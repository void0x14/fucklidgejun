/**
 * Model context windows taken from each vendor's OWN documentation at runtime.
 *
 * Some vendors do not expose a context window on any API surface (MiniMax: /v1/models,
 * /v1/models/<id> and /anthropic/v1/models all return ids only). The value still exists in a
 * machine-readable official source: MiniMax serves its docs as Markdown, and the text-generation
 * page carries a "| Model | Context Window |" table.
 *
 * This module fetches those pages, parses the table, and caches the result on disk so the
 * synchronous catalog path can read it. No window number is written in code: the source of truth
 * is the vendor's page, refreshed on a TTL, and an operator's own config value still wins.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";

/** Providers whose window is documented (not API-exposed): vendor id -> official doc URL. */
export const DOCUMENTED_WINDOW_SOURCES: Record<string, string> = {
  "minimax": "https://platform.minimax.io/docs/guides/text-generation.md",
  "minimax-cn": "https://platform.minimaxi.com/docs/guides/text-generation.md",
};

const CACHE_FILE = "documented-model-windows.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;

interface WindowCache {
  fetchedAt: number;
  /** provider id -> native model id -> context window tokens */
  providers: Record<string, Record<string, number>>;
}

/**
 * Parse every "| model | 1,000,000 | ... |" row of a Markdown table. Model ids keep their
 * vendor casing; a non-numeric or non-positive cell is ignored so captions and headers are not
 * mistaken for a window.
 */
export function parseDocumentedWindowTable(markdown: string): Record<string, number> {
  const windows: Record<string, number> = {};
  for (const line of markdown.split(/\r?\n/)) {
    // Cells arrive with Markdown/JSX wrap: the M3.1 row is
    // "| <span style={{...}}>MiniMax-M3.1-Flash-Preview</span> | 1,000,000 | ... |". Strip tags and
    // emphasis so the model id is read from the cell's text, not its markup.
    const cells = line.split("|").map(cell => cell
      .replace(/<[^>]*>/g, "")
      .replace(/[*_`]/g, "")
      .trim());
    if (cells.length < 4) continue;
    const [, model, window] = cells;
    if (!model || !window) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) continue;
    const normalized = window.replace(/[,_\s]/g, "");
    if (!/^\d{4,}$/.test(normalized)) continue;
    const tokens = Number(normalized);
    if (Number.isSafeInteger(tokens) && tokens > 0) windows[model] = tokens;
  }
  return windows;
}

function cachePath(): string {
  return join(getConfigDir(), CACHE_FILE);
}

/** Cached windows for one provider, read synchronously for the catalog path. */
export function documentedWindowsSync(provider: string): Record<string, number> {
  try {
    const path = cachePath();
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as WindowCache;
    return parsed.providers?.[provider] ?? {};
  } catch {
    return {};
  }
}

function readCache(): WindowCache {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), "utf8")) as WindowCache;
    return { fetchedAt: parsed.fetchedAt ?? 0, providers: parsed.providers ?? {} };
  } catch {
    return { fetchedAt: 0, providers: {} };
  }
}

/**
 * Fetch every documented source and refresh the cache. Best-effort: a network failure keeps the
 * previous cache, and a provider whose page yields no parsed rows keeps its previous entry.
 */
export async function refreshDocumentedModelWindows(
  options: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const previous = readCache();
  if (!options.force && previous.fetchedAt > 0 && now - previous.fetchedAt < CACHE_TTL_MS) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const providers: Record<string, Record<string, number>> = { ...previous.providers };
  let fetchedAny = false;
  for (const [provider, url] of Object.entries(DOCUMENTED_WINDOW_SOURCES)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) continue;
      const windows = parseDocumentedWindowTable(await response.text());
      if (Object.keys(windows).length === 0) continue;
      providers[provider] = windows;
      fetchedAny = true;
    } catch {
      // Keep the previous entry; a stale documented window beats no window.
    } finally {
      clearTimeout(timer);
    }
  }
  if (!fetchedAny) return;
  try {
    const next: WindowCache = { fetchedAt: now, providers };
    writeFileSync(cachePath(), JSON.stringify(next, null, 2));
  } catch {
    // A read-only config dir just means the next boot re-fetches.
  }
}
