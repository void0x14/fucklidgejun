import { describe, expect, test } from "bun:test";
import { classifyError, isContextOverflowText } from "../../src/lib/errors";
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
