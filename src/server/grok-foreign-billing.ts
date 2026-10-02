/**
 * Grok Build client delivery: keep a NON-xAI provider's HTTP 402 from triggering Grok Build's
 * own xAI billing upsell.
 *
 * Grok Build (1.0.46, `xai-grok-pager` status.rs) shows "You hit your weekly limit / Purchase
 * credits to keep using Grok Build" whenever the response status is 402, the error text contains
 * `status 402`, or a 403 carries `run out of credits`. It never checks which provider answered,
 * so a DeepSeek "Insufficient Balance" 402 relayed through opencodex reads as a Grok limit and
 * hides the real cause.
 *
 * The rewrite is client-facing only. It runs at the outermost delivery boundary, AFTER the
 * deferred request log has recorded the real 402, so usage logs, cooldowns, health, key
 * failover and combo accounting all keep the upstream status. It applies only when:
 *   - the request carries the Grok marker (`logCtx.surface === "grok"`),
 *   - the client-bound response is a non-SSE HTTP 402, and
 *   - the provider that produced it is positively identified and is NOT xAI.
 * A genuine xAI 402 stays a 402 so Grok's real billing flow still works, and an unidentified
 * provider is left alone rather than guessed at.
 *
 * The replacement is HTTP 400 `insufficient_quota` with no Retry-After: Grok Build never retries
 * a 400 (it retries 429 and 5xx up to 15 times) and has no upsell for it.
 */
import { getProviderRegistryEntry } from "../providers/registry";
import { redactSecretString } from "../lib/redact";
import type { OcxConfig } from "../types";
import type { RequestLogContext } from "./request-log";

/** Upper bound on the error body read for the rewrite; the message is cut far below this. */
const MAX_REWRITE_BODY_BYTES = 64 * 1024;
const MAX_UPSTREAM_MESSAGE_CHARS = 500;

/** True when the hostname is an xAI / Grok property (api.x.ai, cli-chat-proxy.grok.com, ...). */
function isXaiHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "x.ai" || host.endsWith(".x.ai") || host === "grok.com" || host.endsWith(".grok.com");
}

function baseUrlIsXai(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl) return false;
  try {
    return isXaiHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

type ServingProvider =
  | { kind: "xai" }
  | { kind: "other"; name: string; label: string }
  | { kind: "unknown" };

/**
 * Identify the provider whose response became the client-bound 402, from the attempt records the
 * route wrote (never from the model name). A combo can carry several attempts; the last one that
 * finished with 402 is the one being relayed.
 */
function servingProvider(logCtx: RequestLogContext, config: OcxConfig): ServingProvider {
  const attempts = logCtx.attempts ?? [];
  const attempt = [...attempts].reverse().find(entry => entry.status === 402)
    ?? logCtx.activeAttempt
    ?? attempts.at(-1);
  if (attempt?.credentialSource === "grok-oauth" || attempt?.credentialSource === "xai-api-key") {
    return { kind: "xai" };
  }
  const providers = config.providers ?? {};
  const candidates = [attempt?.provider, logCtx.provider]
    .filter((name): name is string => typeof name === "string" && name.length > 0 && name !== "unknown");
  const name = candidates.find(candidate => Object.hasOwn(providers, candidate));
  if (!name) return { kind: "unknown" };
  const configured = providers[name];
  const registry = getProviderRegistryEntry(name);
  if (name === "xai" || registry?.id === "xai" || baseUrlIsXai(configured?.baseUrl)) return { kind: "xai" };
  return { kind: "other", name, label: registry?.label ?? name };
}

/** Remove every phrase Grok Build matches as a billing trigger (case-insensitive). */
function stripGrokBillingTriggers(text: string): string {
  return text
    .replace(/status(\s+)(40[23])/gi, "HTTP$1$2")
    .replace(/run out of credits/gi, "exhausted the credits");
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  try {
    while (bytes < MAX_REWRITE_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      const remaining = MAX_REWRITE_BODY_BYTES - bytes;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
    }
    await reader.cancel().catch(() => {});
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function upstreamMessageFromJson(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof error === "string" && error.trim()) return error;
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  return undefined;
}

function clientMessage(label: string, upstreamMessage: string | undefined): string {
  const detail = upstreamMessage
    ? redactSecretString(upstreamMessage.replace(/\s+/g, " ").trim()).slice(0, MAX_UPSTREAM_MESSAGE_CHARS)
    : "payment required";
  return stripGrokBillingTriggers(
    `${label}: ${detail} (upstream HTTP 402 Payment Required; this is the ${label} account balance, not a Grok limit)`,
  );
}

/**
 * Client-delivery rewrite for Grok Build. Returns `response` itself for every request it does
 * not apply to, so a request without the Grok marker is untouched.
 */
export async function rewriteGrokForeignPaymentRequired(
  response: Response,
  logCtx: RequestLogContext,
  config: OcxConfig,
): Promise<Response> {
  if (logCtx.surface !== "grok" || response.status !== 402) return response;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) return response;
  // Attempt identity (provider name, credential source) is written when the attempt begins, so
  // it is readable before the body. xAI keeps Grok's native billing flow; unknown is not guessed.
  const provider = servingProvider(logCtx, config);
  if (provider.kind !== "other") return response;
  // Reading the body drives the deferred request log, which records the REAL 402 before any
  // byte of the rewritten response exists.
  let text = "";
  try {
    text = await readBoundedText(response);
  } catch {
    text = "";
  }
  const upstreamMessage = contentType.includes("json") || /^\s*[{[]/.test(text)
    ? upstreamMessageFromJson(text)
    : undefined;
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "retry-after", "retry-after-ms"]) headers.delete(name);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify({
    error: {
      type: "insufficient_quota",
      code: "insufficient_quota",
      message: clientMessage(provider.label, upstreamMessage),
    },
  }), { status: 400, statusText: "Bad Request", headers });
}
