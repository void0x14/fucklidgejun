import { describe, expect, test } from "bun:test";

import { formatErrorResponse } from "../../src/bridge";
import { RequestPacingQueueOverloadError } from "../../src/providers/request-pacing";
import type { OcxConfig } from "../../src/types";
import { beginRequestAttempt, type RequestLogContext } from "../../src/server/request-log";
import type { RouteDecisionTraceV1 } from "../../src/routing/trace";
import { fakeChatGptJwt } from "../helpers/fake-chatgpt-jwt";
import {
  handleResponsesWithPolicyFallback,
  rankPolicyFallbackCandidates,
  sameModelFallbackCandidates,
} from "../../src/server/responses/policy-fallback";

function policyTrace(): RouteDecisionTraceV1 {
  return {
    version: 1,
    decisionId: "decision-1",
    createdAt: 1,
    requestedModel: "policy/daily",
    routeKind: "policy",
    profile: { id: "daily", revision: "rev-1" },
    requirements: [],
    candidates: [
      { provider: "provider-a", model: "model-a", eligible: true, exclusions: [], score: { total: 0.90, components: {} } },
      { provider: "provider-b", model: "model-b", eligible: true, exclusions: [], score: { total: 0.80, components: {} } },
      { provider: "provider-c", model: "model-c", eligible: true, exclusions: [], score: { total: 0.80, components: {} } },
      { provider: "provider-d", model: "model-d", eligible: false, exclusions: [{ code: "tools" }], score: { total: 1, components: {} } },
    ],
    selected: { candidateIndex: 0, provider: "provider-a", model: "model-a", reason: "highest-score" },
  };
}

function request(signal?: AbortSignal): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "policy/daily", input: "hello", stream: false }),
    signal,
  });
}

function seedAttempt(logCtx: RequestLogContext, provider: string, model: string): void {
  if (logCtx.activeAttempt) return;
  const attempt = beginRequestAttempt((logCtx.attempts?.length ?? 0) + 1, provider, model, "test");
  (logCtx.attempts ??= []).push(attempt);
  logCtx.activeAttempt = attempt;
  logCtx.activeAttemptStartedAt = Date.now();
}

describe("policy candidate fallback", () => {
  test("policy hops retain only the original sidecar snapshot outside primary headers", async () => {
    const authorization = `Bearer ${fakeChatGptJwt({ chatgpt_account_id: "sidecar-account" })}`;
    const initial = request();
    const headers = new Headers(initial.headers);
    headers.set("authorization", authorization);
    headers.set("chatgpt-account-id", "sidecar-account");
    const log = { model: "", provider: "" } as RequestLogContext;
    const snapshots: unknown[] = [];
    const primaryAuth: Array<string | null> = [];
    const response = await handleResponsesWithPolicyFallback(new Request(initial, { headers }), {
      port: 0, defaultProvider: "provider-a", providers: {},
    }, log, {}, {
      runCore: async (req, _config, context, options) => {
        snapshots.push(options.openAiSidecarAuth);
        primaryAuth.push(req.headers.get("authorization"));
        context.routeDecision = policyTrace();
        return snapshots.length === 1
          ? Response.json({ error: { message: "retry next candidate" } }, { status: 503 })
          : Response.json({ status: "completed" });
      },
    });
    expect(response.status).toBe(200);
    expect(primaryAuth).toEqual([authorization, null]);
    expect(snapshots).toEqual([
      { authorization, chatgptAccountId: "sidecar-account" },
      { authorization, chatgptAccountId: "sidecar-account" },
    ]);
    expect(snapshots[1]).toBe(snapshots[0]);
  });

  test("ranks only eligible untried candidates by score and stable original order", () => {
    const ranked = rankPolicyFallbackCandidates(policyTrace(), new Set(["provider-a\u0000model-a"]));
    expect(ranked.map(candidate => `${candidate.provider}/${candidate.model}`)).toEqual([
      "provider-b/model-b",
      "provider-c/model-c",
    ]);
  });

  test("a local input-admission refusal hops instead of ending the chain (#1524)", async () => {
    // #1524: a candidate whose context window cannot fit the request used to TERMINATE the
    // fallback chain. It is a local preflight verdict about ONE candidate, not about the
    // request, so the next candidate -- which may have a larger window -- must still be tried.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      if (seenModels.length === 1) {
        // Built by the PRODUCTION emitter, not by hand. A hand-written envelope hid the real
        // defect: formatErrorResponse runs classifyError, whose "context window" remap rewrote
        // our own code to context_length_exceeded, so the shape the proxy actually ships never
        // carried the marker the hop rule looks for.
        return formatErrorResponse(
          413,
          "input_admission_refused",
          "Estimated input (~500000 tokens) is far past the context window of test-model (100000 tokens)."
            + " Start a new session or choose a model with a larger context window.",
        );
      }
      return Response.json({ id: "resp", object: "response", status: "completed", output: [] });
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(200);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
  });

  test("an upstream body that merely echoes the marker does not hop (#1524)", async () => {
    // The refusal is ours and always carries the structured code, so the decision keys on that
    // alone. Error text is provider-controlled and crosses a trust boundary: matching on it
    // would let any upstream override a terminal verdict by mentioning the token.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      return Response.json(
        { error: { message: "upstream says: input_admission_refused is not a thing here", type: "invalid_request_error", code: "invalid_request_error" } },
        { status: 400 },
      );
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(400);
    expect(seenModels).toEqual(["policy/daily"]);
  });
  test("an upstream context_length_exceeded still stops the chain (#1524)", async () => {
    // The mirror-image contract. An upstream verdict is about the REQUEST, so retrying it
    // elsewhere is guesswork -- and hopping would burn every candidate on a doomed request.
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const runCore = async (req: Request, _config: OcxConfig, ctx: RequestLogContext) => {
      const body = await req.clone().json() as { model?: string };
      seenModels.push(String(body.model));
      ctx.routeDecision = trace;
      seedAttempt(ctx, "provider", String(body.model));
      return Response.json(
        { error: { message: "context length exceeded", type: "invalid_request_error", code: "context_length_exceeded" } },
        { status: 400 },
      );
    };

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, { runCore });

    expect(response.status).toBe(400);
    expect(seenModels).toEqual(["policy/daily"]);
  });
  test("retries the next policy candidate and keeps distinct physical attempts", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    const seenAuthorization: Array<string | null> = [];
    const seenAccountIds: Array<string | null> = [];
    const seenTerminalCodes: Array<string | undefined> = [];
    let bodyAcceptedCount = 0;

    const initialRequest = request();
    const initialHeaders = new Headers(initialRequest.headers);
    initialHeaders.set("authorization", "Bearer fixture");
    initialHeaders.set("chatgpt-account-id", "caller-account");
    const credentialedRequest = new Request(initialRequest, { headers: initialHeaders });

    const response = await handleResponsesWithPolicyFallback(credentialedRequest, {} as OcxConfig, logCtx, {
      onRequestBodyRead: () => {
        bodyAcceptedCount += 1;
      },
    }, {
      runCore: async (req, _config, childLog, options) => {
        options.onRequestBodyRead?.();
        seenAuthorization.push(req.headers.get("authorization"));
        seenAccountIds.push(req.headers.get("chatgpt-account-id"));
        const body = await req.json() as { model: string };
        seenModels.push(body.model);
        seenTerminalCodes.push(childLog.terminalErrorCode);
        const first = seenModels.length === 1;
        seedAttempt(childLog, first ? "provider-a" : "provider-b", first ? "model-a" : "model-b");
        if (first) {
          childLog.requestedModel = "policy/daily";
          childLog.routeDecision = trace;
          childLog.terminalErrorCode = "cyber_policy";
          return new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        childLog.requestedModel = body.model;
        childLog.routeDecision = { ...trace, requestedModel: body.model, routeKind: "explicit-provider", profile: undefined };
        return new Response(JSON.stringify({ status: "completed" }), { status: 200 });
      },
    });

    expect(response.status).toBe(200);
    expect(bodyAcceptedCount).toBe(1);
    expect(seenModels).toEqual(["policy/daily", "provider-b/model-b"]);
    expect(seenAuthorization).toEqual(["Bearer fixture", null]);
    expect(seenAccountIds).toEqual(["caller-account", null]);
    expect(seenTerminalCodes).toEqual([undefined, undefined]);
    expect(logCtx.requestedModel).toBe("policy/daily");
    expect(logCtx.routeDecision).toBe(trace);
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]).toMatchObject({ provider: "provider-a", model: "model-a", status: 429 });
    expect(logCtx.attempts?.[1]).toMatchObject({ provider: "provider-b", model: "model-b" });
    expect(logCtx.activeAttempt).toBe(logCtx.attempts?.[1]);
  });

  test("a stored Pool 401 replay dispatch stops policy candidate fallback", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];
    let replaySignals = 0;

    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {
      onStoredPool401ReplayDispatched: () => { replaySignals += 1; },
    }, {
      runCore: async (req, _config, childLog, options) => {
        const body = await req.json() as { model: string };
        seenModels.push(body.model);
        childLog.routeDecision = trace;
        seedAttempt(childLog, "provider-a", "model-a");
        options.onStoredPool401ReplayDispatched?.();
        return Response.json(
          { error: { message: "stored replay exhausted", type: "rate_limit_error" } },
          { status: 429 },
        );
      },
    });

    expect(response.status).toBe(429);
    expect(seenModels).toEqual(["policy/daily"]);
    expect(replaySignals).toBe(1);
  });

  test("returns local pacing overload without switching policy candidates", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async () => {
        calls += 1;
        throw new RequestPacingQueueOverloadError("provider-a", "queue_full", 2);
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(calls).toBe(1);
  });

  test("does not switch candidates for terminal client/input failures", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.requestedModel = "policy/daily";
        childLog.routeDecision = trace;
        return new Response(JSON.stringify({ error: { message: "invalid request", type: "invalid_request_error" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });

  test("does not switch candidates after client cancellation", async () => {
    const trace = policyTrace();
    const controller = new AbortController();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const response = await handleResponsesWithPolicyFallback(request(controller.signal), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.routeDecision = trace;
        controller.abort();
        return new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), { status: 429 });
      },
    });
    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  test("does not switch candidates after a streaming response has started", async () => {
    const trace = policyTrace();
    const logCtx = { requestedModel: "policy/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;
    const body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\ndata: {\"type\":\"response.failed\"}\n\n";
    const response = await handleResponsesWithPolicyFallback(request(), {} as OcxConfig, logCtx, {}, {
      runCore: async (_req, _config, childLog) => {
        calls += 1;
        childLog.routeDecision = trace;
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hello");
    expect(calls).toBe(1);
  });
});

function singleProviderTrace(overrides: Partial<RouteDecisionTraceV1> = {}): RouteDecisionTraceV1 {
  return {
    version: 1,
    decisionId: "decision-2",
    createdAt: 1,
    requestedModel: "provider-a/model-x",
    routeKind: "explicit-provider",
    requirements: [],
    candidates: [
      { provider: "provider-a", model: "model-x", eligible: true, exclusions: [] },
    ],
    selected: {
      candidateIndex: 0,
      provider: "provider-a",
      model: "model-x",
      reason: "explicit-provider-namespace",
    },
    ...overrides,
  };
}

/**
 * provider-b carries the same model id, provider-c carries a different one, provider-d carries
 * the same one but is disabled. Only provider-b is a real candidate.
 */
function siblingConfig(): OcxConfig {
  return {
    port: 0,
    defaultProvider: "provider-a",
    providers: {
      "provider-a": { adapter: "openai-chat", models: ["model-x"], baseUrl: "https://a.example" },
      "provider-b": { adapter: "openai-chat", models: ["model-x"], baseUrl: "https://b.example" },
      "provider-c": { adapter: "openai-chat", models: ["model-y"], baseUrl: "https://c.example" },
      "provider-d": { adapter: "openai-chat", models: ["model-x"], baseUrl: "https://d.example", disabled: true },
    },
  } as unknown as OcxConfig;
}

function requestFor(model: string, input: string): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, stream: false }),
  });
}

describe("single-provider candidate fallback", () => {
  test("offers only other enabled providers that carry the failing model id", () => {
    const candidates = sameModelFallbackCandidates(
      siblingConfig(),
      { provider: "provider-a", model: "model-x" },
      new Set(["provider-a\u0000model-x"]),
    );
    expect(candidates).toEqual([{ provider: "provider-b", model: "model-x" }]);
  });

  test("a 503 retries the identical body on the next provider carrying the model", async () => {
    // The whole point of the change: an overloaded/5xx upstream must not end the turn while a
    // provider that serves the same model is still configured and enabled.
    const trace = singleProviderTrace();
    const logCtx = { requestedModel: "provider-a/model-x", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const bodies: Array<Record<string, unknown>> = [];
    const payload = "context-".repeat(512);

    const response = await handleResponsesWithPolicyFallback(
      requestFor("provider-a/model-x", payload),
      siblingConfig(),
      logCtx,
      {},
      {
        runCore: async (req, _config, childLog) => {
          const body = await req.clone().json() as Record<string, unknown>;
          bodies.push(body);
          childLog.routeDecision = trace;
          seedAttempt(childLog, "provider-a", String(body.model));
          if (bodies.length === 1) {
            return Response.json(
              { error: { message: "server is overloaded", type: "upstream_error", code: "server_is_overloaded" } },
              { status: 503 },
            );
          }
          return Response.json({ id: "resp", object: "response", status: "completed", output: [] });
        },
      },
    );

    expect(response.status).toBe(200);
    expect(bodies.map(body => body.model)).toEqual(["provider-a/model-x", "provider-b/model-x"]);
    // Nothing was trimmed, summarised or dropped to make the retry fit.
    expect(bodies[1]!.input).toBe(payload);
    expect(bodies[1]).toEqual({ ...bodies[0]!, model: "provider-b/model-x" });
    expect(logCtx.routeDecision).toBe(trace);
    expect(logCtx.requestedModel).toBe("provider-a/model-x");
    expect(logCtx.attempts).toHaveLength(2);
    expect(logCtx.attempts?.[0]).toMatchObject({ provider: "provider-a", status: 503 });
  });

  test("a non-retryable 400 from the selected provider is surfaced unchanged", async () => {
    const trace = singleProviderTrace();
    const logCtx = { requestedModel: "provider-a/model-x", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    const seenModels: string[] = [];

    const response = await handleResponsesWithPolicyFallback(
      requestFor("provider-a/model-x", "hello"),
      siblingConfig(),
      logCtx,
      {},
      {
        runCore: async (req, _config, childLog) => {
          const body = await req.clone().json() as { model?: string };
          seenModels.push(String(body.model));
          childLog.routeDecision = trace;
          return Response.json(
            { error: { message: "invalid request", type: "invalid_request_error", code: "invalid_request_error" } },
            { status: 400 },
          );
        },
      },
    );

    expect(response.status).toBe(400);
    expect(seenModels).toEqual(["provider-a/model-x"]);
  });

  test("a combo route keeps its own ladder instead of being hopped twice", async () => {
    const trace = singleProviderTrace({ routeKind: "combo" });
    const logCtx = { requestedModel: "combo/daily", routeDecision: trace, attempts: [] } as unknown as RequestLogContext;
    let calls = 0;

    const response = await handleResponsesWithPolicyFallback(
      requestFor("combo/daily", "hello"),
      siblingConfig(),
      logCtx,
      {},
      {
        runCore: async (_req, _config, childLog) => {
          calls += 1;
          childLog.routeDecision = trace;
          return Response.json({ error: { message: "server is overloaded", code: "server_is_overloaded" } }, { status: 503 });
        },
      },
    );

    expect(response.status).toBe(503);
    expect(calls).toBe(1);
  });
});
