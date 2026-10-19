import { describe, expect, test } from "bun:test";

import {
  AUTO_COMPACT_TURN_HEADROOM_SHARE,
  clampAutoCompactTokenLimit,
  measuredAutoCompactTokenLimit,
  modelAutoCompactTokenLimitsConfigError,
} from "../../src/providers/auto-compact-budget";
import { applyMeasuredAutoCompactTrigger, type RawEntry } from "../../src/codex/catalog/parsing";

describe("per-model auto-compaction budgets", () => {
  test("configuration only lowers the effective hard-limit envelope", () => {
    expect(clampAutoCompactTokenLimit(1_000)).toBe(700);
    expect(clampAutoCompactTokenLimit(1_000, 500)).toBe(500);
    expect(clampAutoCompactTokenLimit(1_000, 800, 600)).toBe(600);
    // A ceiling or a configured value ABOVE the 70% envelope cannot lift it back to 90%.
    expect(clampAutoCompactTokenLimit(1_000, 800)).toBe(700);
    expect(clampAutoCompactTokenLimit(1_000, 800, 5_000)).toBe(700);
  });

  test("one validation contract handles config, native ids, and PATCH tombstones", () => {
    expect(modelAutoCompactTokenLimitsConfigError({ model: 64_000 })).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { "gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(
      { model: null },
      { allowTombstones: true },
    )).toBeNull();
    expect(modelAutoCompactTokenLimitsConfigError(null, { allowTombstones: true })).toBeNull();

    for (const invalid of [
      null,
      [],
      { model: 0 },
      { model: 1.5 },
      { model: Number.MAX_SAFE_INTEGER + 1 },
      { model: null },
      JSON.parse('{"__proto__": 1000}'),
      { constructor: 1000 },
      Object.create({ inherited: 1000 }),
    ]) {
      expect(modelAutoCompactTokenLimitsConfigError(invalid)).not.toBeNull();
    }
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": 64_000 },
      { requireNativeIds: true },
    )).toContain("exact supported native model id");
    expect(modelAutoCompactTokenLimitsConfigError(
      { "team/gpt-5.6-sol": null },
      { allowTombstones: true, requireNativeIds: true },
    )).toContain("exact supported native model id");
  });

  test("validation errors redact secret-shaped model ids", () => {
    const secret = "api_key=sk-secret-provider-key";
    const error = modelAutoCompactTokenLimitsConfigError({ [secret]: 0 });
    expect(error).toContain("[REDACTED]");
    expect(error).not.toContain("sk-secret-provider-key");
  });
});

describe("measured auto-compaction trigger", () => {
  test("one turn's headroom decides whether the measured input becomes the trigger", () => {
    expect(AUTO_COMPACT_TURN_HEADROOM_SHARE).toBe(0.4);
    // Case A — the measured turn that overflowed: 663,534 of a 1,000,000 window is 66%, so the
    // static envelope reads "not yet", but the next turn would no longer fit.
    expect(measuredAutoCompactTokenLimit(1_000_000, 663_534)).toBe(663_534);
    // Case B — a third of the window leaves room for several more turns: the static envelope
    // stays in charge and no measured trigger is advertised.
    expect(measuredAutoCompactTokenLimit(1_000_000, 300_000)).toBeUndefined();
    // The boundary itself is inclusive.
    expect(measuredAutoCompactTokenLimit(1_000_000, 600_000)).toBe(600_000);
    expect(measuredAutoCompactTokenLimit(1_000_000, 599_999)).toBeUndefined();
  });

  test("a measured input never becomes a trigger for a row it does not fit", () => {
    expect(measuredAutoCompactTokenLimit(0, 663_534)).toBeUndefined();
    expect(measuredAutoCompactTokenLimit(1_000_000, 0)).toBeUndefined();
    expect(measuredAutoCompactTokenLimit(1_000_000, -1)).toBeUndefined();
    expect(measuredAutoCompactTokenLimit(1_000_000, 1.5)).toBeUndefined();
    expect(measuredAutoCompactTokenLimit(Number.NaN, 663_534)).toBeUndefined();
  });

  test("Case C — entry application lowers the row and never raises it", () => {
    const measured = { inputTokens: 663_534, model: "deepseek-v4.1-flash", provider: "workbuddy" };
    const row = (slug: string, limit?: number): RawEntry => ({
      slug,
      context_window: 950_000,
      max_context_window: 950_000,
      ...(limit === undefined ? {} : { auto_compact_token_limit: limit }),
    });
    const lowered = row("workbuddy/deepseek-v4.1-flash", 665_000);
    const alreadyLower = row("workbuddy/deepseek-v4.1-flash", 100_000);
    const unset = row("workbuddy/deepseek-v4.1-flash");
    const unrelated = row("workbuddy/other-model", 665_000);

    applyMeasuredAutoCompactTrigger([lowered, alreadyLower, unset, unrelated], measured);
    expect(lowered.auto_compact_token_limit).toBe(663_534);
    // A threshold config or the catalog already lowered further stays where it is.
    expect(alreadyLower.auto_compact_token_limit).toBe(100_000);
    expect(unset.auto_compact_token_limit).toBe(663_534);
    expect(unrelated.auto_compact_token_limit).toBe(665_000);
  });

  test("the ceiling is the row's own advertised window, and a distant input changes nothing", () => {
    const measured = { inputTokens: 663_534, model: "deepseek-v4.1-flash", provider: "workbuddy" };
    // A row whose own window sits below the measurement keeps its lower threshold: the trigger
    // only ever moves down.
    const narrow: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 190_400,
    };
    applyMeasuredAutoCompactTrigger([narrow], measured);
    expect(narrow.auto_compact_token_limit).toBe(190_400);

    // The larger of the two advertised windows is the ceiling: a third of 1,000,000 still fits.
    const wide: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 950_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 700_000,
    };
    applyMeasuredAutoCompactTrigger([wide], { ...measured, inputTokens: 300_000 });
    expect(wide.auto_compact_token_limit).toBe(700_000);

    // No measured conversation: the catalog is returned exactly as it was.
    const untouched: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 950_000,
      max_context_window: 950_000,
      auto_compact_token_limit: 665_000,
    };
    applyMeasuredAutoCompactTrigger([untouched], undefined);
    expect(untouched.auto_compact_token_limit).toBe(665_000);
  });

  test("Case D — a context-overflow failure lowers the trigger to the last measured input", () => {
    // The real case: last success measured 321,539, then every turn failed with
    // prompt_too_long. 321,539 + 40% of 1,000,000 is 721,539, short of the ceiling, so the
    // headroom check would keep the 70% default and compaction would never fire — while the
    // provider keeps refusing every turn. The refusal IS the proof that 321,539 is already at
    // the ceiling, so it becomes the trigger.
    const overflowed = {
      inputTokens: 321_539,
      model: "deepseek-v4.1-flash",
      provider: "workbuddy",
      overflowed: true,
    };
    const atDefault: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 700_000,
    };
    applyMeasuredAutoCompactTrigger([atDefault], overflowed);
    expect(atDefault.auto_compact_token_limit).toBe(321_539);

    // Still a lower-only move: a config or catalog already below the measurement wins.
    const alreadyLower: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 200_000,
    };
    applyMeasuredAutoCompactTrigger([alreadyLower], overflowed);
    expect(alreadyLower.auto_compact_token_limit).toBe(200_000);
  });

  test("Case E — without an overflow the same measurement keeps the static envelope", () => {
    // Same conversation, same 321,539, no refused turn: the next turn still fits with room to
    // spare, so the 70% default stays and the measured input is not advertised.
    const measured = { inputTokens: 321_539, model: "deepseek-v4.1-flash", provider: "workbuddy" };
    const atDefault: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 700_000,
    };
    applyMeasuredAutoCompactTrigger([atDefault], measured);
    expect(atDefault.auto_compact_token_limit).toBe(700_000);

    // An explicit false is the same as absent: the flag has to be set to skip the headroom.
    const explicitFalse: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 700_000,
    };
    applyMeasuredAutoCompactTrigger([explicitFalse], { ...measured, overflowed: false });
    expect(explicitFalse.auto_compact_token_limit).toBe(700_000);

    // The overflow flag cannot invent a trigger out of a non-measurement.
    const noMeasurement: RawEntry = {
      slug: "workbuddy/deepseek-v4.1-flash",
      context_window: 1_000_000,
      max_context_window: 1_000_000,
      auto_compact_token_limit: 700_000,
    };
    applyMeasuredAutoCompactTrigger([noMeasurement], { ...measured, inputTokens: 0, overflowed: true });
    expect(noMeasurement.auto_compact_token_limit).toBe(700_000);
  });
});
