import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "../codex/catalog/native-models";
import { redactSecretString } from "../lib/redact";

const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Resolve a client-facing soft compaction budget without changing any hard
 * model limit. Configuration and measured input ceilings may only lower the
 * default envelope.
 *
 * The envelope is 70%, and it is a hard product rule, not a tuned number: a routed
 * provider's reported prompt usage is not the quantity its ceiling check measures, so the
 * client's meter always reaches its own 100% before the upstream has refused anything.
 * 2026-10-14, workbuddy/global:deepseek-v4.1-flash: the meter read 663,534 of 950,000 (70%)
 * while the upstream had already counted the same request at 1,053,246 against a 1,048,576
 * ceiling and refused it. Budgeting at 90% meant the compaction never fired and the turn died
 * at the wall. Compact at 70% instead, and let `modelAutoCompactTokenLimits` lower it further
 * for a provider whose gap is known to be wider than that.
 */
export function clampAutoCompactTokenLimit(
  contextWindow: number,
  maxInputTokens?: number,
  configuredLimit?: number,
): number {
  const candidates = [Math.floor(contextWindow * 0.7), contextWindow];
  if (positiveSafeInteger(maxInputTokens)) candidates.push(maxInputTokens);
  if (positiveSafeInteger(configuredLimit)) candidates.push(configuredLimit);
  return Math.min(...candidates);
}

export type AutoCompactBudgetValidationOptions = Readonly<{
  /** PATCH accepts null for whole-map and per-key deletion. */
  allowTombstones?: boolean;
  /** The canonical ChatGPT provider accepts only exact supported native ids. */
  requireNativeIds?: boolean;
}>;

/** Shared config/load/management boundary for per-model soft budgets. */
export function modelAutoCompactTokenLimitsConfigError(
  value: unknown,
  options: AutoCompactBudgetValidationOptions = {},
): string | null {
  const field = "modelAutoCompactTokenLimits";
  if (value === undefined || (options.allowTombstones && value === null)) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `${field} must be a plain object${options.allowTombstones ? " or null" : ""}`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return `${field} must be a plain object with own properties`;
  }
  for (const [modelId, entry] of Object.entries(value as Record<string, unknown>)) {
    const safeModelId = JSON.stringify(redactSecretString(modelId));
    if (!modelId.trim()) return `${field} keys must be nonblank model ids`;
    if (RESERVED_OBJECT_KEYS.has(modelId)) {
      return `${field} key ${safeModelId} is reserved`;
    }
    if (options.requireNativeIds
      && (modelId.includes("/") || !SUPPORTED_NATIVE_OPENAI_SLUGS.has(modelId))) {
      return `${field} key ${safeModelId} must be an exact supported native model id`;
    }
    if (options.allowTombstones && entry === null) continue;
    if (!positiveSafeInteger(entry)) {
      return `${field}[${safeModelId}] must be a positive safe integer${
        options.allowTombstones ? " or null" : ""
      }`;
    }
  }
  return null;
}
