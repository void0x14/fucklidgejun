import { describe, expect, test } from "bun:test";
import { parseDocumentedWindowTable } from "../../src/providers/documented-model-windows";

/** Verbatim shape of the MiniMax text-generation page (markdown/JSX wrapped cells). */
const SAMPLE = [
  "# Model Invocation",
  "",
  "| Model Name | Context Window | Description |",
  "| --- | --- | --- |",
  `| <span style={{whiteSpace:"nowrap"}}>MiniMax-M3.1-Flash-Preview</span> | 1,000,000 | **Frontier multimodal coding model** |`,
  "| MiniMax-M3 | 1,000,000 | **Frontier multimodal coding model** |",
  "| MiniMax-M2.7 | 204,800 | **Recursive self-improvement** |",
  "| [M2-her](/docs/guides/text-chat) | 64 K | Designed for dialogue |",
].join("\n");

describe("parseDocumentedWindowTable", () => {
  test("reads the window out of markup-wrapped cells", () => {
    const windows = parseDocumentedWindowTable(SAMPLE);
    expect(windows["MiniMax-M3.1-Flash-Preview"]).toBe(1_000_000);
    expect(windows["MiniMax-M3"]).toBe(1_000_000);
    expect(windows["MiniMax-M2.7"]).toBe(204_800);
  });

  test("ignores headers, separator rows and non-token values", () => {
    const windows = parseDocumentedWindowTable(SAMPLE);
    expect(Object.keys(windows)).not.toContain("Model Name");
    expect(Object.keys(windows)).not.toContain("---");
    expect(windows["M2-her"]).toBeUndefined();
  });

  test("a page with no table yields no windows", () => {
    expect(parseDocumentedWindowTable("nothing here")).toEqual({});
  });
});
