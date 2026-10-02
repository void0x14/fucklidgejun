import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../../src/config";
import { startServer } from "../../../src/server";
import { rewriteGrokForeignPaymentRequired } from "../../../src/server/grok-foreign-billing";
import {
  beginRequestAttempt,
  clearRequestLogsForTests,
  getRequestLogEntries,
  type RequestLogContext,
} from "../../../src/server/request-log";
import type { PersistedUsageAttempt } from "../../../src/usage/log";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

/**
 * Grok Build 1.0.46 shows its own "You hit your weekly limit / purchase credits" upsell for any
 * HTTP 402, for any message containing "status 402", and for 403 + "run out of credits". When a
 * Grok Build client talks to a NON-xAI provider through opencodex, a provider's own 402 (DeepSeek
 * "Insufficient Balance") must reach it as a typed 400 instead, at the client-delivery boundary
 * only. An xAI 402 and every non-Grok request stay exactly as they were.
 */

setDefaultTimeout(30_000);

const originalFetch = globalThis.fetch;
let TEST_DIR = "";
let isolated: IsolatedCodexHome;

type Upstream = (url: URL) => Response | undefined;

function stubUpstream(handler: Upstream): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(requestUrl);
    if (url.pathname.endsWith("/models")) return Response.json({ data: [] });
    const answer = handler(url);
    if (answer) return answer;
    // Never reach a real vendor from a unit test: only the proxy under test is loopback.
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return originalFetch(input, init);
    return new Response("unexpected upstream in test", { status: 418 });
  }) as typeof fetch;
}

const DEEPSEEK_402_BODY = {
  error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" },
};

function isDeepSeek(url: URL, suffix: string): boolean {
  return url.hostname === "api.deepseek.com" && url.pathname.endsWith(suffix);
}

function json402(body: unknown = DEEPSEEK_402_BODY): Response {
  return Response.json(body, { status: 402 });
}

async function withServer(
  providers: Record<string, OcxProviderConfig>,
  run: (url: URL) => Promise<void>,
): Promise<void> {
  saveConfig({ port: 0, defaultProvider: Object.keys(providers)[0], providers } as OcxConfig);
  const server = startServer(0);
  try {
    await run(new URL(server.url));
  } finally {
    await server.stop(true);
  }
}

function postResponses(base: URL, model: string, grok: boolean, stream = false): Promise<Response> {
  return originalFetch(new URL("/v1/responses", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...(grok ? { "x-opencodex-grok": "1" } : {}) },
    body: JSON.stringify({ model, input: "hi", stream }),
  });
}

function postChat(base: URL, model: string, grok: boolean): Promise<Response> {
  return originalFetch(new URL("/v1/chat/completions", base), {
    method: "POST",
    headers: { "content-type": "application/json", ...(grok ? { "x-opencodex-grok": "1" } : {}) },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function expectNoGrokBillingTrigger(message: string): void {
  const lower = message.toLowerCase();
  expect(lower).not.toContain("status 402");
  expect(lower).not.toContain("status 403");
  expect(lower).not.toContain("run out of credits");
}

async function expectRewritten(response: Response, provider: RegExp, upstreamText: RegExp): Promise<string> {
  expect(response.status).toBe(400);
  expect(response.headers.get("retry-after")).toBeNull();
  expect(response.headers.get("content-type") ?? "").toContain("application/json");
  const body = await response.json() as { error: { type: string; code: string; message: string } };
  expect(body.error.type).toBe("insufficient_quota");
  expect(body.error.code).toBe("insufficient_quota");
  expect(body.error.message).toMatch(provider);
  expect(body.error.message).toMatch(upstreamText);
  expect(body.error.message).toContain("HTTP 402 Payment Required");
  expect(body.error.message).toContain("not a Grok limit");
  expectNoGrokBillingTrigger(body.error.message);
  return body.error.message;
}

const DEEPSEEK_CHAT: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://api.deepseek.com",
  authMode: "key",
  apiKey: "test-key",
} as OcxProviderConfig;

// The registry pins the `deepseek` endpoint, so the Responses-wire variant (the incident's
// `openai-responses` attempt) still terminates at api.deepseek.com; the stubs key on the path.
const DEEPSEEK_RESPONSES: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.deepseek.com",
  authMode: "key",
  apiKey: "test-key",
} as OcxProviderConfig;

const XAI_KEY: OcxProviderConfig = {
  adapter: "openai-responses",
  baseUrl: "https://api.x.ai/v1",
  authMode: "key",
  apiKey: "test-key",
} as OcxProviderConfig;

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "ocx-grok-foreign-402-"));
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolated = installIsolatedCodexHome("ocx-grok-foreign-402-codex-");
  clearRequestLogsForTests();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await isolated.restore();
  removeTreeWithRetry(TEST_DIR);
});

describe("Grok Build client + non-xAI upstream 402", () => {
  test("Responses passthrough: a DeepSeek 402 reaches Grok as 400 insufficient_quota; the log keeps 402", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses") ? json402() : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", true);
      await expectRewritten(response, /^DeepSeek: /, /Insufficient Balance/);
      const entry = getRequestLogEntries().at(-1);
      expect(entry?.status).toBe(402);
      expect(entry?.surface).toBe("grok");
    });
  });

  test("Responses ingress through a translating adapter (openai-chat wire) is rewritten too", async () => {
    // DeepSeek's Responses ingress is wire-overridden to /responses, so a custom gateway with no
    // registry row drives the adapter-dispatch path; the label falls back to the configured name.
    stubUpstream(url => url.hostname === "acme-gateway.example.test" && url.pathname.endsWith("/chat/completions")
      ? json402({ error: { message: "account balance is 0" } })
      : undefined);
    await withServer({
      acme: { adapter: "openai-chat", baseUrl: "https://acme-gateway.example.test/v1", authMode: "key", apiKey: "k" } as OcxProviderConfig,
    }, async base => {
      const response = await postResponses(base, "acme/some-model", true, true);
      await expectRewritten(response, /^acme: /, /account balance is 0/);
      expect(getRequestLogEntries().at(-1)?.status).toBe(402);
    });
  });

  test("Chat Completions ingress: a DeepSeek 402 is rewritten to 400 for Grok", async () => {
    stubUpstream(url => isDeepSeek(url, "/chat/completions") ? json402() : undefined);
    await withServer({ deepseek: DEEPSEEK_CHAT }, async base => {
      const response = await postChat(base, "deepseek/deepseek-flash", true);
      await expectRewritten(response, /^DeepSeek: /, /Insufficient Balance/);
      expect(getRequestLogEntries().at(-1)?.status).toBe(402);
    });
  });

  test("an upstream message quoting the Grok trigger phrases is sanitized", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses")
      ? json402({ error: { message: "API error (status 402): you have run out of credits; Status 403 next" } })
      : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", true);
      const message = await expectRewritten(response, /^DeepSeek: /, /credits/);
      expect(message).toContain("HTTP 402");
    });
  });

  test("a non-JSON 402 body falls back to a generic message naming the provider", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses")
      ? new Response("<html>payment required</html>", { status: 402, headers: { "content-type": "text/html" } })
      : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", true);
      const message = await expectRewritten(response, /^DeepSeek: /, /DeepSeek account balance/);
      expect(message).not.toContain("<html>");
      expect(getRequestLogEntries().at(-1)?.status).toBe(402);
    });
  });

  test("an upstream Retry-After on the 402 is not forwarded", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses")
      ? Response.json(DEEPSEEK_402_BODY, { status: 402, headers: { "retry-after": "30" } })
      : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      await expectRewritten(await postResponses(base, "deepseek/deepseek-flash", true), /^DeepSeek: /, /Insufficient/);
    });
  });
});

describe("responses the Grok 402 rewrite must leave alone", () => {
  test("a genuine xAI 402 stays a 402 for Grok", async () => {
    stubUpstream(url => url.hostname === "api.x.ai"
      ? json402({ error: { message: "Grok Build usage balance exhausted" } })
      : undefined);
    await withServer({ xai: XAI_KEY }, async base => {
      const response = await postResponses(base, "xai/grok-4.6", true);
      expect(response.status).toBe(402);
      expect(await response.text()).toContain("Grok Build usage balance exhausted");
    });
  });

  test("an xAI destination under a custom provider name also stays a 402", async () => {
    stubUpstream(url => url.hostname === "api.x.ai"
      ? json402({ error: { message: "credits exhausted" } })
      : undefined);
    await withServer({ "my-grok": XAI_KEY }, async base => {
      const response = await postResponses(base, "my-grok/grok-4.6", true);
      expect(response.status).toBe(402);
    });
  });

  test("without the Grok marker the 402 is relayed byte-for-byte as before", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses") ? json402() : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", false);
      expect(response.status).toBe(402);
      const text = await response.text();
      expect(text).toContain("Insufficient Balance");
      expect(text).not.toContain("not a Grok limit");
    });
  });

  test("without the Grok marker a Chat Completions 402 is unchanged", async () => {
    stubUpstream(url => isDeepSeek(url, "/chat/completions") ? json402() : undefined);
    await withServer({ deepseek: DEEPSEEK_CHAT }, async base => {
      const response = await postChat(base, "deepseek/deepseek-flash", false);
      expect(response.status).toBe(402);
      expect(await response.text()).not.toContain("not a Grok limit");
    });
  });

  test("a Grok request that gets a 403 is unchanged", async () => {
    stubUpstream(url => isDeepSeek(url, "/responses")
      ? Response.json({ error: { message: "Free quota exhausted", code: "insufficient_quota" } }, { status: 403 })
      : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", true);
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain("not a Grok limit");
    });
  });

  test("a Grok request that streams 200 is untouched", async () => {
    const events = [
      { type: "response.created", response: { id: "resp_ok" } },
      { type: "response.output_text.delta", item_id: "msg_ok", output_index: 0, delta: "hello" },
      { type: "response.completed", response: { id: "resp_ok", status: "completed", output: [] } },
    ];
    stubUpstream(url => isDeepSeek(url, "/responses")
      ? new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
      : undefined);
    await withServer({ deepseek: DEEPSEEK_RESPONSES }, async base => {
      const response = await postResponses(base, "deepseek/deepseek-flash", true, true);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type") ?? "").toContain("text/event-stream");
      expect(await response.text()).toContain("hello");
    });
  });
});

describe("rewriteGrokForeignPaymentRequired provider identity", () => {
  const config = {
    port: 0,
    defaultProvider: "deepseek",
    providers: { deepseek: DEEPSEEK_CHAT, xai: XAI_KEY, "my-grok": XAI_KEY },
  } as unknown as OcxConfig;

  function attempt(provider: string, status: number, extra: Partial<PersistedUsageAttempt> = {}): PersistedUsageAttempt {
    return { ...beginRequestAttempt(1, provider, "m", "openai-chat"), status, ...extra };
  }

  test("a combo whose last 402 came from xAI keeps the 402", async () => {
    const logCtx: RequestLogContext = {
      model: "m", provider: "deepseek", surface: "grok",
      attempts: [attempt("deepseek", 402), attempt("xai", 402, { credentialSource: "grok-oauth" })],
    };
    const original = json402();
    expect(await rewriteGrokForeignPaymentRequired(original, logCtx, config)).toBe(original);
  });

  test("a combo whose last 402 came from DeepSeek is rewritten even after an xAI attempt", async () => {
    const logCtx: RequestLogContext = {
      model: "m", provider: "xai", surface: "grok",
      attempts: [attempt("xai", 426, { credentialSource: "grok-oauth" }), attempt("deepseek", 402)],
    };
    const rewritten = await rewriteGrokForeignPaymentRequired(json402(), logCtx, config);
    expect(rewritten.status).toBe(400);
  });

  test("an xAI destination under a custom name is recognized from its base URL", async () => {
    const logCtx: RequestLogContext = { model: "m", provider: "my-grok", surface: "grok" };
    const original = json402();
    expect(await rewriteGrokForeignPaymentRequired(original, logCtx, config)).toBe(original);
  });

  test("a provider that is not in the config is not guessed at", async () => {
    const logCtx: RequestLogContext = { model: "m", provider: "openai-acct-1", surface: "grok" };
    const original = json402();
    expect(await rewriteGrokForeignPaymentRequired(original, logCtx, config)).toBe(original);
  });

  test("the body read is bounded and the message stays short", async () => {
    const logCtx: RequestLogContext = { model: "m", provider: "deepseek", surface: "grok" };
    const huge = JSON.stringify({ error: { message: "x".repeat(1024 * 1024) } });
    const rewritten = await rewriteGrokForeignPaymentRequired(
      new Response(huge, { status: 402, headers: { "content-type": "application/json" } }), logCtx, config);
    expect(rewritten.status).toBe(400);
    const body = await rewritten.json() as { error: { message: string } };
    expect(body.error.message.length).toBeLessThan(1000);
    expect(body.error.message).toContain("DeepSeek account balance");
  });

  test("non-Grok and non-402 responses are returned as the same object", async () => {
    const plain = json402();
    expect(await rewriteGrokForeignPaymentRequired(plain, { model: "m", provider: "deepseek" }, config)).toBe(plain);
    const forbidden = Response.json({ error: { message: "nope" } }, { status: 403 });
    expect(await rewriteGrokForeignPaymentRequired(forbidden, { model: "m", provider: "deepseek", surface: "grok" }, config))
      .toBe(forbidden);
  });
});
