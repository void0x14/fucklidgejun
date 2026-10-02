# 41 — Grok Build foreign-402 rewrite: implementation

## Implementation (grok 402)

Worktree: `.claude/worktrees/agent-a6bc2cb336fd481a7`, branch `worktree-agent-a6bc2cb336fd481a7`,
based on `fca912f80`.

### Claims verified against code before acting (from 30/40)

- The Grok marker sets `logCtx.surface = "grok"` in exactly two places:
  `src/server/index/serve-options.ts` for `/v1/responses` and `src/server/chat-completions.ts`
  for `/v1/chat/completions`. `/v1/messages` never sets it. `src/grok/inject.ts` writes only the
  `responses` backend (and historically the `chat_completions` one). So Grok Build cannot reach the
  Anthropic ingress through opencodex, and that ingress is deliberately not covered.
- `responseWithDeferredRequestLog` (`src/server/relay.ts`) logs `response.status` when the body
  is read. A rewrite placed outside it keeps `usage.jsonl` at 402. Combo, cooldown, health and
  key-failover accounting all run inside the route, before the response reaches this boundary.
- The provider name is readable before the body. Attempt records get `provider` and
  `credentialSource` when the attempt begins (`beginRequestAttempt` and
  `recordAttemptCredentialSource` in `src/server/request-log.ts`). Combo children are finished
  with their status before the parent responds.
- The `deepseek` registry row pins `api.deepseek.com`. A Responses-ingress DeepSeek request goes
  to `/responses`, the same `openai-responses` attempt the incident shows.

### Change

- New module `src/server/grok-foreign-billing.ts`, function
  `rewriteGrokForeignPaymentRequired(response, logCtx, config)`.
  - It is a no-op (it returns the same `Response` object) unless all of these hold:
    - `surface === "grok"`
    - status is 402
    - the content type is not SSE
    - the serving provider is positively identified and is not xAI
  - **Provider identity.** The attempt is the last one with status 402, else the active attempt,
    else the last attempt. It is xAI when any of these hold:
    - `credentialSource` is `grok-oauth` or `xai-api-key`
    - the name is `xai`
    - the registry id is `xai`
    - the configured `baseUrl` host is `x.ai`, `grok.com`, or a subdomain of either

    A name that is not in `config.providers` (for example a Codex pool `openai-<ns>` log label)
    counts as unknown and is left unchanged. Nothing is inferred from the model name.
  - **Output.** HTTP 400 with
    `{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"<Label>: <upstream msg> (upstream HTTP 402 Payment Required; this is the <Label> account balance, not a Grok limit)"}}`.
    - The label is the registry `label`, else the configured name.
    - The upstream message is whitespace-collapsed, passed through `redactSecretString`, and
      capped at 500 characters.
    - A non-JSON body or a missing message gives `payment required`.
    - Every case-insensitive `status 402` / `status 403` becomes `HTTP 40x`, and
      `run out of credits` becomes `exhausted the credits`, across the whole composed message.
    - These headers are removed: `retry-after`, `retry-after-ms`, `content-length`,
      `content-encoding`.
    - The body read is capped at 64 KiB.
- `src/server/index/serve-options.ts`:
  - `/v1/responses` wraps `responseWithDeferredRequestLog(...)`, inside `withCors` and
    `withRequestLogId`.
  - `/v1/chat/completions` wraps the whole `handleChatCompletions(...)` result. That covers the
    native-chat `fail()`, the translated non-OK rewrite, and the combo paths.
- No change to `key-failover`, `request-transport`, `adapter-dispatch`, `passthrough-dispatch`,
  `chat-native`, `core-combo` or `src/combos/` (the areas the concurrent agents own).

### Tests

`tests/providers/xai/grok-foreign-402.test.ts` (domain `providers/xai`), registered in
`scripts/test-layout/layout.json` `explicit` and in `tests/fixtures/test-layout-expected.json`.
It has 18 tests and drives a real `startServer(0)` with a stubbed fetch. Unmatched non-loopback
hosts get 418, so a test never reaches a real vendor.

- **Rewritten to 400:**
  - grok + DeepSeek 402 on the Responses passthrough. The log row keeps 402 and `surface: "grok"`.
  - grok + custom `openai-chat` gateway 402 on Responses (the adapter-dispatch path).
  - grok + DeepSeek 402 on the Chat Completions ingress. The log keeps 402.
  - An upstream message containing trigger phrases is sanitized.
  - A non-JSON (HTML) 402 gets the generic message.
  - An upstream `Retry-After` is dropped.
- **Unchanged:**
  - an xAI 402
  - a custom-named provider at `api.x.ai`
  - no marker, on Responses and on Chat
  - grok + 403
  - grok + streamed 200
- **Unit tests:**
  - A combo whose last 402 came from xAI keeps the 402.
  - A combo with an xAI 426 followed by a DeepSeek 402 is rewritten.
  - A custom xAI base URL is recognized.
  - An unknown provider is left unchanged.
  - A 1 MiB body is read bounded.
  - Non-grok and non-402 responses return the same object.

The first run, with only the tests and no implementation, failed 9 of 12. With the
implementation, 18 of 18 pass, plus both layout guards.

### Docs

- `structure/providers/xai-grok.md`: new section "Grok Build client: foreign HTTP 402".
- `structure/data-planes/inbound-compat.md`: a pointer under the Chat inbound section.
- `docs-site` `guides/grok-build.md` "Known limitations": a bullet in en, fr, ja, ko, ru, tr,
  zh-cn and zh-tw.

### Gates

- `bun run typecheck`: clean.
- `bun run privacy:scan`: passed.
- `bun run structure:check`: 2 failures, and both already exist on `fca912f80`.
  `structure/providers/openai-tiers.md` is 616 lines (over the 600 budget), and it names a
  missing `src/codex/observed-model-denials.ts`. Neither comes from this change.
- `bun run test:changed` cannot resolve a `dev` merge base in this clone. The equivalent
  `bun scripts/test.ts --changed=HEAD` result is in the final report.

### Not done (deliberately)

- No `classifyError` 402 / "insufficient balance" branch. It would change every surface.
- No remap of grok + 403 + "run out of credits". The task requires a 403 to stay unchanged.
