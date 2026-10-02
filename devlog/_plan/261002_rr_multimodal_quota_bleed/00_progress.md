# 261002 — round-robin, non-multimodal image poisoning, foreign "Grok weekly limit"

Running progress log. Updated at every step.

## Reported symptoms (user, Grok Build harness via opencodex)
1. Non-multimodal model (glm 5.3) received an image → opencodex returned "does not support ..." → session
   never recovers; every "continue" fails again.
2. Round-robin key strategy configured but keys are not rotated in real use; a single error of any kind
   locks the stream and "continue" keeps failing. Prior fixes exist in git log
   (92528930a, 3acc81fca, f324acd7e) — regression or never-fixed root cause.
3. While chatting with DeepSeek (via opencodex model), Grok Build suddenly says "Grok weekly limit
   exhausted" and blocks usage — never happened before.

## Log
- [step 1] Created this unit. Launching three parallel read-only investigations (A: image, B: round-robin, C: grok limit).
- [step 2] Three read-only investigation subagents running; reports land in 10_image_findings.md,
  20_round_robin_findings.md, 30_grok_limit_findings.md.
- [step 3] C (grok limit) done → 30_grok_limit_findings.md. Verdict: Grok Build binary itself renders
  "weekly limit" on ANY upstream 402/403 text when not signed into xAI. Trigger was a genuine DeepSeek
  402 "Insufficient Balance" (request_ids match), passed through verbatim by opencodex
  (passthrough-delivery.ts:278-301). No misroute to xAI. Cross-link with B: a 402 on one key of a
  multi-key provider must rotate to the next key instead of reaching the client.
- [step 4] A (image) done → 10_image_findings.md. Root cause: combo `GLM-5.3_Alibaba` has
  imageInput:"disabled"; core-combo.ts:222-224 pre-flight 400s if ANY image exists anywhere in input
  (history included, comboRequestHasImageInput scans everything). Grok Build keeps the image in history
  forever → every later turn 400s → permanent session poison. Direct (non-combo) route already degrades
  via vision sidecar/stripImagesInPlace; combo gate returns before reaching it.
  Side note: routing-history.sqlite has no rows after 2026-09-30 12:52 while usage.jsonl continues.
- [step 5] Image fix implementation subagent launched (strip-to-placeholder instead of 400; TDD; docs+structure).
- [step 6] B (round-robin) done → 20_round_robin_findings.md. Root causes R1 status-narrow failover
  (only 401/429), R2 passthrough wire has no key failover (deepseek-flash path), R3 RR pick mutates live
  row → stamp mismatch → failed key never cooled + concurrent collapse, R4 no-strategy pools never move
  off a dead key, R5 combos ignore API-key spares. Prior fix 92528930a only covered healthy-path rotation.
- [step 7] Key-pool fix implementation subagent launched in an isolated git worktree (TDD, full suite).
- [step 8] Side investigation launched → 40_history_and_grok402_findings.md (routing-history.sqlite
  stalled since 09-30; exact Grok Build 402/403 prompt trigger + safe response mapping).
- [step 9] Side investigation done → 40_history_and_grok402_findings.md. routing-history.sqlite stall is
  NOT a bug (lazy indexer; only catches up when a reader runs — nothing read it since 09-30). Grok Build
  1.0.46 upsell trigger: status==402 || msg has "status 402" || (403 && "run out of credits"); 429/5xx are
  retried 15x, 400/402/403 never retried.
- [step 10] Grok-402 honest-error mapping subagent launched in its own worktree (grok surface + non-xAI
  provider 402 → 400 insufficient_quota with real provider message).
- [step 11] Image fix edits present in main tree (combos/request.ts, core-combo.ts, tests, docs fr/zh-cn/en, structure/runtime.md); its test:changed run in progress. Key-pool + grok402 worktrees in TDD red phase.
- [step 12] All three implementation subagents were cut off by an account rate limit (~10:50 reset). State preserved (image edits in main tree; key-pool + grok402 in worktrees, uncommitted). All three resumed with their context.
- [step 13] Grok-402 fix DONE in worktree branch worktree-agent-a6bc2cb336fd481a7 (fix commit 0d6767101).
  New src/server/grok-foreign-billing.ts, applied in serve-options.ts (/v1/responses + /v1/chat/completions).
  18/18 new tests pass; typecheck + privacy clean. Agent reports 9 failing tests and 2 structure:check
  failures ALREADY on base fca912f80 (pre-existing) → must be triaged separately (baseline health).
- [step 14] Image fix DONE (main tree, uncommitted): stripComboRequestImages in src/combos/request.ts,
  applied in core-combo.ts before replay snapshot. typecheck+privacy green; combos 85/1, e2e 164/1 — both
  single failures reproduce on clean HEAD. Residual: (a) direct route to a model with unknown image
  capability forwards images → upstream 400 repeats every turn; (b) Qoder adapter rejects history
  images. To handle after key-pool merge (shares adapter-dispatch). Baseline failures to triage when
  machine is idle (likely load/timing: Retry-After cooldown, 30s connect-cancel, byte accounting).
- [step 15] Key-pool fix DONE in worktree branch worktree-agent-aaa6566f83f9a68d7
  (commits 10f58a879 + 33b22b03d; 24 files, +1247). R1 classifier, R2 passthrough+billing arms on all
  wires, R3 RR stamping w/o live-row mutation (+ latent ${VAR}/keychain unresolved-key fix), R4
  no-strategy behaves fill-first off cooled keys, R5 combos accept API-key spares. Full suite
  25448/47/15; 13 of 15 failures pre-exist on fca912f80, 2 machine-specific. Next: merge all three
  (image in main tree uncommitted; key-pool + grok402 worktree branches), resolve overlap in
  core-combo.ts, run independent review, commit.
