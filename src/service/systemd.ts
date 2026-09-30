import { execSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV, durableBunRuntime, type DurableBunRuntime } from "../lib/bun-runtime";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { systemdProperty } from "../service-manager-probe";
import { writeServiceApiTokenFile, sh } from "./guards";
import { shellQuote, buildServiceShellCommand, buildServiceLauncherShellCommand, resolvedProxyEnv } from "./health";
import type { ServiceInstallCleanupOps } from "./orchestration";
import { SERVICE_MANAGED_ENV, TASK, cliEntry, stableLauncherEntry, logPath, serviceStatePath, currentCodexSqliteHomeAbsolute, writeServiceInstallState } from "./state";
import { writeServiceDefinitionFile } from "./windows-ops";

/** The `--port <n>` baked into the installed systemd user unit. Linux only. */
export function systemdListenPort(deps: { readUnit?: () => string } = {}): number | null {
  try {
    const text = (deps.readUnit ?? (() => readFileSync(unitPath(), "utf8")))();
    const last = [...text.matchAll(/start --port (\d{1,5})(?:\s|"|$)/gm)].at(-1);
    if (!last) return null;
    const n = Number(last[1]);
    return n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

export function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(
  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
  deps: { launcher?: string | null; runtime?: DurableBunRuntime } = {},
): string {
  const runtime = deps.runtime ?? durableBunRuntime();
  const { bun, bunRuntimeSource, cli } = cliEntry(runtime);
  // Discovery belongs to installSystemd(), which resolves once and passes the same value to
  // both the unit and install state. Keeping this builder explicit makes tests and diagnostics
  // independent of the host PATH.
  const launcher = deps.launcher ?? null;
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const codexSqliteHome = systemdEnvironmentAssignment("CODEX_SQLITE_HOME", currentCodexSqliteHomeAbsolute());
  const opencodexHome = systemdEnvironmentAssignment("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment(SERVICE_MANAGED_ENV, "1"),
    ...(launcher ? [] : [
      systemdEnvironmentAssignment(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource),
      systemdEnvironmentAssignment(BUN_RUNTIME_PATH_ENV, bun),
    ]),
    // A launcher normally resolves the current package's bundled Bun after every upgrade.
    // Preserve only a proof-bound shell override; otherwise writing a package-local path here
    // would recreate the version-manager pin that the launcher mode exists to remove.
    launcher && runtime.source === "override"
      ? systemdEnvironmentAssignment(runtime.overrideEnv, runtime.path)
      : null,
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    codexSqliteHome,
    opencodexHome,
    ...proxyEnv.map(({ name, value }) => systemdEnvironmentAssignment(name, value)),
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = `${launcher ? buildServiceLauncherShellCommand(launcher) : buildServiceShellCommand(bun, cli)} >> ${shellQuote(log)} 2>&1`;
  // home.mount ordering: on btrfs/multi-disk hosts, /home can be mounted AFTER the user
  // manager starts. When that happens, every unit under ~/.config/systemd/user (including
  // this one) is invisible to the user manager at default.target evaluation time, so the
  // enabled unit is never queued and the proxy is silently absent until a manual start.
  // `After=`/`Wants=` here keep the unit ordered behind the home mount whenever the unit
  // is loaded; the user@.service drop-in written by ensureUserManagerHomeWaitDropIn()
  // covers the harder case where the user manager itself must wait for /home to exist.
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
After=home.mount
Wants=network-online.target
Wants=home.mount

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(command)}
Restart=on-failure
RestartSec=5
${envLines}

[Install]
WantedBy=default.target
`;
}

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

export function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ocx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

/**
 * Whether the user manager started before /home was mounted, leaving every
 * `~/.config/systemd/user` unit invisible to it (units never queued at boot).
 * Detects the boot race the drop-in below prevents; false when uncertain.
 */
export function userManagerStartedBeforeHomeMount(
  deps: { show?: (unit: string, property: string) => string } = {},
): boolean {
  const exec = (command: string) => execSync(command, { stdio: "pipe" }).toString();
  const show = deps.show ?? ((unit: string, property: string) => exec(`systemctl show ${unit} -p ${property} --value`));
  try {
    const userUpAt = Number(show("--user", "ActiveEnterTimestampMonotonic").trim());
    if (!Number.isFinite(userUpAt) || userUpAt <= 0) return false;
    const homeUpAt = Number(show("home.mount", "ActiveEnterTimestampMonotonic").trim());
    // Mount finished after the user manager came up (or never within this boot): race hit.
    return !Number.isFinite(homeUpAt) || homeUpAt <= 0 || homeUpAt > userUpAt;
  } catch {
    return false;
  }
}

/**
 * Writes a manager-level drop-in ordering `user@.service` after `home.mount`, so the
 * user manager cannot evaluate `default.target` before `/home` (and every unit under
 * `~/.config/systemd/user`) is visible. Needs root on most distros; failures are
 * non-fatal because buildUnit() also bakes After=/Wants=home.mount into the unit.
 */
export function ensureUserManagerHomeWaitDropIn(): void {
  if (process.platform !== "linux") return;
  const dir = "/etc/systemd/system/user@.service.d";
  const file = join(dir, "ocx-wait-for-home.conf");
  const contents = [
    "# Managed by opencodex — orders user@.service after home.mount so the user manager",
    "# never evaluates default.target before ~/.config/systemd/user is readable.",
    "[Unit]",
    "After=home.mount",
    "Wants=home.mount",
    "",
  ].join("\n");
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === contents) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, contents);
    try { execSync("systemctl daemon-reload", { stdio: "pipe" }); } catch { /* best-effort (needs root bus) */ }
  } catch {
    // Drop-in needs root; the unit-level After=/Wants= plus the login ensure loop
    // still cover the race, so absence of this file is not fatal.
  }
}

export function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
  ensureUserManagerHomeWaitDropIn();
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  recordOwnedConfigPath(getConfigDir(), serviceStatePath());
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  // Resolve ONCE and reuse: the unit and the install state must agree about what is
  // launched, or the staleness check would validate a path the unit does not run.
  const launcher = stableLauncherEntry();
  writeServiceDefinitionFile(unitPath(), buildUnit(resolvedProxyEnv(), { launcher }), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  repairUserUnitWantsSymlink();
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState("scheduler", launcher);
}

/**
 * `systemctl --user enable` writes the wants symlink through the user manager; when the
 * manager was started during the home-mount race (or its bus hiccups) the symlink can be
 * silently missing while enable reports success. A missing symlink means the unit is never
 * queued at boot, so verify the file-level link and create it directly when absent.
 */
function repairUserUnitWantsSymlink(): void {
  const wantsDir = join(unitDir(), "default.target.wants");
  const link = join(wantsDir, `${TASK}.service`);
  try {
    const st = lstatSync(link);
    // A dangling link (unit file removed then re-created elsewhere) must be replaced.
    if (st.isSymbolicLink() && existsSync(link)) return;
    try { unlinkSync(link); } catch { /* nothing to clear */ }
  } catch {
    // absent — fall through and create it
  }
  try {
    mkdirSync(wantsDir, { recursive: true });
    symlinkSync(unitPath(), link);
  } catch {
    // Best-effort: enable already ran; if this also failed the unit remains startable manually.
  }
}

/**
 * Whether systemd's in-memory unit differs from the file on disk.
 *
 * The systemd analogue of launchd's stale-plist case: writing
 * `~/.config/systemd/user/<unit>` does not change the definition systemd has loaded
 * until `daemon-reload`, so a plain `systemctl start` would run the PREVIOUS
 * ExecStart. `NeedDaemonReload` is a per-unit property emitted as a bare
 * `NeedDaemonReload=yes|no` line; pass the unit name or `show` reports the manager's
 * own property instead, which answers a different question.
 *
 * Fail-open: if the query cannot run (no user bus, unit absent) we must not block a
 * start that would otherwise work.
 */
export function systemdNeedsDaemonReload(deps: { show?: () => string } = {}): boolean {
  try {
    const out = (deps.show ?? (() => sh(`systemctl --user show -p NeedDaemonReload ${TASK}`)))();
    return /NeedDaemonReload\s*=\s*yes/i.test(out);
  } catch {
    return false;
  }
}

export function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) {
    console.error(`opencodex service is not installed: ${unitPath()}`);
    console.error("Run `ocx service install` first to create and enable the systemd user unit.");
    process.exit(1);
  }
  // The unit on disk may be newer than what systemd loaded; starting now would run
  // the previous definition.
  //
  // `start` alone is not enough after a reload: it is a no-op on an already-active
  // unit, so the stale process would keep running the old ExecStart. NeedDaemonReload
  // compares disk against loaded, never loaded against running, so the only way to
  // make the running process match the file is to restart it.
  if (systemdNeedsDaemonReload()) {
    console.log("ℹ️  unit file changed on disk; reloading systemd and restarting the service.");
    sh("systemctl --user daemon-reload");
    sh(`systemctl --user restart ${TASK}`);
    return;
  }
  sh(`systemctl --user start ${TASK}`);
}

export function stopSystemd(): void { try { sh(`systemctl --user stop ${TASK}`); } catch { /* not running */ } }

export function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }

export function uninstallSystemd(deps: {
  run?: (command: string) => string;
  unitExists?: () => boolean;
  removeUnit?: () => void;
} = {}): void {
  const run = deps.run ?? sh;
  try { run(`systemctl --user stop ${TASK}`); } catch { /* not running */ }
  try { run(`systemctl --user disable ${TASK}`); } catch { /* absent */ }
  if ((deps.unitExists ?? (() => existsSync(unitPath())))()) {
    (deps.removeUnit ?? (() => unlinkSync(unitPath())))();
  }
  try { run("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

export function systemdServiceInstallCleanupOps(deps: {
  run?: (command: string) => string;
} = {}): ServiceInstallCleanupOps {
  const run = deps.run ?? sh;
  return {
    status: () => {
      const output = run(`systemctl --user show -p LoadState ${TASK}`);
      const loadState = systemdProperty(output, "LoadState")?.toLowerCase();
      if (!loadState) throw new Error("systemd service status could not be verified.");
      return loadState === "not-found" ? null : loadState;
    },
    stop: () => { run(`systemctl --user stop ${TASK}`); },
  };
}
