/**
 * Weekly background refresh for opt-in provider key pools.
 *
 * Shape follows src/codex/catalog-auto-refresh.ts: a module-singleton unref'd interval whose
 * config gate lives in the callee, so enabling or re-pointing a provider's keySource takes
 * effect on the next tick without a restart. Every heavy module — the config barrel and the
 * key-source client — is an import() inside tick(), so importing this module at startup costs
 * nothing.
 *
 * The per-provider `refreshDays` window is enforced against an in-memory last-run stamp rather
 * than a persisted one: the job appends keys, it does not own state, and a stamp on disk would
 * be a second source of truth for something whose only consequence is doing it sooner or later.
 */
import { registerOptionalShutdownHook } from "../lib/optional-shutdown-hooks";

const DEFAULT_KEY_SOURCE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60_000;
const DAY_MS = 86_400_000;

let timer: ReturnType<typeof setInterval> | null = null;
let detachShutdownHook: (() => void) | null = null;
/** Bumped by every start and stop, so in-flight work cannot publish into a dead generation. */
let generation = 0;
/** setInterval does not skip a firing while the previous callback is still awaiting. */
let inFlight = false;
const lastRunByProvider = new Map<string, number>();

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  const entryGeneration = generation;
  try {
    const [{ loadConfig }, { keySourceSettings, syncProviderKeysFromSource }] = await Promise.all([
      import("../config"),
      import("./key-source"),
    ]);
    const config = loadConfig();
    const now = Date.now();
    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      if (entryGeneration !== generation) return;
      const settings = keySourceSettings(provider, name);
      if (!settings) continue;
      const lastRun = lastRunByProvider.get(name);
      // Absent stamp means the first tick runs once per opted-in provider — refresh on boot.
      if (lastRun !== undefined && now - lastRun < settings.refreshDays * DAY_MS) continue;
      lastRunByProvider.set(name, now);
      const result = await syncProviderKeysFromSource(config, name);
      if (entryGeneration !== generation) return;
      // Privacy scan: counts only, never a provider name, topic title, or key.
      if (!("error" in result) && result.added > 0) console.info("[key-source-refresh] verified keys appended");
    }
  } catch {
    // A failed collection is not worth surfacing: the next tick tries again.
  } finally {
    inFlight = false;
  }
}

/** Idempotent. A second call while running is a no-op, matching startCatalogAutoRefresh. */
export function startKeySourceRefresh(intervalMs = DEFAULT_KEY_SOURCE_REFRESH_INTERVAL_MS): void {
  if (timer) return;
  generation += 1;
  timer = setInterval(() => void tick(), intervalMs);
  // Never keep the process alive for a key refresh.
  timer.unref?.();
  detachShutdownHook = registerOptionalShutdownHook("key-source-refresh", stopKeySourceRefresh);
}

export function stopKeySourceRefresh(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  generation += 1;
  detachShutdownHook?.();
  detachShutdownHook = null;
}

export function isKeySourceRefreshRunning(): boolean {
  return timer !== null;
}

/** Test-only: run one tick synchronously rather than waiting out the interval. */
export async function runKeySourceRefreshTickForTests(): Promise<void> {
  await tick();
}

/** Test-only: last-run stamp for one provider, so a window test can assert the skip. */
export function keySourceRefreshLastRunForTests(name: string): number | undefined {
  return lastRunByProvider.get(name);
}

export function resetKeySourceRefreshForTests(): void {
  stopKeySourceRefresh();
  lastRunByProvider.clear();
}