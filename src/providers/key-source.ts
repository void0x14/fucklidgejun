/**
 * Pull VERIFIED provider keys out of the external key-checker service and APPEND them to a
 * provider's `apiKeyPool`. The active key is never touched: a refresh that rotated routing
 * would invalidate every in-flight round-robin pick, and an operator who opted in asked for
 * more capacity, not a different key. See `syncProviderKeysFromSource` for the commit shape.
 *
 * The bearer token and the keys themselves are never logged; this module runs under
 * `bun run privacy:scan`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OcxConfig, OcxProviderConfig } from "../types";
import { apiKeyPoolEntryId, isKeyAuthProvider, sanitizeApiKeyValue } from "./api-keys";
import { commitProviderApiKeySelection } from "./api-key-selection";

export const DEFAULT_KEY_SOURCE_URL = "http://127.0.0.1:8787";
export const DEFAULT_KEY_SOURCE_REFRESH_DAYS = 7;

/** Collecting verifies every candidate key live, so it is minutes-scale, not request-scale. */
const COLLECT_TIMEOUT_MS = 5 * 60_000;

export interface KeySourceSettings { url: string; topic: string; refreshDays: number }
export interface CollectResult { topicId: number; topicTitle: string; keys: string[]; scanned: number; checked: number; reused: number }
export interface SyncResult { added: number; existing: number; verified: number; scanned: number; checked: number; reused: number }

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Absent `keySource` is the off switch; a bare `{}` is a valid opt-in on every default. */
export function keySourceSettings(provider: OcxProviderConfig | undefined, name: string): KeySourceSettings | null {
  if (!provider?.keySource) return null;
  const days = Math.floor(Number(provider.keySource.refreshDays));
  return {
    url: provider.keySource.url?.trim() || DEFAULT_KEY_SOURCE_URL,
    topic: provider.keySource.topic?.trim() || name,
    refreshDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_KEY_SOURCE_REFRESH_DAYS,
  };
}

/** key-checker writes its token next to its state; an unreadable file just means no header. */
function keySourceToken(): string {
  const fromEnv = process.env.OPENCODEX_KEY_SOURCE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
    return readFileSync(join(stateHome, "key-checker", "api-token"), "utf8").trim();
  } catch {
    return "";
  }
}

export async function collectVerifiedKeys(settings: KeySourceSettings, signal?: AbortSignal): Promise<CollectResult> {
  const token = keySourceToken();
  // AbortSignal.any keeps the caller's cancellation while the timeout still bounds a hung collect.
  const timeout = AbortSignal.timeout(COLLECT_TIMEOUT_MS);
  const response = await fetch(`${settings.url.replace(/\/+$/, "")}/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ provider: settings.topic }),
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
  });
  if (!response.ok) {
    let detail = "";
    try { const body = await response.json() as { error?: unknown }; if (typeof body?.error === "string") detail = body.error; } catch { /* non-JSON error body */ }
    throw new Error(detail || `HTTP ${response.status}`);
  }
  let payload: { topicId?: unknown; topicTitle?: unknown; keys?: unknown; scanned?: unknown; checked?: unknown; reused?: unknown };
  try { payload = await response.json() as typeof payload; } catch { throw new Error("key-checker returned an unreadable response"); }
  if (!payload || typeof payload !== "object") throw new Error("key-checker returned an unreadable response");
  const keys = Array.isArray(payload.keys)
    ? payload.keys.flatMap(entry => typeof entry === "string" && entry.trim() ? [entry.trim()] : [])
    : [];
  return {
    topicId: count(payload.topicId),
    topicTitle: typeof payload.topicTitle === "string" ? payload.topicTitle : "",
    keys,
    scanned: count(payload.scanned), checked: count(payload.checked), reused: count(payload.reused),
  };
}

export async function syncProviderKeysFromSource(
  config: OcxConfig,
  name: string,
  opts?: { signal?: AbortSignal },
): Promise<SyncResult | { error: string }> {
  const provider = config.providers[name];
  if (!provider || !isKeyAuthProvider(provider)) return { error: "unknown provider" };
  const settings = keySourceSettings(provider, name);
  if (!settings) return { error: "provider has no keySource configured" };
  const collected = await collectVerifiedKeys(settings, opts?.signal);
  const incoming: string[] = [];
  const seenIncoming = new Set<string>();
  for (const raw of collected.keys) {
    const key = sanitizeApiKeyValue(raw);
    if (!key || seenIncoming.has(key)) continue;
    seenIncoming.add(key);
    incoming.push(key);
  }
  const committed = commitProviderApiKeySelection<SyncResult>(config, name, fresh => {
    // Rebased against the pool handed to us, never a snapshot taken before the lock.
    if (!fresh.apiKeyPool) fresh.apiKeyPool = [];
    if (fresh.apiKeyPool.length === 0 && fresh.apiKey) fresh.apiKeyPool.push({ id: apiKeyPoolEntryId(fresh.apiKey), key: fresh.apiKey });
    const pool = fresh.apiKeyPool;
    const have = new Set(pool.map(entry => entry.id));
    let added = 0;
    for (const key of incoming) {
      const id = apiKeyPoolEntryId(key);
      if (have.has(id)) continue;
      have.add(id);
      pool.push({ id, key, label: "telegram", addedAt: Date.now() });
      added += 1;
    }
    const result: SyncResult = { added, existing: incoming.length - added, verified: incoming.length, scanned: collected.scanned, checked: collected.checked, reused: collected.reused };
    // No apiKey write and no selectionChanged: bumping apiKeySelectionRevision would fail every
    // in-flight round-robin pick, so the operator's active key and live routing stay intact.
    // Nothing to invalidate afterwards either — the active key did not change.
    return { changed: added > 0, value: result };
  });
  if (committed.status === "unavailable") return { error: "provider selection unavailable" };
  return committed.status === "committed" ? committed.value : { error: "provider selection superseded" };
}