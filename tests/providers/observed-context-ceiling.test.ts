import { afterEach, describe, expect, test } from "bun:test";

import {
  clampAutoCompactTokenLimit,
  measuredAutoCompactTokenLimit,
} from "../../src/providers/auto-compact-budget";
import {
  applyMeasuredAutoCompactTrigger,
  applyObservedAutoCompactTrigger,
  type RawEntry,
} from "../../src/codex/catalog/parsing";
import {
  clearObservedContextCeilingsForTests,
  narrowCeilingToObserved,
  observedContextCeiling,
  observedContextCeilingForSlug,
  recordObservedContextCeiling,
} from "../../src/providers/observed-context-ceiling";
import { resolveInputCeiling } from "../../src/server/responses/input-admission";
import type { OcxProviderConfig } from "../../src/types";

/**
 * The production case, in the numbers it actually happened with: workbuddy declared a 1,000,000
 * window and the catalog advertised a 700,000 auto-compact trigger, a 313,021-token turn was
 * answered normally, and the compaction turn was refused with
 * "prompt is too long: 100001 tokens > 100000 maximum".
 */
const WORKBUDDY_MODEL = "global:deepseek-v4.1-flash";
const CATALOG_WINDOW = 1_000_000;
const CATALOG_TRIGGER = 700_000;
const OBSERVED_CEILING = 100_000;

afterEach(() => clearObservedContextCeilingsForTests());

describe("observed context ceiling store", () => {
  test("remembers the ceiling per provider and per model", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: 100_000 });
    expect(observedContextCeiling("workbuddy", WORKBUDDY_MODEL)).toBe(100_000);
    // A different model on the same provider learns nothing from its neighbour.
    expect(observedContextCeiling("workbuddy", "global:deepseek-v4.1-pro")).toBeUndefined();
    // Neither does the same model on a different provider.
    expect(observedContextCeiling("zenmux", WORKBUDDY_MODEL)).toBeUndefined();
  });

  test("the lower ceiling wins and a later, larger one cannot raise it", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: 100_000 });
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: 200_000 });
    // A bigger number from a later refusal is not evidence the limit grew; the first refusal
    // already proved the ceiling is at most 100,000.
    expect(observedContextCeiling("workbuddy", WORKBUDDY_MODEL)).toBe(100_000);

    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: 64_000 });
    expect(observedContextCeiling("workbuddy", WORKBUDDY_MODEL)).toBe(64_000);
  });

  test("a raw and an encoded slug name the same model", () => {
    recordObservedContextCeiling({ provider: "openrouter", model: "anthropic/claude-sonnet-4", ceiling: 200_000 });
    expect(observedContextCeilingForSlug("openrouter/anthropic-claude-sonnet-4")).toBe(200_000);
    expect(observedContextCeilingForSlug("openrouter/anthropic/claude-sonnet-4")).toBe(200_000);
    // A bare native slug carries no provider, so it can never match an observation.
    expect(observedContextCeilingForSlug("claude-sonnet-4")).toBeUndefined();
  });

  test("an unusable observation is dropped, not stored", () => {
    for (const ceiling of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling });
    }
    expect(observedContextCeiling("workbuddy", WORKBUDDY_MODEL)).toBeUndefined();
    recordObservedContextCeiling({ provider: "", model: WORKBUDDY_MODEL, ceiling: 100_000 });
    recordObservedContextCeiling({ provider: "workbuddy", model: "", ceiling: 100_000 });
    expect(observedContextCeiling("workbuddy", WORKBUDDY_MODEL)).toBeUndefined();
  });

  test("narrowing only ever lowers, and never invents a ceiling from nothing", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    // Catalog above the observation: the observation wins.
    expect(narrowCeilingToObserved(CATALOG_WINDOW, "workbuddy", WORKBUDDY_MODEL)).toBe(OBSERVED_CEILING);
    // Catalog already below it: the catalog stays.
    expect(narrowCeilingToObserved(64_000, "workbuddy", WORKBUDDY_MODEL)).toBe(64_000);
    // Nothing observed for this model: the catalog passes through untouched.
    expect(narrowCeilingToObserved(CATALOG_WINDOW, "workbuddy", "global:other")).toBe(CATALOG_WINDOW);
    expect(narrowCeilingToObserved(null, "workbuddy", "global:other")).toBeNull();
    // A model with a measured ceiling no longer fails open.
    expect(narrowCeilingToObserved(null, "workbuddy", WORKBUDDY_MODEL)).toBe(OBSERVED_CEILING);
  });
});

describe("admission ceiling", () => {
  const provider = {
    name: "workbuddy",
    modelContextWindows: { [WORKBUDDY_MODEL]: CATALOG_WINDOW },
  } as unknown as OcxProviderConfig;

  test("the observed ceiling replaces the catalog's for the same model", () => {
    expect(resolveInputCeiling(provider, "workbuddy", WORKBUDDY_MODEL)).toBe(CATALOG_WINDOW);
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    expect(resolveInputCeiling(provider, "workbuddy", WORKBUDDY_MODEL)).toBe(OBSERVED_CEILING);
  });

  test("an observation never raises a ceiling the config already set lower", () => {
    const narrow = {
      name: "workbuddy",
      modelContextWindows: { [WORKBUDDY_MODEL]: 64_000 },
    } as unknown as OcxProviderConfig;
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    expect(resolveInputCeiling(narrow, "workbuddy", WORKBUDDY_MODEL)).toBe(64_000);
  });
});

describe("advertised auto-compact trigger", () => {
  const catalogRow = (): RawEntry => ({
    slug: "workbuddy/global:deepseek-v4.1-flash",
    context_window: CATALOG_WINDOW,
    max_context_window: CATALOG_WINDOW,
    // What the catalog advertises today: 70% of the 1,000,000 window it believes in.
    auto_compact_token_limit: CATALOG_TRIGGER,
  });

  test("a 100000 observed ceiling yields a trigger derived from 100000, not from the catalog", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    const entry = catalogRow();
    applyObservedAutoCompactTrigger([entry]);
    expect(entry.auto_compact_token_limit).toBe(clampAutoCompactTokenLimit(OBSERVED_CEILING));
    expect(entry.auto_compact_token_limit).toBe(70_000);
    // The point of the fix: not the catalog's 70% of 1,000,000.
    expect(entry.auto_compact_token_limit).not.toBe(CATALOG_TRIGGER);
  });

  test("a measured conversation cannot advertise past the observed ceiling either", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    // 313,021 tokens succeeded on this model before the refusal. Without the observation the
    // measured path would advertise 313,021 — three times a ceiling the provider enforces.
    const entry = catalogRow();
    applyMeasuredAutoCompactTrigger([entry], {
      inputTokens: 313_021,
      model: WORKBUDDY_MODEL,
      provider: "workbuddy",
      overflowed: true,
    });
    expect(entry.auto_compact_token_limit).toBe(70_000);
  });

  test("an observation never raises a trigger that is already lower", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    const entry = { ...catalogRow(), auto_compact_token_limit: 32_000 };
    applyObservedAutoCompactTrigger([entry]);
    expect(entry.auto_compact_token_limit).toBe(32_000);
  });

  test("an unobserved model keeps the catalog trigger exactly as it was", () => {
    const entry = catalogRow();
    applyObservedAutoCompactTrigger([entry]);
    expect(entry.auto_compact_token_limit).toBe(CATALOG_TRIGGER);
    // And a measured conversation for an unobserved model behaves as it did before the fix.
    const measured = { inputTokens: 663_534, model: WORKBUDDY_MODEL, provider: "workbuddy" };
    applyMeasuredAutoCompactTrigger([entry], measured);
    expect(entry.auto_compact_token_limit)
      .toBe(measuredAutoCompactTokenLimit(CATALOG_WINDOW, measured.inputTokens)!);
  });

  test("an observation applies to its own model only", () => {
    recordObservedContextCeiling({ provider: "workbuddy", model: WORKBUDDY_MODEL, ceiling: OBSERVED_CEILING });
    const sibling: RawEntry = {
      slug: "workbuddy/global:deepseek-v4.1-pro",
      context_window: CATALOG_WINDOW,
      max_context_window: CATALOG_WINDOW,
      auto_compact_token_limit: CATALOG_TRIGGER,
    };
    applyObservedAutoCompactTrigger([sibling]);
    expect(sibling.auto_compact_token_limit).toBe(CATALOG_TRIGGER);
  });
});
