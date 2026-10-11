/** Yalnızca katalogdaki tek bir gerçek kimliğe eşleşirse düzeltir; model adı üretmez. */
export function canonicalModelId(input: string, provider: string, ids: readonly string[]): string | undefined {
  const requested = input.trim();
  if (ids.includes(requested)) return requested;
  const unscoped = requested.startsWith(`${provider}/`) ? requested.slice(provider.length + 1) : requested;
  if (ids.includes(unscoped)) return unscoped;
  const folded = (value: string) => value.toLowerCase().replace(/[-_\s]/g, "");
  const matches = ids.filter(id => folded(id) === folded(unscoped));
  return matches.length === 1 ? matches[0] : undefined;
}
