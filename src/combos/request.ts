import type { OcxComboDefaultEffort, OcxComboReasoningEffortMode, OcxComboTarget, OcxConfig } from "../types";
import { resolveEffortAtOrBelow } from "../reasoning-effort";
import { resolveComboId } from "./types";

const warnedUnsupportedDefaults = new Set<string>();
let lastWarningReconciledGeneration = 0;

export function reconcileComboWarningMemos(generation: number): number {
  if (generation <= lastWarningReconciledGeneration) return 0;
  const removed = warnedUnsupportedDefaults.size;
  warnedUnsupportedDefaults.clear();
  lastWarningReconciledGeneration = generation;
  return removed;
}

export function resetComboEffortWarningStateForTests(): void {
  warnedUnsupportedDefaults.clear();
}

export function comboIdFromRawBody(body: unknown, config: OcxConfig): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return null;
  return resolveComboId(config, model);
}

/**
 * Detect image-bearing Responses *input* only.
 *
 * Must not walk the full request body: tool JSON schemas, metadata, or extension
 * payloads can legally contain `{ "type": "input_image" }` without any image
 * being dispatched. After previous_response_id expansion, scan the materialised
 * `input` tree (message content and function_call_output.output).
 */
export function comboRequestHasImageInput(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return responsesInputHasImage((body as { input?: unknown }).input);
}

function responsesInputHasImage(input: unknown): boolean {
  if (typeof input === "string" || input == null) return false;
  if (!Array.isArray(input)) return false;
  return input.some(responsesInputNodeHasImage);
}

function responsesInputNodeHasImage(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(responsesInputNodeHasImage);
  const record = value as Record<string, unknown>;
  if (record.type === "input_image") return true;
  // Message content parts and nested function_call_output content/output arrays.
  if (record.content !== undefined && responsesInputNodeHasImage(record.content)) return true;
  if (record.output !== undefined && responsesInputNodeHasImage(record.output)) return true;
  return false;
}

/** The text that replaces each image part when a combo's `imageInput` is "disabled". */
export function comboImageOmittedText(comboId: string): string {
  return `[image omitted: combo ${comboId} does not accept image input]`;
}

/**
 * Replace every image part in a Responses body's `input` with a text placeholder, and return how
 * many were replaced.
 *
 * This is how a combo with `imageInput: "disabled"` enforces "no target receives pixels" without
 * rejecting the turn: clients keep an image in history (a tool result, an earlier user turn, a
 * replayed previous_response_id) for the rest of the session, so a rejection would fail every
 * later request. It walks exactly the tree {@link comboRequestHasImageInput} scans -- every
 * `input` item, recursing through `content` and `output` -- and replaces every
 * `{ type: "input_image" }` node whatever reference it carries (data URL, remote URL, file_id, or
 * none), so the detector reports no image afterwards.
 *
 * Copy-on-write: only `body.input` is reassigned, with fresh arrays and records along each path
 * that carried an image. The body object keeps its identity (continuation provenance is keyed by
 * it), and nested nodes are never mutated, because an expanded previous_response_id input can
 * share them with stored response state. An image-free input is left as the same array.
 */
export function stripComboRequestImages(body: unknown, comboId: string): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return 0;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return 0;
  const replacement = { type: "input_text", text: comboImageOmittedText(comboId) } as const;
  let omitted = 0;
  const rewrite = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map(entry => {
        const rewritten = rewrite(entry);
        if (rewritten !== entry) changed = true;
        return rewritten;
      });
      return changed ? next : value;
    }
    const node = value as Record<string, unknown>;
    if (node.type === "input_image") {
      omitted += 1;
      return { ...replacement };
    }
    let next: Record<string, unknown> | undefined;
    for (const key of ["content", "output"] as const) {
      if (node[key] === undefined) continue;
      const rewritten = rewrite(node[key]);
      if (rewritten !== node[key]) (next ??= { ...node })[key] = rewritten;
    }
    return next ?? node;
  };
  const input = rewrite(record.input);
  if (input !== record.input) record.input = input;
  return omitted;
}

export function concreteComboRequestBody(
  body: unknown,
  target: Pick<OcxComboTarget, "provider" | "model">,
  defaultEffort: OcxComboDefaultEffort | null,
  targetReasoningEfforts: readonly string[] | undefined,
  reasoningEffortMode: OcxComboReasoningEffortMode = "strict",
): Record<string, unknown> {
  const clone = structuredClone(body) as Record<string, unknown>;
  clone.model = `${target.provider}/${target.model}`;
  if (targetReasoningEfforts?.length === 0
    || (reasoningEffortMode === "adaptive" && targetReasoningEfforts === undefined)) {
    stripUnsupportedReasoningControls(clone);
  }
  if (!defaultEffort) return clone;
  const reasoning = clone.reasoning;
  const needsDefault = reasoning === undefined || (
    reasoning
    && typeof reasoning === "object"
    && !Array.isArray(reasoning)
    && !Object.prototype.hasOwnProperty.call(reasoning, "effort")
  );
  if (!needsDefault) return clone;
  // Picker availability treats an unknown ladder as a wildcard, but runtime
  // injection stays fail-closed until this concrete target advertises support.
  //
  // Support is not literal membership. The catalog advertises the combo's default
  // through effectiveComboDefault, which keeps the highest supported rung at or
  // below the request rather than dropping it. Testing membership here meant a
  // combo configured for `max` against a target topping out at `high` sent no
  // effort at all, so the provider default applied and the turn ran at `none`
  // while the catalog still advertised `max` (#3108). Resolve the same way the
  // catalog did.
  const resolvedEffort = targetReasoningEfforts === undefined
    ? undefined
    : resolveEffortAtOrBelow(defaultEffort, targetReasoningEfforts);
  if (!resolvedEffort) {
    const key = `${target.provider}/${target.model}:${defaultEffort}`;
    if (!warnedUnsupportedDefaults.has(key)) {
      warnedUnsupportedDefaults.add(key);
      console.debug("[opencodex] combo default effort omitted", {
        provider: target.provider,
        model: target.model,
        requestedEffort: defaultEffort,
        capability: targetReasoningEfforts === undefined ? "unknown" : "unsupported",
      });
    }
    return clone;
  }
  if (reasoning === undefined) {
    clone.reasoning = { effort: resolvedEffort };
  } else {
    clone.reasoning = { ...(reasoning as Record<string, unknown>), effort: resolvedEffort };
  }
  return clone;
}

function stripUnsupportedReasoningControls(body: Record<string, unknown>): void {
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const next = { ...(reasoning as Record<string, unknown>) };
    delete next.effort;
    if (Object.keys(next).length > 0) body.reasoning = next;
    else delete body.reasoning;
  }
  delete body.reasoning_effort;
  delete body.thinking_budget;
  delete body.thinking;
}
