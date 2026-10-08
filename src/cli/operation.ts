/**
 * `ocx operation` — read and set the provider/model each operation agent runs on.
 *
 * The map lives at `<OPENCODEX_HOME>/operation.json` and is owned by the running proxy, so this
 * command drives the same management route the dashboard does instead of touching the file
 * directly: one validation path, one writer, and no chance of the CLI and the GUI disagreeing
 * about what a saved map means. An empty provider/model means "inherit from the orchestrator".
 */
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  type RuntimeApiDeps,
} from "./runtime-api";
import { OPERATION_AGENTS, isOperationAgent, type OperationAgent } from "../operation/models";

const USAGE = `Usage:
  ocx operation [show] [--json]
  ocx operation set <agent> <provider/model|-> [--json]
  ocx operation clear <agent> [--json]

Agents: ${OPERATION_AGENTS.join(", ")}
An empty selection (set to "-") means the agent inherits from the orchestrator.`;

interface AgentModel {
  provider?: string;
  model?: string;
}

interface OperationModelsResponse {
  agents?: Record<string, AgentModel>;
  saved?: boolean;
}

function describe(model: AgentModel | undefined): string {
  const provider = model?.provider ?? "";
  const id = model?.model ?? "";
  return provider && id ? `${provider}/${id}` : "(inherit from orchestrator)";
}

function parseAgent(raw: string | undefined): OperationAgent {
  const agent = raw?.trim() ?? "";
  if (!agent) throw new CliUsageError("agent is required", USAGE);
  if (!isOperationAgent(agent)) {
    throw new CliUsageError(`unknown agent "${agent}" (expected: ${OPERATION_AGENTS.join(", ")})`, USAGE);
  }
  return agent;
}

function parseSelector(raw: string | undefined): { provider: string; model: string } {
  const selector = raw?.trim() ?? "";
  if (selector === "-") return { provider: "", model: "" };
  const slash = selector.indexOf("/");
  if (slash <= 0 || slash === selector.length - 1) {
    throw new CliUsageError(`invalid selection "${selector}"; use <provider/model>, or "-" to inherit`, USAGE);
  }
  return { provider: selector.slice(0, slash), model: selector.slice(slash + 1) };
}

async function show(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<OperationModelsResponse>("/api/operation-models", {}, deps);
  const agents = result.agents ?? {};
  printData(result, wantsJson, OPERATION_AGENTS.map(agent => `${agent.padEnd(12)} ${describe(agents[agent])}`));
}

async function save(agent: OperationAgent, model: { provider: string; model: string }, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<OperationModelsResponse>("/api/operation-models", {
    method: "PUT",
    body: JSON.stringify({ agents: { [agent]: model } }),
  }, deps);
  const line = model.provider && model.model
    ? `Set ${agent} to ${model.provider}/${model.model}.`
    : `Cleared ${agent}; it now inherits from the orchestrator.`;
  printData(result, wantsJson, [line]);
}

export async function handleOperationCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const first = (args[0] ?? "").toLowerCase();

    if (first === "" || first === "show" || first === "status" || first === "list") {
      if (first !== "") args.shift();
      await show(args, deps);
      return;
    }

    if (first === "set") {
      args.shift();
      const agent = parseAgent(args.shift());
      const model = parseSelector(args.shift());
      await save(agent, model, args, deps);
      return;
    }

    if (first === "clear" || first === "unset") {
      args.shift();
      const agent = parseAgent(args.shift());
      await save(agent, { provider: "", model: "" }, args, deps);
      return;
    }

    throw new CliUsageError(`unknown operation subcommand "${args[0]}"`, USAGE);
  });
}
