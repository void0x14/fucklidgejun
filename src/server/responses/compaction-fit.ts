/**
 * Make a routed compaction request fit under the ceiling its provider actually enforced.
 *
 * Verified 2026-10-14 on a real 78 MB rollout: the remote-compaction-v2 body measured 100,001
 * tokens against a ceiling of 100,000, so compaction could never succeed — the retry rebuilt the
 * same oversize request, and the conversation could never be compacted again. The observation is
 * now remembered (src/providers/observed-context-ceiling.ts); this module is what makes the body
 * obey it, because knowing the number changes nothing on its own.
 *
 * Three invariants:
 *
 *   - COMPACTION TURNS ONLY. The caller gates on `routedCompaction`. A normal turn's history is
 *     never touched, so nothing here can change what a model sees on a real turn.
 *   - THE HANDOVER SURVIVES. Content leaves in usefulness order — tool output, reasoning, tool
 *     calls, assistant prose, middle user turns — so what remains still says what was being done.
 *     The first user message (the task), the last one (the live instruction), any stored
 *     compaction summary, and every system/developer instruction are never dropped: a summary
 *     that lost the task is worse than a request that is too large.
 *   - MEASURED, NOT GUESSED. Every number here comes from the same estimator the admission gate
 *     uses, so the two cannot disagree about what fits.
 *
 * The observed ceiling is the only ceiling used. The catalog number is exactly the one the
 * provider contradicted, so fitting to it would reproduce the failure it was supposed to fix;
 * with nothing observed, nothing is dropped.
 */
import { estimateTokens } from "../../lib/token-estimate";
import { observedContextCeiling } from "../../providers/observed-context-ceiling";
import { COMPACT_PROMPT } from "../../responses/compaction";
import type { OcxMessage, OcxParsedRequest } from "../../types";
import { estimateMessageTokens } from "./input-admission";

/**
 * Headroom kept free below the ceiling, as a fraction of it, and never less than the floor.
 *
 * The estimate is a heuristic on both sides — it can be a little under what the provider charges
 * and the serialized body carries punctuation the per-item walk does not charge — so a body fitted
 * to exactly `ceiling` would still be refused at the boundary. 1% of a 100k ceiling is a thousand
 * tokens of slack against a real failure that missed by one.
 */
export const COMPACTION_FIT_MARGIN_RATIO = 0.01;
export const COMPACTION_FIT_MARGIN_MIN_TOKENS = 256;

/** How a piece of input leaves a compaction request, in the order it is given up. */
type DropKind = "tool-output" | "reasoning" | "tool-call" | "assistant-text" | "user-text" | "other";

/**
 * Usefulness order for a handover. Tool output is the bulkiest and the least informative per
 * token; reasoning explains a past decision the summary has already absorbed; user turns carry
 * the task itself and go last.
 *
 * `other` is last of all rather than absent: an item this module does not recognize is only
 * sacrificed once every known-spareable class is gone, because guessing what an unknown structure
 * carries is how a summary quietly loses the thread.
 */
const DROP_ORDER: readonly DropKind[] = [
  "tool-output",
  "reasoning",
  "tool-call",
  "assistant-text",
  "user-text",
  "other",
];

/** What one input item costs and how it may leave. */
interface ItemCost {
  tokens: number;
  /** `"keep"` marks an item that is never dropped, whatever the budget. */
  kind: DropKind | "keep";
  /** Identity shared by a tool call and its result, so the pair leaves together. */
  pairKey?: string;
}

export interface CompactionFitSummary {
  /** Input items removed across both representations. */
  droppedItems: number;
  /** Estimated total request tokens after fitting, including the instruction and the margin. */
  estimatedTokens: number;
  /** The ceiling this fit targeted. */
  ceiling: number;
  changed: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tokens that ride the request but can never be dropped: the compaction instruction (when the
 * caller has not already put it in the input) plus the safety margin.
 */
export function compactionReserveTokens(
  ceiling: number,
  modelId: string,
  instructionInInput: boolean,
): number {
  const instruction = instructionInInput ? 0 : estimateTokens(COMPACT_PROMPT, modelId);
  return instruction + Math.max(
    COMPACTION_FIT_MARGIN_MIN_TOKENS,
    Math.ceil(ceiling * COMPACTION_FIT_MARGIN_RATIO),
  );
}

/** The first and last user turn of a set: the task and the live instruction. */
function pinnedUserIndices(costs: readonly ItemCost[]): Set<number> {
  const pinned = new Set<number>();
  const users = costs
    .map((cost, index) => (cost.kind === "user-text" ? index : -1))
    .filter(index => index >= 0);
  const first = users[0];
  const last = users[users.length - 1];
  if (first !== undefined) pinned.add(first);
  if (last !== undefined) pinned.add(last);
  return pinned;
}

/**
 * Drop items until the surviving set fits `budget`.
 *
 * Walks `DROP_ORDER`, oldest first inside each class, and stops the moment the set fits — so a
 * request that only needs to lose its oldest tool output loses exactly that.
 */
function pruneToBudget<T>(
  items: readonly T[],
  costs: readonly ItemCost[],
  budget: number,
  pinned: ReadonlySet<number>,
): { kept: T[]; dropped: number } {
  let total = costs.reduce((sum, cost) => sum + cost.tokens, 0);
  if (total <= budget) return { kept: [...items], dropped: 0 };

  const removed = new Set<number>();
  const removeWithPair = (index: number): number => {
    const cost = costs[index];
    if (cost === undefined || removed.has(index) || pinned.has(index) || cost.kind === "keep") return 0;
    removed.add(index);
    let freed = cost.tokens;
    if (cost.pairKey === undefined) return freed;
    // A tool call and its output are one unit: dropping half hands the upstream an unanswerable
    // pair, so both sides leave together.
    for (let other = 0; other < costs.length; other += 1) {
      if (other === index || removed.has(other) || pinned.has(other)) continue;
      if (costs[other]?.pairKey !== cost.pairKey) continue;
      removed.add(other);
      freed += costs[other]?.tokens ?? 0;
    }
    return freed;
  };

  for (const kind of DROP_ORDER) {
    for (let index = 0; index < costs.length && total > budget; index += 1) {
      if (costs[index]?.kind !== kind) continue;
      total -= removeWithPair(index);
    }
    if (total <= budget) break;
  }

  return { kept: items.filter((_item, index) => !removed.has(index)), dropped: removed.size };
}

/**
 * Classify one Responses wire input item.
 *
 * The compaction body is rebuilt from `parsed._rawBody` by the openai-responses passthrough, so
 * this is the representation that reaches the wire on the route that actually failed.
 */
function wireItemCost(item: unknown, modelId: string): ItemCost {
  const tokens = estimateTokens(JSON.stringify(item) ?? "", modelId);
  if (!isPlainObject(item)) return { tokens, kind: "other" };
  const type = typeof item.type === "string" ? item.type : "";
  const callId = typeof item.call_id === "string" ? item.call_id : undefined;
  const pair = callId === undefined ? {} : { pairKey: callId };
  // Removed before the wire by buildRoutedCompactionBody(): charging them would drop real
  // history to pay for bytes the provider never receives.
  if (type === "additional_tools" || type === "compaction_trigger") return { tokens: 0, kind: "keep" };
  // A stored compaction summary IS the history. Losing it would make the handover circular.
  if (type === "compaction" || type === "compaction_summary") return { tokens, kind: "keep" };
  if (type === "message") {
    const role = typeof item.role === "string" ? item.role : "";
    if (role === "system" || role === "developer") return { tokens, kind: "keep" };
    return { tokens, kind: role === "user" ? "user-text" : "assistant-text" };
  }
  if (type === "reasoning") return { tokens, kind: "reasoning" };
  // A tool listing is tool output in every sense that matters here: bulky and disposable.
  if (type === "mcp_list_tools") return { tokens, kind: "tool-output", ...pair };
  if (type.endsWith("_output")) return { tokens, kind: "tool-output", ...pair };
  if (type.endsWith("_call")) return { tokens, kind: "tool-call", ...pair };
  return { tokens, kind: "other" };
}

/** Classify one parsed-context message; the shape every non-passthrough adapter builds from. */
function messageCost(message: OcxMessage, modelId: string): ItemCost {
  const tokens = estimateMessageTokens(message, modelId);
  switch (message.role) {
    case "developer":
      return { tokens, kind: "keep" };
    case "toolResult":
      return { tokens, kind: "tool-output", pairKey: message.toolCallId };
    case "user":
      return { tokens, kind: "user-text" };
    case "assistant": {
      const call = message.content.find(part => part.type === "toolCall");
      if (call !== undefined && call.type === "toolCall") return { tokens, kind: "tool-call", pairKey: call.id };
      if (message.content.some(part => part.type === "text")) return { tokens, kind: "assistant-text" };
      // Thinking-only: reasoning, and the first thing a handover can spare.
      return { tokens, kind: "reasoning" };
    }
  }
}

/**
 * Fit a Responses wire `input` array under `ceiling`.
 *
 * `instructions` is the body-level system prompt: always sent, never droppable, so it is charged
 * against the ceiling before the input gets its budget.
 */
export function fitCompactionInputItems(
  input: readonly unknown[],
  options: { ceiling: number; modelId: string; instructions?: string },
): { input: unknown[]; summary: CompactionFitSummary } {
  const { ceiling, modelId } = options;
  const instructionsTokens = typeof options.instructions === "string"
    ? estimateTokens(options.instructions, modelId)
    : 0;
  const reserve = compactionReserveTokens(ceiling, modelId, false);
  const budget = ceiling - reserve - instructionsTokens;
  const costs = input.map(item => wireItemCost(item, modelId));
  const after = costs.reduce((sum, cost) => sum + cost.tokens, 0);

  if (budget <= 0 || after <= budget) {
    return {
      input: [...input],
      summary: {
        droppedItems: 0,
        estimatedTokens: after + instructionsTokens + reserve,
        ceiling,
        changed: false,
      },
    };
  }

  const { kept, dropped } = pruneToBudget(input, costs, budget, pinnedUserIndices(costs));
  const keptTokens = kept.reduce<number>((sum, item) => sum + wireItemCost(item, modelId).tokens, 0);
  return {
    input: kept,
    summary: {
      droppedItems: dropped,
      estimatedTokens: keptTokens + instructionsTokens + reserve,
      ceiling,
      changed: dropped > 0,
    },
  };
}

/**
 * Fit parsed-context messages under `ceiling`.
 *
 * The caller has already appended the compaction instruction, so it is counted in `messages` and
 * only the margin is reserved on top.
 */
export function fitCompactionMessages(
  messages: readonly OcxMessage[],
  options: { ceiling: number; modelId: string; systemPromptTokens?: number },
): { messages: OcxMessage[]; summary: CompactionFitSummary } {
  const { ceiling, modelId } = options;
  const systemTokens = options.systemPromptTokens ?? 0;
  const reserve = compactionReserveTokens(ceiling, modelId, true);
  const budget = ceiling - reserve - systemTokens;
  const costs = messages.map(message => messageCost(message, modelId));
  const after = costs.reduce((sum, cost) => sum + cost.tokens, 0);

  if (budget <= 0 || after <= budget) {
    return {
      messages: [...messages],
      summary: {
        droppedItems: 0,
        estimatedTokens: after + systemTokens + reserve,
        ceiling,
        changed: false,
      },
    };
  }

  const { kept, dropped } = pruneToBudget(messages, costs, budget, pinnedUserIndices(costs));
  const keptTokens = kept.reduce((sum, message) => sum + estimateMessageTokens(message, modelId), 0);
  return {
    messages: kept,
    summary: {
      droppedItems: dropped,
      estimatedTokens: keptTokens + systemTokens + reserve,
      ceiling,
      changed: dropped > 0,
    },
  };
}

/**
 * Fit a routed compaction turn to the ceiling its provider has enforced, in both representations.
 *
 * The passthrough adapter rebuilds the wire body from `parsed._rawBody`, every other adapter
 * rebuilds it from `parsed.context`; a routed compaction can take either, and only one of them
 * reaches the provider per attempt. Both are fitted so the fix does not depend on which wire the
 * route happens to speak.
 *
 * Returns `undefined` when the provider has never stated a ceiling: with nothing measured there is
 * nothing to fit to, and the catalog's number is the one that was wrong.
 */
export function fitRoutedCompactionToObservedCeiling(
  parsed: OcxParsedRequest,
  providerName: string,
  modelId: string,
): CompactionFitSummary | undefined {
  const ceiling = observedContextCeiling(providerName, modelId);
  if (ceiling === undefined) return undefined;

  const systemPromptTokens = (parsed.context.systemPrompt ?? [])
    .reduce((sum, prompt) => sum + estimateTokens(prompt, modelId), 0);
  const messageFit = fitCompactionMessages(parsed.context.messages, {
    ceiling,
    modelId,
    systemPromptTokens,
  });
  parsed.context.messages = messageFit.messages;

  const rawBody = parsed._rawBody;
  let inputFit: { summary: CompactionFitSummary } | undefined;
  if (isPlainObject(rawBody) && Array.isArray(rawBody.input)) {
    const fitted = fitCompactionInputItems(rawBody.input, {
      ceiling,
      modelId,
      ...(typeof rawBody.instructions === "string" ? { instructions: rawBody.instructions } : {}),
    });
    rawBody.input = fitted.input;
    inputFit = fitted;
  }

  // One number for the request: the wire that is actually sent is whichever the adapter builds,
  // so the summary reports the larger of the two and the sum of what was given up.
  return {
    droppedItems: messageFit.summary.droppedItems + (inputFit?.summary.droppedItems ?? 0),
    estimatedTokens: Math.max(
      messageFit.summary.estimatedTokens,
      inputFit?.summary.estimatedTokens ?? 0,
    ),
    ceiling,
    changed: messageFit.summary.changed || (inputFit?.summary.changed ?? false),
  };
}
