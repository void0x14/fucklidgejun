/**
 * Operator view of the bug-bounty "operation" agent model map, plus its save.
 *
 * Loaded on demand from src/server/management-api.ts for the same recorded reason the
 * workflow-budget and routing-profile handlers are: management-api.ts is the fourth entry in the
 * protected set of tests/lab/core-lab-boundary.test.ts, and every route that file statically
 * imports runs on every dashboard request. A static import here would put the operation store and
 * its config-directory resolution on all of them.
 *
 * Authentication is inherited: every /api route passes through requireManagementAuth before the
 * chain runs, so these handlers add no auth code of their own. Neither verb spends user identity.
 *
 * The GET reads `<OPENCODEX_HOME>/operation.json` and lists the models the proxy already exposes,
 * so the picker can only offer a row the operation could actually dispatch to. The PUT validates
 * and persists one map; a malformed body is refused with `{error:{code,message}}` rather than
 * written.
 */

import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { readManagementJsonBodyOr } from "./body";
import { fetchAllModels } from "./shared";
import { catalogModelSlug } from "../../codex/catalog";
import {
  operationModelDefaults,
  readOperationModels,
  validateOperationAgents,
  writeOperationModels,
} from "../../operation/models";

function invalidBodyResponse(req: Request, config: ManagementContext["config"], code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 400, req, config);
}

export async function handleOperationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { url, req, config, deps } = ctx;

  if (url.pathname === "/api/operation-models" && req.method === "GET") {
    const stored = readOperationModels();
    const models = await (deps.fetchAllModels ?? fetchAllModels)(config);
    const available = models.map(model => ({
      namespaced: catalogModelSlug(model),
      provider: model.provider,
      model: model.id,
    }));
    return jsonResponse(
      {
        agents: stored.agents,
        available,
        defaults: operationModelDefaults(config),
      },
      200,
      req,
      config,
    );
  }

  if (url.pathname === "/api/operation-models" && req.method === "PUT") {
    const body = await readManagementJsonBodyOr(req, null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return invalidBodyResponse(req, config, "invalid_body", "JSON body must be an object");
    }
    const validated = validateOperationAgents((body as { agents?: unknown }).agents);
    if (!validated.ok) {
      return invalidBodyResponse(req, config, validated.code, validated.message);
    }
    writeOperationModels({ version: 1, agents: validated.agents });
    return jsonResponse({ agents: validated.agents, saved: true }, 200, req, config);
  }

  return null;
}
