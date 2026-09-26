import { describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import { compileGoogleWireBody, repairGoogleInvalidRequestBody } from "../../../src/adapters/google-wire-compiler";
import type { OcxParsedRequest } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

describe("Google wire compiler", () => {
  test("enforces the conservative wire contract at the final serialization boundary", () => {
    const originalName = `9 bad.tool name ${"x".repeat(80)}`;
    const compiled = compileGoogleWireBody({
      contents: [
        { role: "model", parts: [{ functionCall: { name: originalName, args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: originalName, response: { result: "ok" } } }] },
      ],
      tools: [{
        functionDeclarations: [{
          name: originalName,
          description: "A hostile MCP tool",
          parameters: {
            type: "object",
            properties: {
              token: { type: "string", "x-mcp-header": "Authorization" },
            },
          },
          futureDeclarationField: true,
        }],
        futureToolField: true,
      }],
      generationConfig: {
        maxOutputTokens: -2,
        temperature: 99,
        topP: -1,
        thinkingConfig: { thinkingLevel: "max", futureThinkingField: true },
        futureGenerationField: true,
      },
      futureTopLevelField: true,
    });

    const body = compiled.body;
    const declaration = (body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]
      .functionDeclarations[0];
    const wireName = declaration.name as string;
    expect(wireName).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
    expect(compiled.restoreToolName(wireName)).toBe(originalName);
    expect(JSON.stringify(declaration.parameters)).not.toContain("x-mcp-header");
    expect(declaration.futureDeclarationField).toBeUndefined();
    expect((body.tools as Array<Record<string, unknown>>)[0].futureToolField).toBeUndefined();

    const contents = body.contents as Array<{ parts: Array<Record<string, any>> }>;
    expect(contents[0].parts[0].functionCall.name).toBe(wireName);
    expect(contents[1].parts[0].functionResponse.name).toBe(wireName);
    expect(body.generationConfig).toEqual({
      temperature: 2,
      thinkingConfig: { thinkingLevel: "high" },
    });
    expect(body.futureTopLevelField).toBeUndefined();
  });

  test("the Google adapter compiles tool names on request and restores them on response", async () => {
    const originalName = `9 invalid tool ${"x".repeat(80)}`;
    const adapter = createGoogleAdapter({
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
    });
    const request = await adapter.buildRequest({
      modelId: "gemini-3.5-flash",
      stream: false,
      options: {},
      context: {
        messages: [{ role: "user", content: "Use the tool" }],
        tools: [{ name: originalName, description: "Test", parameters: { type: "object" } }],
      },
    } as OcxParsedRequest);
    const body = JSON.parse(request.body);
    const wireName = body.tools[0].functionDeclarations[0].name as string;

    expect(wireName).not.toBe(originalName);
    expect(wireName).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);

    const events = await adapter.parseResponse!(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: wireName, args: {} } }] } }],
    })));
    expect(events.find(event => event.type === "tool_call_start")).toMatchObject({
      type: "tool_call_start",
      name: originalName,
    });
  });

  test("restores a model echo that drops the codec hash suffix (tavily_tavily_search)", () => {
    // Real incident 2026-09-26: declared `tavily_tavily-search` went on the wire as
    // `tavily__tavily_search_<sha8>`; Gemini echoed `tavily_tavily_search` (no hash,
    // separator folded to underscore). Exact-match restore missed it, the undeclared-tool
    // guard failed the turn closed with `routed provider emitted undeclared client tool`.
    const compiled = compileGoogleWireBody({
      tools: [{
        functionDeclarations: [{
          name: "tavily__tavily-search",
          description: "Tavily search",
          parameters: { type: "object" },
        }],
      }],
    });
    const body = compiled.body;
    const wireName = (body.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]
      .functionDeclarations[0].name as string;
    expect(wireName).not.toBe("tavily__tavily-search");
    // Exact echo still restores.
    expect(compiled.restoreToolName(wireName)).toBe("tavily__tavily-search");
    // Hash-stripped echo must restore too, not pass through as an undeclared name.
    expect(compiled.restoreToolName("tavily__tavily_search")).toBe("tavily__tavily-search");
    // Partially corrupted hash shards restore through the same stem.
    expect(compiled.restoreToolName(`${wireName.slice(0, -4)}`)).toBe("tavily__tavily-search");
    // Unknown names still pass through so the guard keeps failing closed on real strangers.
    expect(compiled.restoreToolName("never_declared_tool")).toBe("never_declared_tool");
  });

  test("hash-stripped restore stays ambiguous-safe (no invented grants)", () => {
    // Two declarations sharing one cleaned stem: a hash-less echo cannot name either one,
    // so it must pass through and let the guard reject it rather than mis-route the call.
    const compiled = compileGoogleWireBody({
      tools: [{
        functionDeclarations: [
          { name: "ns__tool-search", description: "a", parameters: { type: "object" } },
          { name: "ns__tool_search", description: "b", parameters: { type: "object" } },
        ],
      }],
    });
    expect(compiled.restoreToolName("ns__tool_search")).toBe("ns__tool_search");
  });


  test("repairs only the tool schema named by a Claude-on-Antigravity 400", () => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [{ functionDeclarations: [
          { name: "safe", parameters: { type: "object", properties: { value: { type: "string" } } } },
          { name: "rejected", parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } } },
        ] }],
      },
    });
    const error = JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "tools.1.custom.input_schema: JSON schema is invalid",
      },
    });

    const repaired = JSON.parse(repairGoogleInvalidRequestBody(body, error)!);
    const declarations = repaired.request.tools[0].functionDeclarations;
    expect(declarations[0].parameters).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
    });
    expect(declarations[1].parameters).toEqual({ type: "object", properties: {} });
  });

  test("repairs an unsupported thinking level without discarding other generation config", () => {
    const body = JSON.stringify({
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        generationConfig: {
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingLevel: "high" },
        },
      },
    });
    const error = "Invalid value at 'request.generation_config.thinking_config.thinking_level'";

    const repaired = JSON.parse(repairGoogleInvalidRequestBody(body, error)!);
    expect(repaired.request.generationConfig).toEqual({ maxOutputTokens: 4096 });
  });

  test("keeps the includeThoughts opt-in while still dropping unknown thinking keys", () => {
    const withOptIn = compileGoogleWireBody({
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "max", futureThinkingField: true },
      },
    });
    expect(withOptIn.body.generationConfig).toEqual({
      thinkingConfig: { thinkingLevel: "high", includeThoughts: true },
    });

    // The flag has to survive on its own too: suffix tier ids deliberately carry no
    // thinkingLevel, so an includeThoughts-only config is the whole request.
    const optInOnly = compileGoogleWireBody({
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    });
    expect(optInOnly.body.generationConfig).toEqual({ thinkingConfig: { includeThoughts: true } });

    // Non-boolean / absent values must not invent the key.
    const notRequested = compileGoogleWireBody({
      generationConfig: { thinkingConfig: { includeThoughts: "yes", thinkingLevel: "high" } },
    });
    expect(notRequested.body.generationConfig).toEqual({ thinkingConfig: { thinkingLevel: "high" } });
  });
});
