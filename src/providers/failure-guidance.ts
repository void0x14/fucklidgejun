import { readBoundedResponseBody } from "../lib/bounded-body";
import { redactSecretString } from "../lib/redact";
import {
  isContextOverflowText,
  isCyberPolicyCode,
  isCyberPolicyMessage,
  parseStatedContextMaximum,
} from "../lib/errors";
import { recordObservedContextCeiling } from "./observed-context-ceiling";
import { classifyKeyScopedFailure } from "./key-failure-class";

function errorFields(body: string): { message: string; code?: string | number | null; type?: string; param?: string | null } {
  const text = body.replace(/^Provider error \d+:\s*/, "").slice(0, 16_384);
  try {
    const parsed = JSON.parse(text);
    const fields = parsed?.error ?? parsed?.response?.error ?? parsed;
    if (typeof fields === "string") return { message: redactSecretString(fields).slice(0, 500) };
    return { message: typeof fields?.message === "string" ? redactSecretString(fields.message).slice(0, 500) : "",
      ...(typeof fields?.code === "string" ? { code: redactSecretString(fields.code).slice(0, 80) }
        : fields?.code === null || typeof fields?.code === "number" ? { code: fields.code } : {}),
      ...(typeof fields?.param === "string" ? { param: redactSecretString(fields.param).slice(0, 80) }
        : fields?.param === null ? { param: null } : {}),
      ...(typeof fields?.type === "string" ? { type: redactSecretString(fields.type).slice(0, 80) } : {}) };
  } catch {
    return { message: /<html|<!doctype/i.test(text) ? "" : redactSecretString(text).slice(0, 500) };
  }
}

/** Durum kodunu ve makine kimliğini değiştirmeden neden ve yapılacak işi açıklar. */
export function providerFailureMessage(status: number, body: string): string {
  const fields = errorFields(body);
  const text = `${fields.code ?? ""} ${fields.message}`;
  if (/api[ _-]?key[^.]{0,80}(?:missing|unavailable|required)|credential[^.]{0,80}(?:missing|unavailable|empty)/i.test(text)) {
    return "Anahtar okunamadı. API Anahtarları bölümündeki anahtarını düzelt veya yenisini ekle.";
  }
  const code = typeof fields.code === "string" ? fields.code : undefined;
  if (isCyberPolicyCode(code) || isCyberPolicyMessage(fields.message)
    || /content[_ -]?(?:filter|policy)|safety[_ -]?(?:filter|violation)|blocked[_ -]?prompt|moderation|censorship/i.test(text)) {
    return "Sağlayıcı isteği içerik politikası nedeniyle reddetti. Engellenen kısmı değiştirip yeniden gönder.";
  }
  const keyFailure = classifyKeyScopedFailure(status, body, code);
  if (keyFailure === "auth") return "Sağlayıcı kimlik doğrulamasını reddetti. API anahtarını yenile; hesapla bağlandıysan yeniden giriş yap.";
  if (keyFailure === "balance") return "Anahtarın bakiyesi yetmiyor. Bakiye ekle veya kullanılabilir başka bir anahtar ekle.";
  if (keyFailure === "quota") return "Anahtarın kotası bitmiş. Kotanın yenilenmesini bekle veya kotası olan başka bir anahtar ekle.";
  if (keyFailure === "rate") return "Sağlayıcının hız sınırına ulaşıldı. Bekleme süresi dolunca yeniden gönder; varsa başka kullanılabilir anahtar ekle.";
  if (/unknown adapter|adapter.*not.*(?:found|available)/i.test(text)) {
    return "Sağlayıcının bağlantı türü tanınmıyor. Ayarlar bölümünden listede bulunan bağlantı türünü seç.";
  }
  if (/model[_ -]?(?:not[_ -]?found|does[_ -]?not[_ -]?exist)|unknown model|no such model|model[^.]{0,80}(?:not available|not supported|does not exist)/i.test(text)) {
    return "Bu model sağlayıcıda bulunamadı. Sağlayıcı → Modeller bölümünden canlı listeyi yenileyip listedeki modeli seç.";
  }
  if (status === 413 || isContextOverflowText(text)) {
    return "Upstreamin kabul ettiği context window doldu, compaction yapınız.";
  }
  if (/reasoning|thinking|effort/i.test(text) && status === 400) {
    return "Model bu düşünme ayarını kabul etmiyor. Modelin sunduğu düşünme düzeylerinden birini seç.";
  }
  if (/certificate|CERT_|TLS/i.test(text)) return "Sağlayıcı bağlantısının sertifikası doğrulanamadı. API adresini ve VPN/proxy bağlantını kontrol et.";
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return "Sağlayıcı zamanında yanıt vermedi. Biraz sonra yeniden gönder; sürerse bağlantını ve sağlayıcının durumunu kontrol et.";
  if (status === 404 || status === 405) return "Sağlayıcının API yolu bulunamadı. Ayarlar bölümündeki API adresini sağlayıcının verdiği adresle eşleştir.";
  if (status >= 500) return "Sağlayıcıya ulaşılamadı veya geçici sunucu hatası alındı. Biraz sonra yeniden gönder; sürerse bağlantını kontrol et.";
  if (status === 403) return "Sağlayıcı erişim izni vermedi. Hesap ve model erişimini kontrol et veya yetkili bir anahtar kullan.";
  if (status === 400 || status === 422) {
    // Never replace the provider's own refusal with a generic sentence: the real message is the
    // only thing that says which field it rejected. Fall back only when the body carried none.
    const stated = errorFields(text).message;
    if (typeof stated === "string" && stated.trim().length > 0) return stated.trim().slice(0, 400);
    return "İstek biçimi kabul edilmedi. Modeli canlı listeden seç; hata ayrıntısındaki desteklenmeyen alanı düzelt.";
  }
  return "İstek tamamlanamadı. Hata ayrıntısındaki durum kodunu kontrol ederek sağlayıcı adresini ve model seçimini düzelt.";
}

/** The routed identity of the turn whose failure response is being described. */
export interface ProviderErrorIdentity {
  provider: string;
  model: string;
}

/**
 * Learn the ceiling the provider enforced from the refusal itself, while the number still exists.
 *
 * `recordStatedCeilingFromFailure` (src/server/request-log.ts) reads the log row, and by the time
 * that row exists this function has already replaced the body: `upstreamError` then holds
 * "Upstreamin kabul ettiği context window doldu, compaction yapınız." and the raw
 * "prompt is too long: 100001 tokens > 100000 maximum" is gone, so `parseStatedContextMaximum`
 * finds nothing and the catalog keeps advertising a window the provider already closed. The
 * refusal is a direct measurement, and this is the last point at which it is still readable.
 *
 * Same acceptance rule as the request-log fallback: the body must describe a window overflow AND
 * state a plausible maximum. A failure response is already a failure by construction here (the
 * status guard above), so only the text needs checking.
 */
function recordStatedCeilingFromRawRefusal(
  identity: ProviderErrorIdentity | undefined,
  text: string,
): void {
  if (identity === undefined || !text) return;
  if (!isContextOverflowText(text)) return;
  const ceiling = parseStatedContextMaximum(text);
  if (ceiling === undefined) return;
  recordObservedContextCeiling({ provider: identity.provider, model: identity.model, ceiling });
}

/** Yalnızca son hata yanıtına uygulanır; combo kararları özgün sağlayıcı hatasını görür. */
export async function humanizeProviderErrorResponse(
  response: Response,
  identity?: ProviderErrorIdentity,
): Promise<Response> {
  if (response.status < 400 || response.status === 499) return response;
  let text = "";
  try {
    const body = await readBoundedResponseBody(response, { maxBytes: 131_072, totalTimeoutMs: 2_000 });
    if (body.displaySafe && !body.truncated) text = body.text;
  } catch { /* Yanıtsız veya bozuk hata gövdesinde durum koduyla açıklama yapılır. */ }
  // Before the body below is rebuilt: the refusal is the only trustworthy source for the ceiling.
  recordStatedCeilingFromRawRefusal(identity, text);
  const fields = errorFields(text);
  // A window overflow is the one shape a Codex client can act on: it classifies
  // `context_length_exceeded` as its own context-window failure and runs its compaction
  // path, which a vendor code like `prompt_too_long` never reaches. Verified 2026-10-14:
  // ocx forwarded that vendor code and the turn died with a generic "request format"
  // sentence while the client sat at 70% of a window the provider had already closed.
  const overflow = response.status === 413
    || isContextOverflowText(`${fields.code ?? ""} ${fields.message}`);
  const headers = new Headers(response.headers);
  headers.delete("content-length"); headers.delete("content-encoding");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({ error: {
    type: overflow ? "invalid_request_error" : (fields.type ?? "upstream_error"),
    ...(overflow
      ? { code: "context_length_exceeded" }
      : fields.code !== undefined ? { code: fields.code } : {}),
    ...(fields.param !== undefined ? { param: fields.param } : {}),
    message: providerFailureMessage(response.status, text),
    details: { status: response.status, ...(fields.code !== undefined ? { code: fields.code } : {}),
      ...(fields.message ? { message: fields.message } : {}) },
  } }), { status: response.status, headers });
}
