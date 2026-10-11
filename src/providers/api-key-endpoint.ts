/**
 * Per-key upstream endpoint for API-key pools.
 *
 * Some vendors publish the same product under two regional hosts (MiniMax: api.minimax.io
 * for global and api.minimaxi.com for mainland China). A key authenticates on exactly one of
 * them, so a pool that mixes regions cannot be served by a single provider-level baseUrl: keys
 * that belong to the other region answer 401 on every hit even though they are valid.
 *
 * The fix is DATA, not a per-request guess: each pool entry carries the endpoint its key was
 * DETECTED to authenticate on (`entry.baseUrl`), set by src/providers/region-detect.ts. This
 * module is the pure read side — resolvePoolEntryEndpoint() tells the router which endpoint a
 * row is about to send, and nothing here performs I/O or mutates state.
 */
import type { OcxProviderConfig } from "../types";

type PoolEntry = NonNullable<OcxProviderConfig["apiKeyPool"]>[number];

/** The pool entry a provider row is about to send: by key value, else by the routed selection stamp. */
export function poolEntryForProvider(
  provider: Pick<OcxProviderConfig, "apiKey" | "apiKeyPool" | "_apiKeyAttempt">,
): PoolEntry | undefined {
  const pool = provider.apiKeyPool;
  if (!pool?.length) return undefined;
  const byKey = provider.apiKey ? pool.find(entry => entry.key === provider.apiKey) : undefined;
  if (byKey) return byKey;
  const entryId = provider._apiKeyAttempt?.entryId;
  return entryId ? pool.find(entry => entry.id === entryId) : undefined;
}

/**
 * Endpoint override for the pool entry a row is about to send, or undefined when the entry has
 * none (then the provider's own baseUrl stands). Set only for providers whose registry entry
 * declares more than one official host.
 */
export function resolvePoolEntryEndpoint(
  provider: Pick<OcxProviderConfig, "apiKey" | "apiKeyPool" | "_apiKeyAttempt">,
): string | undefined {
  const entry = poolEntryForProvider(provider);
  const endpoint = entry?.baseUrl?.trim();
  return endpoint ? endpoint : undefined;
}
