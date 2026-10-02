import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import {
  clearKeyCooldowns,
  forgetApiKeyRotationCursor,
  getKeyCooldownUntil,
  rotateKeyOn429,
  rotateProviderTransportOnKeyFailure,
} from "../../src/providers/key-failover";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearReasoningReplayCacheForTests } from "../../src/responses/reasoning-replay-cache";
import { routedProviderConfig } from "../../src/router";
import { startServer } from "../../src/server";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * End-to-end coverage for the key-pool root causes in
 * devlog/_plan/261002_rr_multimodal_quota_bleed/20_round_robin_findings.md: a key-scoped
 * verdict before any byte reaches the client retries the SAME request on the next healthy key
 * on every wire, cools the key that was actually sent, and never strands a combo whose
 * provider still has a healthy key.
 */

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-keypool-e2e-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-keypool-e2e-"));
  process.env.OPENCODEX_HOME = testDir;
  clearKeyCooldowns();
  forgetApiKeyRotationCursor();
  clearComboTargetCooldowns();
  clearComboSelectionState();
  clearReasoningReplayCacheForTests();
});

afterEach(() => {
  upstream?.stop(true);
  upstream = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
  clearKeyCooldowns();
  forgetApiKeyRotationCursor();
  clearComboTargetCooldowns();
  clearComboSelectionState();
  clearReasoningReplayCacheForTests();
});

type Script = (key: string, path: string) => Response | undefined;

const chatOk = (text: string) => Response.json({
  id: "chatcmpl-pool", object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

const responsesOk = (text: string) => Response.json({
  id: "resp_pool", object: "response", status: "completed", model: "m1",
  output: [{
    id: "msg_pool", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

const deepseek402 = () => Response.json(
  { error: { message: "Insufficient Balance", type: "unknown_error", param: null, code: "invalid_request_error" } },
  { status: 402 },
);
const freeQuota403 = () => Response.json(
  { error: { code: "AllocationQuota.FreeTierOnly", message: "Free quota exhausted. Please upgrade to continue." } },
  { status: 403 },
);
const contentPolicy403 = () => Response.json(
  { error: { code: "DataInspectionFailed", message: "Input data may contain inappropriate content." } },
  { status: 403 },
);
const credit400 = () => Response.json(
  { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } },
  { status: 400 },
);

/** Upstream that records each bearer it saw and answers per key; unscripted keys succeed. */
function serveUpstream(script: Script, ok: (text: string) => Response): string[] {
  const seen: string[] = [];
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    seen.push(key);
    return script(key, new URL(req.url).pathname) ?? ok(`served by ${key}`);
  } });
  return seen;
}

function pooledProvider(
  adapter: "openai-chat" | "openai-responses",
  keys: string[],
  extra: Partial<OcxProviderConfig> = {},
): OcxProviderConfig {
  return {
    adapter,
    baseUrl: `http://127.0.0.1:${upstream!.port}/v1`,
    allowPrivateNetwork: true,
    authMode: "key",
    apiKey: keys[0],
    apiKeyPool: keys.map(key => ({ id: `id-${key}`, key })),
    ...extra,
  } as OcxProviderConfig;
}

async function postResponses(server: ReturnType<typeof startServer>, model: string): Promise<Response> {
  return fetch(new URL("/v1/responses", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: "hello", stream: false }),
  });
}

async function postChat(server: ReturnType<typeof startServer>, model: string): Promise<Response> {
  return fetch(new URL("/v1/chat/completions", server.url), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: "hello" }] }),
  });
}

describe("key pool failover on key-scoped verdicts (end-to-end)", () => {
  test("Responses passthrough: 402 on the first key retries on the second and cools the first (R1+R2)", async () => {
    const seen = serveUpstream(key => key === "first" ? deepseek402() : undefined, responsesOk);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
      pooled: pooledProvider("openai-responses", ["first", "second"]),
    } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await postResponses(server, "pooled/m1");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("served by second");
      expect(seen).toEqual(["first", "second"]);
      expect(getKeyCooldownUntil("pooled", "id-first")).not.toBeNull();
      expect(loadConfig().providers.pooled!.apiKey).toBe("second");
      // "continue": the next request goes straight to the healthy key.
      const next = await postResponses(server, "pooled/m1");
      expect(next.status).toBe(200);
      expect(seen).toEqual(["first", "second", "second"]);
    } finally {
      await server.stop(true);
    }
  });

  test("Responses passthrough: 401 and 429 rotate too", async () => {
    for (const failure of [
      () => Response.json({ error: { message: "invalid api key" } }, { status: 401 }),
      () => Response.json({ error: { message: "rate limited" } }, { status: 429 }),
    ]) {
      clearKeyCooldowns();
      const seen = serveUpstream(key => key === "first" ? failure() : undefined, responsesOk);
      saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
        pooled: pooledProvider("openai-responses", ["first", "second"]),
      } } as OcxConfig);
      const server = startServer(0);
      try {
        const response = await postResponses(server, "pooled/m1");
        expect(response.status).toBe(200);
        expect(seen).toEqual(["first", "second"]);
        expect(getKeyCooldownUntil("pooled", "id-first")).not.toBeNull();
      } finally {
        await server.stop(true);
        upstream?.stop(true);
        upstream = null;
      }
    }
  });

  test("translated adapter (round-robin): 403 'Free quota exhausted' rotates and cools the key actually sent", async () => {
    const seen = serveUpstream(key => key === "beta" ? freeQuota403() : undefined, chatOk);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "rr", providers: {
      rr: pooledProvider("openai-chat", ["alpha", "beta", "gamma"], { apiKeyPoolStrategy: "round-robin" }),
    } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await postResponses(server, "rr/m1");
      expect(response.status).toBe(200);
      // RR picked beta (the committed key's successor); beta's quota verdict moved the request.
      expect(seen[0]).toBe("beta");
      expect(seen).toHaveLength(2);
      expect(seen[1]).not.toBe("beta");
      expect(getKeyCooldownUntil("rr", "id-beta")).not.toBeNull();
      // RR never hands the cooled key out again while it cools.
      for (let index = 0; index < 4; index += 1) {
        expect((await postResponses(server, "rr/m1")).status).toBe(200);
      }
      expect(seen.slice(2)).not.toContain("beta");
    } finally {
      await server.stop(true);
    }
  });

  test("translated adapter: a content-policy 403 is returned as-is and cools nothing", async () => {
    const seen = serveUpstream(() => contentPolicy403(), chatOk);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
      pooled: pooledProvider("openai-chat", ["first", "second"]),
    } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await postResponses(server, "pooled/m1");
      expect(response.status).toBe(403);
      await response.text();
      expect(seen).toEqual(["first"]);
      expect(getKeyCooldownUntil("pooled", "id-first")).toBeNull();
      expect(loadConfig().providers.pooled!.apiKey).toBe("first");
    } finally {
      await server.stop(true);
    }
  });

  test("native Chat: a 400 'credit balance is too low' moves to the next key", async () => {
    const seen = serveUpstream(key => key === "first" ? credit400() : undefined, chatOk);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
      pooled: pooledProvider("openai-chat", ["first", "second"]),
    } } as OcxConfig);
    const server = startServer(0);
    try {
      const response = await postChat(server, "pooled/m1");
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("served by second");
      expect(seen).toEqual(["first", "second"]);
      expect(getKeyCooldownUntil("pooled", "id-first")).not.toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("a pool with no strategy moves off a cooled committed key on the next request (R4)", async () => {
    const seen = serveUpstream(() => undefined, chatOk);
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
      pooled: pooledProvider("openai-chat", ["first", "second"]),
    } } as OcxConfig);
    rotateKeyOn429(loadConfig(), "pooled", null, Date.now(), "first");
    const restored = loadConfig();
    restored.providers.pooled!.apiKey = "first";
    saveConfig(restored);
    const server = startServer(0);
    try {
      expect((await postChat(server, "pooled/m1")).status).toBe(200);
      expect((await postResponses(server, "pooled/m1")).status).toBe(200);
      expect(seen).toEqual(["second", "second"]);
    } finally {
      await server.stop(true);
    }
  });

  test("every key cooling: the request still dispatches once and returns the real upstream error", async () => {
    for (const [adapter, post] of [["openai-chat", postChat], ["openai-chat", postResponses], ["openai-responses", postResponses]] as const) {
      clearKeyCooldowns();
      const seen = serveUpstream(() => deepseek402(), adapter === "openai-responses" ? responsesOk : chatOk);
      saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "pooled", providers: {
        pooled: pooledProvider(adapter, ["first", "second"]),
      } } as OcxConfig);
      const live = loadConfig();
      rotateProviderTransportOnKeyFailure(live, "pooled", routedProviderConfig("pooled", live.providers.pooled!), "balance");
      rotateProviderTransportOnKeyFailure(loadConfig(), "pooled", routedProviderConfig("pooled", loadConfig().providers.pooled!), "balance");
      expect(getKeyCooldownUntil("pooled", "id-first")).not.toBeNull();
      expect(getKeyCooldownUntil("pooled", "id-second")).not.toBeNull();
      const server = startServer(0);
      try {
        const response = await post(server, "pooled/m1");
        expect(response.status).toBe(402);
        expect(await response.text()).toContain("Insufficient Balance");
        expect(seen).toHaveLength(1);
      } finally {
        await server.stop(true);
        upstream?.stop(true);
        upstream = null;
      }
    }
  });
});

describe("combos over an API-key pool (R5)", () => {
  function soloCombo(provider: OcxProviderConfig): OcxConfig {
    return {
      port: 0, hostname: "127.0.0.1", defaultProvider: "pooled",
      providers: { pooled: provider },
      combos: { solo: { strategy: "failover", targets: [{ provider: "pooled", model: "m1" }] } },
    } as OcxConfig;
  }

  test("a single-target combo survives a key-scoped failure and the next request is served", async () => {
    const seen = serveUpstream(key => key === "first" ? deepseek402() : undefined, chatOk);
    saveConfig(soloCombo(pooledProvider("openai-chat", ["first", "second"])));
    const server = startServer(0);
    try {
      const first = await postResponses(server, "combo/solo");
      expect(first.status).toBe(200);
      expect(seen).toEqual(["first", "second"]);
      const next = await postResponses(server, "combo/solo");
      expect(next.status).toBe(200);
      expect(seen).toEqual(["first", "second", "second"]);
    } finally {
      await server.stop(true);
    }
  });

  test("a key-scoped failure that outlives the request budget does not cool the combo while a key is healthy", async () => {
    // Five dead keys and one live one: the request budget stops in-request failover before the
    // live key is reached, so the 402 reaches the combo. A provider-wide cooldown here would
    // answer the next request "No available targets" although `fifth` is healthy.
    const dead = new Set(["k1", "k2", "k3", "k4", "k5"]);
    const seen = serveUpstream(key => dead.has(key) ? deepseek402() : undefined, responsesOk);
    saveConfig(soloCombo(pooledProvider("openai-responses", [...dead, "fifth"])));
    const server = startServer(0);
    try {
      const first = await postResponses(server, "combo/solo");
      // Five sends (the combo target's guarded budget), all dead keys; the real 402 is returned.
      expect(first.status).toBe(402);
      expect(await first.text()).toContain("Insufficient Balance");
      expect(seen).toEqual(["k1", "k2", "k3", "k4", "k5"]);
      // Before the fix the combo cooled its only target here and answered "No available targets".
      const next = await postResponses(server, "combo/solo");
      expect(next.status).toBe(200);
      expect(await next.text()).toContain("served by fifth");
      expect(seen).toEqual(["k1", "k2", "k3", "k4", "k5", "fifth"]);
    } finally {
      await server.stop(true);
    }
  });
});
