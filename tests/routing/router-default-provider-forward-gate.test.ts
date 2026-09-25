import { describe, expect, test } from "bun:test";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

/**
 * The default-provider fallback must never forward an unresolved model to the
 * canonical ChatGPT forward provider. The ChatGPT backend refuses every model
 * outside its allowlist with a pre-stream 400 whose detail reads
 * "The '<model>' model is not supported when using Codex with a ChatGPT account."
 * — observed in production logs for claude-sonnet-5, claude-opus-5,
 * opencode-zen/muse-spark-1.3-contributor-free, gemini-38,
 * workbuddy/global:deepseek-v4.1-flash and google-antigravity/gemini-3.8-flash
 * alike (usage.jsonl 2026-07-29 through 2026-09-25). Routing misses have to fail
 * as routing errors instead of producing that refusal.
 */
function canonicalForwardDefault(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
      },
    },
  };
}

describe("default-provider fallback never targets the canonical ChatGPT forward provider", () => {
  test("a routed slug whose provider is absent is refused, not forwarded", () => {
    const config = canonicalForwardDefault();
    expect(() => routeModel(config, "google-antigravity/gemini-3.8-flash"))
      .toThrow("No provider configured for model: google-antigravity/gemini-3.8-flash");
  });

  test("an unresolved bare slug is refused, not forwarded", () => {
    const config = canonicalForwardDefault();
    expect(() => routeModel(config, "gemini-38"))
      .toThrow("No provider configured for model: gemini-38");
  });

  test("non-forward default providers keep the ordinary unresolved-model fallback", () => {
    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "xai",
      providers: {
        xai: {
          adapter: "openai-chat",
          baseUrl: "https://api.x.ai/v1",
          authMode: "key",
          apiKey: "xai-test-key",
        },
      },
    };
    const routed = routeModel(config, "brand-new-model");
    expect(routed.providerName).toBe("xai");
    expect(routed.modelId).toBe("brand-new-model");
  });
});
