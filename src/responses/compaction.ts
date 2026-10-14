/**
 * Remote compaction v2 support for ROUTED providers.
 *
 * Codex decides "this provider supports remote compaction" by provider name (built-in `OpenAI`),
 * and Design B points that provider at this proxy — so Codex sends remote compaction v2 requests
 * for EVERY routed model. The request is a normal /responses call whose input ends with
 * `{"type":"compaction_trigger"}`; codex-rs `collect_compaction_output` then requires the stream
 * to carry EXACTLY ONE `{"type":"compaction","encrypted_content":...}` output item
 * (compact_remote_v2.rs) or it fatals with "expected exactly one compaction output item".
 *
 * Routed models cannot produce OpenAI's encrypted blob, so the proxy runs the model as a plain
 * summarizer and wraps the summary text in a transparent envelope: `ocx1:` + base64(utf8 summary).
 * Codex stores the item and replays it in later input; the parser decodes our envelope back into
 * plain text for routed models. Real OpenAI-encrypted blobs (no `ocx1:` prefix) are opaque —
 * routed models get a short "history was compacted" note instead.
 */

export const OCX_COMPACTION_PREFIX = "ocx1:";

export const OCX_NATIVE_REPLAY_RECOVERY_NOTE =
  "Threads compacted through a routed provider can contain OpenCodeX-owned ocx1 state. "
  + "Before resuming one through native Codex, run `ocx recover-history --ocx-compaction <thread-id> --yes`.";

/**
 * Mirrors codex-rs core/templates/compact/prompt.md (the local-compaction instruction), with
 * the standing contract and the record of past attempts kept inside it.
 *
 * The stock instruction says "be concise", and a routed turn then loses the two things it can
 * never get back: the rules the user established plus how they want to be spoken to, and the
 * record of what was already tried. Without the second one the next model walks the same dead
 * ends again and reads every failure as if it were new information. So this asks for a handover
 * rather than a summary, and leaves the shape of the writing to the model: a fixed form turns
 * the output into something a person has to decode before it can be used.
 */
export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

The next model has none of this conversation. It cannot see what you saw, it cannot ask you
anything, and whatever you leave out is gone for good, including for the user, who would then
have to explain all of it a second time.

So do not summarize and do not compress. Write the substance out in full, in plain readable
prose that a person can follow without decoding a form. No template, no headings, no numbered
entries unless the content really is a list.

Before you write, make sure the handover really contains all of this:

Who the user is, how they want to be spoken to, and every rule they have given you that still
stands. If they ever corrected you on something, that correction is now one of their rules.
Reproduce their wording rather than paraphrasing it into something vaguer.

What the user is actually trying to get, in their own terms, and how far along the work is.

Everything you have already tried. For each attempt, what the idea was, why you thought it was
worth trying, exactly what you ran or asked or read, and exactly what came back, including the
error text and the empty results. Keep the failed attempts and the dead ends, not just the ones
that worked. A dead end written down here is a dead end the next model does not have to walk
again, and a wrong guess written down here is one it does not have to make again.

Which of those attempts actually worked, and what each one produced.

What you decided and why, including the alternatives you rejected and the reason each was
rejected. The reasons are what stop the next model from reopening a closed question.

What you actually proved, and what you merely believe. Keep those apart, and name the evidence
for anything you call proved.

The numbers that matter, with their current values and where each number came from. If a number
has not been measured, say that plainly instead of leaving it out, because a missing number
reads like a zero.

What is still open, and the single next action.

Keep every name, path, command, identifier, version and key exactly as it was written. Never
shorten them, never tidy them, never correct a spelling you are not sure about. If the user
asked for a specific tone or a specific way of working, that survives into the handover.

Write in plain sentences. Do not use em dashes anywhere, use a full stop or a comma instead.`;

/** Mirrors codex-rs core/templates/compact/summary_prefix.md (framing for a replayed summary). */
export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";

/**
 * Item types in the compact wire family. Each carries an `encrypted_content` blob the client
 * replays verbatim on every later turn, and the minting backend verifies it is unmodified.
 *
 * Keep this the only enumeration: a copy that listed just `compaction` let the response-side
 * field backfill synthesize ids into the other two, which the client then replayed as "modified
 * from the compact response".
 */
const COMPACTION_ITEM_TYPES: ReadonlySet<string> = new Set([
  "compaction",
  "compaction_summary",
  "context_compaction",
]);

export function isCompactionItemType(type: unknown): boolean {
  return typeof type === "string" && COMPACTION_ITEM_TYPES.has(type);
}

export function encodeCompactionSummary(summary: string): string {
  return OCX_COMPACTION_PREFIX + Buffer.from(summary, "utf-8").toString("base64");
}

/** Decode an `ocx1:` envelope; returns null for real (OpenAI-encrypted) blobs or garbage. */
export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(OCX_COMPACTION_PREFIX)) return null;
  try {
    return Buffer.from(encryptedContent.slice(OCX_COMPACTION_PREFIX.length), "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/** Render a replayed compaction item as plain user-visible text for a routed model. */
export function compactionItemToText(encryptedContent: string | undefined): string {
  const decoded = typeof encryptedContent === "string" ? decodeCompactionSummary(encryptedContent) : null;
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

/**
 * Remote compaction v1 (`POST /responses/compact`, unary) — codex-rs installs the returned
 * `{"output":[ResponseItem...]}` as the REPLACEMENT history (compact_remote.rs
 * process_compacted_history). Mirror codex-rs local `build_compacted_history`: recent real user
 * messages within a token budget, then one user message `SUMMARY_PREFIX\n<summary>`. Plain user
 * message items parse as real user messages on the codex side (event_mapping parse_user_message);
 * contextual wrappers are filtered there, and v2-style `compaction` items are NOT expected here.
 */

/** codex-rs compact.rs COMPACT_USER_MESSAGE_MAX_TOKENS = 20k tokens (~4 chars/token). */
const COMPACT_V1_RETAINED_CHAR_BUDGET = 20_000 * 4;

/** Extract plain-text user messages from a Responses `input` array (for v1 compact retention). */
export function extractCompactUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { type?: string; role?: string; content?: unknown };
    if (rec.type !== undefined && rec.type !== "message") continue;
    if (rec.role !== "user") continue;
    let text = "";
    if (typeof rec.content === "string") text = rec.content;
    else if (Array.isArray(rec.content)) {
      text = rec.content
        .map(b => {
          if (!b || typeof b !== "object") return "";
          const block = b as { type?: string; text?: string };
          return (block.type === "input_text" || block.type === "text") && typeof block.text === "string" ? block.text : "";
        })
        .join("");
    }
    if (text.trim().length > 0) out.push(text);
  }
  return out;
}

function compactUserMessageItem(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

/** Build the v1 compact `output` array: retained recent user messages + the summary message. */
export function buildCompactV1Output(userMessages: string[], summary: string): Record<string, unknown>[] {
  const selected: string[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  for (let i = userMessages.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = userMessages[i];
    if (msg.length <= remaining) {
      selected.push(msg);
      remaining -= msg.length;
    } else {
      // Budget partially covers this older message: keep its tail (most recent context) and stop.
      let tailStart = msg.length - remaining;
      // Never start the retained tail on a lone LOW surrogate: the pair's
      // other half would be lost and encoding substitutes U+FFFD.
      if (tailStart > 0 && tailStart < msg.length) {
        const first = msg.charCodeAt(tailStart);
        if (first >= 0xdc00 && first <= 0xdfff) tailStart += 1;
      }
      selected.push(msg.slice(tailStart));
      break;
    }
  }
  selected.reverse();
  // codex-rs compact.rs uses "{SUMMARY_PREFIX}\n{summary}" (single newline) and detects stored
  // summaries by that exact prefix — keep the same shape.
  const summaryText = summary.trim().length > 0 ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  return [...selected.map(compactUserMessageItem), compactUserMessageItem(summaryText)];
}
