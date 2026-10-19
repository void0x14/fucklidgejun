import { describe, expect, test } from "bun:test";
import { classifyError, isContextOverflowText, parseStatedContextMaximum } from "../../src/lib/errors";
import { humanizeProviderErrorResponse, providerFailureMessage } from "../../src/providers/failure-guidance";

/** The body workbuddy/global:deepseek-v4.1-flash returned on 2026-10-14, verbatim shape. */
const WORKBUDDY_OVERFLOW_BODY = JSON.stringify({
  error: {
    code: "prompt_too_long",
    gateway_hint: "request context exceeds the model's limit; reduce history/message size",
    message: "{\"code\":11115,\"msg\":\"prompt is too long: 1053246 tokens > 1048576 maximum\"}",
  },
});

describe("context overflow classification", () => {
  test("reads a vendor prompt_too_long body as a window overflow, not a bad request shape", () => {
    expect(isContextOverflowText(WORKBUDDY_OVERFLOW_BODY)).toBe(true);
    expect(classifyError(400, "upstream_error", WORKBUDDY_OVERFLOW_BODY).code)
      .toBe("context_length_exceeded");
  });

  test("reads the other vendors' overflow wording", () => {
    for (const body of [
      "input is too long: 210000 tokens > 200000 maximum",
      "prompt_too_long",
      "Input exceeds the maximum length of 128000 tokens",
      "input length and `max_tokens` exceed context limit: 210000 > 200000",
      "request context exceeds the model's limit",
    ]) expect(isContextOverflowText(body)).toBe(true);
  });

  test("a genuine shape error stays a shape error", () => {
    for (const body of [
      "Description is too long (2000 characters). Maximum is 1024 characters.",
      "unsupported parameter: 'reasoning.effort'",
    ]) expect(isContextOverflowText(body)).toBe(false);
  });

  test("the user-facing sentence names the window and the fix, not the request format", () => {
    const message = providerFailureMessage(400, `Provider error 400: ${WORKBUDDY_OVERFLOW_BODY}`);
    expect(message).toBe("Upstreamin kabul ettiği context window doldu, compaction yapınız.");
    expect(message).not.toContain("İstek biçimi kabul edilmedi");
  });

  test("the wire carries context_length_exceeded so the client can run its compaction path", async () => {
    const response = await humanizeProviderErrorResponse(new Response(WORKBUDDY_OVERFLOW_BODY, {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    const body = await response.json() as { error: { code?: string; type?: string; message?: string; details?: { code?: string } } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("context_length_exceeded");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toBe("Upstreamin kabul ettiği context window doldu, compaction yapınız.");
    // The vendor code stays available for diagnosis; only the client-facing code is remapped.
    expect(body.error.details?.code).toBe("prompt_too_long");
  });

  test("an unrelated 400 keeps its own code", async () => {
    const response = await humanizeProviderErrorResponse(new Response(
      JSON.stringify({ error: { code: "invalid_param", message: "unsupported parameter: 'reasoning.effort'" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));
    const body = await response.json() as { error: { code?: string } };
    expect(body.error.code).toBe("invalid_param");
  });
});

/**
 * The ceiling a provider states is the only trustworthy one. Config declared 1,000,000 for
 * workbuddy/global:deepseek-v4.1-flash and the catalog advertised a 700,000 trigger, while a
 * 313,021-token turn was answered normally and the compaction turn was then refused at 100,000.
 */
describe("stated context maximum", () => {
  test("reads the maximum after the comparison, never the prompt size before it", () => {
    // Production shapes, verbatim.
    expect(parseStatedContextMaximum("prompt is too long: 100001 tokens > 100000 maximum"))
      .toBe(100_000);
    expect(parseStatedContextMaximum("prompt is too long: 1049108 tokens > 1048576 maximum"))
      .toBe(1_048_576);
    // The number BEFORE the ">" is the oversized prompt, so reading it would reproduce the bug.
    expect(parseStatedContextMaximum("prompt is too long: 1049108 tokens > 1048576 maximum"))
      .not.toBe(1_049_108);
  });

  test("reads the vendor body workbuddy actually returned", () => {
    expect(parseStatedContextMaximum(WORKBUDDY_OVERFLOW_BODY)).toBe(1_048_576);
  });

  test("tolerates the comparison without a trailing bound word", () => {
    expect(parseStatedContextMaximum("prompt is too long: 210000 tokens > 200000 tokens"))
      .toBe(200_000);
    expect(parseStatedContextMaximum("input is too long: 210000 tokens > 200000 maximum"))
      .toBe(200_000);
  });

  test("states nothing when the text carries no such comparison", () => {
    for (const body of [
      "prompt_too_long",
      "request context exceeds the model's limit",
      "Input exceeds the maximum length of 128000 tokens",
      "Description is too long (2000 characters). Maximum is 1024 characters.",
      "",
    ]) expect(parseStatedContextMaximum(body)).toBeUndefined();
  });

  test("refuses an implausible maximum rather than adopting a refusal threshold of 5", () => {
    // A body that happens to contain a tiny "tokens > N" comparison is not a context window; an
    // adopted ceiling is a refusal threshold, so a garbage value would refuse every turn.
    expect(parseStatedContextMaximum("tokens > 5 maximum")).toBeUndefined();
    expect(parseStatedContextMaximum("tokens > 0 maximum")).toBeUndefined();
    expect(parseStatedContextMaximum("tokens > 1023 maximum")).toBeUndefined();
    expect(parseStatedContextMaximum("tokens > 1024 maximum")).toBe(1_024);
  });

  test("the classification and the parse are independent: detection does not imply a number", () => {
    expect(isContextOverflowText("prompt is too long: 100001 tokens > 100000 maximum")).toBe(true);
    expect(parseStatedContextMaximum("prompt is too long: 100001 tokens > 100000 maximum"))
      .toBe(100_000);
    // Detected as an overflow, but no stated maximum to learn from.
    expect(isContextOverflowText("context_length_exceeded")).toBe(true);
    expect(parseStatedContextMaximum("context_length_exceeded")).toBeUndefined();
  });
});
