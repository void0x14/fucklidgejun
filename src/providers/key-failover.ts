/**
 * Multi-key failover for static API-key pools.
 *
 * When a provider's upstream answers with a KEY-SCOPED verdict (429 rate window, 401 rejected
 * key, 402 unpaid account, or a 400/403 that names billing/quota -- see `key-failure-class.ts`),
 * this module puts the key that was actually sent into cooldown and returns a fresh provider
 * config for the next healthy key in `apiKeyPool`. If every other key is cooling, it returns
 * null so the caller surfaces the real upstream answer to the client.
 *
 * Modelled after src/codex/routing.ts cooldown logic but scoped to plain API-key pools.
 */
import { commitProviderApiKeySelection } from "./api-key-selection";
import type { KeyScopedFailureClass } from "./key-failure-class";
import type { ProviderApiKeySelection } from "../types/provider";
import { routedProviderConfig } from "../router";
import type { OcxConfig, OcxProviderConfig, RateLimitRetryPolicy, TransientRetryPolicy } from "../types";
import { OPENCODE_GO_SESSION_HEADER } from "./opencode-go-transport";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";
// quota-key-accounts imports only node:crypto, the key store and the quota types -- NOT
// providers/quota.ts -- so the cached reader reaches the dispatch path without dragging the
// probe machinery onto it.
import { cachedApiKeyQuota } from "./quota-key-accounts";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // cap at 10 min for api-key rotation

/**
 * Default same-target 429 retry policy used when a provider opts in via a bare
 * `retryOn429: {}` (presence = opt-in with these defaults).
 */
const DEFAULT_RATE_LIMIT_RETRY = {
  enabled: true,
  attempts: 3,
  intervalMs: 5_000,
  maxIntervalMs: 60_000,
  respectRetryAfter: true,
} as const satisfies Required<RateLimitRetryPolicy>;

/**
 * Default transient-5xx retry used when a provider opts in with a bare
 * `transientRetryOn5xx: {}`. `attempts` is a TOTAL send budget, not extra retries.
 */
const DEFAULT_TRANSIENT_RETRY = {
  enabled: true,
  attempts: 3,
} as const satisfies Required<TransientRetryPolicy>;

/** Map<`${providerName}\0${keyId}`, KeyCooldown> */
const keyCooldowns = new Map<string, KeyCooldown>();

function cooldownKey(providerName: string, keyId: string): string {
  return `${providerName}\0${keyId}`;
}

/**
 * Parse an upstream `Retry-After` header: numeric seconds (including `0`) or an HTTP-date.
 * Returns a bounded delay in ms (1..MAX_COOLDOWN_MS), or undefined when the value is
 * malformed. An HTTP-date already in the past yields an immediate (1 ms) retry.
 */
function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  // A valid HTTP-date whose retry time has already passed is an immediate retry, exactly like
  // numeric `Retry-After: 0` — never a malformed-header fallback to the fixed interval.
  return Math.min(Math.max(delay, 1), MAX_COOLDOWN_MS);
}

/**
 * True while the given key is inside its 429 cooldown window (lazily evicting the entry once the
 * window expires). Used to skip keys that the upstream just rate-limited during failover.
 */
function isKeyInCooldown(providerName: string, keyId: string, now = Date.now()): boolean {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(cooldownKey(providerName, keyId));
    return false;
  }
  return true;
}

/**
 * How long a key stays out of rotation after a key-scoped verdict.
 *
 * A rate window resets on the upstream's own schedule, so it honours Retry-After (default 60s).
 * Auth, balance and quota verdicts are about the credential itself and do not clear on a timer
 * the upstream announces -- a revoked key, an empty balance, an exhausted free tier -- so they
 * hold the key for the full cap instead of re-trying a dead key once a minute.
 */
function cooldownMsFor(
  failure: KeyScopedFailureClass,
  retryAfterHeader: string | null | undefined,
  now: number,
): number {
  if (failure === "rate") return parseRetryAfterMs(retryAfterHeader, now) ?? DEFAULT_COOLDOWN_MS;
  return MAX_COOLDOWN_MS;
}

/**
 * Cool one pool entry. Never shortens a longer hold already in place (a 429 on a key that is
 * already held for a balance verdict must not release it early). Logs the entry id only:
 * labels are user-supplied free text and could carry secret material, and the key never.
 */
function coolKey(
  providerName: string,
  keyId: string,
  failure: KeyScopedFailureClass,
  retryAfterHeader: string | null | undefined,
  now: number,
): void {
  const until = now + cooldownMsFor(failure, retryAfterHeader, now);
  const existing = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (existing && existing.cooldownUntil >= until) return;
  keyCooldowns.set(cooldownKey(providerName, keyId), { cooldownUntil: until });
  sweepExpiredOnWrite(now);
  console.warn(
    `[key-failover] ${providerName}: ${failure} verdict on key ${keyId}; cooling for ${Math.ceil((until - now) / 1000)}s`,
  );
}

// ---- public API ----

/**
 * Check whether a provider has multiple keys available for failover.
 * Returns true only for key-auth providers with 2+ pool entries.
 */
export function hasKeyPoolFailover(provider: OcxProviderConfig): boolean {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  return (provider.apiKeyPool?.length ?? 0) >= 2;
}

/**
 * Process-local round-robin cursor per provider, deliberately parallel to `keyCooldowns`
 * rather than borrowing the Codex pool-rotation state: an API key is not an OAuth account
 * and must not share a quota scope key. Multi-process desync is the same accepted limit
 * the cooldown map already carries.
 */
const keyRotationCursor = new Map<string, string>();

/**
 * Forget a provider's cursor so an operator's manual key selection is not second-guessed.
 *
 * Optional name, mirroring `clearKeyCooldowns`, because the batch provider PUT rewrites the
 * entire roster: a cursor that survives a reorder still names a real id, so round-robin
 * resumes after the pre-edit position and can skip the first eligible key in the new pool.
 */
export function forgetApiKeyRotationCursor(providerName?: string): void {
  if (!providerName) {
    keyRotationCursor.clear();
    return;
  }
  keyRotationCursor.delete(providerName);
}

/*
 * Next healthy pool key after the round-robin cursor, or null when every key is cooling.
 *
 * The cursor is the single source of sequence truth: it advances on every distributed pick
 * AND on every proactive committed move (the persisted branch of `selectProactiveApiKey`
 * writes it), so proactive recovery and per-request distribution advance the same sequence
 * instead of forking it; failure recovery leaves it alone and relies on cooldowns instead.
 * Seeding from the last pick -- not from the committed row -- is what makes back-to-back
 * requests land on different keys even when the persisted row does not move between them.
 *
 * When the cursor is unknown (fresh boot, manual pool edit), anchor on the committed key so
 * the first distributed request goes to its successor instead of re-sending it.
 */
function nextRoundRobinKey(
  providerName: string,
  pool: readonly ApiKeyPoolEntry[],
  committedKey: string | undefined,
  now: number,
): ApiKeyPoolEntry | null {
  const cursorId = keyRotationCursor.get(providerName);
  const cursorIndex = cursorId ? pool.findIndex(entry => entry.id === cursorId) : -1;
  const anchorIndex = cursorIndex >= 0
    ? cursorIndex
    : pool.findIndex(entry => entry.key === committedKey);
  for (let offset = 1; offset <= pool.length; offset += 1) {
    const candidate = pool[(anchorIndex + offset) % pool.length]!;
    if (isKeyInCooldown(providerName, candidate.id, now)) continue;
    keyRotationCursor.set(providerName, candidate.id);
    return candidate;
  }
  return null;
}

/*
 * Per-request round-robin pick for the `round-robin` strategy.
 *
 * Returns a request-local copy of the committed row with the picked key and a selection stamp
 * that names the PICKED entry: `{ entryId: picked.id, reference: picked.key, revision }` at the
 * committed row's current `apiKeySelectionRevision`. Nothing shared is written:
 * - The live config row keeps the committed key. Writing the pick onto it (what this used to do)
 *   made every concurrent request read the newest pick at its dispatch gate, so in-flight
 *   requests collapsed onto one key.
 * - The dispatch gate (`providerApiKeySelectionIsCurrent`) accepts a stamp that names any pool
 *   member at the current revision for a round-robin provider, so the pick dispatches as itself.
 *   A manual selection bumps the revision and still wins over an in-flight pick.
 * - Because the stamp names the key that was actually sent, a failure on it cools THAT key in
 *   `rotateKeyAfterFailure` instead of going `superseded` against the committed row.
 * - No `mutatePersistedConfig`, no revision bump, no `publishAccountSelection` event: this runs
 *   on every request, so it stays off the mutation lock and the UI keeps showing the committed
 *   key until a real rotation or a manual selection moves it.
 *
 * The caller rebuilds the route through the registry seam (`routedProviderConfig`, via
 * `applyRotatedTransport`), which keeps this stamp and resolves an env/keychain reference.
 */
function buildRoundRobinRow(
  provider: OcxProviderConfig,
  picked: ApiKeyPoolEntry,
): OcxProviderConfig {
  return {
    ...provider,
    apiKey: picked.key,
    _apiKeyAttempt: {
      entryId: picked.id,
      reference: picked.key,
      revision: provider.apiKeySelectionRevision,
    },
  };
}

/** The pool entry shape is inline on OcxProviderConfig; name it once rather than re-spelling it. */
type ApiKeyPoolEntry = NonNullable<OcxProviderConfig["apiKeyPool"]>[number];

/**
 * Remaining headroom for one key, or null when nothing current measures it.
 *
 * Same definition as `headroomOf` on the OAuth side, so the two pools cannot disagree about
 * what "more room" means. `creditsUsd` is deliberately excluded: it is a currency amount, not
 * a percentage, and ranking one against the other produces an order that means nothing.
 */
function keyHeadroom(providerName: string, provider: OcxProviderConfig, entry: ApiKeyPoolEntry): number | null {
  const quota = cachedApiKeyQuota(providerName, provider, entry.id, entry.key);
  if (!quota) return null;
  const percents = [
    quota.fiveHourPercent,
    quota.weeklyPercent,
    quota.monthlyPercent,
    ...(quota.customWindows ?? []).map((window: { percent?: number }) => window.percent),
  ].filter((value): value is number => typeof value === "number");
  if (percents.length === 0) return null;
  return 100 - Math.max(...percents);
}

/**
 * Order eligible keys best-first, in the same three buckets `rankAccountsByHeadroom` uses:
 * measured-with-headroom, then unmeasured, then measured-and-spent. Ties keep the roster order.
 *
 * An unmeasured key is NOT assumed spent, and not assumed fresh either -- it sits between the
 * two, which is the only honest position for a key nothing has looked at. A provider that
 * publishes no per-key differentiation (DeepSeek reports every key at the same percent) ties
 * across the board and falls through to the roster order, which is exactly today's behaviour.
 */
function rankKeysByHeadroom(
  providerName: string,
  provider: OcxProviderConfig,
  eligible: readonly ApiKeyPoolEntry[],
): ApiKeyPoolEntry[] {
  return eligible
    .map((entry, index) => {
      const headroom = keyHeadroom(providerName, provider, entry);
      const bucket = headroom === null ? 1 : headroom <= 0 ? 2 : 0;
      return { entry, bucket, headroom: headroom ?? 0, index };
    })
    .sort((left, right) => (left.bucket - right.bucket)
      || (right.headroom - left.headroom)
      || (left.index - right.index))
    .map(row => row.entry);
}


/*
 * Pick a key BEFORE the first attempt.
 *
 * Two modes, split by strategy:
 * - `round-robin`: EVERY request advances to the next healthy pool key, whether or not
 *   the committed key is healthy. This is true per-request load distribution: without it
 *   every request lands on the same committed key until a 429 forces a rotation, so a
 *   single upstream key absorbs the full request rate (and its per-key quota) while its
 *   siblings sit idle. The choice is request-local -- no config write, no revision bump, no
 *   live-row mutation -- so the UI keeps showing the operator's committed key and failure
 *   recovery still owns persistence. Cooldown-skipped keys are never picked.
 * - `quota` / `fill-first` / no strategy: intentionally narrow. Never overrides a healthy key:
 *   if the committed `apiKey` is not in cooldown it returns null, so an operator's manual
 *   selection stands and no config write happens. Only acts when the committed key is
 *   known-cooled (or missing from the pool), which is exactly the case where the request would
 *   otherwise be spent earning a refusal the runtime could already predict. A pool with no
 *   strategy behaves like `fill-first` here: without it a key that failed with a verdict the
 *   in-request failover could not move away from stayed committed, and every "continue" was
 *   sent to the same dead key.
 *
 * When every key is cooling this returns null and the request dispatches on the committed key:
 * the upstream's real answer is better than a synthetic local refusal, and a cooldown is a
 * prediction, not a fact.
 *
 * Returning null is the common path for the non-round-robin strategies, so the
 * persisted-selection transaction is not on the per-request hot path.
 *
 * Like `rotateKeyAfterFailure`, the PERSISTED branch of this function answers with a snapshot
 * of the persisted config and carries none of the registry backfills `routedProviderConfig`
 * merges in at request time. A request path must not assign it to an active route wholesale --
 * for a built-in provider stored in its valid minimal form that would drop the adapter id,
 * the base URL and the static headers, so `resolveAdapter()` throws
 * `Unknown adapter: undefined` and a hand-built URL dereferences a missing `baseUrl`. Use
 * `selectProactiveApiKeyTransport`, the pre-dispatch twin of `rotateProviderTransportOn429`.
 */
export function selectProactiveApiKey(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
): OcxProviderConfig | null {
  const provider = config.providers?.[providerName];
  if (!provider) return null;
  const strategy = provider.apiKeyPoolStrategy;
  if (!hasKeyPoolFailover(provider)) return null;
  const pool = provider.apiKeyPool ?? [];

  const activeEntry = pool.find(entry => entry.key === provider.apiKey);
  const activeHealthy = activeEntry && !isKeyInCooldown(providerName, activeEntry.id, now);

  // Round-robin is per-request load distribution, not failover: advance on every request
  // while the committed key is healthy. A cooled committed key falls through to the shared
  // recovery-flavoured branch below, which persists the move like any other rotation.
  if (strategy === "round-robin" && activeHealthy) {
    const rotated = nextRoundRobinKey(providerName, pool, provider.apiKey, now);
    // No healthy alternative (single eligible key, or everything else cooling): stay put.
    if (!rotated) return null;
    // The committed key's own turn is returned too, stamped exactly as the committed row would
    // be, so every request in the cycle carries a stamp naming the key it sends.
    return buildRoundRobinRow(provider, rotated);
  }

  // A healthy committed key wins, whether the operator chose it or a previous rotation did.
  if (activeHealthy) return null;

  const eligible = pool.filter(entry => !isKeyInCooldown(providerName, entry.id, now));
  if (eligible.length === 0) return null;

  let chosen = eligible[0]!;
  if (strategy === "round-robin") {
    const lastId = keyRotationCursor.get(providerName);
    const lastIndex = lastId ? pool.findIndex(entry => entry.id === lastId) : -1;
    for (let offset = 1; offset <= pool.length; offset += 1) {
      const candidate = pool[(lastIndex + offset) % pool.length]!;
      if (isKeyInCooldown(providerName, candidate.id, now)) continue;
      chosen = candidate;
      break;
    }
  } else if (strategy === "quota") {
    // else-if, deliberately. `fill-first` is not a named branch here -- it is the eligible[0]
    // default above, so replacing that default would silently retarget it.
    chosen = rankKeysByHeadroom(providerName, provider, eligible)[0] ?? chosen;
  }
  if (chosen.key === provider.apiKey) return null;

  const outcome = commitProviderApiKeySelection<string | null>(config, providerName, freshProvider => {
    const freshPool = freshProvider.apiKeyPool ?? [];
    const target = freshPool.find(entry => entry.id === chosen.id);
    if (!target) return { changed: false, value: null };
    if (freshProvider.apiKey === target.key) return { changed: false, value: null };
    const freshActive = freshPool.find(entry => entry.key === freshProvider.apiKey);
    // Re-check under the lock: a concurrent manual selection may have landed a healthy key.
    if (freshActive && !isKeyInCooldown(providerName, freshActive.id, now)) {
      return { changed: false, value: null };
    }
    freshProvider.apiKey = target.key;
    return { changed: true, value: target.id };
  });
  if (outcome.status !== "committed" || outcome.value === null) return null;

  keyRotationCursor.set(providerName, outcome.value);
  const committed = structuredClone(outcome.provider);
  config.providers[providerName] = committed;
  return structuredClone(committed);
}

/**
 * Pre-dispatch twin of `rotateProviderTransportOn429`: pick a warm key, then rebuild the
 * active route from the committed row through the same seam the 429 path uses, so the
 * registry backfills survive and only explicit runtime transport state (`fetch` and a
 * generated OpenCode session header) is carried over from the route being replaced.
 *
 * Every request path that assigns the result to a live route must call THIS, not
 * `selectProactiveApiKey`, which answers with a persisted snapshot.
 */
export function selectProactiveApiKeyTransport(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  promptCacheKey?: string,
  now = Date.now(),
): OcxProviderTransport | null {
  const committed = selectProactiveApiKey(config, providerName, now);
  if (!committed) return null;
  return applyRotatedTransport(providerName, routedProvider, committed, promptCacheKey);
}

/**
 * Normalize a provider's `retryOn429` policy, or return null when the knob is absent,
 * explicitly disabled, or the provider is not key-auth (OAuth/forward credentials must not be
 * replayed on the same token, forward passthrough never reaches the recovery loop anyway, and
 * local runtimes have no remote key to preserve). The returned policy is fully defaulted so
 * callers never re-check fields.
 */
export function rateLimitRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "retryOn429" | "authMode">,
): Required<RateLimitRetryPolicy> | null {
  const policy = provider.retryOn429;
  if (!policy || policy.enabled === false) return null;
  // Fail closed: only explicit key auth or the documented omitted-default (undefined == key for
  // custom API-key providers) may use same-key replays. OAuth/forward are never replayed on the
  // same token, local runtimes have no remote key to preserve, and unknown/custom values are
  // rejected rather than guessed at.
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_RATE_LIMIT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_RATE_LIMIT_RETRY.attempts,
    intervalMs: policy.intervalMs ?? DEFAULT_RATE_LIMIT_RETRY.intervalMs,
    maxIntervalMs: policy.maxIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY.maxIntervalMs,
    respectRetryAfter: policy.respectRetryAfter ?? DEFAULT_RATE_LIMIT_RETRY.respectRetryAfter,
  };
}

/**
 * Normalize a provider's `transientRetryOn5xx` policy, or return null when it is absent,
 * explicitly disabled, not key-auth, or not the `openai-chat` adapter.
 *
 * The adapter gate is part of the accepted scope, not incidental: this first version covers
 * key-auth `openai-chat` only, and without an explicit check any generic key-auth adapter
 * could opt in. Auth mode follows the same fail-closed rule as `rateLimitRetryPolicyFor` —
 * explicit `key` or the documented omitted default, never OAuth, forward, local, or an
 * unknown value.
 */
export function transientRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "transientRetryOn5xx" | "authMode" | "adapter">,
): Required<TransientRetryPolicy> | null {
  const policy = provider.transientRetryOn5xx;
  if (!policy || policy.enabled === false) return null;
  if (provider.adapter !== "openai-chat") return null;
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_TRANSIENT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_TRANSIENT_RETRY.attempts,
  };
}

/**
 * Wait before the next same-target replay: upstream Retry-After (seconds or HTTP-date) when
 * `respectRetryAfter` is on and the header parses, capped at `maxIntervalMs`; otherwise the
 * fixed `intervalMs`, also capped at `maxIntervalMs` (a single wait never exceeds the cap).
 * Malformed headers fall back to the fixed interval.
 */
export function rateLimitRetryDelayMs(
  policy: Required<RateLimitRetryPolicy>,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number {
  const raw = retryAfterHeader?.trim();
  if (policy.respectRetryAfter && raw) {
    const parsed = parseRetryAfterMs(raw, now);
    if (parsed !== undefined) return Math.min(parsed, policy.maxIntervalMs);
  }
  return Math.min(policy.intervalMs, policy.maxIntervalMs);
}

/**
 * Record a key-scoped failure for the key that was actually sent and pick the key the SAME
 * request should retry on.
 *
 * - The failed key is the attempt's own selection stamp (`attemptedSelection`, which a
 *   round-robin pick stamps with the entry it picked), else `attemptedKey`, else the committed
 *   key. That key is cooled -- `failure` decides for how long -- whenever the persisted row
 *   could be read, including when a newer manual selection superseded this attempt, unless that
 *   newer selection deliberately points at the very same key again.
 * - The retry key is the committed key when it is healthy and is not the one that failed
 *   (a round-robin pick failed while the committed key is fine: no persisted move). Otherwise
 *   the committed key is moved to the next healthy pool entry after the failed one and
 *   persisted, so the NEXT request ("continue") lands on a healthy key too.
 *
 * @returns A new OcxProviderConfig carrying the retry key, or `null` when no other key is
 *          available (every other key cooling, pool < 2, or persistence unavailable). Callers
 *          then return the real upstream answer: there is no synthetic refusal and no loop,
 *          because every call cools one more key.
 *
 * The returned object is a snapshot of the PERSISTED config — it carries none of the
 * registry backfills `routedProviderConfig` merges in at request time. Request paths must
 * not assign it to an active route wholesale; use `rotateProviderTransportOnKeyFailure` (or
 * its 429/401 twins), which rebuild from this committed row, reapply registry metadata, and
 * retain only explicit runtime transport state (`fetch` and generated OpenCode session
 * affinity).
 */
function rotateKeyAfterFailure(
  config: OcxConfig,
  providerName: string,
  failure: KeyScopedFailureClass,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return null;

  const failedKey = attemptedSelection?.reference ?? attemptedKey ?? provider.apiKey;
  const findFailed = (pool: readonly ApiKeyPoolEntry[]): ApiKeyPoolEntry | undefined =>
    attemptedSelection?.entryId
      ? pool.find(entry => entry.id === attemptedSelection.entryId && entry.key === failedKey)
      : pool.find(entry => entry.key === failedKey);
  type Rotation =
    | { failedId?: string; retryId: string; moved: boolean }
    | { exhaustedCount: number; failedId?: string };
  const outcome = commitProviderApiKeySelection<Rotation | null>(config, providerName, freshProvider => {
    const pool = freshProvider.apiKeyPool;
    if (!pool || pool.length < 2) return { changed: false, value: null };

    // The callback can be rerun after rebasing, so identify the failed key here but
    // defer the in-memory cooldown side effect until persistence has succeeded.
    const failedEntry = findFailed(pool);
    const usable = (entry: ApiKeyPoolEntry): boolean =>
      entry.key !== failedKey && !isKeyInCooldown(providerName, entry.id, now);

    if (freshProvider.apiKey !== failedKey) {
      const activeEntry = pool.find(entry => entry.key === freshProvider.apiKey);
      if (activeEntry && usable(activeEntry)) {
        return {
          changed: false,
          value: { failedId: failedEntry?.id, retryId: activeEntry.id, moved: false },
        };
      }
    }

    const currentIndex = failedEntry ? pool.indexOf(failedEntry) : -1;
    const candidateCount = failedEntry ? pool.length - 1 : pool.length;
    for (let offset = 1; offset <= candidateCount; offset += 1) {
      const candidate = pool[(currentIndex + offset) % pool.length]!;
      if (!usable(candidate)) continue;
      freshProvider.apiKey = candidate.key;
      return {
        changed: true,
        value: { failedId: failedEntry?.id, retryId: candidate.id, moved: true },
      };
    }
    return { changed: false, value: { exhaustedCount: pool.length, failedId: failedEntry?.id } };
  }, attemptedSelection);
  if (outcome.status === "unavailable") return null;
  if (outcome.status === "superseded") {
    // A newer manual selection (including A→B→A) owns subsequent dispatch. Reusing the
    // same failed key here would loop forever; preserve its original failure instead.
    // The failed key is still cooled -- it really did fail -- unless the operator's newer
    // selection points at it again, in which case that explicit choice is not second-guessed.
    if (outcome.provider.apiKey === failedKey) return null;
    const failedEntry = findFailed(outcome.provider.apiKeyPool ?? []);
    if (failedEntry) coolKey(providerName, failedEntry.id, failure, retryAfterHeader, now);
    return structuredClone(outcome.provider);
  }
  if (outcome.value === null) return null;
  if (outcome.value.failedId) {
    coolKey(providerName, outcome.value.failedId, failure, retryAfterHeader, now);
  }
  if ("exhaustedCount" in outcome.value) {
    console.warn(`[key-failover] ${providerName}: all ${outcome.value.exhaustedCount} keys in cooldown after a ${failure} verdict; returning the upstream status to the client`);
    return null;
  }

  const committed = structuredClone(outcome.provider);
  config.providers[providerName] = committed;
  console.warn(
    // Log ids only — labels are user-supplied free text and could carry secret material.
    outcome.value.moved
      ? `[key-failover] ${providerName}: ${failure} verdict on key ${outcome.value.failedId ?? "?"}; rotating to key ${outcome.value.retryId}`
      : `[key-failover] ${providerName}: ${failure} verdict on key ${outcome.value.failedId ?? "?"}; retrying on committed key ${outcome.value.retryId}`,
  );
  return structuredClone(committed);
}

export function rotateKeyOn429(
  config: OcxConfig,
  providerName: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, "rate", retryAfterHeader, now, attemptedKey, attemptedSelection);
}

/**
 * Record a 401 for the current key and attempt to switch to the next available one.
 *
 * A static key pool can recover a credential-scoped 401 without abandoning the provider: one
 * revoked or mistyped key in a pool of several says nothing about its siblings. OAuth and
 * forward providers never reach here — they refresh or re-authenticate instead, and
 * `rotateKeyAfterFailure` rejects both auth modes outright.
 */
export function rotateKeyOn401(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  attemptedKey?: string,
  attemptedSelection?: ProviderApiKeySelection,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, "auth", null, now, attemptedKey, attemptedSelection);
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    removed += 1;
  }
  return removed;
}

interface RotateProviderTransportOptions {
  retryAfter?: string | null;
  now?: number;
  attemptedKey?: string;
  attemptedSelection?: ProviderApiKeySelection;
  promptCacheKey?: string;
}

/**
 * Rotate a failed key and re-apply provider-specific transport metadata to the replacement.
 *
 * Route the authoritative committed row again so concurrent provider edits take effect, then
 * restore only transport-only state that can never come from persisted configuration.
 */
export function rotateProviderTransportOn429(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn429(
    config,
    providerName,
    options.retryAfter,
    options.now,
    options.attemptedKey,
    options.attemptedSelection ?? routedProvider._apiKeyAttempt,
  );
  if (!rotated) return null;
  return applyRotatedTransport(providerName, routedProvider, rotated, options.promptCacheKey);
}

/** 401 counterpart of `rotateProviderTransportOn429`; shares its transport-rebuild rules. */
export function rotateProviderTransportOn401(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: Omit<RotateProviderTransportOptions, "retryAfter"> = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn401(config, providerName, options.now, options.attemptedKey,
    options.attemptedSelection ?? routedProvider._apiKeyAttempt);
  if (!rotated) return null;
  return applyRotatedTransport(providerName, routedProvider, rotated, options.promptCacheKey);
}

function applyRotatedTransport(
  providerName: string,
  routedProvider: OcxProviderTransport,
  rotated: OcxProviderConfig,
  promptCacheKey?: string,
): OcxProviderTransport {
  const committedRoute = routedProviderConfig(providerName, rotated);
  const routedSession = routedProvider.headers?.[OPENCODE_GO_SESSION_HEADER];
  const retryProvider: OcxProviderTransport = {
    ...committedRoute,
    ...(routedProvider.fetch !== undefined ? { fetch: routedProvider.fetch } : {}),
    ...(routedSession !== undefined
      ? {
          headers: {
            ...(committedRoute.headers ?? {}),
            [OPENCODE_GO_SESSION_HEADER]: routedSession,
          },
        }
      : {}),
  };
  return resolveProviderTransport(providerName, retryProvider, promptCacheKey);
}

/** Clear cooldown state for a provider (e.g. after manual key management). */
export function clearKeyCooldowns(providerName?: string): void {
  if (!providerName) {
    keyCooldowns.clear();
    return;
  }
  const prefix = `${providerName}\0`;
  for (const key of keyCooldowns.keys()) {
    if (key.startsWith(prefix)) keyCooldowns.delete(key);
  }
}

/**
 * Any-class counterpart of `rotateProviderTransportOn429`: cool the key the route actually sent
 * for a key-scoped verdict of class `failure` and rebuild the route on the retry key.
 *
 * Every wire's pre-stream recovery loop (translated adapters, native Chat, Responses
 * passthrough, the terminal-guard continuation) calls this with the class from
 * `classifyKeyScopedResponse`, so a 402 or a billing 403 moves to the next key exactly the way a
 * 429 does. Callers that cannot afford the replay (request budget spent) may still call it for
 * its bookkeeping and drop the result: the cooldown and the persisted move are what keep the
 * NEXT request off the dead key.
 */
export function rotateProviderTransportOnKeyFailure(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  failure: KeyScopedFailureClass,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyAfterFailure(
    config,
    providerName,
    failure,
    options.retryAfter,
    options.now,
    options.attemptedKey,
    options.attemptedSelection ?? routedProvider._apiKeyAttempt,
  );
  if (!rotated) return null;
  return applyRotatedTransport(providerName, routedProvider, rotated, options.promptCacheKey);
}

/**
 * True when the provider is a static key pool with at least one key outside its cooldown.
 *
 * The combo layer reads this after a key-scoped failure: the request path has already cooled
 * the key it sent and moved the committed selection, so a pool with a healthy key left is still
 * a working target and must not be blackholed for the combo's cooldown window. Mirrors the
 * OAuth side's `eligibleFailoverAccounts(...).length > 0`.
 */
export function hasHealthyApiKeySpare(config: OcxConfig, providerName: string, now = Date.now()): boolean {
  const provider = config.providers?.[providerName];
  if (!provider || provider.disabled || !hasKeyPoolFailover(provider)) return false;
  return (provider.apiKeyPool ?? []).some(entry => !isKeyInCooldown(providerName, entry.id, now));
}

/** Visible-for-testing: get the cooldown-until timestamp for a key. */
export function getKeyCooldownUntil(providerName: string, keyId: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, keyId));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}
