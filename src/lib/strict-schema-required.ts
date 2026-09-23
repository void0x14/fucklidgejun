/**
 * Normalize an output JSON Schema for strict-`required` consumers.
 *
 * Google generateContent (responseJsonSchema / function parameters) and llama.cpp's
 * json-schema-to-grammar both validate that every `required` array includes EVERY key
 * of `properties` at the same node. OpenAI-style partial `required` lists are legal
 * upstream of us, so a schema that Anthropic/OpenAI callers emit freely gets rejected
 * the moment we forward it verbatim (live 2026-09-16: Claude Code's goal evaluator sends
 * {ok,reason,impossible} with required:[ok,reason] and Antigravity answers
 * 400 "required is required to be supplied ... Missing 'impossible'").
 *
 * The transform is additive only: missing keys are appended to `required` in
 * properties order; an existing entry order is preserved. Everything else is deep-copied
 * untouched, and every nested object node gets the same treatment because the strict
 * rule applies recursively on the wire.
 */
export function completeStrictRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(completeStrictRequired);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  const properties = (schema as Record<string, unknown>).properties;
  const hasProperties = !!properties && typeof properties === "object" && !Array.isArray(properties);
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && hasProperties) {
      out.properties = completeStrictRequired(properties);
      continue;
    }
    if (key === "required" && hasProperties) {
      const existing = Array.isArray(value) ? value as unknown[] : [];
      const merged = [...existing];
      for (const propKey of Object.keys(properties as Record<string, unknown>)) {
        if (!merged.includes(propKey)) merged.push(propKey);
      }
      out.required = merged;
      continue;
    }
    out[key] = completeStrictRequired(value);
  }
  return out;
}
