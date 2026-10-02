/**
 * Key-scoped upstream failure classifier for static API-key pools.
 *
 * A pool can only help when the upstream's verdict is about the CREDENTIAL that was sent, not
 * about the request: a sibling key serves the same prompt once the first key's balance, quota or
 * rate window is spent. Everything about the request itself -- a schema error, a context-length
 * overflow, an image the model cannot read, a content-policy refusal -- fails identically on
 * every key, so classifying it would burn the whole pool on one prompt and cool healthy keys.
 *
 * The rule is therefore deliberately conservative:
 * - 429 is a rate window, 401 a rejected credential, 402 an unpaid account. The status alone
 *   is the verdict.
 * - 403 and 400 count ONLY when the error's code or message names billing, quota, arrears or
 *   credit in one of the phrases providers actually send (DeepSeek, DashScope/Alibaba,
 *   Anthropic, OpenAI). A 403 or 400 with any other wording is left alone.
 * - 5xx is never key-scoped here; the opt-in same-key transient retry owns it.
 *
 * Pure apart from `classifyKeyScopedResponse`, which reads a bounded CLONE so the original
 * response stays intact for whatever the caller returns to the client.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";
import type { AttemptRecoveryKind } from "../usage/log";

export type KeyScopedFailureClass = "rate" | "auth" | "balance" | "quota";

/** Error bodies worth classifying are small; anything larger is not a billing verdict. */
const KEY_FAILURE_BODY_MAX_BYTES = 16 * 1024;
const KEY_FAILURE_BODY_TIMEOUT_MS = 2_000;

/**
 * Billing/quota/arrears/credit verdicts, each taken from a real provider body:
 * - OpenAI-compatible `insufficient_quota` code and its "exceeded your current quota" message;
 * - DeepSeek "Insufficient Balance" (402, but some gateways relay it as 400);
 * - DashScope "Free quota exhausted", `AllocationQuota.*`, `Arrearage`, `Model.AccessDenied`
 *   and the arrears message "please make sure your account is in good standing";
 * - Anthropic "Your credit balance is too low".
 */
const BILLING_VERDICTS: readonly RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /exceeded your current quota/i,
  /insufficient[_\s-]+(?:account[_\s-]+)?balance/i,
  /free\s+(?:tier\s+)?quota\s+(?:is\s+|has\s+been\s+)?exhausted/i,
  /\bAllocationQuota\b/,
  /\bArrearage\b/i,
  /\baccount\b[^.\n]{0,40}\bin good standing\b/i,
  /credit balance is too low/i,
  /\bModel\.AccessDenied\b/,
];

/** A 429 that is really exhausted billing quota, not a timing window. */
const QUOTA_429_VERDICTS: readonly RegExp[] = [
  /insufficient[_\s-]?quota/i,
  /exceeded your current quota/i,
  /insufficient[_\s-]+(?:account[_\s-]+)?balance/i,
  /free\s+(?:tier\s+)?quota\s+(?:is\s+|has\s+been\s+)?exhausted/i,
  /\bArrearage\b/i,
  /credit balance is too low/i,
];

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The text a verdict is matched against. A structured body is read through its error fields
 * only (code, type, status, message at the top level and under `error`), so a request echo or
 * any other free text in the body cannot fake a billing verdict. A body that is not JSON is
 * matched as-is: some gateways answer `Provider error 403: Free quota exhausted` in plain text.
 */
function verdictText(bodyText: string, code?: string | null): string {
  const parts: string[] = [];
  if (code) parts.push(code);
  const trimmed = bodyText.trim();
  if (!trimmed) return parts.join("\n");
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { parsed = undefined; }
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (parsed === undefined) parts.push(trimmed);
    return parts.join("\n");
  }
  const record = parsed as Record<string, unknown>;
  const scopes: Record<string, unknown>[] = [record];
  if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
    scopes.push(record.error as Record<string, unknown>);
  }
  for (const scope of scopes) {
    for (const field of ["code", "type", "status", "message"] as const) {
      const value = stringField(scope[field]);
      if (value) parts.push(value);
    }
  }
  const bare = stringField(record.error);
  if (bare) parts.push(bare);
  return parts.join("\n");
}

/**
 * Classify one upstream answer, or null when it says nothing about the key that was sent.
 *
 * `bodyText` is the (bounded) error body; `code` is an already-extracted upstream error code
 * when the caller has one (the combo layer keeps it separately from the message).
 */
export function classifyKeyScopedFailure(
  status: number,
  bodyText = "",
  code?: string | null,
): KeyScopedFailureClass | null {
  if (status === 401) return "auth";
  if (status === 402) return "balance";
  if (status === 429) {
    const text = verdictText(bodyText, code);
    return QUOTA_429_VERDICTS.some(pattern => pattern.test(text)) ? "quota" : "rate";
  }
  if (status !== 403 && status !== 400) return null;
  const text = verdictText(bodyText, code);
  if (!text || !BILLING_VERDICTS.some(pattern => pattern.test(text))) return null;
  return status === 403 ? "quota" : "balance";
}

/**
 * Classify a live upstream response without consuming it.
 *
 * 401/402/429 are decided by status alone, so their bodies are never touched. A 403/400 is read
 * from a bounded clone: an oversized, undecodable, slow or aborted body fails closed (null), and
 * the original body is left for the caller to relay to the client unchanged.
 */
export async function classifyKeyScopedResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<KeyScopedFailureClass | null> {
  const status = response.status;
  if (status === 401 || status === 402 || status === 429) return classifyKeyScopedFailure(status);
  if (status !== 403 && status !== 400) return null;
  if (response.bodyUsed) return null;
  try {
    const body = await readBoundedResponseBody(response.clone(), {
      signal,
      maxBytes: KEY_FAILURE_BODY_MAX_BYTES,
      totalTimeoutMs: KEY_FAILURE_BODY_TIMEOUT_MS,
    });
    if (!body.displaySafe || body.truncated) return null;
    return classifyKeyScopedFailure(status, body.text);
  } catch {
    return null;
  }
}

/** Usage-log recovery label for a key hop of the given class. */
export function keyScopedRecoveryKind(failure: KeyScopedFailureClass): Extract<AttemptRecoveryKind, "key-401" | "key-429" | "key-quota"> {
  if (failure === "auth") return "key-401";
  if (failure === "rate") return "key-429";
  return "key-quota";
}
