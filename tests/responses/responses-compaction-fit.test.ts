/**
 * The compaction request must fit the ceiling its provider actually enforced.
 *
 * Verified 2026-10-14 on a real rollout: a remote-compaction-v2 body measured 100,001 tokens
 * against a 100,000 ceiling, so compaction could never succeed — the retry rebuilt the same
 * oversize request. `src/providers/observed-context-ceiling.ts` remembers the number the provider
 * stated; these tests pin down that the compaction body then obeys it, and that a normal turn's
 * history is never touched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleResponses } from "../../src/server/responses";
import {
  compactionReserveTokens,
  fitCompactionInputItems,
  fitCompactionMessages,
  fitRoutedCompactionToObservedCeiling,
} from "../../src/server/responses/compaction-fit";
import { estimateTokens } from "../../src/lib/token-estimate";
import { COMPACT_PROMPT } from "../../src/responses/compaction";
import {
  clearObservedContextCeilingsForTests,
  recordObservedContextCeiling,
} from "../../src/providers/observed-context-ceiling";
import type { OcxConfig, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../../src/types";

const originalFetch = globalThis.fetch;
const MODEL = "some-model";
const PROVIDER = "gw";
/** Above the reserve, small enough that a fixture is a few hundred KB, not a few hundred MB. */
const CEILING = 20_000;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearObservedContextCeilingsForTests();
});

beforeEach(() => {
  clearObservedContextCeilingsForTests();
});

function text(tag: string, length: number): string {
  return `${tag}-${"x".repeat(length)}`;
}

/**
 * A Codex-shaped history of roughly 25k estimated tokens: an original task, then repeated
 * reasoning / tool call / tool output / assistant prose, then the live instruction.
 */
function history(): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "ORIGINAL TASK: keep this" }],
  }];
  for (let index = 0; index < 18; index += 1) {
    items.push(
      { type: "reasoning", summary: [], encrypted_content: text(`r${index}`, 2000) },
      { type: "function_call", call_id: `c${index}`, name: "shell", arguments: JSON.stringify({ cmd: text(`a${index}`, 900) }) },
      { type: "function_call_output", call_id: `c${index}`, output: text(`o${index}`, 3000) },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: text(`m${index}`, 400) }] },
    );
  }
  items.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "LATEST INSTRUCTION: keep this too" }],
  });
  return items;
}

function keyProviderConfig(overrides: Partial<OcxProviderConfig> = {}): OcxConfig {
  return {
    defaultProvider: PROVIDER,
    providers: {
      [PROVIDER]: {
        adapter: "openai-responses",
        baseUrl: "https://gateway.example/v1",
        authMode: "key",
        apiKey: "test-key",
        ...overrides,
      },
    },
  } as unknown as OcxConfig;
}

function compactionRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function completedPayload(): Record<string, unknown> {
  return {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "handoff summary" }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  };
}

/** Send one turn and return the body that actually reached the provider. */
async function sentBody(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return jsonResponse(completedPayload());
  }) as typeof fetch;
  const response = await handleResponses(compactionRequest(body), keyProviderConfig(), {
    model: "",
    provider: "",
  });
  expect(response.status).toBe(200);
  expect(bodies.length).toBe(1);
  return bodies[0]!;
}

function parsedWith(messages: OcxMessage[], input: unknown[]): OcxParsedRequest {
  return {
    modelId: MODEL,
    context: { messages },
    stream: false,
    options: {},
    _rawBody: { model: MODEL, input },
  } as unknown as OcxParsedRequest;
}

describe("fitCompactionInputItems", () => {
  test("drops the oldest tool output first and lands strictly under the ceiling", () => {
    const input = history();
    const before = estimateTokens(JSON.stringify(input), MODEL);
    expect(before).toBeGreaterThan(CEILING);

    const fitted = fitCompactionInputItems(input, { ceiling: CEILING, modelId: MODEL });

    expect(fitted.summary.changed).toBe(true);
    expect(fitted.summary.droppedItems).toBeGreaterThan(0);
    expect(fitted.summary.estimatedTokens).toBeLessThanOrEqual(CEILING);
    // Tool output is the bulkiest and least useful thing in a handover, so it goes first, and the
    // oldest goes before the newest: the summary keeps the recent work and loses the stale part.
    const kept = fitted.input as Array<{ call_id?: string; type?: string }>;
    expect(kept.some(item => item.call_id === "c0")).toBe(false);
    expect(kept.some(item => item.call_id === "c17")).toBe(true);
    // The task and the live instruction are the two things a handover cannot lose.
    expect(JSON.stringify(fitted.input)).toContain("ORIGINAL TASK: keep this");
    expect(JSON.stringify(fitted.input)).toContain("LATEST INSTRUCTION: keep this too");
    expect(estimateTokens(JSON.stringify(fitted.input), MODEL)).toBeLessThan(CEILING);
  });

  test("keeps a tool call paired with the output it answers", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "function_call", call_id: "pair", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "pair", output: text("o", 8000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "latest" }] },
    ];

    const fitted = fitCompactionInputItems(input, { ceiling: 600, modelId: MODEL });

    const kept = fitted.input as Array<{ call_id?: string }>;
    const calls = kept.filter(item => item.call_id === "pair").length;
    // Either both halves survive or neither does; a lone half is an unanswerable pair upstream.
    expect(calls === 0 || calls === 2).toBe(true);
  });

  test("is a no-op below the ceiling", () => {
    const input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "short" }] }];
    const fitted = fitCompactionInputItems(input, { ceiling: CEILING, modelId: MODEL });
    expect(fitted.summary.changed).toBe(false);
    expect(fitted.summary.droppedItems).toBe(0);
    expect(fitted.input).toEqual(input);
  });

  test("never charges the items the compaction body removes before the wire", () => {
    const input = [
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "x" }] },
      { type: "compaction_trigger" },
    ];
    const fitted = fitCompactionInputItems(input, { ceiling: CEILING, modelId: MODEL });
    expect(fitted.summary.changed).toBe(false);
    expect(fitted.summary.estimatedTokens).toBeLessThan(CEILING);
  });

  test("keeps a stored compaction summary", () => {
    const input = [
      { type: "compaction", encrypted_content: text("summary", 4000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "function_call_output", call_id: "c", output: text("o", 8000) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "latest" }] },
    ];
    const fitted = fitCompactionInputItems(input, { ceiling: 2000, modelId: MODEL });
    expect((fitted.input as Array<{ type?: string }>)[0]?.type).toBe("compaction");
  });
});

describe("fitCompactionMessages", () => {
  const messages = (): OcxMessage[] => [
    { role: "user", content: "ORIGINAL TASK: keep this", timestamp: 0 },
    ...Array.from({ length: 14 }, (_unused, index): OcxMessage[] => [
      { role: "assistant", content: [{ type: "thinking", thinking: text(`t${index}`, 2000) }], timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: `c${index}`, name: "shell", arguments: { cmd: text(`a${index}`, 900) } }],
        timestamp: 0,
      },
      { role: "toolResult", toolCallId: `c${index}`, toolName: "shell", content: text(`o${index}`, 3000), isError: false, timestamp: 0 },
      { role: "assistant", content: [{ type: "text", text: text(`m${index}`, 400) }], timestamp: 0 },
    ]).flat(),
    { role: "user", content: "LATEST INSTRUCTION: keep this too", timestamp: 0 },
    { role: "user", content: COMPACT_PROMPT, timestamp: 0 },
  ];

  test("drops tool results and reasoning, keeping the task and the instruction", () => {
    const input = messages();
    const fitted = fitCompactionMessages(input, { ceiling: CEILING, modelId: MODEL });

    expect(fitted.summary.changed).toBe(true);
    expect(fitted.summary.estimatedTokens).toBeLessThanOrEqual(CEILING);
    // Oldest first, and tool results before the prose they fed.
    const toolCallIds = fitted.messages.flatMap(message => (message.role === "toolResult" ? [message.toolCallId] : []));
    expect(toolCallIds).not.toContain("c0");
    expect(toolCallIds).toContain("c13");
    expect(fitted.messages[0]).toMatchObject({ role: "user", content: "ORIGINAL TASK: keep this" });
    expect(fitted.messages.at(-1)).toMatchObject({ role: "user", content: COMPACT_PROMPT });
  });

  test("is a no-op below the ceiling", () => {
    const input = messages().slice(0, 2);
    const fitted = fitCompactionMessages(input, { ceiling: CEILING, modelId: MODEL });
    expect(fitted.summary.changed).toBe(false);
    expect(fitted.messages).toEqual(input);
  });
});

describe("fitRoutedCompactionToObservedCeiling", () => {
  test("does nothing when the provider has never stated a ceiling", () => {
    const parsed = parsedWith(
      [{ role: "user", content: "task", timestamp: 0 }],
      history(),
    );
    expect(fitRoutedCompactionToObservedCeiling(parsed, PROVIDER, MODEL)).toBeUndefined();
    expect((parsed._rawBody as { input: unknown[] }).input.length).toBe(history().length);
  });

  test("fits both representations a routed compaction can be built from", () => {
    recordObservedContextCeiling({ provider: PROVIDER, model: MODEL, ceiling: CEILING });
    const parsed = parsedWith(
      [{ role: "user", content: "task", timestamp: 0 }, { role: "user", content: COMPACT_PROMPT, timestamp: 0 }],
      history(),
    );

    const summary = fitRoutedCompactionToObservedCeiling(parsed, PROVIDER, MODEL);

    expect(summary?.ceiling).toBe(CEILING);
    expect(summary?.changed).toBe(true);
    expect(estimateTokens(JSON.stringify((parsed._rawBody as { input: unknown[] }).input), MODEL))
      .toBeLessThan(CEILING);
  });

  test("charges the compaction instruction the passthrough appends afterwards", () => {
    // The adapter appends the instruction to the wire input after this point, so the reserve has
    // to cover it or the fitted body would still be over the ceiling on the wire.
    expect(compactionReserveTokens(CEILING, MODEL, false))
      .toBeGreaterThan(estimateTokens(COMPACT_PROMPT, MODEL));
    expect(compactionReserveTokens(CEILING, MODEL, true))
      .toBeLessThan(compactionReserveTokens(CEILING, MODEL, false));
  });
});

describe("a routed compaction turn against a stated ceiling", () => {
  test("sends a body strictly below the ceiling", async () => {
    recordObservedContextCeiling({ provider: PROVIDER, model: MODEL, ceiling: CEILING });

    const sent = await sentBody({
      model: `${PROVIDER}/${MODEL}`,
      stream: false,
      input: [...history(), { type: "compaction_trigger" }],
      tools: [{ type: "function", name: "shell" }],
    });

    const input = sent.input as unknown[];
    expect(input.length).toBeGreaterThan(0);
    // The real failure was 100,001 against a 100,000 maximum: strictly below is the contract.
    expect(estimateTokens(JSON.stringify(sent), MODEL)).toBeLessThan(CEILING);
    expect(JSON.stringify(input)).toContain("CONTEXT CHECKPOINT COMPACTION");
    expect(JSON.stringify(input)).toContain("ORIGINAL TASK: keep this");
  });

  test("leaves a normal turn with the same history untouched", async () => {
    const body = {
      model: `${PROVIDER}/${MODEL}`,
      stream: false,
      input: history(),
      tools: [{ type: "function", name: "shell" }],
    };

    const withoutObservation = await sentBody(body);
    recordObservedContextCeiling({ provider: PROVIDER, model: MODEL, ceiling: CEILING });
    const withObservation = await sentBody(body);

    expect(withObservation).toEqual(withoutObservation);
    expect((withObservation.input as unknown[]).length).toBe(history().length);
  });
});
