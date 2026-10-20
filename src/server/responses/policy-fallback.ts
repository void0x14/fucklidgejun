import { comboFailureDecision } from "../../combos/failover";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { readJsonRequestBody, resolveInboundBodyLimitBytes } from "../request-decompress";
import { finishRequestAttempt, type RequestLogContext } from "../request-log";
import { linkRequestSessionLane } from "../request-log-conversation";
import type { OcxConfig } from "../../types";
import type { RouteCandidateTrace, RouteDecisionTraceV1 } from "../../routing/trace";
import { knownModelIdsForProvider } from "../../router";
import { handleResponses as handleResponsesCore } from "./core";
import { requestPacingOverloadResponse } from "./pacing-overload";
import { captureExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import { captureCallerDirectAuth } from "../../providers/caller-authorization";

type CoreHandler = typeof handleResponsesCore;
type CoreOptions = Parameters<CoreHandler>[3];

export interface PolicyFallbackDeps {
  runCore?: CoreHandler;
}

function candidateKey(candidate: Pick<RouteCandidateTrace, "provider" | "model">): string {
  return `${candidate.provider}\u0000${candidate.model}`;
}

/**
 * Rank the remaining candidates from the ORIGINAL policy trace. The initial
 * decision stays immutable; fallback execution belongs in attempts[], not in a
 * rewritten decision trace.
 */
export function rankPolicyFallbackCandidates(
  trace: RouteDecisionTraceV1,
  tried: ReadonlySet<string>,
): RouteCandidateTrace[] {
  return trace.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) =>
      candidate.eligible
      && candidate.exclusions.length === 0
      && !tried.has(candidateKey(candidate)))
    .sort((left, right) => {
      const scoreDelta = (right.candidate.score?.total ?? Number.NEGATIVE_INFINITY)
        - (left.candidate.score?.total ?? Number.NEGATIVE_INFINITY);
      return scoreDelta || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}

/**
 * Remaining candidates for a route that picked ONE provider: every other enabled provider
 * whose own catalog carries the model id that just failed.
 *
 * A bare (or explicitly namespaced) model request has no declared ladder, so the only honest
 * alternative is the same model on a provider that advertises it — config list, default model,
 * registry seed or live cache, the exact evidence `routeModel` resolves `<provider>/<model>`
 * against. A provider that does not carry the id is skipped rather than tried: it could only
 * answer "unknown model", which is not progress. Config order is kept so the hop is stable.
 */
export function sameModelFallbackCandidates(
  config: OcxConfig,
  selected: Pick<RouteCandidateTrace, "provider" | "model">,
  tried: ReadonlySet<string>,
): Array<Pick<RouteCandidateTrace, "provider" | "model">> {
  const candidates: Array<Pick<RouteCandidateTrace, "provider" | "model">> = [];
  // A retry path must never throw: an absent provider table simply means no candidate.
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    if (name === selected.provider || provider.disabled === true) continue;
    const candidate = { provider: name, model: selected.model };
    if (tried.has(candidateKey(candidate))) continue;
    // The same model is often carried under a provider namespace ("global:deepseek-v4.1-flash"
    // on one provider, plain "deepseek-v4.1-flash" on the next). An exact-id-only match found no
    // sibling for the namespaced form, so a 429 or 503 on that provider ended the turn instead of
    // moving to a provider that serves the same model.
    const ids = knownModelIdsForProvider(name, provider, config);
    const bare = selected.model.includes(":")
      ? selected.model.slice(selected.model.indexOf(":") + 1)
      : selected.model;
    if (!ids.includes(selected.model) && !ids.includes(bare)) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function requestWithCandidate(
  req: Request,
  rawBody: Record<string, unknown>,
  candidate: Pick<RouteCandidateTrace, "provider" | "model">,
): Request {
  const headers = new Headers(req.headers);
  // The next candidate owns a different physical credential domain. Typed
  // admission and any claimed Claude snapshot stay in caller-owned CoreOptions.
  headers.delete("authorization");
  headers.delete("chatgpt-account-id");
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  const retryRequest = new Request(req.url, {
    method: req.method,
    headers,
    body: JSON.stringify({ ...rawBody, model: `${candidate.provider}/${candidate.model}` }),
    signal: req.signal,
  });
  // A sessionless request keeps the lane it was already allocated. Without this the second
  // candidate reaches OpenCode Go under a different x-opencode-session than the first attempt,
  // which is the same conversation split the header exists to prevent.
  linkRequestSessionLane(req, retryRequest);
  return retryRequest;
}

function errorCodeFromText(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const payload = JSON.parse(text) as { error?: { code?: unknown; type?: unknown }; code?: unknown };
    const candidate = payload.error?.code ?? payload.error?.type ?? payload.code;
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this pre-success failure may be replayed against the next candidate. The verdict is
 * the combo ladder's own — one classifier for "the request is impossible" versus "this target
 * could not serve it" — so a client-shape refusal (bad request body, rejected caller auth) ends
 * the chain exactly where it ends a combo hop.
 */
async function shouldHopCandidate(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status < 400 || signal?.aborted) return false;
  try {
    const inspected = await readBoundedResponseBody(response.clone(), { signal });
    const text = inspected.displaySafe ? inspected.text : "";
    return comboFailureDecision(response.status, text, { code: errorCodeFromText(text) }) === "hop";
  } catch {
    return false;
  }
}

function isPolicyDecision(trace: RouteDecisionTraceV1 | undefined): trace is RouteDecisionTraceV1 {
  return trace?.routeKind === "policy" && !!trace.profile;
}

/** Finalize the failed physical attempt so the retry receives a fresh attempt row. */
function finishFailedHopAttempt(logCtx: RequestLogContext, status: number): void {
  const attempt = logCtx.activeAttempt;
  if (attempt) {
    const startedAt = logCtx.activeAttemptStartedAt ?? Date.now();
    finishRequestAttempt(attempt, status, Math.max(0, Date.now() - startedAt), attempt.usage ?? logCtx.usage);
  }
  delete logCtx.activeAttempt;
  delete logCtx.activeAttemptStartedAt;
  delete logCtx.usage;
  delete logCtx.usageFromBridge;
  delete logCtx.upstreamError;
  delete logCtx.terminalHttpStatus;
  delete logCtx.terminalErrorCode;
  delete logCtx.terminalIncompleteReason;
}

/**
 * Run a Responses request and hop to the next eligible candidate after a retryable pre-success
 * failure, so one upstream 4xx/5xx does not end the turn.
 *
 * Two candidate sources, both already-existing selections:
 * - an explicitly selected policy profile ranks its declared candidates by score;
 * - every other route is a single-provider pick, so the candidates are the other enabled
 *   providers whose own catalog carries the model id that just failed.
 *
 * The initial trace remains the canonical selection evidence and the request body is replayed
 * byte-for-byte apart from the `model` selector; physical retries continue to accumulate in the
 * existing request attempts. Combo routes are left to `executeComboResponses`, which already
 * runs its own declared target ladder.
 */
export async function handleResponsesWithPolicyFallback(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  options: CoreOptions = {},
  deps: PolicyFallbackDeps = {},
): Promise<Response> {
  const runCore = deps.runCore ?? handleResponsesCore;
  let requestBodyReadNotified = false;
  let storedPool401ReplayDispatched = false;
  const coreOptions: CoreOptions = {
    ...options,
    openAiSidecarAuth: options.openAiSidecarAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.openAiSidecarAuth,
    nativeCallerAuth: options.nativeCallerAuth === undefined
      ? captureExplicitOpenAiCallerAuth(req.headers, config) : options.nativeCallerAuth,
    callerDirectAuth: options.callerDirectAuth === undefined
      ? captureCallerDirectAuth(req.headers, config) : options.callerDirectAuth,
    ...(options.onRequestBodyRead ? {
      onRequestBodyRead: () => {
        if (requestBodyReadNotified) return;
        requestBodyReadNotified = true;
        options.onRequestBodyRead?.();
      },
    } : {}),
    onStoredPool401ReplayDispatched: () => {
      storedPool401ReplayDispatched = true;
      options.onStoredPool401ReplayDispatched?.();
    },
  };
  let rawBody: Record<string, unknown> | null = null;
  try {
    const parsed = await readJsonRequestBody(
      req.clone(),
      undefined,
      resolveInboundBodyLimitBytes(config.maxInboundBodyBytes),
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) rawBody = parsed as Record<string, unknown>;
  } catch {
    // Core owns the client-facing parse/decompression error.
  }

  let response: Response;
  try {
    response = await runCore(req, config, logCtx, coreOptions);
  } catch (error) {
    const overload = requestPacingOverloadResponse(error);
    if (overload) return overload;
    throw error;
  }
  const initialTrace = logCtx.routeDecision;
  const initialRequestedModel = logCtx.requestedModel;
  if (!rawBody || !initialTrace) return response;
  // A combo already runs its declared target ladder inside core. Hopping here would dispatch the
  // same turn to a second target behind that ladder's own transition and cooldown bookkeeping.
  if (initialTrace.routeKind === "combo") return response;
  const policyTrace = isPolicyDecision(initialTrace) ? initialTrace : null;

  const tried = new Set<string>([
    candidateKey({ provider: initialTrace.selected.provider, model: initialTrace.selected.model }),
  ]);

  while (!storedPool401ReplayDispatched && await shouldHopCandidate(response, req.signal)) {
    if (req.signal.aborted) return response;
    const next = policyTrace
      ? rankPolicyFallbackCandidates(policyTrace, tried)[0]
      : sameModelFallbackCandidates(config, initialTrace.selected, tried)[0];
    if (!next) return response;
    tried.add(candidateKey(next));

    finishFailedHopAttempt(logCtx, response.status);
    const retryRequest = requestWithCandidate(req, rawBody, next);
    try {
      try {
        response = await runCore(retryRequest, config, logCtx, coreOptions);
      } catch (error) {
        const overload = requestPacingOverloadResponse(error);
        if (overload) return overload;
        throw error;
      }
    } finally {
      logCtx.requestedModel = initialRequestedModel;
      logCtx.routeDecision = initialTrace;
    }
  }

  return response;
}

export const handleResponses = handleResponsesWithPolicyFallback;
