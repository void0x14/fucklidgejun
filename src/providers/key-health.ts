import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../config/atomic-write";
import { getConfigDir } from "../config/paths";
import type { OcxProviderConfig } from "../types";
import type { KeyScopedFailureClass } from "./key-failure-class";
import type { ProviderApiKeyHealth as ApiKeyHealth } from "../types/provider";
export type { ProviderApiKeyHealth as ApiKeyHealth } from "../types/provider";

type PoolEntry = NonNullable<OcxProviderConfig["apiKeyPool"]>[number];
type StoredHealth = ApiKeyHealth & { identity: string };
const MAX_ENTRIES = 1_024;
const HALF_LIFE_MS = 6 * 60 * 60_000;
let loadedPath = "";
const observations = new Map<string, StoredHealth>();
let pendingSave: ReturnType<typeof setTimeout> | undefined;

function storePath(): string {
  const path = join(getConfigDir(), "key-health.json");
  if (loadedPath === path) return path;
  loadedPath = path;
  observations.clear();
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1_024) return path;
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows)) return path;
    for (const row of rows.slice(-MAX_ENTRIES)) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || !row[1]) continue;
      const value = row[1] as StoredHealth;
      if (typeof value.identity !== "string" || !Number.isFinite(value.lastUsedAt)
        || !Number.isFinite(value.successes) || value.successes < 0
        || !Number.isFinite(value.failures) || value.failures < 0
        || !Number.isFinite(value.reliability) || value.reliability < 0 || value.reliability > 1) continue;
      observations.set(row[0], value);
    }
  } catch { /* Optional learning history must never stop inference. */ }
  return path;
}

function identity(provider: OcxProviderConfig, entry: PoolEntry): string {
  return createHash("sha256").update(`${entry.baseUrl ?? provider.baseUrl}\0${entry.key}`).digest("hex");
}

export function apiKeyHealth(providerName: string, provider: OcxProviderConfig, entry: PoolEntry, now = Date.now()): ApiKeyHealth {
  storePath();
  const stored = observations.get(`${providerName}\0${entry.id}`);
  if (!stored || stored.identity !== identity(provider, entry)) {
    return { successes: 0, failures: 0, reliability: 0.5, lastUsedAt: 0 };
  }
  const weight = Math.pow(0.5, Math.max(0, now - stored.lastUsedAt) / HALF_LIFE_MS);
  return { successes: stored.successes, failures: stored.failures,
    reliability: 0.5 + (stored.reliability - 0.5) * weight,
    lastUsedAt: stored.lastUsedAt, lastFailure: stored.lastFailure };
}

/** Records credential acceptance, never a claim that a streamed answer completed. */
export function noteApiKeyOutcome(providerName: string, provider: OcxProviderConfig, failure?: KeyScopedFailureClass, entryId?: string, now = Date.now()): void {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return;
  const entry = provider.apiKeyPool?.find(row => row.id === (entryId ?? provider._apiKeyAttempt?.entryId))
    ?? provider.apiKeyPool?.find(row => row.key === provider.apiKey);
  if (!entry) return;
  const path = storePath();
  const previous = apiKeyHealth(providerName, provider, entry, now);
  const key = `${providerName}\0${entry.id}`;
  observations.delete(key);
  observations.set(key, {
    identity: identity(provider, entry),
    successes: previous.successes + (failure ? 0 : 1),
    failures: previous.failures + (failure ? 1 : 0),
    reliability: previous.reliability * 0.8 + (failure ? 0 : 0.2),
    lastUsedAt: now,
    ...(failure ? { lastFailure: failure } : {}),
  });
  while (observations.size > MAX_ENTRIES) observations.delete(observations.keys().next().value!);
  if (pendingSave) return;
  pendingSave = setTimeout(() => {
    pendingSave = undefined;
    if (path !== loadedPath) return;
    try { atomicWriteFile(path, JSON.stringify([...observations])); }
    catch { /* Keep learning in memory when optional persistence is unavailable. */ }
  }, 1_000);
  pendingSave.unref?.();
}
