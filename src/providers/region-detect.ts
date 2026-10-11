/**
 * Automatic region/endpoint detection for multi-region API-key pools.
 *
 * Some vendors publish one product under two hosts with separate accounts (MiniMax:
 * api.minimax.io global vs api.minimaxi.com mainland China). A key authenticates on exactly
 * one, so a pool that mixes regions cannot be served by a single provider baseUrl -- the keys
 * that belong to the other region answer 401 on every request.
 *
 * Instead of guessing per request, the system DETECTS each key's host up front: probe every
 * declared endpoint with the key and persist the one that authenticates onto entry.baseUrl
 * (the read side is src/providers/api-key-endpoint.ts). After detection a mixed pool
 * round-robins cleanly: every key is dispatched to the host it belongs to, with no errors.
 *
 * Detection is only meaningful for providers whose registry entry declares more than one
 * official host (baseUrlChoices). Everything else returns an empty plan.
 */
import { PROVIDER_REGISTRY } from "./registry";
import { resolveProviderApiKey } from "./key-store";
import { setProviderApiKeyEndpoint } from "./api-keys";
import type { OcxConfig, OcxProviderConfig } from "../types";

export const KEY_REGION_PROBE_TIMEOUT_MS = 15_000;

export interface KeyRegionEndpoint {
  id: string;
  label: string;
  baseUrl: string;
}

export interface KeyRegionResult {
  id: string;
  status: "detected" | "unresolvable" | "unchanged";
  endpoint?: string;
}

export interface KeyRegionDetection {
  provider: string;
  status: "ok" | "unsupported";
  endpoints: KeyRegionEndpoint[];
  results: KeyRegionResult[];
  detected: number;
  unresolved: number;
}

export interface KeyRegionDetectOptions {
  /** Re-probe entries that already carry an endpoint instead of leaving them untouched. */
  force?: boolean;
  /** Restrict detection to these pool entry ids (e.g. just the key that was added). */
  entryIds?: readonly string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function normalizeEndpoint(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The endpoints a provider's registry entry officially serves, in registry order, with the
 * labels a UI can show. Empty unless the entry declares 2+ distinct hosts.
 */
export function providerDeclaredRegionEndpoints(providerName: string): KeyRegionEndpoint[] {
  const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === providerName);
  if (!entry) return [];
  const out: KeyRegionEndpoint[] = [];
  const seen = new Set<string>();
  const add = (id: string, label: string, baseUrl: string | undefined): void => {
    if (!baseUrl) return;
    const normalized = normalizeEndpoint(baseUrl);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ id, label, baseUrl });
  };
  for (const choice of entry.baseUrlChoices ?? []) add(choice.id, choice.label, choice.baseUrl);
  // The row's own baseUrl is the implicit default host when it is not one of the named choices.
  add("default", "Default", /\{[^}]*\}/.test(entry.baseUrl) ? undefined : entry.baseUrl);
  return out.length >= 2 ? out : [];
}

/**
 * Probe one endpoint with one key. A 401/403 means "this key does not belong here"; ANY other
 * answered status (2xx, 400 model, 402 balance, 429 rate) means the credential AUTHENTICATED on
 * this host, which is what region detection is asking. A transport failure is unknown, never a
 * rejection -- a flaky network must not mark a working key unresolvable.
 */
async function probeEndpoint(
  provider: OcxProviderConfig,
  endpoint: string,
  key: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<"auth" | "reject" | "unknown"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.headers ?? {}),
        authorization: "Bearer " + key,
      },
      body: JSON.stringify({
        model: provider.defaultModel ?? provider.models?.[0] ?? "",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });
    return response.status === 401 || response.status === 403 ? "reject" : "auth";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect and persist the host each pool key authenticates on. Serial and per-key best-effort:
 * a key that authenticates nowhere is left unresolved (the ordinary failover path owns it) and
 * never blocks the keys around it.
 */
export async function detectProviderKeyRegions(
  config: OcxConfig,
  providerName: string,
  options: KeyRegionDetectOptions = {},
): Promise<KeyRegionDetection> {
  const endpoints = providerDeclaredRegionEndpoints(providerName);
  const empty: KeyRegionDetection = {
    provider: providerName, status: "unsupported", endpoints, results: [], detected: 0, unresolved: 0,
  };
  const provider = config.providers?.[providerName];
  if (!provider || endpoints.length < 2) return empty;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return empty;
  if ((provider.adapter ?? "") !== "openai-chat") return empty;
  const pool = provider.apiKeyPool ?? [];
  if (pool.length === 0) return { ...empty, status: "ok" };

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? KEY_REGION_PROBE_TIMEOUT_MS;
  const results: KeyRegionResult[] = [];
  let detected = 0;
  let unresolved = 0;

  for (const entry of pool) {
    if (options.entryIds && !options.entryIds.includes(entry.id)) continue;
    if (!options.force && entry.baseUrl) {
      results.push({ id: entry.id, status: "unchanged", endpoint: entry.baseUrl });
      continue;
    }
    const key = resolveProviderApiKey(entry.key) ?? entry.key;
    if (typeof key !== "string" || !key.trim()) {
      results.push({ id: entry.id, status: "unresolvable" });
      unresolved += 1;
      continue;
    }
    let found: string | undefined;
    for (const endpoint of endpoints) {
      const verdict = await probeEndpoint(provider, endpoint.baseUrl, key, fetchImpl, timeoutMs);
      if (verdict === "auth") { found = endpoint.baseUrl; break; }
    }
    if (found) {
      setProviderApiKeyEndpoint(config, providerName, entry.id, found);
      results.push({ id: entry.id, status: "detected", endpoint: found });
      detected += 1;
    } else {
      results.push({ id: entry.id, status: "unresolvable" });
      unresolved += 1;
    }
  }
  return { provider: providerName, status: "ok", endpoints, results, detected, unresolved };
}

/**
 * Fire-and-forget startup sweep: detect regions for every provider that declares 2+ hosts and
 * still has an undetected pool key. Runs after listen; a slow or failing probe must never block
 * startup, so every provider is best-effort and errors are logged, not thrown.
 */
export async function sweepProviderKeyRegions(config: OcxConfig): Promise<void> {
  for (const name of Object.keys(config.providers ?? {})) {
    if (providerDeclaredRegionEndpoints(name).length < 2) continue;
    const pool = config.providers[name]?.apiKeyPool ?? [];
    if (!pool.some(entry => !entry.baseUrl)) continue;
    try {
      const result = await detectProviderKeyRegions(config, name);
      if (result.status === "ok" && (result.detected > 0 || result.unresolved > 0)) {
        console.warn(
          "[region-detect] " + name + ": detected " + result.detected
          + ", unresolved " + result.unresolved,
        );
      }
    } catch (error) {
      console.warn(
        "[region-detect] " + name + " sweep failed: "
        + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}
