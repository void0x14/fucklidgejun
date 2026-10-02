import { randomUUID } from "node:crypto";
import { mutatePersistedConfig } from "../config";
import { publishAccountSelection } from "../lib/account-selection-events";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { ProviderApiKeySelection } from "../types/provider";
import { routedProviderConfig } from "../router";
import { OPENCODE_GO_SESSION_HEADER } from "./opencode-go-transport";
import { resolveProviderTransport, XAI_GROK_COMPATIBILITY, type OcxProviderTransport } from "./xai-transport";
import { captureProviderApiKeySelection } from "./api-key-selection-capture";

export { captureProviderApiKeySelection } from "./api-key-selection-capture";

/**
 * Whether a selection stamp still describes a key this provider row would send.
 *
 * The committed key at the same revision always matches. A round-robin provider additionally
 * accepts any OTHER pool member at the same revision: its per-request pick is stamped with the
 * entry it picked (see `buildRoundRobinRow` in key-failover.ts) and is never written onto the
 * shared row, so concurrent requests each dispatch as the key they were given. Every operator
 * selection bumps `apiKeySelectionRevision`, so a manual choice still invalidates an in-flight
 * pick; removing or re-keying the picked entry invalidates it too. Non-round-robin providers keep
 * the exact committed-key match, so their dispatch contract is unchanged.
 */
export function providerApiKeySelectionMatches(
  provider: OcxProviderConfig,
  expected: ProviderApiKeySelection,
): boolean {
  if (provider.apiKeySelectionRevision !== expected.revision) return false;
  const current = captureProviderApiKeySelection(provider);
  if (current.entryId === expected.entryId && current.reference === expected.reference) return true;
  return provider.apiKeyPoolStrategy === "round-robin"
    && expected.entryId !== undefined
    && expected.reference !== undefined
    && (provider.apiKeyPool ?? []).some(entry => entry.id === expected.entryId && entry.key === expected.reference);
}

/** Resolve the provider row as it would send `reference` (default: its committed key). */
function currentKeyProvider(config: OcxConfig, name: string, reference?: string): OcxProviderConfig | null {
  const configured = config.providers[name];
  if (!configured || configured.disabled) return null;
  const current = routedProviderConfig(name, {
    ...configured,
    ...(reference !== undefined ? { apiKey: reference } : {}),
    _apiKeyAttempt: undefined,
  });
  if (current.authMode === "oauth" || current.authMode === "forward") return null;
  if (current.authMode === "key" && !current.keyOptional && !current.apiKey?.trim()) return null;
  return current;
}

/** The stamped reference when it is a still-valid round-robin pick other than the committed key. */
function stampedPoolReference(provider: OcxProviderConfig | undefined, expected: ProviderApiKeySelection | undefined): string | undefined {
  if (!provider || !expected || expected.reference === undefined) return undefined;
  if (expected.reference === provider.apiKey) return undefined;
  return providerApiKeySelectionMatches(provider, expected) ? expected.reference : undefined;
}

/** Physical-send check; stored references alone do not detect a changed env/keychain value. */
export function providerApiKeySelectionIsCurrent(
  config: OcxConfig,
  name: string,
  routedProvider: OcxProviderConfig,
): boolean {
  const configured = config.providers[name];
  const expected = routedProvider._apiKeyAttempt;
  if (!configured || expected === undefined || !providerApiKeySelectionMatches(configured, expected)) return false;
  const current = currentKeyProvider(config, name, stampedPoolReference(configured, expected));
  return current !== null
    && current.apiKey === routedProvider.apiKey
    && current.authMode === routedProvider.authMode
    && current.baseUrl === routedProvider.baseUrl;
}

/**
 * Rebuild transport from the already committed choice; never allocate or publish a selection.
 * A round-robin pick that is still a valid pool member at the current revision is kept, so a
 * transport refresh (changed base URL, headers, env value) does not collapse it onto the
 * committed key.
 */
export function resolveCurrentProviderApiKeyTransport(
  config: OcxConfig,
  name: string,
  routedProvider: OcxProviderConfig,
): OcxProviderConfig | null {
  const current = currentKeyProvider(
    config,
    name,
    stampedPoolReference(config.providers[name], routedProvider._apiKeyAttempt),
  );
  if (!current) return null;
  const runtime = routedProvider as OcxProviderTransport;
  const headers = { ...current.headers };
  const affinityHeaders = name === "xai"
    ? [XAI_GROK_COMPATIBILITY.headers.conversationId, XAI_GROK_COMPATIBILITY.headers.sessionId]
    : [OPENCODE_GO_SESSION_HEADER];
  for (const header of affinityHeaders) {
    const configured = Object.keys(headers).some(key => key.toLowerCase() === header.toLowerCase());
    const value = Object.entries(runtime.headers ?? {}).find(([key]) => key.toLowerCase() === header.toLowerCase())?.[1];
    if (!configured && value !== undefined) headers[header] = value;
  }
  const fetch = (current as OcxProviderTransport).fetch ?? runtime.fetch;
  return resolveProviderTransport(name, {
    ...current,
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(fetch ? { fetch } : {}),
  });
}

type SelectionMutation<T> = { changed: boolean; value: T; selectionChanged?: boolean };
export type ProviderApiKeyCommit<T> =
  | { status: "committed"; provider: OcxProviderConfig; value: T }
  | { status: "superseded"; provider: OcxProviderConfig }
  | { status: "unavailable" };

/** GUI and recovery share one persisted selection transaction and post-commit notification. */
export function commitProviderApiKeySelection<T>(
  config: OcxConfig,
  name: string,
  mutation: (provider: OcxProviderConfig) => SelectionMutation<T>,
  expectedSelection?: ProviderApiKeySelection,
): ProviderApiKeyCommit<T> {
  const outcome = mutatePersistedConfig<ProviderApiKeyCommit<T> & { notify?: boolean }>(fresh => {
    const provider = fresh.providers[name];
    if (!provider || provider.authMode === "oauth" || provider.authMode === "forward") {
      return { changed: false, value: { status: "unavailable" } };
    }
    if (expectedSelection && !providerApiKeySelectionMatches(provider, expectedSelection)) {
      return { changed: false, value: { status: "superseded", provider: structuredClone(provider) } };
    }
    const before = provider.apiKey;
    const result = mutation(provider);
    const notify = result.selectionChanged === true || before !== provider.apiKey;
    if (notify) provider.apiKeySelectionRevision = randomUUID();
    delete provider._apiKeyAttempt;
    return {
      changed: result.changed || notify,
      value: { status: "committed", provider: structuredClone(provider), value: result.value, notify },
    };
  });
  if (outcome.status === "unavailable") return { status: "unavailable" };
  const committed = outcome.value;
  if (committed.status !== "unavailable") config.providers[name] = structuredClone(committed.provider);
  if (committed.status === "committed" && committed.notify) publishAccountSelection(name, "api-key");
  return committed;
}
