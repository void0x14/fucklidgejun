import { beforeEach, describe, expect, test } from "bun:test";

import {
  clearConversationOversizeForTests,
  clearRequestLogsForTests,
  conversationOverflowedInput,
  measuredConversationInput,
  recordConversationOversize,
} from "../../src/server/request-log";
import { normalizeLogConversationId } from "../../src/server/request-log-conversation";
import { applyMeasuredAutoCompactTrigger, type RawEntry } from "../../src/codex/catalog/parsing";

const CEILING = 1_000_000;

function oversize(
  conversationIds: readonly string[],
  estimatedTokens: number,
  ceiling = CEILING,
): void {
  recordConversationOversize({
    conversationIds,
    estimatedTokens,
    ceiling,
    model: "deepseek-v4.1-flash",
    provider: "workbuddy",
  });
}

describe("locally decided conversation oversize", () => {
  beforeEach(() => {
    clearRequestLogsForTests();
  });

  test("an oversized body reads as overflowed without any provider verdict", () => {
    // The gap: this conversation's turns fail with a 5xx, so no row ever carries an overflow code
    // and the provider never names the wall. The proxy's own measurement of the body it received
    // is the only evidence there is, and it has to be enough.
    oversize(["thread-oversized"], CEILING + 1);
    expect(conversationOverflowedInput(["thread-oversized"])).toEqual({
      inputTokens: 0,
      model: "deepseek-v4.1-flash",
      provider: "workbuddy",
    });
  });

  test("a body that fits the ceiling is not an oversize record", () => {
    oversize(["thread-fits"], CEILING - 1);
    expect(conversationOverflowedInput(["thread-fits"])).toBeUndefined();

    // The boundary is strict: equal to the ceiling still fits, so nothing is recorded.
    oversize(["thread-exact"], CEILING);
    expect(conversationOverflowedInput(["thread-exact"])).toBeUndefined();
  });

  test("entries are per conversation", () => {
    oversize(["thread-a"], CEILING + 5_000);
    oversize(["thread-b"], 10);

    expect(conversationOverflowedInput(["thread-a"])).toBeDefined();
    expect(conversationOverflowedInput(["thread-b"])).toBeUndefined();
    // A turn carries several candidate ids; any one of them is enough to match.
    expect(conversationOverflowedInput(["session-unrelated", "thread-a"])).toBeDefined();
    expect(conversationOverflowedInput(["session-unrelated"])).toBeUndefined();
  });

  test("the raw header id and the persisted digest are the same conversation", () => {
    const raw = "0199c0de-thread-raw";
    const digest = normalizeLogConversationId(raw)!;
    expect(digest).not.toBe(raw);

    // Recorded from the request (raw header value), read back by the digest /api/logs shows. The
    // map stores the digest — a client-controlled session id must not sit in process state in the
    // clear — and `matchesLogConversationId` hashes the query, so both forms resolve.
    oversize([raw], CEILING + 1);
    expect(conversationOverflowedInput([raw])).toBeDefined();
    expect(conversationOverflowedInput([digest])).toBeDefined();
  });

  test("a local verdict never reports an estimated input as a measurement", () => {
    // The trigger's VALUE must still come from the last successful row, which is a real
    // measurement. An estimate reported as `inputTokens` would be a fabricated measurement.
    oversize(["thread-estimate"], 4_000_000);
    expect(conversationOverflowedInput(["thread-estimate"])?.inputTokens).toBe(0);
    expect(measuredConversationInput(["thread-estimate"])).toBeUndefined();
  });

  test("no candidate, no verdict", () => {
    oversize(["thread-empty"], CEILING + 1);
    expect(conversationOverflowedInput([])).toBeUndefined();
  });

  test("a non-finite or unusable measurement records nothing", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      oversize(["thread-nan"], bad);
      expect(conversationOverflowedInput(["thread-nan"])).toBeUndefined();
    }
    oversize(["thread-nan"], CEILING + 1, Number.NaN);
    expect(conversationOverflowedInput(["thread-nan"])).toBeUndefined();
  });

  test("clearing the verdict forgets it", () => {
    oversize(["thread-cleared"], CEILING + 1);
    expect(conversationOverflowedInput(["thread-cleared"])).toBeDefined();
    clearConversationOversizeForTests();
    expect(conversationOverflowedInput(["thread-cleared"])).toBeUndefined();
  });

  test("the local verdict is what lowers the auto-compact trigger to the measured input", () => {
    // Case D through the LOCAL path: last success measured 321,539, then every turn failed with a
    // 5xx. 321,539 + 40% of 1,000,000 is short of the ceiling, so the headroom check would keep the
    // 70% default; the local oversize verdict is what skips the headroom instead.
    const measured = { inputTokens: 321_539, model: "deepseek-v4.1-flash", provider: "workbuddy" };
    const row = (): RawEntry => ({
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: CEILING,
      max_context_window: CEILING,
      auto_compact_token_limit: 700_000,
    });

    const withoutVerdict = row();
    applyMeasuredAutoCompactTrigger([withoutVerdict], measured);
    expect(withoutVerdict.auto_compact_token_limit).toBe(700_000);

    oversize(["thread-failing"], CEILING + 250_000);
    const overflowed = conversationOverflowedInput(["thread-failing"]) !== undefined;
    expect(overflowed).toBe(true);

    const withVerdict = row();
    applyMeasuredAutoCompactTrigger([withVerdict], { ...measured, overflowed });
    expect(withVerdict.auto_compact_token_limit).toBe(321_539);
  });
});
