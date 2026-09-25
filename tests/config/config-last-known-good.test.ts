import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, getDefaultConfig, loadConfig } from "../../src/config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * A config that fails validation must keep serving the last successfully loaded
 * config for that path. On 2026-09-25 a run of invalid writes made every load
 * serve bare defaults for two minutes, retiring google-antigravity mid-task and
 * turning ordinary Codex turns into "The '...' model is not supported when using
 * Codex with a ChatGPT account." refusals. A parse failure is not evidence the
 * previous config was wrong.
 */
let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-last-known-good-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function validConfig(providerKey: string, apiKey: string) {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    defaultProvider: providerKey,
    providers: {
      [providerKey]: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey,
      },
    },
  };
}

/** The exact failure shape seen in production: a written provider missing required fields. */
function invalidConfig() {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-good",
      },
      workbuddy: {},
    },
  };
}

function writeConfig(value: unknown): void {
  writeFileSync(getConfigPath(), JSON.stringify(value, null, 2) + "\n");
}

test("a later invalid config keeps serving the last known good providers", () => {
  writeConfig(validConfig("xai", "xai-good"));
  const first = loadConfig();
  expect(first.providers.xai).toBeDefined();

  writeConfig(invalidConfig());
  const second = loadConfig();
  expect(second.providers.xai).toBeDefined();
  expect((second.providers.xai as { apiKey?: string }).apiKey).toBe("xai-good");
  expect(second.providers.workbuddy).toBeUndefined();
});

test("a valid config written after the broken one replaces the served config", () => {
  writeConfig(validConfig("xai", "xai-first"));
  expect(loadConfig().providers.xai).toBeDefined();

  writeConfig(invalidConfig());
  expect(loadConfig().providers.xai).toBeDefined();

  writeConfig(validConfig("xai", "xai-second"));
  const recovered = loadConfig();
  expect((recovered.providers.xai as { apiKey?: string }).apiKey).toBe("xai-second");
});

test("a missing config file still resets instead of serving a stale fallback", () => {
  writeConfig(validConfig("xai", "xai-good"));
  expect(loadConfig().providers.xai).toBeDefined();

  const path = getConfigPath();
  unlinkSync(path);
  expect(existsSync(path)).toBe(false);
  expect(loadConfig().providers.xai).toBeUndefined();
});

test("another home's broken config never observes this home's fallback", () => {
  writeConfig(validConfig("xai", "xai-home-one"));
  expect(loadConfig().providers.xai).toBeDefined();

  const previousHome = home;
  const otherHome = mkdtempSync(join(tmpdir(), "ocx-last-known-good-other-"));
  try {
    home = otherHome;
    process.env.OPENCODEX_HOME = otherHome;
    writeConfig(invalidConfig());
    const other = loadConfig();
    expect(other.providers.xai).toBeUndefined();
  } finally {
    home = previousHome;
    process.env.OPENCODEX_HOME = previousHome;
  }
});

test("the invalid-config warning names the last-known-good serving", () => {
  writeConfig(validConfig("xai", "xai-good"));
  expect(loadConfig().providers.xai).toBeDefined();

  writeConfig(invalidConfig());
  const errorSpy = spyOn(console, "error");
  try {
    loadConfig();
    expect(errorSpy.mock.calls.join("\n")).toContain("Serving the last known good config");
  } finally {
    errorSpy.mockRestore();
  }
});
