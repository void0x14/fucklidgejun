import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import { useProviderAccountPools } from "../src/hooks/useProviderAccountPools";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { ProviderAuthHandlers } from "../src/components/provider-workspace/types";

const REFRESH_URL = "/proxy/api/providers/keys/refresh";
const BUTTON_LABEL = "Fetch keys from source";
const BUSY_LABEL = "Fetching keys…";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT", "fetch"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let fetchMock: ReturnType<typeof mock>;

/**
 * The provider has its source turned on: the fetch button is only offered once a
 * source is configured, because pressing it with none is a guaranteed 400.
 */
const ITEM: WorkspaceItem = {
  name: "deepseek",
  adapter: "openai",
  baseUrl: "https://api.deepseek.com",
  authMode: "key",
  hasApiKey: true,
  keySourceStatus: { enabled: true, url: "http://127.0.0.1:8787", topic: "deepseek", refreshDays: 7 },
};

const ITEM_NO_SOURCE: WorkspaceItem = { ...ITEM, keySourceStatus: undefined };

function baseHandlers(): ProviderAuthHandlers {
  return {
    onLogin: () => {}, onLogout: () => {}, onReauth: () => {}, onSwitchAccount: () => {}, onRemoveAccount: () => {},
    onAddApiKey: async () => true, onSwitchApiKey: () => {}, onRemoveApiKey: () => {}, onEditAlias: () => {},
  };
}

/**
 * The pool hook owns the request, so the test drives the real one rather than a stub:
 * a control that rendered but posted nothing would still pass on a stub.
 * `config: null` keeps the bootstrap roster effects from firing, so every fetch this
 * file makes comes from the click under test.
 */
function Harness({ withSourceFetch, item = ITEM }: { withSourceFetch: boolean; item?: WorkspaceItem }) {
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
  const handlers: ProviderAuthHandlers = {
    ...baseHandlers(),
    ...(withSourceFetch ? { onRefreshKeysFromSource: pools.refreshKeysFromSource } : {}),
  };
  return <ProviderAuthPanel item={item} apiBase="/proxy" authHandlers={handlers} />;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => win.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  fetchMock = mock(async (url: string) => new Response(JSON.stringify(
    url === REFRESH_URL
      ? { ok: true, added: 2, existing: 5, verified: 7, scanned: 40, checked: 12, reused: 28 }
      : { activeId: null, keys: [] },
  )));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document }, window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator }, localStorage: { configurable: true, value: win.localStorage },
    fetch: { configurable: true, value: fetchMock },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) { const current = root; await act(async () => { current.unmount(); }); root = null; }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await win.happyDOM?.close?.();
});

async function mount(withSourceFetch = true, item: WorkspaceItem = ITEM) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><Harness withSourceFetch={withSourceFetch} item={item} /></LanguageProvider>);
  });
  await act(async () => { await flush(); });
}

function sourceButton(): HTMLButtonElement | null {
  return [...host.querySelectorAll("button")]
    .find(button => button.textContent?.includes(BUTTON_LABEL) || button.textContent?.includes(BUSY_LABEL)) ?? null;
}

/** Only the refresh call is under test; the post-success roster read is not. */
function refreshCalls(): [string, RequestInit][] {
  return (fetchMock.mock.calls as [string, RequestInit][]).filter(([url]) => url === REFRESH_URL);
}

test("the button posts the frozen refresh contract exactly once", async () => {
  await mount();

  await act(async () => { sourceButton()!.click(); await flush(); });

  const calls = refreshCalls();
  expect(calls).toHaveLength(1);
  const [url, init] = calls[0];
  expect(url).toBe(REFRESH_URL);
  expect(init.method).toBe("POST");
  expect(init.body).toBe('{"name":"deepseek"}');
});

test("no fetch button renders when the provider has no source configured", async () => {
  await mount(true, ITEM_NO_SOURCE);

  // The toggle is what turns sourcing on; offering the fetch button without one
  // is a button whose only possible outcome is a 400.
  expect(sourceButton()).toBeNull();
  expect(refreshCalls()).toHaveLength(0);
});

test("the button is disabled until the in-flight refresh settles", async () => {
  let release!: () => void;
  fetchMock.mockImplementationOnce(async (url: string) => {
    if (url === REFRESH_URL) await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify({ ok: true, added: 1 }));
  });
  await mount();

  await act(async () => { sourceButton()!.click(); await flush(); });
  expect(refreshCalls()).toHaveLength(1);
  expect(sourceButton()!.disabled).toBe(true);
  expect(sourceButton()!.textContent).toContain(BUSY_LABEL);

  // A disabled control must not issue a second refresh for the same click burst.
  await act(async () => { sourceButton()!.click(); await flush(); });
  expect(refreshCalls()).toHaveLength(1);

  await act(async () => { release(); await flush(); });
  expect(sourceButton()!.disabled).toBe(false);
  expect(sourceButton()!.textContent).toContain(BUTTON_LABEL);
});
