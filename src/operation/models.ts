/**
 * Persistence for the bug-bounty "operation" agent model map.
 *
 * An operation is a swarm of agents (orchestrator, recon, classifier, exploit, report), and
 * this module owns the one file that says which provider/model each of them runs on. The
 * operator configures it from the dashboard; an agent may read or write the same file through
 * the management API, so the file itself is the contract and this module is its only reader and
 * writer.
 *
 * The file lives at `<OPENCODEX_HOME>/operation.json`, resolved through `getConfigDir()` like
 * every other state file in this tree rather than by hardcoding `~/.opencodex`.
 *
 * Failure policy, and it is deliberate: a missing file and an unparseable file both read as
 * "all agents inherit" and NEVER throw. A malformed operation.json must not take down the
 * dashboard or the proxy; the operator's recovery path is to save a fresh map, not to see a
 * crash. Only the write path validates, and only the write path rejects.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { atomicWriteFile } from "../config/atomic-write";
import type { OcxConfig } from "../types";

export const OPERATION_FILE = "operation.json";

/** The five roles an operation configures. Order is the operator-facing display order. */
export const OPERATION_AGENTS = [
  "orchestrator",
  "recon",
  "classifier",
  "exploit",
  "report",
] as const;

export type OperationAgent = (typeof OPERATION_AGENTS)[number];

/** One agent's model selection. Both fields empty means "inherit from the orchestrator". */
export interface OperationAgentModel {
  provider: string;
  model: string;
}

export interface OperationModels {
  version: 1;
  agents: Record<OperationAgent, OperationAgentModel>;
}

export type OperationModelsValidation =
  | { ok: true; agents: Record<OperationAgent, OperationAgentModel> }
  | { ok: false; code: string; message: string };

/** Bound the read: this file is five small strings, not a data dump. */
const MAX_OPERATION_FILE_BYTES = 64 * 1024;

export function operationModelsPath(): string {
  return join(getConfigDir(), OPERATION_FILE);
}

export function isOperationAgent(value: string): value is OperationAgent {
  return (OPERATION_AGENTS as readonly string[]).includes(value);
}

/** The value a missing or unparseable file resolves to: every agent inherits. */
export function emptyOperationModels(): OperationModels {
  const agents = {} as Record<OperationAgent, OperationAgentModel>;
  for (const agent of OPERATION_AGENTS) agents[agent] = { provider: "", model: "" };
  return { version: 1, agents };
}

/**
 * What each agent resolves to when its own entry is empty, so the dashboard can show the
 * fallback next to an untouched picker. The orchestrator falls back to the proxy's default
 * provider (`config.defaultProvider`); the four role agents inherit the orchestrator. `model`
 * stays empty because an unset orchestrator does not pin one — it leaves model choice to the
 * proxy's normal routing.
 */
export function operationModelDefaults(
  config: Pick<OcxConfig, "defaultProvider">,
): Record<OperationAgent, OperationAgentModel> {
  const provider = typeof config.defaultProvider === "string" ? config.defaultProvider.trim() : "";
  const agents = {} as Record<OperationAgent, OperationAgentModel>;
  for (const agent of OPERATION_AGENTS) agents[agent] = { provider, model: "" };
  return agents;
}

function normalizeAgentModel(value: unknown): OperationAgentModel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const provider = typeof row.provider === "string" ? row.provider.trim() : "";
  const model = typeof row.model === "string" ? row.model.trim() : "";
  return { provider, model };
}

/**
 * Read the stored map. Never throws: a missing file, a symlink, an oversized file, invalid
 * JSON, a wrong version, or a non-object all resolve to the empty map.
 */
export function readOperationModels(): OperationModels {
  const path = operationModelsPath();
  if (!existsSync(path)) return emptyOperationModels();
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_OPERATION_FILE_BYTES) {
      return emptyOperationModels();
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyOperationModels();
    const doc = raw as Record<string, unknown>;
    if (doc.version !== 1) return emptyOperationModels();
    const stored = doc.agents;
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return emptyOperationModels();
    const rows = stored as Record<string, unknown>;
    const agents = {} as Record<OperationAgent, OperationAgentModel>;
    for (const agent of OPERATION_AGENTS) {
      agents[agent] = normalizeAgentModel(rows[agent]) ?? { provider: "", model: "" };
    }
    return { version: 1, agents };
  } catch {
    return emptyOperationModels();
  }
}

/** Persist the map. Creates the config directory when it does not exist yet. */
export function writeOperationModels(models: OperationModels): void {
  const path = operationModelsPath();
  mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
  atomicWriteFile(path, `${JSON.stringify(models, null, 2)}\n`);
}

/**
 * Validate a PUT body's `agents` field and merge it onto the current map.
 *
 * Rejects, with a code the route turns into a 400: a non-object `agents`, an unknown agent key,
 * a non-object agent entry, a non-string provider/model, and the half-set case where exactly one
 * of provider/model is filled. That last one is not pedantry: "inherit" is spelled by leaving
 * BOTH empty, so a lone provider has no defined meaning and accepting it would persist a
 * selector the resolver cannot act on.
 */
export function validateOperationAgents(raw: unknown): OperationModelsValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_body", message: "agents must be an object" };
  }
  const rows = raw as Record<string, unknown>;
  const current = readOperationModels();
  const next: Record<OperationAgent, OperationAgentModel> = { ...current.agents };
  for (const [key, value] of Object.entries(rows)) {
    if (!isOperationAgent(key)) {
      return {
        ok: false,
        code: "unknown_agent",
        message: `unknown agent "${key}"; expected one of ${OPERATION_AGENTS.join(", ")}`,
      };
    }
    const normalized = normalizeAgentModel(value);
    if (!normalized) {
      return { ok: false, code: "invalid_agent_model", message: `${key} must be an object with provider and model strings` };
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (row.provider !== undefined && typeof row.provider !== "string") {
        return { ok: false, code: "invalid_agent_model", message: `${key}.provider must be a string` };
      }
      if (row.model !== undefined && typeof row.model !== "string") {
        return { ok: false, code: "invalid_agent_model", message: `${key}.model must be a string` };
      }
    }
    const hasProvider = normalized.provider !== "";
    const hasModel = normalized.model !== "";
    if (hasProvider !== hasModel) {
      return {
        ok: false,
        code: "incomplete_agent_model",
        message: `${key} must set both provider and model, or neither (empty means inherit from the orchestrator)`,
      };
    }
    next[key] = normalized;
  }
  return { ok: true, agents: next };
}
