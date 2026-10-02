# 21 — Round-robin key pool: implementation

## Implementation (key pool)

- Worktree: `/home/void0x14/Projects/fucklidgejun/.claude/worktrees/agent-aaa6566f83f9a68d7`.
- Branch: `worktree-agent-aaa6566f83f9a68d7`, based on `fca912f80`.
- Commits:
  - `10f58a879`: the fix, tests and docs.
  - `33b22b03d`: two source-oracle and ratchet tests aligned with the change.
- Plan steps 1–7 from `20_round_robin_findings.md` are implemented, and the step 8 docs are
  updated. Every root cause has a regression test that fails on the old code.

### What changed, per root cause

**R1: failover only covered 401 and 429**

- New pure module `src/providers/key-failure-class.ts`.
- `classifyKeyScopedFailure(status, body, code)` returns `rate | auth | balance | quota | null`:
  - 429 is `rate`. It is `quota` instead when the body names `insufficient_quota` or exceeded
    billing quota.
  - 401 is `auth`, and 402 is `balance`.
  - 403 becomes `quota` and 400 becomes `balance` only when the error fields match an explicit
    phrase:
    - `insufficient_quota`
    - "exceeded your current quota"
    - "insufficient (account) balance"
    - "Free (tier) quota exhausted"
    - `AllocationQuota`
    - `Arrearage`
    - "account … in good standing"
    - "credit balance is too low"
    - `Model.AccessDenied`
  - A structured body is matched only on `code`, `type`, `status` and `message` (top level and
    under `error`), so text the request echoes back cannot fake a verdict.
  - These return `null`: content policy (`DataInspectionFailed`), schema, context-length and
    image 400s, generic 403s, and every 5xx.
- `classifyKeyScopedResponse(response, signal)`:
  - Decides 401/402/429 from the status alone and never touches the body.
  - Reads 400/403 from `response.clone()`, capped at 16 KiB and 2 s.
  - Fails closed (returns `null`) on an oversized, undecodable, timed-out or aborted body.
  - Leaves the original body intact.
- `keyScopedRecoveryKind(class)` returns `key-401`, `key-429` or `key-quota`. The new
  `key-quota` kind was added to `AttemptRecoveryKind` and `ATTEMPT_RECOVERY_KINDS`
  (`src/usage/log.ts`) and to `COOLDOWN_RECOVERY_KINDS` (`src/routing/analytics.ts`).
- `src/providers/key-failover.ts` `rotateKeyAfterFailure` now takes a failure class:
  - `cooldownMsFor`: a rate verdict uses Retry-After, or 60 s without one. Auth, balance and
    quota use the 10-minute cap.
  - `coolKey` never shortens a longer hold already in place. It logs
    `[key-failover] <provider>: <class> verdict on key <entryId>; cooling for Ns`.
- New exports:
  - `rotateProviderTransportOnKeyFailure(config, name, routed, failure, opts)`.
  - `hasHealthyApiKeySpare(config, name, now)`.

**R2: no key failover on the passthrough wire, or for any class beyond 401/429**

- `src/server/responses/passthrough-dispatch.ts` gets a new key-pool arm:
  - It sits after the generic-OAuth 429 arm and after the opt-in same-key `retryOn429` replay.
  - It runs on any non-OK pre-stream response that is classified as key-scoped, when
    `hasKeyPoolFailover` holds.
  - It reserves a credential hop (`auth-recovery`, target `provider|model|key-pool`, counted
    externally) and hands it over through `pendingHopPermit`. This is the same pattern as the
    OAuth 429 arm.
  - If the hop is refused, it still records the cooldown and the persisted move, then returns
    the real response.
  - It is capped at one rotation per pool member. `keyPoolHops` is declared outside
    `passthroughRecovery`.
- `src/server/responses/adapter-dispatch.ts`:
  - The 401 and 429 key loops now share the per-request `keyPoolHops` cap.
  - New billing/quota arm for a 402/400/403 classified as `balance` or `quota`. It follows the
    OAuth-403 arm's pattern (`reserveCredentialHop` plus a permit used in `onDispatch`), then
    does `continue recovery`.
- `src/server/chat-native.ts`: the old 429-only loop now loops over every key-scoped class,
  capped at the pool size. The `transientSendAvailable()` check is kept.
- `src/server/responses/adapter-continuation.ts`: the terminal-guard continuation now rotates on
  every key-scoped class, with a per-continuation cap.
- Not changed: the image and web-search sidecars still rotate on 429 only (B4). They do inherit
  the corrected rotation core, which cools the key that was actually sent.

**R3: RR stamp mismatch and concurrent collapse**

- `buildRoundRobinTransport` was replaced by `buildRoundRobinRow`:
  - It returns a request-local copy of the committed row carrying the picked key. The
    `_apiKeyAttempt` stamp is
    `{ entryId: picked.id, reference: picked.key, revision: apiKeySelectionRevision }`.
  - **It no longer writes `provider.apiKey` on the live row.**
  - The row goes through `applyRotatedTransport` → `routedProviderConfig`, so a `${VAR}` or
    `keychain:` pool reference is now resolved. Before, the raw reference was sent (a latent bug).
  - When the RR turn lands on the committed key, that row is returned too, stamped like the
    committed row.
- `src/providers/api-key-selection.ts` gets a new `providerApiKeySelectionMatches(provider, stamp)`:
  - The revision must be the same.
  - It accepts the committed entry, or, **only for `apiKeyPoolStrategy: "round-robin"`**, any
    other pool member whose id and key still match.
  - It is used by the dispatch gate `providerApiKeySelectionIsCurrent`, which resolves the
    stamped reference so a changed env or keychain value is still detected.
  - It is also used by `commitProviderApiKeySelection`'s expected-selection check. That removes
    the false `superseded` result.
- `resolveCurrentProviderApiKeyTransport` keeps a still-valid RR pick when it rebuilds a stale
  transport.
- A manual selection bumps the revision, so it still wins over an in-flight pick. Removing or
  re-keying the picked entry invalidates the pick.
- `rotateKeyAfterFailure` retry and commit semantics:
  - It retries on the committed key when that key is healthy and is not the one that failed. No
    persisted move happens in that case.
  - Otherwise it moves the committed key to the next healthy entry after the failed one and
    persists the move.
  - It cools the failed key on both the committed and the superseded branch. On superseded it
    skips the cooldown only when the operator's newer selection points at that same key again,
    which keeps the ABA guarantee.

**R4: a pool with no strategy stayed on a cooling key**

- `selectProactiveApiKey` no longer returns early when no strategy is set. An omitted strategy
  now behaves like `fill-first`:
  - A healthy committed key is never touched.
  - A cooling committed key is replaced by the first healthy entry, and the move is persisted.
- With every key cooling it returns `null`, so the request still dispatches on the committed
  key. Nothing synthetic is returned and nothing loops.

**R5: combos ignored API-key spares**

- `src/server/responses/core-combo.ts`, `hasSpareAccount` (about 6 lines plus 2 imports, kept
  local):
  - Adds `|| (classifyKeyScopedFailure(status, text, code) !== null && hasHealthyApiKeySpare(config, provider, now))`.
  - A key-scoped failure on a pool that still has a healthy key now records cooldown scope
    `none`.

**Observability (step 7)**

- `[key-failover]` lines now cover every cooldown, every rotation, a "retrying on committed key",
  and the all-cooled case. Lines carry only the pool entry id: never the key, never its label.
- `recordAttemptCredentialSource` (`src/server/request-log.ts`) stamps `attempt.apiKeyEntryId`:
  - Source: the route's own `_apiKeyAttempt.entryId`, for key-auth pools of at least 2 keys.
  - Validated by `isApiKeyEntryId` (`^[A-Za-z0-9._-]{1,40}$`).
  - Persisted through `normalizeUsageAttempt` (`src/usage/log.ts`).

### Report claims: verified or corrected

**Verified in code**

- R1, R2 (B1), R3 a/b, R4 and R5 all hold.
- Specifically: the `superseded` early return skipped the cooldown, the loops covered 401/429
  only, and `eligibleFailoverAccounts` is OAuth-only.
- Red run: on the old code (with stubs for the new exports only), every new root-cause test
  failed (29 failures).
- Red control for R5: with the exemption clause disabled, the second request returns 503
  "No available targets".

**Corrected**

- `chat-native.ts:391` was a 429-only loop. Native Chat never had 401 key rotation, which the
  report implies it did. It now rotates on every class.
- The `nextRoundRobinKey` comment claimed `rotateKeyAfterFailure` writes the RR cursor. It never
  did. The comment is fixed: failure recovery relies on cooldowns, not on the cursor.

**Extra findings**

- The old RR path returned `{ ...committedRoute, apiKey: picked.key }`, which sent a `${VAR}` or
  `keychain:` entry unresolved. Fixed.
- Combo targets get a derived send budget. A single-target combo allowed 5 physical sends
  (1 initial + 4 key hops), while a plain request gets 4.
- The structure doc pointed at `core.ts` for the pre-dispatch pick. The code lives in
  `request-transport.ts`. Fixed.

**Caveat**

- 403 `Model.AccessDenied` is classified as asked, but it is model- or workspace-scoped. Rotating
  only helps when the keys belong to different accounts.

### Tests

- New test files are registered in `scripts/test-layout/layout.json` (`explicit`) and in
  `tests/fixtures/test-layout-expected.json`.
- `tests/providers/key-failure-class.test.ts` (new):
  - The positive phrases.
  - The negatives: content policy, schema, context length, image, 5xx.
  - Resistance to echoed request text.
  - Clone-and-preserve of the original body, and fail-closed on an oversized body.
- `tests/adapters/key-failover.test.ts`, new describe "key pool root causes (261002)", 10 tests:
  - R3: the stamp names the picked entry, the gate passes, and the live row is not mutated.
  - R3: a failure on a distributed key cools that key (this used to go `superseded` with no
    cooldown), and the cursor never re-picks it.
  - R3: concurrent picks do not collapse onto one key.
  - R3: a manual selection still wins.
  - R3: a removed entry invalidates the pick.
  - R1: a balance/quota verdict sets a 10-minute cooldown and a persisted move.
  - R4: a pool with no strategy moves off a cooling key.
  - R4: a pool with no strategy keeps a healthy key.
  - All keys cooling: the pick returns `null`.
  - R5: `hasHealthyApiKeySpare`.
- `tests/server/server-key-pool-failover-e2e.test.ts` (new), 9 end-to-end tests:
  - Passthrough 402: the request moves to the second key, the first key is cooled, and the next
    request goes straight to the second key.
  - Passthrough 401 and 429 rotate.
  - RR adapter with a 403 "Free quota exhausted": the key rotates and the cooled key is never
    re-picked.
  - Content-policy 403: exactly one send and no cooldown.
  - Native Chat 400 "credit balance is too low": the key rotates.
  - No strategy: the next request avoids the cooled key.
  - All keys cooling: exactly one dispatch on each of 3 wires, and the real 402 is returned.
  - Single-target combo over a 2-key provider survives.
  - Combo key failure outlives the request budget: the target is not cooled, and the second
    request returns 200 (the old code answered 503).
- Changed expectations. Each pinned the old behaviour, and the reason is now commented in the
  test:
  - `server-key-failover-e2e` "without a configured strategy …" and `server-images` "keyed image
    send …": a pool with no strategy now moves off a cooling key (R4).
  - `generic-oauth-failover` rotator count: the `hasKeyPoolFailover` sites go from 3 to 5.
  - `transient-budget-scope-source`: the `reserveCredentialHop` sites go from 6 to 9. This
    count was already wrong on HEAD (7 sites, because the OAuth-403 arm from c691915ff was never
    counted).
  - `key-failover` ABA test: it now clears cooldowns after the manual re-selection, as the
    management route does.

### Results

**Focused and gate checks**

- Focused key-pool files: 97/97 pass.
- Touched-plus-guard set (ratchet, layout, `core-lab-boundary`, oracles, key-pool files):
  249/249 pass.
- `bun run typecheck`: clean.
- `bun run privacy:scan`: passed.

**`bun run structure:check`**

- Two failures, both already present on HEAD and outside this change:
  - `providers/openai-tiers.md` is 616 lines, over the 600-line budget.
  - The same doc names `src/codex/observed-model-denials.ts`, which is missing.
- The edited docs (`responses.md`, `inventory.md`) pass.

**`bun run test:changed`**

- It cannot resolve `dev` in this clone, so `bun scripts/test.ts --changed=fca912f80` was used
  instead. It ran twice; both attempts hit the runner's 900 s wall while concurrent agents held the user test lock, so it produced no verdict. The equivalent coverage is covered by the full suite, which is green for every file this change touches.

**Full suite (`bun run test`, final run)**

- Parallel suite: **25269 pass / 23 skip / 15 fail** (25307 tests, 1299 files).
- Serial lanes: 179 pass / 24 skip / 0 fail.
- Total: **25448 pass / 47 skip / 15 fail**.
- The first full run also failed 2 tests caused by this change. Both are fixed in `33b22b03d`:
  - The file-size ratchet: `server-images.test.ts` grew by 1 line.
  - The hop-count oracle.
- None of the 15 remaining failures comes from this change. 13 fail the same way on a pristine
  `git archive` of `fca912f80`, and 2 depend on the machine. None of them is one of the 5
  failures `AGENTS.md` lists as container-only; this machine has systemd, so those pass.

| Test | Why it fails |
| --- | --- |
| google `-tiered` wire renames (3 tests) | Pre-existing, from local commit c2d9fe69f. The two unit tests fail on HEAD. The request-path variant is the same defect showing up under parallel order. |
| google tool-result adjacency (2 tests) | Fails on HEAD. |
| `router-combo-failover-classification` "no-signal 429 cools briefly" | Fails on HEAD; local commit 3acc81fca raised combo cooldowns to 60 s. |
| `combos.test.ts` "explicit Retry-After" | Same cause: 3acc81fca's 60 s cooldowns. |
| `structure-ssot` | Fails on HEAD (`openai-tiers.md`). |
| kiro native effort | Fails on HEAD. |
| provider registry parity | Fails on HEAD. |
| usage-cost overlay membership | Fails on HEAD. |
| model-metadata-sync | Fails on HEAD. |
| release-version-line | Machine-dependent: `package.json` 2.56.0 is behind tag v2.64.0 in this clone. |
| remote-workspace bubblewrap (2 tests) | Machine-dependent: the host `bwrap` fails the `nlink === 1` check. |

### Docs

- `docs-site/src/content/docs/reference/configuration/providers.md`: the `apiKeyPoolStrategy`
  row is rewritten. It now covers:
  - RR distribution.
  - No strategy behaving like fill-first.
  - What happens when every key is cooling.
  - The in-request failover classes, on every wire.
- `docs-site/src/content/docs/guides/providers.md`: one sentence on which refusals the key-pool
  failover answers.
- Locales: none of them documents `apiKeyPoolStrategy` or the failover classes, so there is no
  contradiction. They are unchanged.
- `structure/transports/responses.md`:
  - "Pre-dispatch API-key pool pick" is rewritten, and its code location is corrected from
    `core.ts` to `request-transport.ts`.
  - New section "API-key pool failover".
- `structure/transports/inventory.md`: the API-key pools row now covers `key-failure-class.ts`
  and links the new section.

### Residual risks

- **Shared-account pools.** Open questions 1–2 still stand: rotating on a balance verdict only
  helps when the keys belong to separate accounts. If they share one account, each request walks
  up to the budget (4–5 sends), every key then cools for 10 minutes, and later requests return
  the real 402 after one send.
- **More sends per request.** On an all-dead pool a request now makes up to 4–5 upstream sends
  instead of 1. Passthrough and the adapter billing arm are bounded by the request budget. The
  adapter 401/429 loops are bounded only by pool size, as before.
- **Process-local state.** Cooldowns and the RR cursor are still process-local. Multi-process
  deployments do not share them.
- **Looser RR gate.** For `round-robin` providers the gate now accepts any pool member at the
  same revision. A provider PUT that changes `apiKey` without bumping the revision, while keeping
  the old key in the pool, no longer forces in-flight RR requests onto the new committed key.
  Non-RR providers keep the exact old check.
- **Unlisted billing phrases.** A 400 or 403 billing verdict worded outside the phrase list is
  still not rotated. This is deliberate: a missed rotation is preferred over burning healthy
  keys.
- **New disk writes.** A pool with no strategy now persists a committed-key move when the
  committed key is cooling, and the UI shows that move. Before, it never moved proactively.
- **GUI gaps.** Usage attempts carry `apiKeyEntryId`, a non-secret 8-hex id derived from the key.
  `gui/src/pages/Logs.tsx` does not render `key-quota` (it shows the "unknown" label) or the id.
  The GUI was left untouched.
- **Merge.** The `core-combo.ts` edit is localized at `hasSpareAccount` plus imports, so it
  should merge cleanly with the concurrent image change near line 222.
- **Other agents' edits.** The `tests/server/server-combo-failover-e2e.test.ts` and
  `src/combos/request.ts` edits in the main tree are not touched here.
