import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { routedProviderConfig } from "../../src/router";
import { MINIMAX_CN_BASE_URL, MINIMAX_INTL_BASE_URL } from "../../src/providers/base-url-choices";
import { detectProviderKeyRegions, providerDeclaredRegionEndpoints } from "../../src/providers/region-detect";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home: string;

function configWith(provider: Partial<OcxProviderConfig>, id = "minimax-cn"): OcxConfig {
  const config = {
    port: 10199,
    defaultProvider: id,
    providers: {
      [id]: {
        adapter: "openai-chat",
        baseUrl: MINIMAX_CN_BASE_URL,
        authMode: "key",
        defaultModel: "MiniMax-M3",
        ...provider,
      } as OcxProviderConfig,
    },
  } as OcxConfig;
  saveConfig(config);
  return config;
}

/** A fake upstream: "cn-" keys authenticate on .com, "gl-" keys on .io, "dead-" nowhere. */
function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const key = authorization.replace(/^Bearer\s+/i, "");
    const onCn = url.includes("api.minimaxi.com");
    const ok = (key.startsWith("cn-") && onCn) || (key.startsWith("gl-") && !onCn);
    return new Response(null, { status: ok ? 200 : 401 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-region-detect-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  delete process.env.OPENCODEX_HOME;
  removeTreeWithRetry(home);
});

describe("providerDeclaredRegionEndpoints", () => {
  test("lists the two MiniMax hosts with labels; single-host providers list none", () => {
    const endpoints = providerDeclaredRegionEndpoints("minimax-cn");
    expect(endpoints.map(entry => entry.baseUrl).sort()).toEqual([MINIMAX_CN_BASE_URL, MINIMAX_INTL_BASE_URL].sort());
    expect(endpoints.every(entry => entry.label.length > 0)).toBe(true);
    // A provider with one official host has no region surface.
    expect(providerDeclaredRegionEndpoints("deepseek")).toEqual([]);
    expect(providerDeclaredRegionEndpoints("not-a-provider")).toEqual([]);
  });
});

describe("routedProviderConfig per-key endpoint", () => {
  test("a declared pool-entry endpoint outranks the provider row", () => {
    const config = configWith({
      apiKey: "gl-aaaa",
      apiKeyPool: [{ id: "g1", key: "gl-aaaa", baseUrl: MINIMAX_INTL_BASE_URL }],
    });
    expect(routedProviderConfig("minimax-cn", config.providers["minimax-cn"]!).baseUrl).toBe(MINIMAX_INTL_BASE_URL);
  });

  test("an undeclared per-key endpoint is ignored (pinned-identity boundary holds)", () => {
    const config = configWith({
      apiKey: "cn-aaaa",
      apiKeyPool: [{ id: "c1", key: "cn-aaaa", baseUrl: "https://evil.example/v1" }],
    });
    expect(routedProviderConfig("minimax-cn", config.providers["minimax-cn"]!).baseUrl).toBe(MINIMAX_CN_BASE_URL);
  });
});

describe("detectProviderKeyRegions", () => {
  test("detects and persists each key's real host, leaving a key that works nowhere unresolved", async () => {
    const config = configWith({
      apiKey: "cn-1",
      apiKeyPool: [
        { id: "c1", key: "cn-1" },
        { id: "g1", key: "gl-1" },
        { id: "x1", key: "dead-1" },
      ],
    });
    const detection = await detectProviderKeyRegions(config, "minimax-cn", { fetchImpl: fakeFetch(), timeoutMs: 2000 });

    expect(detection.status).toBe("ok");
    expect(detection.detected).toBe(2);
    expect(detection.unresolved).toBe(1);
    const byId = new Map(detection.results.map(row => [row.id, row]));
    expect(byId.get("c1")).toMatchObject({ status: "detected", endpoint: MINIMAX_CN_BASE_URL });
    expect(byId.get("g1")).toMatchObject({ status: "detected", endpoint: MINIMAX_INTL_BASE_URL });
    expect(byId.get("x1")).toMatchObject({ status: "unresolvable" });

    // Persisted to disk and reflected on the live row, so routing now sends each key home.
    const persisted = loadConfig().providers["minimax-cn"]!;
    const pool = new Map((persisted.apiKeyPool ?? []).map(entry => [entry.id, entry.baseUrl]));
    expect(pool.get("c1")).toBe(MINIMAX_CN_BASE_URL);
    expect(pool.get("g1")).toBe(MINIMAX_INTL_BASE_URL);
    expect(pool.get("x1")).toBeUndefined();
    expect(routedProviderConfig("minimax-cn", config.providers["minimax-cn"]!).baseUrl).toBe(MINIMAX_CN_BASE_URL);
  });

  test("already-detected keys are left untouched unless force is set", async () => {
    const config = configWith({
      apiKey: "gl-1",
      apiKeyPool: [{ id: "g1", key: "gl-1", baseUrl: MINIMAX_INTL_BASE_URL }],
    });
    const skip = await detectProviderKeyRegions(config, "minimax-cn", { fetchImpl: fakeFetch() });
    expect(skip.results[0]).toMatchObject({ status: "unchanged", endpoint: MINIMAX_INTL_BASE_URL });
    const forced = await detectProviderKeyRegions(config, "minimax-cn", { fetchImpl: fakeFetch(), force: true });
    expect(forced.results[0]).toMatchObject({ status: "detected", endpoint: MINIMAX_INTL_BASE_URL });
  });

  test("a single-host provider is unsupported and probes nothing", async () => {
    const config = {
      port: 10199,
      defaultProvider: "p",
      providers: {
        p: { adapter: "openai-chat", baseUrl: "https://api.example.com/v1", authMode: "key", apiKey: "k", apiKeyPool: [{ id: "a", key: "k" }] } as OcxProviderConfig,
      },
    } as OcxConfig;
    saveConfig(config);
    let called = false;
    const spy = (async () => { called = true; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const detection = await detectProviderKeyRegions(config, "p", { fetchImpl: spy });
    expect(detection.status).toBe("unsupported");
    expect(called).toBe(false);
  });
});
