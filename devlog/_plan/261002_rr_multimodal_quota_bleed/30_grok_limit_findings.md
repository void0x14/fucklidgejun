# 30 — Foreign "Grok weekly limit" while chatting with DeepSeek via opencodex

Read-only investigation, 2026-10-02. All times UTC (local = UTC+3).

**Verdict: (a), triggered by a real upstream 402 from DeepSeek.** Grok Build's own
pager shows "You hit your weekly limit." for **any** HTTP 402 it gets, whichever
provider or model is selected. opencodex routed correctly (explicit `deepseek`
provider, no xAI misroute, no foreign quota headers). DeepSeek returned
`402 Insufficient Balance`, and opencodex's Responses passthrough relayed it unchanged.
It "never happened before" because the DeepSeek account balance had never run out before.

## Evidence

### Session
`~/.grok/sessions/%2Fhome%2Fvoid0x14%2FDocuments%2Freceive_sms_otomasyon/01a0fa0e-a3d6-7032-b582-b34623a8b040/`
(most recent; `summary.json`: `current_model_id: "deepseek/deepseek-flash"`, created 00:40:58Z,
last active 02:29:45Z, Grok Build 1.0.46).

`updates.jsonl` `retry_state` / `turn_completed` sequence (abridged):

| UTC | Model | Error relayed by ocx |
|---|---|---|
| 00:41:50 | alibaba-cn/glm-5.3 | 400 `Arrearage` (Aliyun overdue payment) |
| 01:33:37 | combo/GLM-5.3_Alibaba | 400 `Combo "GLM-5.3_Alibaba" does not accept image input` (×3) |
| 01:49:37, 01:58:20 | qwen3.8-omni-flash / combo/qwen.38-omni | 403 `insufficient_quota` "Free quota exhausted" |
| 01:59:42 | deepseek/deepseek-v4.1-flash | 400 unsupported model name |
| 02:03:26 | (deepseek-flash) | retry: `502 Bad Gateway: Grok is temporarily unavailable` (Grok Build's own wording for a 502) |
| **02:15:57** | **deepseek/deepseek-flash** | **`API error (status 402 Payment Required): unknown_error: Insufficient Balance (request_id: afd19d51-…)`** |
| 02:15:59, 02:16:43, 02:29:21, 02:29:29 | deepseek/deepseek-flash | same 402 `Insufficient Balance` |

The preceding turn (prompt `2930ce04-…`) ran 107 model calls and about 22.6M input tokens on
`deepseek-flash` before the first 402 (`turn_completed.usage.modelUsage.deepseek-flash`).

### Grok Build unified log (`~/.grok/logs/unified.jsonl`)
- l.15547 `shell.turn.inference_failed` `status_code:402, is_retryable:false, "…Insufficient Balance…"`
- l.15548 `turn.terminal_failure` `status_code:402, auth_mode:null`
- **l.15551 (02:15:57.899Z) `"tier re-check identity changed, discarding result"` `started_user_id:""`.**
  The 402 sends Grok Build into its xAI subscription-tier re-check. The same line appears after
  every 402: l.15582, l.15741, l.15767. It does **not** appear after the 403s or 400s.
- The user is not signed in to xAI: `AuthManager::new auth.json load result … path_exists:false` (l.~15600).
- The upsell modal text is not logged. It is UI-only.

### Grok Build binary (`~/.grok/downloads/grok-1.0.46-linux-x86_64`, `strings`)
One string block in `crates/codegen/xai-grok-pager/src/app/dispatch/status.rs`:

```
run out of credits | status 402 | status 403 | You hit your free usage limit. | …
Upgrade to SuperGrok Heavy … | No billing data available. | You hit your weekly limit. |
Upgrade to a higher tier for more usage | Purchase credits to keep using Grok Build |
You've hit the credit limit for your plan. | … | You've hit your spending cap. | …
subscription.check.meta_parse_failed | check_failed | subscription.check.complete
```

So the pager matches the error text against `status 402` (and similar strings) and shows one of
its own billing upsells. The user has no xAI identity and no billing data, so it falls back to
"You hit your weekly limit." The same block is in 1.0.44 and in the July `grok-linux-x86_64` (0.2.93),
so a recent Grok Build update did **not** cause this. `CHANGELOG.md` (1.0.45/1.0.46) has no
change to limits or usage.

Earlier evidence of the same mapping: `~/.grok/sessions/%2Fhome%2Fvoid0x14%2FDocuments%2Fecho/01a034a4-…`
and `01a0380f-…` (2026-08-25, model `grok-4.6`) carry a genuine xAI
`402 Payment Required: Grok Build usage balance exhausted`. The 402 channel is how xAI
signals real Grok exhaustion, and Grok Build does not check which provider sent it.

### opencodex side
- `~/.grok/config.toml` l.5-11: `[model_providers.opencodex] base_url = http://127.0.0.1:10100/v1`,
  `api_backend = "responses"`, `extra_headers x-opencodex-grok = "1"`. l.5520-5526:
  `[model.ocx-deepseek-deepseek-flash] model = "deepseek/deepseek-flash"`, `model_provider = "opencodex"`.
- `~/.opencodex/usage.jsonl`: the records at 1790907355622, 1790907357928, 1790907402203, 1790908158827
  and 1790908168278 all have
  `requestedModel:"deepseek/deepseek-flash", provider:"deepseek", status:402, errorCode:"http_402",
  upstreamError:"Insufficient Balance (request_id: …)"`, `attempts[0].adapter:"openai-responses"`,
  `routeDecision.routeKind:"explicit-provider"`, single candidate `deepseek/deepseek-flash`.
  **No xAI attempt and no fallback.** The `request_id`s match the ones Grok Build displayed.
- The only xAI traffic in the window is separate, explicitly requested `grok-4.6` calls at
  about 01:30Z (`provider:"xai"`, `credentialSource:"grok-oauth"`, status 426). These were the
  user's own grok-4.6 picks (session `modelsUsed` includes `grok-4.6`) and are unrelated to the 402.
- `~/.opencodex/service.log` ends at 00:48Z (shutdown, then restart at 00:57Z), so it has no lines
  for the event. `routing-history.sqlite` was last written 2026-10-01 01:36Z (stale), so it was not used.

## Who emits it

**Grok Build (xAI CLI) itself.** The wording comes from its pager (`status.rs`). The trigger is
a real `402 Payment Required` from **DeepSeek's API** (`Insufficient Balance`: the DeepSeek
account's prepaid balance ran out). opencodex relayed that 402 unchanged. Ruled out:
(b) no quota or rate-limit headers or `codex.rate_limits` events from another account were attached, because the body
and status are DeepSeek's own; (c) no misroute, because the route decision is explicit-provider `deepseek`.

## Root cause

1. DeepSeek balance exhausted → upstream HTTP 402.
2. `src/server/responses/passthrough-delivery.ts:278-301`: for `!upstreamResponse.ok`, a
   non-combo request relays the status through `formatPassthroughUpstreamError(upstreamResponse.status, …)`.
   `src/server/responses/passthrough-error.ts:42-90` keeps both the status and the body unchanged
   (by design, for #452 and pool-retry fidelity). `classifyError` (`src/lib/errors.ts:179-337`) has no
   402 or balance branch, so the message falls through to the generic `{type, code:type||null}`. Grok
   Build then labels it `unknown_error`.
3. Grok Build pattern-matches `status 402`, runs a subscription re-check against xAI, finds no
   identity, and shows "You hit your weekly limit / Purchase credits to keep using Grok Build".
   It ignores that the active model is a custom provider. That is a Grok Build UX bug.

opencodex already knows the request came from Grok Build (`logCtx.surface = "grok"` from the
`x-opencodex-grok: 1` header, `src/server/index/serve-options.ts:1346`,
`src/server/chat-completions.ts:146`). But it never adapts error statuses for that surface. The only
grok-surface special cases are heartbeat style (`adapter-delivery.ts:106`, `run-turn-execution.ts:348`)
and `passthrough-delivery.ts:407`.

## Proposed fix

User-side, now: top up DeepSeek or switch the session to a funded provider. Grok Build is not
actually limited, and native Grok usage is unaffected.

opencodex (optional, makes the error readable for Grok clients):
- On `surface === "grok"` only, remap a **non-xAI** upstream 402 before relaying. For example,
  send 403 (or 400) with a typed envelope such as
  `{error:{type:"insufficient_quota", code:"insufficient_quota", message:"<provider>: Insufficient Balance …"}}`.
  Keep the provider name in the message so Grok Build shows DeepSeek's text instead of the
  xAI upsell. Do this in `passthrough-delivery.ts` (before `formatPassthroughUpstreamError`) and
  in the equivalent adapter path (`src/server/responses/adapter-dispatch.ts:954`, plus
  `chat-completions.ts` / `chat/outbound.ts` for chat clients). Do **not** remap for
  `provider === "xai"`, because a genuine Grok 402 should keep its native upsell. Check first
  that 403 does not hit the same upsell: `status 403` is in the same string block. The 01:49Z
  403s produced no tier re-check in the log, but whether the UI showed an upsell is unverified.
  If 403 does trigger it, use 400 or 429 + `insufficient_quota` with no Retry-After.
- Add a `402`/"insufficient balance" branch to `classifyError` that returns
  `insufficient_quota`, so the client sees a typed code instead of `unknown_error`.
- Keep Codex and pool behaviour unchanged. 402 is meaningful to the Codex pool cooldown
  (`src/codex/routing/cooldown-math.ts:189-191`, `core-codex-account.ts:224`), so the remap must
  be client-facing only and come after the outcome is recorded.

## Affected tests/docs

- Tests: `tests/codex-integration/issue-452-empty-503.test.ts`, `tests/server/retry-after-429.test.ts`,
  `tests/providers/cyber-policy-error-fidelity.test.ts` (all assert `formatPassthroughUpstreamError`
  fidelity). Grok surface: `tests/providers/xai/grok-config-inject.test.ts`,
  `tests/providers/xai/grok-attribution.test.ts`. A new regression test would cover "grok surface + non-xAI
  402 → no 402 to client; xAI 402 unchanged; codex surface unchanged".
- Structure: `structure/transports/responses.md` (passthrough error contract),
  `structure/providers/xai-grok.md` (Grok Build contract parity), `structure/runtime.md` (`src/grok/`
  owner). `src/lib/errors.ts` classification changes touch every surface.

## Sources

- Local: `~/.grok/sessions/…/01a0fa0e-a3d6-7032-b582-b34623a8b040/{updates.jsonl,summary.json,signals.json,usage.json}`,
  `~/.grok/logs/unified.jsonl` l.15547-15770, `~/.grok/downloads/grok-1.0.46-linux-x86_64` (strings),
  `~/.grok/config.toml` l.5-11 and l.5520-5526, `~/.opencodex/usage.jsonl` (timestamps above).
- [AgEnD issue #992 — Grok Build weekly-limit screen ("You hit your weekly limit", Upgrade tier / Buy more credits)](https://github.com/songsid/AgEnD/issues/992)

## Open questions

- Is the exact on-screen text "You hit your weekly limit." or one of the sibling upsells
  ("credit limit for your plan", "spending cap")? Selection depends on the failed billing lookup, which
  the logs do not record. A screenshot would settle it.
- Does Grok Build show the upsell for 403 too (the 01:49Z Alibaba `insufficient_quota`)? The string block
  includes `status 403`, but no tier re-check was logged for it.
- Does the chat-completions/adapter path (non-passthrough providers) also relay 402 unchanged?
  The current incident only exercised the Responses passthrough.
