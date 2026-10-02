# 10 — Non-multimodal image poisoning (combo `GLM-5.3_Alibaba`)

Investigation A of unit 261002. Read-only; no repo source was changed. Every claim cites a log line
or `file:line` (line numbers as of `fca912f80`, branch `main`).

## Evidence

### Session and model

- Grok Build session `01a0fa0e-a3d6-7032-b582-b34623a8b040`
  (`~/.grok/sessions/%2Fhome%2Fvoid0x14%2FDocuments%2Freceive_sms_otomasyon/01a0fa0e-.../`).
- The model the harness selected was **`combo/GLM-5.3_Alibaba`** (updates.jsonl line 151:
  `"_meta":{"modelId":"combo/GLM-5.3_Alibaba","promptIndex":3}`). `~/.grok/config.toml:4059-4062`
  maps the picker entry `ocx-combo-GLM-5-3_Alibaba` to `model = "combo/GLM-5.3_Alibaba"`,
  `model_provider = "opencodex"`.
- Wire API: `~/.grok/config.toml:5-7` sets
  `[model_providers.opencodex] base_url = "http://127.0.0.1:10100/v1"`, `api_backend = "responses"`,
  so requests go to **`POST /v1/responses`**. `~/.opencodex/usage.jsonl` confirms it with
  `"inboundProtocol": "responses"` and `"surface": "grok"`.
- In `~/.opencodex/config.json`, the combo is:
  ```json
  "GLM-5.3_Alibaba": { "strategy": "round-robin", "stickyLimit": 1, "defaultEffort": "max",
    "targets": [{ "provider": "alibaba-cn", "model": "glm-5.3", "weight": 2 }],
    "imageInput": "disabled" }
  ```
  The only target is `alibaba-cn/glm-5.3`. Provider `alibaba-cn` (`adapter: openai-chat`) declares
  `modelInputModalities["glm-5.3"] = ["text"]`. It has no `noVisionModels` and no `modelCapabilities`.
- `"imageInput": "disabled"` was explicitly set. None of the older config backups has the key, and
  the first backup that has it is `config.json.bak-pre-clean-keys-1790902121` (2026-10-02 03:48:41
  +03), about 45 min before the failure. The GUI exposes it as the "Görsel / çok modlu" toggle
  (`gui/src/i18n/tr.ts:2428-2430`).

### Failure sequence (updates.jsonl, times are +03)

| line | time | event |
|---|---|---|
| 156 | 04:33:37 | the agent calls `read_file` on `screenshots/screenshot-1790904791251.png` |
| 159 | 04:33:37 | the tool result is an `image` (`mimeType: image/png`, base64) |
| 158/160 | 04:33:37 | `turn_completed stop_reason:"error"`, `agent_result: "API error (status 400 Bad Request): invalid_request_error: Combo \"GLM-5.3_Alibaba\" does not accept image input"` |
| 161-163 | 04:33:46 | user sends `"."`, gets the same 400, `elapsed_ms: 64` |
| 164-166 | 04:33:59 | user sends `"abıcım malmısın sen"`, gets the same 400, `elapsed_ms: 63` |
| 167 | 04:34:17 | user switches to `alibaba-cn/qwen3.8-omni-flash` (multimodal), and the session recovers |

In `chat_history.jsonl` line 99 the tool result stays in history with its pixels, even after the
text was elided:
`{"type":"tool_result","tool_call_id":"call_43f4d9817f85438584e5bc9e","content":"[Tool result omitted — too old]","images":[{"type":"image","url":"data:image/png;base64,<B64>"}]}`.
Every later turn therefore replays the image.

### Proxy-side records

`~/.grok/logs/unified.jsonl`, three times (01:33:37Z, 01:33:46Z, 01:33:59Z):
`"msg":"shell.turn.inference_failed","ctx":{"kind":"api","status_code":400,"is_retryable":false,"message":"API error (status 400 Bad Request): invalid_request_error: Combo \"GLM-5.3_Alibaba\" does not accept image input"}`.

`~/.opencodex/usage.jsonl` has three rows (identifying fields redacted):
```
{"requestId":"ocx-40081932addcf7b05e3bdb624bf21034","timestamp":1790904817645,"provider":"combo","model":"combo/GLM-5.3_Alibaba","surface":"grok","inboundProtocol":"responses","status":400,"durationMs":8,"errorCode":"invalid_request_error","closeReason":"non_stream","upstreamError":"Combo \"GLM-5.3_Alibaba\" does not accept image input"}
{"requestId":"ocx-cab09fb41f6df3bc2f0718a2365a11fe", ... "status":400,"durationMs":9, ...}
{"requestId":"ocx-a8bc3de278f7258d069c118802cee673", ... "status":400,"durationMs":9, ...}
```
`provider: "combo"`, `durationMs` 8–9 ms, and no `attempts` entry: **no upstream was contacted**.
The 400 is opencodex's own pre-flight rejection. It is not an Alibaba error passed through.

Other stores:
- `~/.opencodex/service.log`, `crash.log` (empty) and `invariant.log` have 0 matches.
- `~/.opencodex/routing-history.sqlite` has 70871 rows, the newest at **2026-09-30 12:52:33**. It
  has no rows for 2026-10-02, so this store has not been written since then. That is a separate
  observation; see Open questions.

## Code path (file:line)

1. `POST /v1/responses` → `handleResponses` (`src/server/responses/core.ts:37`) →
   `prepareResponsesRequest`. `src/server/responses/request-prepare.ts:215` dispatches to
   `requestDispatchers.handleComboResponses` (`core.ts:70-87`) → `executeComboResponses`
   (`src/server/responses/core-combo.ts:160`).
2. `core-combo.ts:194` expands `previous_response_id` (`expandPreviousResponseInput`), which puts
   earlier images back into `input`.
3. `core-combo.ts:215-221`: if `imageInput === "disabled"` and the previous response cannot be
   resolved, it returns 400 `previous_response_not_found`.
4. **`core-combo.ts:222-224`, the hard fail:**
   ```ts
   if (combo.imageInput === "disabled" && comboRequestHasImageInput(body)) {
     return formatErrorResponse(400, "invalid_request_error", `Combo "${comboId}" does not accept image input`);
   }
   ```
5. `comboRequestHasImageInput` (`src/combos/request.ts:35-54`) scans the **whole materialised
   `input`**: every message `content` and every `function_call_output.output`, including all
   history items. One `input_image` anywhere in the conversation makes every later request fail.
6. Child dispatch (`core-combo.ts:406-485`: `concreteComboRequestBody`, then
   `requestDispatchers.handleResponses(childRequest, …, { comboAttempt: true })`) would have run the
   normal per-target vision handling. Execution never gets there.

The direct (non-combo) path already degrades gracefully:
- `src/server/responses/request-sidecar-auth.ts:118-141`: `planVisionSidecar`, then either
  `describeImagesInPlace` or `stripImagesInPlace`.
- `src/vision/plan.ts:104-121` (`requiresVisionPreprocessing`): `modelInputModalities = ["text"]`
  makes it return true for `alibaba-cn/glm-5.3`. `src/vision/eligibility.ts:80-90` (`isModelVisionSidecarConsumer`) returns
  true for that declaration too.
- `src/vision/image-rewrite.ts:86-108` (`stripImagesInPlace`) replaces every image part in **all**
  carrying messages (user/developer/toolResult, so history is included). It uses the marker
  `IMAGE_OMITTED_TEXT` (`image-rewrite.ts:12`), and `syncRawBodyImageDescriptions`
  (`image-rewrite.ts:28-80`) mirrors the change into the raw Responses body, including
  `function_call_output.output`.
- The catalog (`src/codex/catalog/model-hints.ts:299-307`) even advertises `image` for this
  text-only model, because the sidecar is expected to cover it.

## Root cause

The combo-level `imageInput: "disabled"` policy is implemented as a **fail-closed request rejection
over the full conversation input** (`core-combo.ts:222-224` with `combos/request.ts:35-54`). It does
not sanitise the input. The design assumes the client honours the published catalog modalities and
never sends an image (`docs-site/src/content/docs/guides/combos.md:307-311`: "image-bearing
requests are rejected with HTTP 400 before any target is called"). That assumption fails here for
two reasons:

- Grok Build does not read opencodex modalities. `src/grok/*` emits no modality field, and Grok's
  per-model config has no image-capability key. Grok's `read_file` returns images as tool results
  regardless of the model.
- The image lives in history, so the rejection repeats on every later turn. The client cannot get
  past it except by switching model or rewinding.

The existing tests lock this behaviour in, including the history case:
`tests/server/server-combo-failover-e2e.test.ts:2979` asserts "disabled image input rejects an
image restored from previous_response_id before dispatch".

Contributing factors:
- The rejection overrides the per-target vision preprocessing that would otherwise apply. With
  `imageInput: "auto"`, the child `alibaba-cn/glm-5.3` request would reach
  `request-sidecar-auth.ts:122-141`, and its images would be described by the sidecar or stripped
  with a marker. The session would keep working.
- The error is reported as a plain non-retryable `invalid_request_error` 400 (Grok:
  `"is_retryable":false`). Nothing in the message tells the user that the cause is an image
  earlier in the history.
- There is no upstream strip-and-retry for image rejections. `src/combos/failover.ts:383-416`
  (`isRequestLocalTargetIncompatibility`) only classifies an upstream
  `Model '…' does not support image inputs.` 400 as a reason to hop to the next target. A
  one-target combo, or a direct route on a model with unknown modalities, has no next target, so
  that 400 also repeats every turn.

## Proposed fix

### Primary (fixes this incident): strip instead of reject when `imageInput: "disabled"`

1. Add a raw-Responses-body image replacer next to the detector, for example
   `stripComboRequestImages(body, comboId): number` in `src/combos/request.ts`. Export it from
   `src/combos/index.ts`.
   - Walk the same tree as `responsesInputNodeHasImage`: message `content`, and
     `function_call_output` / `custom_tool_call_output` `output`, recursively.
   - Replace **every** `{type:"input_image", …}` with
     `{type:"input_text", text:"[image omitted: combo <id> does not accept image input]"}`.
   - Unlike `syncRawBodyImageDescriptions`, it must also replace `input_image` parts that carry only
     `file_id` and no `image_url`.
   - Do not touch `tools`, `metadata`, or other items (same contract as
     `tests/codex-integration/combos.test.ts:246-290`).
   - Return the replacement count.

   The alternative is to factor the raw walker out of `syncRawBodyImageDescriptions`
   (`src/vision/image-rewrite.ts:28-80`) into a shared helper that takes a replacer callback, and
   use it from both places. That keeps one definition of "which Responses items carry images".
2. In `src/server/responses/core-combo.ts:222-224`, replace the 400 with:
   ```ts
   if (combo.imageInput === "disabled") {
     const omitted = stripComboRequestImages(body, comboId); // body is already the expanded copy or rawBody
     if (omitted > 0) { logCtx.imagesOmitted = omitted; console.warn(`[opencodex] combo ${comboId}: omitted ${omitted} image part(s) (imageInput disabled)`); }
   }
   ```
   It must run **before** `comboReplaySnapshot` (`core-combo.ts:225`) captures `sourceBody: body`,
   so every child and replay sees the stripped input.
   - When `body === rawBody` (no `previous_response_id`), mutating in place is fine because
     `rawBody` is request-owned. Cloning first is the safer choice if any caller retains it.
   - Keep the `unresolvedPrevious` 400 at `core-combo.ts:215-221`. It is recoverable: the client
     resends the full conversation, and that resend then gets stripped. It is still needed because
     opencodex cannot strip images it cannot see.
   - The operator intent ("targets never receive pixels") still holds. It is enforced by stripping
     rather than by rejecting.
3. Optional follow-up, a policy decision for the maintainer: let `"disabled"` fall through to the
   per-target vision sidecar (describe) instead of a plain placeholder. This is deliberately not the
   default, because it would send the pixels to a sidecar model on another provider, which may be
   what the operator meant to prevent. If wanted, add it as an explicit third value such as
   `imageInput: "describe"`, rather than changing what `"disabled"` means.

### Secondary (defence in depth, same symptom class)

4. Upstream image rejection should trigger one strip-and-retry. When a target answers with the exact
   envelope `isRequestLocalTargetIncompatibility` already recognises (`param:"input"`,
   `Model '…' does not support image inputs.`, `src/combos/failover.ts:414`), and there is no
   eligible next target (single-target combo, or the direct route), re-send once with
   `stripImagesInPlace`. Charge that send to the existing `sendBudget` final-recovery reserve. Also
   record the verdict for the session, so later turns strip pre-flight instead of paying a failed
   upstream call every time.
   - The direct-route equivalent lives in the Responses execution layer
     (`src/server/responses/request-sidecar-auth.ts` / execution). Read
     `structure/transports/responses.md` before touching it.

### User-side mitigation (no code change)

- Set the combo's image toggle back to `auto`, i.e. remove `"imageInput": "disabled"`. The child
  `alibaba-cn/glm-5.3` is declared `["text"]`, so the existing per-target sidecar path
  (`request-sidecar-auth.ts:122-141`) describes or strips the image, and the session keeps working.

## Affected tests and docs

Tests that encode the current reject behaviour and must change to assert strip-and-dispatch:
- `tests/server/server-combo-failover-e2e.test.ts:2322` ("disabled image input rejects the request
  before any combo target is called"). It should assert `hits === 1` and that the upstream body has
  the placeholder and no `input_image`.
- `tests/server/server-combo-failover-e2e.test.ts:2979` ("…rejects an image restored from
  previous_response_id…"). This becomes the core regression for this incident: a history image is
  stripped, the turn succeeds, and the next "continue" also succeeds.
- `tests/server/server-combo-failover-e2e.test.ts:2339` (tool schemas mentioning `input_image`
  stay untouched) and `:2371` / `:2389` (previous_response_id unresolved/expanded). These keep
  their semantics; re-verify them.

Tests to add or extend:
- A new unit test for the raw strip helper in `tests/codex-integration/combos.test.ts` (next to
  `:246`): message content, `function_call_output.output`, a `file_id`-only `input_image`, and
  tools/metadata left untouched.
- For the secondary fix: `tests/combos/` failover classification and `tests/vision/vision-fail-closed.test.ts`.

Related coverage that must stay green: `tests/vision/vision-sidecar-e2e.test.ts`,
`tests/vision/vision-cache.test.ts`, `tests/server/server-combo-failover-e2e.test.ts:3013` ("fresh
child reparsing recomputes vision…"), `tests/codex-integration/codex-catalog.test.ts`,
`tests/routing/combo-management-api.test.ts:407`, `tests/gui/combo-workspace-data.test.ts`, and
`tests/cli/cli-headless-parity.test.ts`.

Docs that own this:
- `structure/INDEX.md:105`: `src/combos/` → `structure/runtime.md`.
- `structure/INDEX.md:125`: `src/server/` → `runtime.md`, `transports/responses.md`,
  `data-planes/images.md`, and others.
- `structure/INDEX.md:134`: `src/vision/` → `runtime.md`, `gui-and-management-api.md`.
- `structure/runtime.md:403-413` (vision fail-closed) and `:424` (failover image envelope). Neither
  documents the combo `imageInput` gate yet; add it there.
- User docs to update, with locales: `docs-site/src/content/docs/guides/combos.md:307-311` and
  `:418`, and `docs-site/src/content/docs/reference/configuration/routing.md:95`. Both currently
  say "rejects image-bearing requests before dispatch". Also `fr`/`ja`/`ko` routing.md and
  `fr` combos.md.
- `gui/src/i18n/*` `cws.capability.imageInputHint`: the "text only" wording still holds, but
  consider mentioning that images get replaced with a note.

## Open questions

1. Is a placeholder strip acceptable as the meaning of `"disabled"`, or should a new
   `imageInput: "describe"` value exist (sidecar caption)? This is a product decision (see fix 3).
2. Should opencodex also publish modalities to Grok (for example a `notice` or per-model hint
   written by `src/grok/inject.ts`)? Grok 1.0.46's config has no image-capability key; only
   `models.image_description` exists, for user-pasted images. So client-side gating does not look
   possible, and the fix has to live in the proxy.
3. `~/.opencodex/routing-history.sqlite` has no rows after 2026-09-30 12:52:33, while
   `usage.jsonl` is still written (2026-10-02 05:29). Either the history writer stopped or it
   writes elsewhere now. This is unrelated to the image bug but blocks sqlite-based evidence for
   the B and C investigations.
4. Grok elides old tool-result text but keeps `images` forever (chat_history line 99). It is not
   verified whether Grok sends the image as `function_call_output.output[]` or as a separate user
   message. The proposed strip covers both shapes.

## Implementation (image)

Primary fix (strip instead of reject) is implemented; nothing is committed.

- `src/combos/request.ts`: new `comboImageOmittedText(comboId)` and
  `stripComboRequestImages(body, comboId): number`, exported from `src/combos/index.ts`. The
  stripper walks the same tree as `comboRequestHasImageInput` (every `input` item, recursing
  through `content` and `output`, nested arrays included) and replaces every `input_image` node,
  whatever it references (data URL, remote URL, `file_id` only, empty), with
  `{type:"input_text", text:"[image omitted: combo <id> does not accept image input]"}`. It is
  copy-on-write: only `body.input` is reassigned and nested nodes are never mutated, so replayed
  history shared with stored response state is safe. The body object keeps its identity, which the
  continuation provenance WeakMaps key on. `syncRawBodyImageDescriptions` was not reused, because it
  only matches string `image_url` parts in user/developer messages and tool outputs, which is
  narrower than the detector.
- `src/server/responses/core-combo.ts`: the `does not accept image input` 400 is gone. After
  `previous_response_id` expansion, a `"disabled"` combo strips the images and logs only the count.
  This runs before `comboReplaySnapshot` captures `sourceBody`, so every target attempt and failover
  hop gets the stripped body. When images were stripped, `providerContinuation` is dropped, so a
  target cannot recall them out of band through a provider-side continuation. The
  `previous_response_not_found` 400 for an unresolved continuation is unchanged. With `"auto"`,
  `imagesOmitted` is 0 and the path is byte-identical to before.
- Tests:
  - `tests/server/server-combo-failover-e2e.test.ts`: the two reject tests now assert strip and
    dispatch (current turn, history, tool output, `file_id`; `previous_response_id` history plus a
    second chained "continue"). A new test checks that a failover hop (503, then an image-capable
    backup) never re-sends the image.
  - `tests/codex-integration/combos.test.ts`: the detector/stripper invariant over 11 shapes,
    copy-on-write, and tools/metadata left untouched.
- Docs: `guides/combos.md` and `reference/configuration/routing.md` (en, fr, zh-cn; no other
  locale described the reject behaviour), and `structure/runtime.md` ("Capability-aware image
  admission").
- Other gates checked:
  - Chat Completions and Anthropic Messages ingress route combos through `handleResponses`, and
    their images become `input_image` (`src/chat/inbound.ts:88`, `src/claude/inbound.ts:36`), so
    they are covered.
  - The direct route already strips or describes for proven text-only models
    (`request-sidecar-auth.ts:122-141`).
  - `src/combos/failover.ts:414` hops to the next target on an upstream `does not support image
    inputs` 400 (no cooldown). A single-target combo still returns that 400. With `"disabled"` this
    can no longer be triggered by images.
- Residual risk:
  - The Qoder adapter (`src/adapters/qoder/adapter.ts:111-124`) still returns a 400 for any image in
    history. Seeded Qoder models are in `noVisionModels`, so the sidecar strips first, but a
    live-discovered model outside the seed list would poison the session the same way.
  - A direct route to a model with unknown modalities still forwards images. If the upstream answers
    400, that repeats every turn (secondary fix 4, not implemented).
  - Routing-profile `require.imageInput` is opt-in and was not changed.
- Pre-existing failures, identical on a clean `HEAD` worktree:
  - `combos.test.ts` "honors explicit Retry-After over the request-rate default"
  - `router-combo-failover-classification.test.ts` "a no-signal 429 cools briefly"
  - e2e "connect cancellation wins with 499" (30 s timeout)
  - `structure:check`: `providers/openai-tiers.md` is over budget and names a missing file.
- Gate results:
  - Passed: `bun run typecheck` and `bun run privacy:scan`.
  - Focused files:
    - `combos.test.ts`: 85 pass, 1 fail (the pre-existing failure above).
    - e2e: 164 pass, 1 fail (the pre-existing failure above); all 6 `disabled image input` tests
      pass.
  - `bun run test:changed` never completed:
    - This checkout has no `dev` ref.
    - `--changed=HEAD` hit the runner's 900 s lane timeout with the machine shared with another
      agent.
    - A partial related-domain run surfaced only failures that reproduce identically on clean
      `HEAD` (chat-refusal, chat-json-sse-fallback, chat-completions-endpoint,
      openai-responses-passthrough surrogate byte accounting).
