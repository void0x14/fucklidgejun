/**
 * Same-target 429 race.
 *
 * A 429 is a statement about a moment, not about the request: the same built request sent a
 * few milliseconds later, or a few times in parallel, is frequently served. Waiting for it is
 * the expensive part -- the client's turn is parked for the upstream's stated interval -- so
 * this replaces the wait-and-replay shape with a bounded fan-out: fire several identical
 * sends of the SAME request at the SAME target and keep the first answer that is not a 429.
 *
 * Deliberately not in scope here: key rotation, provider change, backoff, and body rewriting.
 * The request is replayed byte-identically, so the race is only legal pre-stream, before any
 * client bytes have been relayed.
 *
 * Bounds, all hard:
 *   - `SAME_TARGET_429_RACERS_PER_WAVE` concurrent re-sends per wave,
 *   - launched `SAME_TARGET_429_STAGGER_MS` apart so they do not reach the socket at the same
 *     instant,
 *   - at most `SAME_TARGET_429_WAVES` waves, so one request can never exceed
 *     1 initial + 12 x 10 = 121 sends from this unit.
 *
 * The wave cap is the ONLY bound. The per-request send budget is deliberately not consulted by
 * the racers and a budget refusal does not end the race: a 429 must not reach the client, and a
 * leg the budget declines is noise the remaining racers answer for, exactly like a transport
 * failure. The wave cap still bounds the unit, so the ceiling stays 1 initial + 12 x 10 = 121.
 */
import { sleepWithAbort } from "../../lib/upstream-retry";

/** Concurrent identical re-sends in one wave. */
export const SAME_TARGET_429_RACERS_PER_WAVE = 12;
/** Launch offset between two racers of the same wave. */
export const SAME_TARGET_429_STAGGER_MS = 20;
/** Waves one request may run before the last 429 is returned. */
export const SAME_TARGET_429_WAVES = 10;

/**
 * What one racer produced.
 *
 * `refused` is kept as a distinct outcome so the racer senders can still report WHY a leg made
 * no request, but it is handled exactly like `failed`: ignored. Neither a budget refusal nor a
 * transport failure is this request's answer, so the remaining racers keep answering.
 */
export type SameTarget429LegOutcome =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "refused" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed" };

export interface SameTarget429RaceOptions {
  /** The 429 the first attempt already produced. Returned verbatim when no racer may send. */
  readonly initial: Response;
  /**
   * One physical send of the identical built request. Must honour `signal`: the race aborts
   * the losers as soon as it has an answer, and that abort has to reach the wire.
   */
  readonly send: (signal: AbortSignal) => Promise<SameTarget429LegOutcome>;
  /** The request's own signal; a client cancel propagates into every leg. */
  readonly signal: AbortSignal;
}

export interface SameTarget429RaceResult {
  /** The first non-429 answer, else the last 429 observed. */
  readonly response: Response;
  /** Physical sends this race started, excluding the initial attempt. */
  readonly sends: number;
  /** True when the caller cancelled before the waves ran out. */
  readonly stopped: boolean;
}

/**
 * Best-effort body release. A discarded racer holds an unread body, and an unread body holds a
 * socket until the runtime collects it -- one per loser is exactly how a rate-limit storm turns
 * into a connection leak.
 */
function releaseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => {});
  } catch {
    // Already consumed or closed; release is cleanup only.
  }
}

export async function raceSameTarget429(
  options: SameTarget429RaceOptions,
): Promise<SameTarget429RaceResult> {
  const { initial, send, signal } = options;
  if (signal.aborted) return { response: initial, sends: 0, stopped: true };

  /** The answer this unit returns if no racer beats the 429. */
  let last: Response = initial;
  let winner: Response | undefined;
  let sends = 0;
  let stopped = false;

  for (
    let wave = 0;
    wave < SAME_TARGET_429_WAVES && winner === undefined && !stopped;
    wave += 1
  ) {
    if (signal.aborted) {
      stopped = true;
      break;
    }
    // One controller per wave: it carries the caller's cancel inward and lets the winner
    // cancel the legs that are still in flight.
    const race = new AbortController();
    const abortRace = () => race.abort();
    signal.addEventListener("abort", abortRace, { once: true });
    let settled = false;
    let waveLast: Response | undefined;
    const legs: Promise<void>[] = [];
    try {
      for (let index = 0; index < SAME_TARGET_429_RACERS_PER_WAVE; index += 1) {
        legs.push((async () => {
          if (index > 0) {
            // A launch offset, not a wait for the previous answer: every racer is in flight
            // at once, 20 ms apart.
            try {
              await sleepWithAbort(index * SAME_TARGET_429_STAGGER_MS, race.signal);
            } catch {
              return;
            }
          }
          if (settled || stopped || race.signal.aborted) return;
          sends += 1;
          const outcome = await send(race.signal);
          // `refused` and `failed` are both noise: the leg made no answer for this request, and
          // the remaining racers are still allowed to produce one. A 429 must never reach the
          // client just because a leg was declined, so neither ends the race. Only a non-429
          // response, the wave cap, or the caller's abort does.
          if (outcome.kind !== "response") return;
          if (settled) {
            // Lost the race between its response and its turn to be read.
            releaseBody(outcome.response);
            return;
          }
          if (outcome.response.status !== 429) {
            settled = true;
            winner = outcome.response;
            race.abort();
            return;
          }
          // Another 429: keep the newest as the wave's candidate and release the one it
          // replaces, so only one unread body survives per wave.
          if (waveLast !== undefined) releaseBody(waveLast);
          waveLast = outcome.response;
        })().catch(() => {
          // A leg that dies on its own is not this request's answer; the remaining legs and
          // the wave's 429 still stand.
        }));
      }
      await Promise.all(legs);
    } finally {
      signal.removeEventListener("abort", abortRace);
      race.abort();
    }
    if (waveLast !== undefined) {
      if (last !== initial) releaseBody(last);
      last = waveLast;
    }
  }

  const response = winner ?? last;
  if (response !== last) releaseBody(last);
  // The first attempt's body is only worth keeping while it is still the answer.
  if (response !== initial) releaseBody(initial);
  return { response, sends, stopped };
}
