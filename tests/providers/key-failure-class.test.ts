import { describe, expect, test } from "bun:test";
import {
  classifyKeyScopedFailure,
  classifyKeyScopedResponse,
  keyScopedRecoveryKind,
} from "../../src/providers/key-failure-class";

/**
 * Key-scoped failure classifier (devlog/_plan/261002_rr_multimodal_quota_bleed, R1).
 *
 * The bodies below are the shapes recorded in the investigation evidence: DeepSeek 402
 * "Insufficient Balance", DashScope 403 "Free quota exhausted" / Model.AccessDenied, DashScope
 * 400 arrears ("account is in good standing"), Anthropic 400 "credit balance is too low", and
 * the OpenAI `insufficient_quota` code. Everything that is about the REQUEST rather than the
 * credential must stay unclassified, or a pool would burn every key on a prompt no key can serve.
 */
describe("classifyKeyScopedFailure", () => {
  test("status-only classes", () => {
    expect(classifyKeyScopedFailure(429, "")).toBe("rate");
    expect(classifyKeyScopedFailure(401, "")).toBe("auth");
    expect(classifyKeyScopedFailure(402, "")).toBe("balance");
    expect(classifyKeyScopedFailure(402, JSON.stringify({ error: { message: "Insufficient Balance", type: "unknown_error" } })))
      .toBe("balance");
  });

  test("a 429 that names exhausted billing quota is a quota verdict, not a timing blip", () => {
    expect(classifyKeyScopedFailure(429, JSON.stringify({ error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota", code: "insufficient_quota",
    } }))).toBe("quota");
  });

  test.each([
    ["Free quota exhausted", JSON.stringify({ error: { code: "AllocationQuota.FreeTierOnly", message: "Free quota exhausted. Please upgrade." } })],
    ["Model.AccessDenied", JSON.stringify({ error: { code: "Model.AccessDenied", message: "Model access denied." } })],
    ["insufficient_quota code", JSON.stringify({ error: { code: "insufficient_quota", message: "Provider error 403" } })],
    ["Arrearage", JSON.stringify({ code: "Arrearage", message: "Access denied, please make sure your account is in good standing." })],
    ["plain-text body", "insufficient_quota: Provider error 403: Free quota exhausted for this model"],
  ])("403 %s rotates as quota", (_name, body) => {
    expect(classifyKeyScopedFailure(403, body)).toBe("quota");
  });

  test.each([
    ["DashScope arrears", JSON.stringify({ error: { code: "Arrearage", message: "Access denied, please make sure your account is in good standing." } })],
    ["Anthropic credit", JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } })],
    ["insufficient balance", JSON.stringify({ error: { message: "Insufficient account balance" } })],
  ])("400 %s rotates as balance", (_name, body) => {
    expect(classifyKeyScopedFailure(400, body)).toBe("balance");
  });

  test.each([
    ["content policy 403", 403, JSON.stringify({ error: { code: "DataInspectionFailed", message: "Input data may contain inappropriate content." } })],
    ["generic forbidden 403", 403, JSON.stringify({ error: { message: "Forbidden" } })],
    ["permission 403 naming a model", 403, JSON.stringify({ error: { code: "permission_denied", message: "You do not have access to this model" } })],
    ["schema 400", 400, JSON.stringify({ error: { type: "invalid_request_error", message: "Invalid schema for function 'x': 'type' is required", param: "tools" } })],
    ["context length 400", 400, JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens." } })],
    ["image 400", 400, JSON.stringify({ error: { type: "invalid_request_error", param: "input", message: "Model 'glm-5.3' does not support image inputs." } })],
    ["5xx", 503, "Service Unavailable"],
    ["500 balance text", 500, "Insufficient Balance"],
    ["404", 404, "insufficient_quota"],
  ])("%s is not key-scoped", (_name, status, body) => {
    expect(classifyKeyScopedFailure(status, body)).toBeNull();
  });

  test("the prompt echoed inside a 400 cannot fake a billing verdict when the error fields say otherwise", () => {
    // A structured body is matched on its error fields, never on unrelated free text.
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "Invalid value for 'input'" },
      echo: "please make sure your account is in good standing and has insufficient balance",
    });
    expect(classifyKeyScopedFailure(400, body)).toBeNull();
  });

  test("recovery kind labels", () => {
    expect(keyScopedRecoveryKind("auth")).toBe("key-401");
    expect(keyScopedRecoveryKind("rate")).toBe("key-429");
    expect(keyScopedRecoveryKind("balance")).toBe("key-quota");
    expect(keyScopedRecoveryKind("quota")).toBe("key-quota");
  });
});

describe("classifyKeyScopedResponse", () => {
  test("classifies from a clone and leaves the original body readable for the client", async () => {
    const body = JSON.stringify({ error: { code: "AllocationQuota.FreeTierOnly", message: "Free quota exhausted" } });
    const response = new Response(body, { status: 403, headers: { "content-type": "application/json" } });
    expect(await classifyKeyScopedResponse(response)).toBe("quota");
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(body);
  });

  test("status-only classes do not read the body at all", async () => {
    const response = new Response("Insufficient Balance", { status: 402 });
    expect(await classifyKeyScopedResponse(response)).toBe("balance");
    expect(response.bodyUsed).toBe(false);
  });

  test("a 2xx or a 5xx is never key-scoped", async () => {
    expect(await classifyKeyScopedResponse(new Response("ok", { status: 200 }))).toBeNull();
    expect(await classifyKeyScopedResponse(new Response("Insufficient Balance", { status: 502 }))).toBeNull();
  });

  test("an oversized 403 body fails closed instead of being buffered", async () => {
    const huge = `Free quota exhausted ${"x".repeat(256 * 1024)}`;
    const response = new Response(huge, { status: 403 });
    expect(await classifyKeyScopedResponse(response)).toBeNull();
    expect((await response.text()).length).toBe(huge.length);
  });
});
