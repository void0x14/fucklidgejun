import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ApiKeyRow, KeyRegionEndpoint, ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;

const ENDPOINTS: KeyRegionEndpoint[] = [
  { id: "international", label: "International (.io)", baseUrl: "https://api.minimax.io/v1" },
  { id: "china", label: "China (.com)", baseUrl: "https://api.minimaxi.com/v1" },
];

const ITEM: WorkspaceItem = {
  name: "minimax-cn", adapter: "openai-chat", baseUrl: "https://api.minimaxi.com/v1", authMode: "key", hasApiKey: true,
};

function key(id: string, endpoint?: string): ApiKeyRow {
  return { id, masked: id + "****", active: id === "cn1", endpoint };
}

function handlers(onDetectRegions?: ProviderAuthHandlers["onDetectRegions"]): ProviderAuthHandlers {
  return {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
    ...(onDetectRegions ? { onDetectRegions } : {}),
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => win.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(name => [name, Reflect.get(globalThis, name)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    fetch: { configurable: true, value: mock(async () => new Response("{}")) },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  for (const name of globals) Object.defineProperty(globalThis, name, { configurable: true, value: previous[name] });
  await win.happyDOM?.close?.();
});

async function mount(keys: ApiKeyRow[], authHandlers: ProviderAuthHandlers, endpoints: KeyRegionEndpoint[] = ENDPOINTS) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel item={ITEM} apiBase="/proxy" keys={keys} endpoints={endpoints} accountLoadState="ready" authHandlers={authHandlers} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
}

function buttonWith(text: string): HTMLButtonElement | null {
  return [...host.querySelectorAll("button")].find(b => b.textContent?.includes(text)) ?? null;
}

test("every key shows its detected region, and an undetected key is called out", async () => {
  await mount(
    [key("cn1", "https://api.minimaxi.com/v1"), key("gl1", "https://api.minimax.io/v1"), key("x1")],
    handlers(async () => ({ detected: 0, unresolved: 0 })),
  );

  expect(host.textContent).toContain("Region: China (.com)");
  expect(host.textContent).toContain("Region: International (.io)");
  expect(host.textContent).toContain("region not detected");
});

test("no region surface renders for a single-host provider", async () => {
  await mount([key("cn1")], handlers(async () => ({ detected: 0, unresolved: 0 })), []);

  expect(host.textContent).not.toContain("Region:");
  expect(buttonWith("Detect regions")).toBeNull();
});

test("Detect regions calls the handler and shows the result tally", async () => {
  const calls: Array<[string, boolean | undefined]> = [];
  await mount([key("cn1", "https://api.minimaxi.com/v1")], handlers(async (provider, force) => {
    calls.push([provider, force]);
    return { detected: 6, unresolved: 1 };
  }));

  const detect = buttonWith("Detect regions");
  expect(detect).not.toBeNull();
  await act(async () => { detect!.click(); await flush(); });

  expect(calls).toEqual([["minimax-cn", false]]);
  expect(host.textContent).toContain("Detected 6 key(s)");
  expect(host.textContent).toContain("1 could not be matched to a host");
});

/**
 * The panel only shows the region surface when the POOL HOOK captured the declared endpoints
 * from the roster response. The recovery/invalidation read is a second code path and previously
 * dropped them, so the badges silently vanished after a roster refresh — drive the real hook and
 * assert the endpoints survive that path.
 */
function HookHarness() {
  const pools = useProviderAccountPools({
    apiBase: "/proxy",
    t: key => key,
    config: null,
    oauthStatus: {},
    aliveRef: { current: true },
    notify: () => {},
    fetchConfig: async () => {},
    fetchOauth: async () => {},
    fetchProviderQuotas: async () => {},
    codexActiveNeedsReauth: false,
  });
  return (
    <div>
      <button type="button" onClick={() => { void pools.refreshAccountRosters({ provider: "minimax-cn", kind: "api-key" }); }}>
        load-roster
      </button>
      <span data-testid="endpoint-count">{pools.keyEndpoints["minimax-cn"]?.length ?? 0}</span>
      <span data-testid="key-count">{pools.keyPools["minimax-cn"]?.length ?? 0}</span>
      <ProviderAuthPanel
        item={ITEM}
        apiBase="/proxy"
        keys={pools.keyPools["minimax-cn"] ?? []}
        endpoints={pools.keyEndpoints["minimax-cn"] ?? []}
        accountLoadState="ready"
        authHandlers={handlers(async () => ({ detected: 0, unresolved: 0 }))}
      />
    </div>
  );
}

test("the roster-refresh path still carries the declared endpoints into the panel", async () => {
  const rosterCalls: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: mock(async (input: string) => {
      rosterCalls.push(String(input));
      return new Response(JSON.stringify({
        activeId: "cn1",
        endpoints: ENDPOINTS,
        keys: [key("cn1", "https://api.minimaxi.com/v1")],
      }));
    }),
  });
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><HookHarness /></LanguageProvider>);
  });
  await act(async () => { await flush(); });

  await act(async () => {
    host.querySelector("button")!.click();
    await flush();
  });

  expect(rosterCalls).toHaveLength(1);
  expect(host.querySelector('[data-testid="endpoint-count"]')!.textContent).toBe("2");
  expect(host.textContent).toContain("Region: China (.com)");
  expect(buttonWith("Detect regions")).not.toBeNull();
});
