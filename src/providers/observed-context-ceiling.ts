/**
 * The context ceiling a provider has actually enforced, learned from its own refusal.
 *
 * Every ceiling this proxy knows about comes from configuration or from the catalog, and both are
 * frequently optimistic. Verified 2026-10-14 on `workbuddy` / `global:deepseek-v4.1-flash`:
 * `modelContextWindows` declared 1,000,000 and the catalog advertised a 700,000 auto-compact
 * trigger, a 313,021-token turn was answered normally — and the compaction turn was then refused
 * with `prompt is too long: 100001 tokens > 100000 maximum`. The real ceiling for that request
 * shape was 100,000, an order of magnitude below every number held anywhere in the process, and
 * nothing in `src/` contained that number: it existed only in the provider's error text.
 *
 * So the refusal is the measurement. `parseStatedContextMaximum` (src/lib/errors.ts) reads the
 * maximum out of it, this module remembers it per routed model, and every consumer of a resolved
 * ceiling narrows through `narrowCeilingToObserved`. Two invariants make that safe:
 *
 *   - LOWER WINS. An observation may only move a ceiling down, never up. A provider that later
 *     raises its limit is not detectable from an error message, so the catalog keeps that job.
 *   - NO CONTENT CHANGE. Nothing here truncates, summarises or drops request content. The only
 *     thing an observation changes is the number the proxy compares against.
 */
import { slugEquivalenceKey } from "./slug-codec";

/**
 * Process lifetime, bounded like every other map keyed by a provider-controlled identity.
 *
 * The request-log ring it is learned from is capped at MAX_LOG_SIZE (2000 rows), so an unbounded
 * map here would be a leak. 1024 routed models is far more than any deployment routes to.
 */
const observedCeilings = new Map<string, number>();
const MAX_OBSERVED_CEILINGS = 1024;

/**
 * One key per routed model, tolerant of the raw/encoded mix the rest of the codebase already
 * accepts: `slugEquivalenceKey` is the exact relation the catalog and config use to match a
 * stored slug against `provider/model`, so an observation recorded from a route identity and read
 * back from a catalog slug land on the same entry.
 */
function ceilingKey(provider: string, model: string): string | undefined {
  if (typeof provider !== "string" || !provider) return undefined;
  if (typeof model !== "string" || !model) return undefined;
  return slugEquivalenceKey(`${provider}/${model}`);
}

/**
 * Remember the ceiling a provider enforced for one routed model.
 *
 * Called from the request-log finalizer, where the failed turn's routed identity and its upstream
 * message are both still in hand. Only a plausible positive integer is stored, and a later
 * observation can only lower the recorded value — the first refusal already proved the ceiling is
 * at most that number, so a bigger one from a later request is not evidence that it grew.
 */
export function recordObservedContextCeiling(input: {
  provider: string;
  model: string;
  ceiling: number;
}): void {
  const key = ceilingKey(input.provider, input.model);
  if (key === undefined) return;
  if (!Number.isSafeInteger(input.ceiling) || input.ceiling <= 0) return;
  const existing = observedCeilings.get(key);
  if (existing !== undefined && existing <= input.ceiling) return;
  if (existing === undefined && observedCeilings.size >= MAX_OBSERVED_CEILINGS) {
    const oldest = observedCeilings.keys().next();
    if (!oldest.done) observedCeilings.delete(oldest.value);
  }
  // Re-inserting an existing key keeps its original insertion order, so eviction stays oldest-first.
  observedCeilings.set(key, input.ceiling);
}

/** The ceiling a provider has enforced for this routed model, or undefined when never observed. */
export function observedContextCeiling(provider: string, model: string): number | undefined {
  const key = ceilingKey(provider, model);
  return key === undefined ? undefined : observedCeilings.get(key);
}

/**
 * The same lookup from a Codex-facing routed slug (`<provider>/<encoded id>`).
 *
 * Only routed slugs are accepted: a bare native slug carries no provider, and guessing one would
 * key an observation to a provider that never made it. A native row keeps its catalog ceiling.
 */
export function observedContextCeilingForSlug(slug: string): number | undefined {
  if (typeof slug !== "string") return undefined;
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) return undefined;
  return observedCeilings.get(slugEquivalenceKey(slug));
}

/**
 * Narrow a catalog/config ceiling to what the provider has actually enforced.
 *
 * The observation wins only when it is LOWER; `null` (nothing resolved) stays `null` rather than
 * becoming a ceiling, so the fail-open path keeps failing open.
 */
export function narrowCeilingToObserved(
  ceiling: number | null,
  provider: string,
  model: string,
): number | null {
  const observed = observedContextCeiling(provider, model);
  if (observed === undefined) return ceiling;
  return ceiling === null ? observed : Math.min(ceiling, observed);
}

/** Test-only process-state reset for isolated harnesses. */
export function clearObservedContextCeilingsForTests(): void {
  observedCeilings.clear();
}
