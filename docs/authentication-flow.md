# Authentication and request flow

OpenCodex has two different authentication decisions: whether a client may call the
proxy, and which credential the selected upstream provider receives. A proxy admission
key is not a model-provider key. Changing reasoning settings does not change either
credential decision.

## Components and boundaries

| Component | Code | Responsibility |
| --- | --- | --- |
| Data admission | [`auth-cors.ts`](../src/server/auth-cors.ts) | `resolveApiAuth` admits Messages-style requests; `resolveResponsesApiAuth` admits Responses/Chat transports. It records the credential source and a scoped principal. |
| Management admission | [`management-auth.ts`](../src/server/management-auth.ts) | Independent admin credential, constant-time comparisons, protected token file, session admission and route-scoped capabilities. |
| Dashboard sessions | [`gui-session.ts`](../src/server/gui-session.ts) | Origin-bound, expiring sessions; mutations also require CSRF. Local sessions last five minutes, remote sessions twelve hours. |
| Route selection | [`router.ts`](../src/router.ts), [`combos/`](../src/combos/) | Resolve aliases, concrete model/provider, metadata and operator-selected combo targets. |
| Provider keys | [`key-store.ts`](../src/providers/key-store.ts), [`api-key-selection.ts`](../src/providers/api-key-selection.ts) | Resolve literal, environment or OS-keychain keys and select the configured physical key. |
| Provider OAuth | [`oauth/index.ts`](../src/oauth/index.ts), [`oauth/store.ts`](../src/oauth/store.ts) | Select stored accounts, resolve access tokens and serialize refreshes with account/generation-aware locking. |
| Codex credentials | [`auth-context.ts`](../src/codex/auth-context.ts), [`account-store.ts`](../src/codex/account-store.ts), [`main-account.ts`](../src/codex/main-account.ts) | Distinguish caller/main/pool identity and materialize only the selected credential. |
| Upstream transport | [`xai-transport.ts`](../src/providers/xai-transport.ts), [`core-auth.ts`](../src/server/responses/core-auth.ts), [`adapters/`](../src/adapters/) | Resolve provider-specific auth and serialize the selected protocol. |

## A request, end to end

1. A client sends `POST /v1/responses`, `/v1/messages` or `/v1/chat/completions`.
   [`server/index.ts`](../src/server/index.ts) applies listener, origin and admission
   policy before the selected endpoint processes the body. A loopback data listener
   permits local requests without a proxy token; a non-loopback data listener requires
   a configured admission credential.
2. Messages and translated Chat input become the internal Responses request through
   [`claude-messages.ts`](../src/server/claude-messages.ts) and
   [`chat-completions.ts`](../src/server/chat-completions.ts). Eligible native Chat
   and native Anthropic routes have their own passthrough paths.
3. The router resolves the actual provider and native model. A combo selects a concrete
   target; each attempt resolves that target's credentials and capabilities. A combo
   default fills a missing client effort. Operator pins/caps are separate controls in
   [`effort-policy.ts`](../src/server/effort-policy.ts).
4. `key` auth resolves that provider's key. `oauth` resolves the selected stored access
   token. Codex `forward` resolves the caller/main/pool context and calls
   `materializeCodexUpstreamAuthAsync`; it is not unconditional header forwarding.
5. The adapter constructs the provider request. OpenAI Chat normally sends
   `Authorization: Bearer …`; Anthropic key auth normally sends `x-api-key`, with
   explicit bearer transport available. The selected provider's protocol owns the
   final field names. The client-to-proxy admission secret must not become this key.
6. Upstream output is streamed or translated back to the client. Existing error,
   cancellation and output-commit boundaries govern recovery. A fallback cannot
   replay a request freely after visible output has committed.

## Credentials and tokens

| Material | Storage / lifetime | Where it is used |
| --- | --- | --- |
| Data admission keys | `OPENCODEX_API_AUTH_TOKEN`; service delivery through `service-api-token`/`OCX_API_TOKEN_FILE`; configured `apiKeys` in protected `config.json`. | Data endpoints. Dedicated `x-opencodex-api-key` takes precedence. Messages admission can also accept `x-api-key`; Responses admission does not. A bearer matching an OpenCodex admission secret may be admitted, with upstream substitution where required. |
| Admin credential | `OPENCODEX_ADMIN_AUTH_TOKEN` or independently generated `admin-api-token`; protected file mode `0600` and platform ACL hardening. | Management endpoints only. Management has no loopback bypass and fails closed if its credential is unavailable or overlaps a data credential. |
| GUI token and CSRF token | Session state in process memory, bound to server/browser origin and expiry. | Management only; not attached to inference requests. Bootstrap pages use `no-store`. |
| Provider API key | Literal value in protected provider config, `${ENV_VAR}` reference, or `keychain:` reference resolved through the OS keychain. | Selected provider request only. Provider configuration DTOs remove keys and headers and expose presence indicators. |
| Provider OAuth access/refresh tokens | Protected `auth.json` under the OpenCodex state directory, normally `~/.opencodex`; multi-account records include credential and identity state. JSON storage is permission protected, not application-level encryption. | Access tokens authenticate upstream; refresh tokens stay in provider refresh flows. Mutations use atomic persistence and file locking. |
| Codex pool tokens | Protected `codex-accounts.json`; main-account access uses the managed Codex auth state. | Selected ChatGPT/Codex account. Pool materialization replaces bearer/account headers with that selected account's values. |

When a caller uses an OpenCodex admission bearer on a Codex main route, materialization
substitutes the stored main token or fails before upstream I/O. When a dedicated proxy
header accompanies a legitimate native Codex bearer, the intentional forward path may
retain that bearer. `validateForwardAdmissionCredential` rejects proxy-secret material
from upstream forwarding. Route-changing recovery drops unscoped caller credentials;
the next target resolves its own credential.

OAuth refresh is account-scoped and single-flighted. Rotating-token providers also use
durable refresh intent/locks; stale generation checks prevent a late refresh from
overwriting a newer credential. Background Token Guardian refresh is optional and uses
the existing resolver, not a second refresh implementation. A missing OAuth credential
does not silently select API-key billing instead.

See the canonical [authentication boundaries](../structure/gui-and-management-api.md#authentication-boundaries)
and [provider auth modes](../docs-site/src/content/docs/guides/providers.md#auth-modes).

## The reported MiniMax 400

The screenshot is a parameter-contract failure, not evidence of a broken login.
Previously the shared M3-family seed mapped `low` to `thinking.type=disabled`, although
M3.1 requires thinking to remain on. It also replayed M3.1 reasoning using M3's structured
field. The shared [model seed](../src/providers/registry/model-seeds.ts) now distinguishes:

| Target | Low effort | Reasoning replay |
| --- | --- | --- |
| M3 | Existing disabled-thinking toggle | `reasoning_details` |
| M3.1 Flash Preview | `reasoning_effort=low` | `reasoning_content` |

Both regional presets use that same seed. Catalog enrichment and routing repair only
exact obsolete generated maps/lists; differently edited settings remain authoritative.
Per-model default/map filling keeps one customization from suppressing sibling metadata.
The GUI's null combo default is labeled **Inherit client / provider**; it does not mean
`none` or disable thinking. Without an operator override, explicit caller `none` remains
a provider-rejected request on M3.1, rather than being silently changed to a higher effort.

The current vendor contract is documented in the
[MiniMax OpenAI API reference](https://platform.minimax.io/docs/api-reference/text-openai-api).
For diagnostics, open **Logs**, select the request, and inspect requested/effective effort,
wire field/value, resolved model and upstream error before changing credentials.

## Scope and verification

The Operation page now enables saving only after a valid preference snapshot loads,
keeps stored models visible when absent from the current catalog, and requires a
confirmed `saved: true` response before reporting success. Reads and writes use the
existing bounded-fetch utility. The shared GUI error reader also exposes nested
backend `error.message` responses. Retry explicitly re-reads the saved snapshot.

This refactor removes the identified metadata mismatches; it is not proof that every local
failure in the repository is eliminated. Network access, local configuration, credential
availability, filesystem/process failures, protocol translation and future provider
contract changes remain possible. Custom maps are preserved and can still request an
unsupported value. No new fallback model, credential domain or retry mechanism is added.

No tests are written or run for this change, as requested. TypeScript, GUI/documentation
builds and static checks are separate validation and do not establish live provider or
end-to-end correctness.
