# 20 — Round-robin key pool: rotation and failover findings (investigation B)

Read-only investigation, 2026-10-02. No source changed. Key values were never printed; only
pool sizes, entry ids and strategies. HEAD = `fca912f80` (branch `main`).

## TL;DR

- Request-to-request rotation **does** run for providers with `apiKeyPoolStrategy:
  "round-robin"` (only `google`, 19 keys, and `alibaba-cn`, 5 keys, have it). It breaks down
  under concurrency, and none of its failures are remembered.
- In-request failover only exists for **HTTP 401 and 429**, only on the **translated adapter**
  path (`adapter-dispatch.ts`, `chat-native.ts`). The Responses **passthrough** path (used by
  `deepseek/deepseek-flash`) has no API-key failover at all. 402, 403 quota/billing, 400
  "account in good standing", and 5xx never rotate a key and never cool one.
- With no strategy set (`deepseek`, `anthropic-apikey`, `atria`, `apmix`, `bai`,
  `tokenharbor`), every request uses the committed key. A key-scoped error that is not 401/429
  is therefore sticky forever: "continue" goes back to the same dead key. The live evidence
  shows exactly that: five consecutive `deepseek` 402 "Insufficient Balance" responses at
  05:15–05:29 on 2026-10-02, each with `sendCount 1` and no recovery.
- 92528930a fixed pre-dispatch distribution only. 3acc81fca, f324acd7e and c691915ff did not
  touch API-key pools at all. They changed combo cooldowns, the Codex wire-model map, and
  OAuth-account (Antigravity) rotation.

## Prior-fix analysis

| Commit | What it changed | Rotation per request? | Failover on error? |
|---|---|---|---|
| `92528930a` fix(providers): advance api key pool on each request | `src/providers/key-failover.ts` only: adds `nextRoundRobinKey` (now :143-161) and `buildRoundRobinTransport` (:183-192), and the RR branch in `selectProactiveApiKey` (:290-295). It writes the picked key onto the **live** config row in memory and never persists it. Tests: 3 unit tests in `tests/adapters/key-failover.test.ts`. | Yes, for `round-robin` only. Sequential requests advance through the cursor. | **No.** It does not touch any error path. Its stamp/gate assumption is also wrong (see Root cause R3). |
| `3acc81fca` "...round-robin fix and googlesal şeyler" | `combos/failover.ts`: blind and request-rate combo cooldowns go from 15s/5s to **60s**, and "resource has been exhausted" now counts as a rate window. `core-combo.ts`: `hasSpareAccount` stops a 429 from cooling a combo target, but only when `eligibleFailoverAccounts(provider)` has **OAuth** accounts. Also strict-schema and Google/Ollama adapter tweaks. | No (this is **combo** round-robin, not key round-robin) | No for API-key pools. `eligibleFailoverAccounts` (`src/oauth/generic-account-failover.ts:189-195`) reads the OAuth account set, so an API-key provider always gets `[]`. A key-pool 429 inside a combo still cools the target, now for 60s instead of 15s. |
| `f324acd7e` | `core-codex-account.ts`: gpt-6 to sol/luna wire map. `codex/catalog/*`: native model rows. Google: one line. | No | No (unrelated) |
| `c691915ff` fix(antigravity): rotate off VALIDATION_REQUIRED | OAuth-only: `isAccountScopedAccessDenied` and `rotateGenericOAuthAccountOnAccessDenied` (adapter-dispatch.ts ~700-750). `isAccountScopedComboFailure` (`combos/failover.ts:432`) widens the combo exemption to that 403. | No | OAuth accounts only. It is still gated by `eligibleFailoverAccounts` (OAuth), so API keys are untouched. |

`git log -- src/providers/key-failover.ts` shows only `92528930a` and the squash merge
`e4a8539b9`. No other commit touched the key pool.

Verdict: the earlier fix was a distribution patch for the healthy path. Failover on error, and
remembering a bad key, were never implemented beyond the pre-existing 401/429 loop.

## Current code path (file:line)

1. Route resolution: `routedProviderConfig` stamps `_apiKeyAttempt =
   captureProviderApiKeySelection(provider)` (`src/router.ts:301`;
   `src/providers/api-key-selection-capture.ts:4-10`: entryId, reference, revision).
2. Pre-dispatch pick:
   - Responses core: `src/server/responses/request-transport.ts:548-554`
     (`selectProactiveApiKeyTransport`).
   - Native chat: `src/server/chat-native.ts:253`. Compact: `responses/compact.ts:780`.
     Images: `server/images.ts:718`.
   - Claude `/v1/messages` replays through `handleResponses` (`server/claude-messages.ts:919`).
     Combo children also call `handleResponses` (`core-combo.ts:479`). Both therefore go
     through `request-transport.ts`.
   - `selectProactiveApiKey` (`key-failover.ts:272-339`):
     - `if (!strategy) return null` (:280). No strategy means always the committed key.
     - RR plus a healthy committed key gives `nextRoundRobinKey` and `buildRoundRobinTransport`,
       which mutates `config.providers[p].apiKey` in memory (:190).
     - fill-first/quota leave a healthy committed key alone (:298). A cooled committed key is
       replaced by a persisted commit (:320-338).
3. Dispatch gate:
   - `selectionIsCurrent`, then `providerApiKeySelectionIsCurrent`
     (`request-transport.ts:244-248`, `api-key-selection.ts:29-41`). It compares the route's
     `_apiKeyAttempt` against the **live** row.
   - If they differ, `refreshDispatchAdapter` (`request-transport.ts:276-291`) rebuilds from the
     live row through `resolveCurrentProviderApiKeyTransport` (`api-key-selection.ts:44-67`). It
     re-stamps from the live row and retries up to 3 times (`request-transport.ts:340-395`).
4. Upstream fetch, then the recovery loop (`responses/adapter-dispatch.ts:509+`):
   - 401 plus pool: `rotateProviderTransportOn401` (:573-597).
   - 429 plus `retryOn429`: same-key wait-and-replay (:605-636).
   - 429 plus pool: `rotateProviderTransportOn429` (:643-667).
   - OAuth-only arms: Anthropic pool (:671+), generic OAuth 403 (:700+).
   - Nothing else rotates a key.
5. Rotation core, `rotateKeyAfterFailure` (`key-failover.ts:442-526`):
   - `failureStatus: 401 | 429` only (:445).
   - It commits through `commitProviderApiKeySelection(..., attemptedSelection)`
     (`api-key-selection.ts:76-105`), which returns `superseded` if the **on-disk** row does not
     match the stamp (:87-89) and resets the live row to the disk row (:102).
   - The cooldown write (`keyCooldowns.set`, :509) happens only on the committed/unchanged
     branches. The `superseded` early return (:496-500) skips it.
6. Back to the client: the non-OK upstream response is returned as is. A combo first runs
   `advanceComboAfterFailure` (`core-combo.ts:667-688`, `combos/resolve.ts:331-367`).

## Bypass paths found

- **B1: Responses passthrough has no key-pool failover.**
  - `src/server/responses/passthrough-dispatch.ts` imports only `rateLimitRetryPolicyFor` and
    `rateLimitRetryDelayMs` from key-failover (:112).
  - Its 401 arm is Codex-pool only (:884-980). Its 429 arm is generic-OAuth only
    (:1107-1150), followed by same-key `retryOn429` (:1161+).
  - No `hasKeyPoolFailover` or `rotateProviderTransportOn429/401` exists in that file.
  - Live: `deepseek/deepseek-flash` attempts run with `adapter: "openai-responses"`
    (usage.jsonl, 153×200 and 5×402 on 2026-10-02), while `deepseek-v4.1-flash` runs
    `openai-chat` and did get `key-401` recovery (04:59:40).
- **B2: no strategy means no pre-dispatch movement.** `key-failover.ts:280`. 6 of the 8
  multi-key providers in `~/.opencodex/config.json` have no strategy (`deepseek` 6 keys,
  `anthropic-apikey` 5, `atria` 5, `apmix` 137, `bai` 3, `tokenharbor` 3). The docs describe this
  as intended (`docs-site/.../providers.md:204`, "Omitted keeps rotation reactive-only").
- **B3: model discovery** uses the committed `provider.apiKey` only
  (`src/codex/catalog/provider-models.ts:121-123`). It is not on the request path, but a dead
  committed key degrades discovery for the whole provider.
- **B4: sidecars and web search** reuse the same `route.provider` that request-transport
  already picked. `sidecar-execution.ts:153-163` rotates only on 429. This is not a separate
  bypass, but it inherits all of R1–R3.
- No sticky per-session key affinity exists for API keys: `promptCacheKey` only feeds
  transport headers in `applyRotatedTransport`. There is no cached client keyed by provider,
  and the upstream host circuit is opt-in and unset in this config
  (`upstreamHostCircuitThreshold` undefined; `codex/upstream-host-health.ts` header).

## Error/failover behavior

| Upstream answer (pre-stream) | Same-request retry on another key? | Failed key cooled for next request? |
|---|---|---|
| 429, translated path | Yes (adapter-dispatch :643) | Only if the failed key == the persisted committed key. Under RR the distributed key is **not** cooled (R3). |
| 401, translated path | Yes (:573) | Same caveat as 429. A committed key gets the 10-min cap (:506-508). |
| 429/401, passthrough path | **No** (B1) | **No** |
| 402 Insufficient Balance | **No** | **No** |
| 403 "Free quota exhausted" / Model.AccessDenied | **No** | **No** |
| 400 "Access denied… account in good standing" (Alibaba arrears) | **No** | **No** |
| 5xx | Same-key replay only (`transientRetryOn5xx`, openai-chat, opt-in, :398-409) | No |
| Mid-stream error after bytes | No (by design: not replayable) | No |

Sticky mechanisms:

- **S1 (non-RR providers):** the committed key never moves on 402/403/400/5xx, so every
  "continue" replays the same dead key indefinitely.
- **S2 (combos over a key-pool provider):**
  - `hasSpareAccount` is OAuth-only (`core-combo.ts:667-671`), so any key-scoped failure cools
    the combo target.
  - Scope: 401/402/403 give `provider` scope (`combos/failover.ts:464`). Quota caps give
    provider scope. 429 gives `target` scope.
  - Duration: 60s default, Retry-After or reset up to 10 min (`combos/failover.ts:21-29`,
    `coolComboTarget`).
  - `waitForCooldownMs` defaults to 0 (`combos/types.ts:6`). A single-target combo
    (`GLM-5.3_Alibaba`, `qwen.38-omni`, `qwen-max`, `kimi-k3-alibaba`, `paidgoogle`,
    `gemini-38-google` — all one target) therefore answers `No available targets` to a
    "continue" inside the window, even though the other 4 alibaba keys are healthy.
  - This is code-proven. It was not observed in the logs for the 2026-10-02 window (the
    failures there were minutes apart, past the 60s default).
- **S3 (RR):** a 401/429 on a distributed key is never cooled (R3), and 402/403/400 are never
  cooled anywhere. The RR cursor therefore keeps feeding a dead key back every N requests.
- Combo `strategy: "round-robin"` with one target does **not** rotate keys. Combo round-robin
  and key round-robin are independent mechanisms, which the combo naming obscures.

## Real evidence

Sources: `~/.opencodex/usage.jsonl` (current) and `routing-history.sqlite`. The sqlite store
stopped at 2026-09-30 12:52, file mtime Oct 1. `service.log` is stale: the proxy runs from a
terminal since 2026-10-02 03:57, PID 265814, and its stdout is not captured. Neither store
records the upstream key entry id, so per-request key ids **cannot** be shown from logs. That
gap is itself a finding.

- `service.log`: `grep -c key-failover` = **0**. No 429/401 key rotation was ever logged.
- deepseek (6 keys, no strategy, `deepseek-flash` via openai-responses passthrough), 2026-10-02:
  - 153 straight 200s, then `05:15:55 402`, `05:15:57 402`, `05:16:42 402`, `05:29:18 402`,
    `05:29:28 402`.
  - All five: "Insufficient Balance", `sendCount 1`, `recoveryKinds []`.
  - This is the "continue keeps failing on the same key" symptom, reproduced by B1+B2+S1.
- deepseek `04:59:40 deepseek-v4.1-flash 400 s2 [key-401]`: the openai-chat path did rotate on a
  401. The committed id changed `92727e27` → `f7b19d16` between `config.json.bak-pre-clean-keys-*`
  (03:48) and the current config. The persisted rotation works where it exists.
- alibaba-cn (round-robin):
  - Pool was 10 keys before the 03:48 key cleanup and is 5 now.
  - `03:29:35`, `03:41:49`, `03:45:58`: 400 "Access denied, please make sure your account is in
    good standing", `s1`, no recovery.
  - `04:49:34`, `04:50:58`, `04:58:17` (combo/qwen.38-omni): 403 "Free quota exhausted",
    `s1`, no recovery.
  - 200s are interleaved (`04:53:18`), which is consistent with RR moving to a different key on
    the next request. The key ids are unprovable from logs.
- Grok session `~/.grok/sessions/%2Fhome%2Fvoid0x14%2FDocuments%2Freceive_sms_otomasyon/01a0fa0e-…/updates.jsonl`:
  - `retry_state failed … "API error (status 403 Forbidden): insufficient_quota: Provider error 403: Free quota exhausted…"`
  - then `stop_reason: "error"`. The client stops the job on a single pre-stream failure.
- routing-history 2026-09-30:
  - alibaba-cn glm-5.3: 8×200, then `12:48:59 403 Model.AccessDenied`, `s1`.
  - anthropic-apikey: 400 "credit balance is too low", `s1`, ×4 across two days. It has no
    strategy and does not rotate.
- Scratch reproduction (`bun test` on a scratch file under the session scratchpad, temp
  `OPENCODEX_HOME`, pool alpha/beta/gamma, RR):
  - RR pick = beta, but the stamp says `k1`. Gate `providerApiKeySelectionIsCurrent` = **false**
    on every RR pick, so dispatch always takes the refresh path.
  - After the refresh (beta, stamp k2), a 429 rotation returned **alpha** (the persisted key) and
    `getKeyCooldownUntil("p","k2")` = **null**. The failing key was not cooled, and the live row
    was reset to alpha.
  - Two in-flight picks (beta, gamma) both dispatch as **gamma**: concurrent requests collapse
    onto the newest pick.

## Root cause(s)

- **R1, failover is status-narrow.** Only 401 and 429 are treated as key-scoped
  (`key-failover.ts:445`, `adapter-dispatch.ts:573/643`, `chat-native.ts:391`). Provider
  billing/quota verdicts arrive as 402, 403 or 400 (DeepSeek 402 "Insufficient Balance";
  DashScope 403 "Free quota exhausted" / Model.AccessDenied, 400 arrears). They pass straight to
  the client with no rotation and no cooldown.
- **R2, the passthrough wire has no key failover** (B1). Any key-pool provider whose route
  resolves to `openai-responses` (DeepSeek's Responses preset, for example) gets neither 401 nor
  429 rotation.
- **R3, RR distribution is invisible to failure accounting.** `buildRoundRobinTransport`
  mutates only the live row. The persisted row and the selection stamp disagree with it, so:
  - (a) the dispatch gate always reads stale and re-reads the shared live row, which collapses
    concurrent requests onto the latest pick and can throw "selection changed repeatedly"
    (`request-transport.ts:395`) under churn;
  - (b) `rotateKeyAfterFailure` on a distributed key goes `superseded` and returns the persisted
    key **without cooling the failed key** (`key-failover.ts:496-500`). RR then keeps re-picking
    the bad key.
  - The comment at `key-failover.ts:176-178` ("stamp captured from the committed row… rotates
    relative to the key that actually failed") does not hold. The 92528930a tests never pass
    `attemptedSelection`, so they miss this.
- **R4, no strategy means a sticky key.** Without `apiKeyPoolStrategy` there is no pre-dispatch
  movement (:280). A key that fails with anything other than 401/429 is never moved off, and
  that covers 6 of the 8 multi-key providers here.
- **R5, combo cooldown ignores API-key spares.** `hasSpareAccount` consults only OAuth accounts
  (`core-combo.ts:667-671`). A key-scoped failure on a single-target combo blackholes it for
  60s–10min.

## Proposed fix (concrete)

1. **Key-scoped failure classifier** (new `src/providers/key-failure-class.ts`, pure):
   - `classifyKeyScopedFailure(status, bodyText, code)` returns
     `"rate" | "auth" | "balance" | "quota" | null`.
   - Map 429 to rate and 401 to auth.
   - Map 402 to balance.
   - Map a 403 whose code or message matches `insufficient_quota|free quota exhausted|
     AllocationQuota|Arrearage|account.*good standing|credit balance is too low|
     Model\.AccessDenied` to quota.
   - Map a 400 whose message matches the same billing phrases to balance.
   - Read a cloned, bounded body, like `isAccountScopedAccessDenied` already does.
2. **Generalise `rotateKeyAfterFailure`**:
   - Make `failureStatus` a failure class.
   - Cooldowns: balance/quota/auth get `MAX_COOLDOWN_MS`; rate gets Retry-After or 60s.
   - **Always cool the key that was actually sent**, identified by
     `entryId === _apiKeyAttempt.entryId` or `key === attemptedKey`. Do this before and
     independent of the persisted commit, including on the `superseded` branch (:496-500).
3. **Fix the RR stamp (R3).**
   - In `buildRoundRobinTransport`, stamp `_apiKeyAttempt` with the **picked** entry
     (`{entryId: picked.id, reference: picked.key, revision: provider.apiKeySelectionRevision}`).
   - Make `providerApiKeySelectionIsCurrent` accept a route whose entry is any **pool member**
     at the same revision, instead of comparing against the single shared live row. Then stop
     mutating `provider.apiKey` on the live row at all.
   - This removes the concurrency collapse and makes rotation-on-failure relative to the real key.
4. **One recovery loop for all wires.**
   - Add the key-pool rotation arm to `passthrough-dispatch.ts` `passthroughRecovery`.
   - Extend both loops (adapter-dispatch :573/:643, chat-native :391,
     adapter-continuation :305) to rotate on every key-scoped class from step 1, bounded by
     the pool size and `reserveCredentialHop`, pre-stream only.
5. **Cooled keys are skipped even without a strategy.**
   - Today `selectProactiveApiKey` returns null when the strategy is unset (:280).
   - Change that guard to "no strategy and committed key healthy". A committed key in cooldown
     should then move to the first healthy entry for every pool. That is what makes the
     "continue" request land elsewhere.
6. **Combo exemption (R5).** In `core-combo.ts:667-671`, OR in
   `hasKeyPoolFailover(provider) && healthyPoolKeys(provider) > 0`, using a new
   `key-failover.ts` export, so a key-scoped failure on a pool provider records scope `none`.
7. **Observability.**
   - Record the pool entry id (non-secret id, never the label or the key) on each attempt
     (`recordAttemptCredentialSource`).
   - Log a `[key-failover]` line on every cooldown, including the superseded and non-429 cases.
8. **Docs:** update `docs-site/.../providers.md:204` and `structure/transports/responses.md`
   §"Pre-dispatch API-key pool pick" (:114-143). Both still say "a healthy committed key is never
   overridden" and point at `core.ts`; the code is now in `request-transport.ts:548`.

## Affected tests/docs

- Tests:
  - `tests/adapters/key-failover.test.ts`: RR tests at ~467-510 and ~601-620 never pass
    `attemptedSelection`. Add a superseded-path cooldown test plus a concurrency test.
  - `tests/server/server-key-failover-e2e.test.ts`: has 429 rotation, warm-key pick, and the
    `/v1/responses` pick. Add 402, 403-quota, the passthrough wire, and RR+429 end to end.
  - Also: `tests/providers/rate-limit-retry.test.ts`,
    `tests/providers/upstream-transient-retry.test.ts`,
    `tests/server/server-combo-failover-e2e.test.ts` (key-pool spare exemption),
    `tests/combos/router-combo-failover-classification.test.ts`,
    `tests/responses/responses-send-budget-counts.test.ts` (hop budget).
- Structure ownership:
  - `structure/INDEX.md:118` maps `src/providers/` to `runtime.md`, `subagents.md`,
    `transports/inventory.md` and `providers/xai-grok.md`.
  - The API-key pool row is `structure/transports/inventory.md:33`. The pre-dispatch section is
    `structure/transports/responses.md:114-143`.
  - Both are stale relative to 92528930a, which is a `structure:check`/doc-sync obligation for
    any fix.
- User docs: `docs-site/src/content/docs/reference/configuration/providers.md:204`.

## Open questions

1. Are the 6 DeepSeek keys from **one** DeepSeek account? Balance is per account, so if they
   are, rotating on 402 cannot help. A free `GET /user/balance` per key, run by the user,
   would settle it.
2. Are the alibaba-cn keys separate Alibaba accounts? Free-tier quota and arrears are per
   account and model, so rotation only helps if the keys are distinct accounts.
3. Why did `routing-history.sqlite` stop at 2026-09-30 12:52 while `usage.jsonl` continues? A
   disabled writer, or the size cap (286 MB)?
4. Should the user-set combos with one target (`GLM-5.3_Alibaba`, etc.) be plain model routes?
   A single-target combo adds the R5 blackhole and no failover value.
5. Is the passthrough route for `deepseek-flash` intended (the wire override to
   `openai-responses`)? On the chat wire it would at least get 401/429 key rotation today.
