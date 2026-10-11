import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managementFetch as fetch } from "../helpers/management-auth";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import {
  DEFAULT_KEY_SOURCE_REFRESH_DAYS,
  DEFAULT_KEY_SOURCE_URL,
  keySourceSettings,
} from "../../src/providers/key-source";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ACTIVE_KEY = "key-active-000111222333";
const TOKEN_ENV = "OPENCODEX_KEY_SOURCE_TOKEN";
const KEY_SOURCE_FIXTURE = "key-source-fixture";

let testDir = "";
let previousHome: string | undefined;
let previousToken: string | undefined;
let previousStateHome: string | undefined;
let stateHome = "";
let isolatedCodexHome: IsolatedCodexHome | null = null;
let keyChecker: ReturnType<typeof Bun.serve> | null = null;
/** What the fake key-checker actually saw, so the request contract is asserted, not assumed. */
let seen: { path: string; method: string; body: unknown; authorization: string | null } | null = null;
let payloadKeys: string[] = [];

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "minimax",
    providers: {
      minimax: {
        adapter: "openai-chat",
        baseUrl: "https://api.minimax.io/v1",
        apiKey: ACTIVE_KEY,
      },
      // Opted out on purpose: the 400 case must never reach the fake service.
      secondary: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", apiKey: "key-secondary-999" },
    },
  } as OcxConfig;
}

/** A stand-in for the external key-checker daemon; the suite never touches the network. */
function startKeyChecker(): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const raw = await request.text();
      seen = {
        path: new URL(request.url).pathname,
        method: request.method,
        body: raw ? JSON.parse(raw) : null,
        authorization: request.headers.get("authorization"),
      };
      return Response.json({
        provider: "minimax", topicId: 12, topicTitle: "MiniMax",
        keys: payloadKeys, scanned: 40, checked: 12, reused: 28,
      });
    },
  });
  keyChecker = server;
  return `http://127.0.0.1:${server.port}`;
}

function readDiskProvider(): {
  apiKey?: string;
  apiKeyPool?: Array<{ id: string; key: string; label?: string }>;
  apiKeySelectionRevision?: string;
} {
  return JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")).providers.minimax;
}

function post(serverUrl: string, name: string) {
  return fetch(new URL("/api/providers/keys/refresh", serverUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  previousToken = process.env[TOKEN_ENV];
  previousStateHome = process.env.XDG_STATE_HOME;
  delete process.env[TOKEN_ENV];
  // An empty state home keeps keySourceToken() off the real ~/.local/state/key-checker.
  stateHome = mkdtempSync(join(tmpdir(), "ocx-key-source-state-"));
  process.env.XDG_STATE_HOME = stateHome;
  isolatedCodexHome = installIsolatedCodexHome("ocx-key-source-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-key-source-"));
  process.env.OPENCODEX_HOME = testDir;
  seen = null;
  payloadKeys = [];
  const config = baseConfig();
  config.providers.minimax!.keySource = { url: startKeyChecker() };
  saveConfig(config);
});

afterEach(() => {
  keyChecker?.stop(true);
  keyChecker = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousToken === undefined) delete process.env[TOKEN_ENV];
  else process.env[TOKEN_ENV] = previousToken;
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  if (stateHome) removeTreeWithRetry(stateHome);
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

describe("key source refresh route", () => {
  test("appends verified keys and leaves the operator's active key byte-identical", async () => {
    payloadKeys = ["key-telegram-a", "key-telegram-b"];
    const before = readDiskProvider();
    const server = startServer(0);
    try {
      const res = await post(server.url, "minimax");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true, added: 2, existing: 0, verified: 2, scanned: 40, checked: 12, reused: 28,
      });

      const after = readDiskProvider();
      // The single most important assertion: sourcing capacity must not re-key routing, and
      // a revision bump here would fail every in-flight round-robin key pick.
      expect(after.apiKey).toBe(ACTIVE_KEY);
      expect(after.apiKey).toBe(before.apiKey);
      expect(after.apiKeySelectionRevision).toBe(before.apiKeySelectionRevision);
      expect(after.apiKeyPool!.map(entry => entry.key)).toEqual([ACTIVE_KEY, "key-telegram-a", "key-telegram-b"]);
      expect(after.apiKeyPool!.slice(1).every(entry => entry.label === "telegram")).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("an existing pool member and a duplicate inside one payload are each added exactly once", async () => {
    payloadKeys = [ACTIVE_KEY, "key-telegram-a", "key-telegram-a", "key-telegram-b", "  key-telegram-c  "];
    const server = startServer(0);
    try {
      const body = await post(server.url, "minimax").then(r => r.json()) as { added: number; existing: number; verified: number };
      expect(body.verified).toBe(4);
      expect(body.added).toBe(3);
      expect(body.existing).toBe(1);
      const pool = readDiskProvider().apiKeyPool!;
      expect(pool.map(entry => entry.key)).toEqual([ACTIVE_KEY, "key-telegram-a", "key-telegram-b", "key-telegram-c"]);
      expect(new Set(pool.map(entry => entry.key)).size).toBe(pool.length);
    } finally {
      await server.stop(true);
    }
  });

  test("a second refresh adds nothing and leaves the pool length identical", async () => {
    payloadKeys = ["key-telegram-a"];
    const server = startServer(0);
    try {
      expect((await post(server.url, "minimax").then(r => r.json()) as { added: number }).added).toBe(1);
      const firstPool = readDiskProvider().apiKeyPool!;
      const second = await post(server.url, "minimax").then(r => r.json()) as { added: number; existing: number };
      expect(second.added).toBe(0);
      expect(second.existing).toBe(1);
      expect(readDiskProvider().apiKeyPool!.length).toBe(firstPool.length);
    } finally {
      await server.stop(true);
    }
  });

test("the call carries the collect contract: path, method, default topic body, and the bearer token", async () => {
payloadKeys = ["key-telegram-a"];
// Kept under the privacy scanner's bearer-token length floor: a longer fixture reads as
// a credential and fails the scan for a value that is obviously not one.
process.env[TOKEN_ENV] = KEY_SOURCE_FIXTURE;
const server = startServer(0);
try {
await post(server.url, "minimax");
expect(seen).toEqual({
path: "/collect",
method: "POST",
body: { provider: "minimax" },
authorization: `Bearer ${KEY_SOURCE_FIXTURE}`,
});
} finally {
await server.stop(true);
}
});

  test("without a token the Authorization header is omitted rather than sent empty", async () => {
    payloadKeys = ["key-telegram-a"];
    const server = startServer(0);
    try {
      await post(server.url, "minimax");
      expect(seen?.authorization).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("a provider without keySource is refused with 400 and is never contacted", async () => {
    const server = startServer(0);
    try {
      const res = await post(server.url, "secondary");
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe("provider has no keySource configured");
      expect(seen).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("an unknown provider is 404", async () => {
    const server = startServer(0);
    try {
      const res = await post(server.url, "nope");
      expect(res.status).toBe(404);
      expect((await res.json() as { error: string }).error).toBe("unknown provider");
      expect(seen).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

// The key-checker is a separate process an operator may simply not have started. That
// failure must arrive as a readable JSON error, not as an exception thrown past the
// management dispatcher into an opaque 500 -- which is exactly what happened before.
test("an unreachable key-checker is a 502 with the reason, not a thrown request", async () => {
keyChecker?.stop(true);
const deadPort = keyChecker!.port;
keyChecker = null;
const config = baseConfig();
config.providers.minimax!.keySource = { url: `http://127.0.0.1:${deadPort}` };
saveConfig(config);
const server = startServer(0);
try {
const res = await post(server.url, "minimax");
expect(res.status).toBe(502);
const body = await res.json() as { error: string };
expect(body.error).toStartWith("key source unavailable: ");
// A failed run must not have touched the provider at all.
expect(readDiskProvider().apiKey).toBe(ACTIVE_KEY);
expect(readDiskProvider().apiKeyPool).toBeUndefined();
} finally {
await server.stop(true);
}
});

test("an error reply from key-checker is reported verbatim instead of being flattened to a status", async () => {
keyChecker?.stop(true);
keyChecker = Bun.serve({ port: 0, fetch: () => Response.json({ error: "no in-scope topic for provider \"cohere\"" }, { status: 502 }) });
const config = baseConfig();
config.providers.minimax!.keySource = { url: `http://127.0.0.1:${keyChecker.port}` };
saveConfig(config);
const server = startServer(0);
try {
const res = await post(server.url, "minimax");
expect(res.status).toBe(502);
expect((await res.json() as { error: string }).error).toBe('key source unavailable: no in-scope topic for provider "cohere"');
} finally {
await server.stop(true);
}
});
});

describe("keySourceSettings defaults", () => {
  const provider = (keySource?: { url?: string; topic?: string; refreshDays?: number }) =>
    ({ adapter: "openai-chat", baseUrl: "https://example.invalid", ...(keySource ? { keySource } : {}) } as const);

  test("an absent keySource is the off switch", () => {
    expect(keySourceSettings(provider(), "minimax")).toBeNull();
    expect(keySourceSettings(undefined, "minimax")).toBeNull();
  });

  test("a bare opt-in takes every default", () => {
    expect(keySourceSettings(provider({}), "minimax")).toEqual({
      url: DEFAULT_KEY_SOURCE_URL,
      topic: "minimax",
      refreshDays: DEFAULT_KEY_SOURCE_REFRESH_DAYS,
    });
  });

  test("blank and non-positive values degrade to the defaults, explicit values win", () => {
    expect(keySourceSettings(provider({ url: "  ", topic: "   ", refreshDays: 0 }), "minimax")).toEqual({
      url: DEFAULT_KEY_SOURCE_URL,
      topic: "minimax",
      refreshDays: DEFAULT_KEY_SOURCE_REFRESH_DAYS,
    });
    expect(keySourceSettings(provider({ refreshDays: -3 }), "minimax")?.refreshDays).toBe(DEFAULT_KEY_SOURCE_REFRESH_DAYS);
    expect(keySourceSettings(provider({ refreshDays: 2.9 }), "minimax")?.refreshDays).toBe(2);
    expect(keySourceSettings(provider({ url: " http://127.0.0.1:9000 ", topic: " MiniMax ", refreshDays: 30 }), "minimax")).toEqual({
      url: "http://127.0.0.1:9000",
      topic: "MiniMax",
      refreshDays: 30,
    });
  });
});