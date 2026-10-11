import { canonicalModelId } from "./model-id";
import { createHash } from "node:crypto";
import type { OcxConfig } from "../types";
import { routedProviderConfig } from "../router";
import { resolveModelsAuthToken } from "../oauth";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "./registry";
import { providerFailureMessage } from "./failure-guidance";
import { providerKeyCandidates } from "./key-failover";
import { captureProviderGather } from "../codex/catalog/gather-capture";
import { fetchProviderModelsWithAuth, refreshingModelsAuthResolver } from "../codex/catalog/provider-models";
import { clearModelDiscoveryFailureCooldown, getProviderDiscoveryStatus } from "../codex/model-cache";

export interface LiveModelsResult {
  ok: boolean;
  models: string[];
  source: "live" | "cached" | "preset" | "unavailable";
  verifiedAt?: number;
  message?: string;
}
const snapshots = new Map<string, { models: string[]; verifiedAt: number }>();
const flights = new Map<string, Promise<LiveModelsResult>>();
const CACHE_MS = 5 * 60_000;

export function modelDiscoveryIdentity(provider: OcxConfig["providers"][string]): string {
  return createHash("sha256").update(JSON.stringify({ baseUrl: provider.baseUrl, adapter: provider.adapter,
    authMode: provider.authMode, apiKey: provider.apiKey, headers: provider.headers,
    apiKeyPool: provider.apiKeyPool?.map(({id,key,baseUrl}) => ({id,key,baseUrl})),
    apiKeyTransport: provider.apiKeyTransport })).digest("hex");
}

/** Aynı keşif motoru bütün protokolleri çözer; hazır satırlar canlı kanıt sayılmaz. */
export async function discoverLiveModels(config: OcxConfig, name: string, refresh = false): Promise<LiveModelsResult> {
  const configured = config.providers[name];
  if (!configured) return { ok: false, models: [], source: "unavailable", message: "Önce sağlayıcıyı ekle." };
  const identity = modelDiscoveryIdentity(configured);
  const provider = routedProviderConfig(name, configured);
  const token = await resolveModelsAuthToken(name, provider);
  const cacheKey = `${name}\0${identity}\0${createHash("sha256").update(token ?? "").digest("hex")}`;
  const cached = snapshots.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.verifiedAt < CACHE_MS) return { ok: true, ...cached, source: "cached" };
  const pending = flights.get(cacheKey);
  if (pending) return pending;
  const entry = getProviderRegistryEntry(name);
  const preset = entry && providerMatchesRegistryTransport(name, provider) ? entry.models : undefined;
  const fallback = (message: string): LiveModelsResult => ({ ok: false,
    models: cached?.models ?? [...(preset ?? [])], source: cached ? "cached" : preset ? "preset" : "unavailable",
    ...(cached ? { verifiedAt: cached.verifiedAt } : {}), message });
  const run = async (): Promise<LiveModelsResult> => {
    const started = Date.now();
    const candidates = provider.authMode === "oauth" || provider.authMode === "forward"
      ? [configured] : providerKeyCandidates(name, configured);
    let message = "Canlı liste alınamadı. Sağlayıcının API adresini ve anahtarını kontrol et.";
    for (const candidate of candidates) {
      if (Date.now() - started >= 20_000) return fallback("Canlı liste zamanında gelmedi. Eski liste korunuyor; yeniden dene.");
      clearModelDiscoveryFailureCooldown(name);
      const captured = captureProviderGather(name, { ...candidate, liveModels: true }, refreshingModelsAuthResolver, undefined, config);
      const result = await fetchProviderModelsWithAuth(captured, -1, undefined, refreshingModelsAuthResolver);
      if (config.providers[name] === undefined || modelDiscoveryIdentity(config.providers[name]) !== identity) {
        return fallback("Sağlayıcı ayarı keşif sırasında değişti. Yeni ayarla listeyi yeniden al.");
      }
      if (result.verifiedModelIds !== undefined) {
        const snapshot = { models: [...new Set(result.verifiedModelIds)], verifiedAt: Date.now() };
        snapshots.delete(cacheKey); snapshots.set(cacheKey, snapshot);
        while (snapshots.size > 128) snapshots.delete(snapshots.keys().next().value!);
        return { ok: true, ...snapshot, source: "live" };
      }
      const status = getProviderDiscoveryStatus(name);
      if (status?.status === "failed" && status.reason === "http") message = providerFailureMessage(status.httpStatus, "");
      else if (status?.status === "failed" && status.reason === "invalid_response") message = "Sağlayıcının model listesi okunamadı. Eski liste korunuyor; API adresini kontrol et.";
      else if (result.outcome.state === "authoritative") return fallback("Bu sağlayıcı canlı model listesi sunmuyor. Hazır model listesini kullan.");
    }
    return fallback(message);
  };
  const flight = run().finally(() => flights.delete(cacheKey));
  flights.set(cacheKey, flight);
  return flight;
}

/** Kaydedilmiş özel satırlar doğrulama kanıtı değildir. */
export async function validateProviderModelId(config: OcxConfig, name: string, input: string) {
  let catalog: LiveModelsResult;
  try { catalog = await discoverLiveModels(config, name); }
  catch { catalog = { ok: false, models: [], source: "unavailable", message: "Model listesi alınamadı. API adresini ve anahtarını kontrol edip yeniden dene." }; }
  const modelId = canonicalModelId(input, name, catalog.models);
  return { modelId, suggestions: catalog.models.slice(0, 20), source: catalog.source,
    error: modelId ? undefined : catalog.models.length
      ? "Bu model listede yok. Önerilen gerçek model kimliklerinden birini seç."
      : catalog.message ?? "Doğrulanabilir model listesi yok. Canlı listeyi alıp yeniden dene." };
}
