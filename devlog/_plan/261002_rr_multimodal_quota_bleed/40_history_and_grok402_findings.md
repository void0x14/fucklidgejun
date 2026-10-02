# 40 — routing-history.sqlite "stopped", and Grok Build's 402/403 billing prompt

Read-only investigation, 2026-10-02 (local time UTC+3 unless marked Z). No repo files were edited
except this note.

---

## Q1. Why routing-history.sqlite has no rows after 2026-09-30 12:52

**Verdict: environmental / by design, not a bug and not a failure.** `routing-history.sqlite` is a
*lazy, pull-based projection* of `usage.jsonl`. Nothing writes it per request. It only catches up
when a consumer opens it, and no consumer has opened it since 09-30 12:52.

### How it is written
- `src/routing/history/indexer.ts:1-10`: `usage.jsonl` is canonical, and the sqlite file is a
  "rebuildable SQLite projection". On every **open or query**, it "appends whatever complete JSONL
  rows arrived since the last index".
- The only write path is `refreshLockedSync()` (`indexer.ts:429-457`), which calls
  `ingestSourceTail()` (`:217-294`). It is reached only through these functions:
  - `openRequestHistoryIndex()`, `queryRequestHistory()`, `requestHistoryRowById()` and
    `requestHistoryIndexStatus()` (`:469-595`).
  - `openRequestHistoryIndexSync()` (`:460`).
- The callers (from grep) are:
  - `src/server/management/request-history-routes.ts:92,145,190`: `/api/request-history*`, used by `ocx observe logs explain`.
  - `src/server/management/routing-analytics-routes.ts:65` calls `src/routing/analytics.ts:179`.
    `/api/routing-analytics` is fetched only by the dashboard **Routing Profiles** page
    (`gui/src/pages/RoutingProfiles.tsx:351`).
  - `src/routing/health.ts:236` (`computeHistoricalHealthEvidence`) is reached only via
    `policyCandidateHealthEvidence` from `src/routing/compatibility/assemble.ts:75`, which means it
    runs only when **policy routing profiles** are in use.
  - `src/cli/observe.ts:146` (`ocx observe logs index-status`) and `:130` (`rebuild-index`).
- No config toggle exists. The config has no routing profiles: `jq` over `config.json` and the
  09-30 and 10-02 backups shows no `routing`, `routingProfiles` or `lab` key. So the router never
  touches the index, and only manual dashboard or CLI visits advance it.

### State of the DB (read-only `sqlite3 -readonly`)
| check | value |
|---|---|
| `PRAGMA journal_mode` | `wal` |
| `PRAGMA quick_check` | `ok` |
| rows / max ts | 70871 / 2026-09-30 12:52:33 (min 2026-07-29 20:08:50) |
| `schema_meta.built_at_ms` | 1790761969411 = 2026-09-30 12:52:49 |
| `last_error` | `""`: the last refresh was a clean tail ingest (`indexer.ts:454`) |
| source path / ino / birthtime | match the live `usage.jsonl` (ino 25875691, birth 2026-07-29 20:08:50.84) |
| `indexed_offset` | 108776199 of current 111796490 bytes. The byte at that offset−1 is `0x0a` (a clean line boundary), and **2193 rows are pending** |
| files | `.sqlite` 286 MB (mtime Oct 1 04:36, the WAL checkpoint at the old proxy's shutdown), `-wal` 0 B, `-shm` 32 KB |
| open handles | none. `/proc/265814/fd` (the current proxy, started 10-02 03:57) has no `routing-history` fd, and `lsof` and `fuser` show nothing |

The module keeps its `db` handle open for the life of the process once it is opened (`indexer.ts:85,353-382`).
So the missing fd proves that the current proxy has **never** opened the index. That means no
locked DB, no failed migration, and no corrupt WAL.
`crash.log` is empty. `service.log` and `invariant.log` contain no sqlite or history errors. The
invariant log belongs to the user's own guard script and is unrelated. Since 09-27 the only `src/`
commits are `fca912f80` (systemd), `cda78d614` and `c2d9fe69f`, and none of them touch `src/routing/history/`.

### Errors that are swallowed (for completeness; none fired here)
- `openIndexDb` catch → `destroyAndRecreate` (`:371-378`). `ensureSchemaAndIdentity` catch → rebuild (`:401-406`).
- `isHealthy` returns false on throw (`:316-323`). `parsedEntryFromLine` skips bad lines silently (`:211`).
- Records larger than 1 MiB are silently omitted (`:83,256-277`).
- `computeHistoricalHealthEvidence` swallows everything and returns `{}` (`health.ts`, the
  "index unreadable" comment above `:335`).
- **None of these leave a trace outside `schema_meta.last_error`.** That field is `""`, so none
  of them ran.

### Fix
No code fix is needed. To bring the index current, open Dashboard → Routing Profiles, or run
`ocx observe logs index-status`. Either one ingests the 2193 pending rows.
Optional hardening if "stale" is confusing:
- (a) Expose `indexedOffset` against the source size in `index-status` and the dashboard.
- (b) Note that each refresh runs `PRAGMA quick_check` on a 286 MB file (`indexer.ts:391`). On
  the synchronous routing path (`health.ts:236`) that is a latency hazard once routing profiles
  are enabled. Consider checking only on open, not on every refresh.

---

## Q2. Grok Build 1.0.46: what triggers the billing upsell, and what is shown plainly

Binary: `~/.grok/bin/grok`, which links to `~/.grok/downloads/grok-1.0.46-linux-x86_64`
(`version.json`: 1.0.46). `.rodata` vaddr == file offset.

### Exact trigger (disassembled, `objdump -d`, function at 0x52c68xx, `xai-grok-pager/src/app/dispatch/status.rs`)
The string literals are `run out of credits` @0x7a607a, `status 402` @0x7a608c and `status 403`
@0x7a6096. The code ASCII-lowercases the error message, then:

```
credits = msg.contains("run out of credits")
if let Some(code) = status_code {
    if code == 402                  -> BILLING
    if code == 403 && credits       -> BILLING
}
if msg.contains("status 402")       -> BILLING
return credits && msg.contains("status 403")
```
(`cmp $0x192` = 402 and `cmp $0x193` = 403 at 0x52c6916/0x52c691d.)

So the upsell fires on any of these:
- HTTP **402**, whatever the body says.
- **Any** message containing `status 402`. Grok's own message prefix is
  `API error (status N …)`, so a message that merely quotes "status 402" will trip it.
- **403 together with "run out of credits"**.

A BILLING verdict starts the subscription re-check (`subscription.check.*`), which picks one of
these strings: "You hit your free usage limit.", "You hit your weekly limit.", "You've hit the
credit limit for your plan.", "You've hit your spending cap.". With no xAI identity
(`unified.jsonl` l.15551 `tier re-check identity changed … started_user_id:""`), it lands on
"You hit your weekly limit." (xref 0x7a61f5 at 0x52c93f4).

The logs confirm it. The 402s (l.15547/15561/15579/15738/15764) are each followed by a tier
re-check. The 403 `insufficient_quota` "Free quota exhausted" (l.13839, l.13883) was **not**
followed by one, because the message has no "run out of credits".

Not involved in the upsell, but present: `insufficient_quota` and `usage_limit` (the latter only
as the xAI enum `usage_limit_reached`/`usage_pool_exhausted`) are not upsell triggers. A
separate list in `shell/src/session/compaction.rs` (`spending limit | out of credits | usage
balance exhausted | usage limit reached | status 401 | unauthorized`) only suppresses
auto-compaction after a compaction failure.

### Plain display (pager table near 0x79c6f4)
`Status (` titles map to user strings:
- 400 "The server rejected this request." / "Bad request"
- 403 "You don't have permission to do this." / "Request denied"
- 404 "This model isn't available. Run /model to pick another."
- 409 Conflict, 413 "Try a smaller prompt or run /compact."
- 429 "You've hit the rate limit for your plan." / "Rate limited"
- 500 "Something went wrong on our side…", 503 "The service is busy. Wait a minute…"

The detail line keeps the provider text, formatted as `API error (status N Reason): <error.code
or unknown_error>: <error.message>`. See session `updates.jsonl` l.15/158/506/524/1113. A null
`code` is rendered as `unknown_error`, which is what happened with the DeepSeek 402.

### Auto-retry (`shell.turn.inference_retry`, `max_retries: 15`, exponential backoff of about 2/4/8 s)
Aggregated over `~/.grok/logs/unified.jsonl`:
- `inference_failed`: 400×14, 402×5 and 403×6 are all `is_retryable:false`. 429×1 and 503×13 are
  `is_retryable:true`.
- `inference_retry`: 503 (200 retries), 502, 500, 429 (`kind:"rate_limited"`) and connection
  errors. The 502 retry is session l.532 (`attempt 1/15`).
- **400, 402 and 403 never retry. 429 and 5xx retry up to 15 times.**

### opencodex side
- **Grok identification:** the `x-opencodex-grok: 1` header sets `logCtx.surface = "grok"`
  (`src/server/index/serve-options.ts:1346`, `src/server/chat-completions.ts:146`). The header
  is injected by `src/grok/inject.ts:327,1013`.
- **Existing per-client shaping is stream-only:**
  - `heartbeatStyle: "comment"` (`adapter-delivery.ts:106`, `run-turn-execution.ts:348`).
  - `grokClientCompatibilityEnabled` snapshot rewrites (`passthrough-delivery.ts:407`).
  - There is **no** error-status shaping per client.
- **402 is relayed unchanged on every path:**
  - Passthrough: `passthrough-delivery.ts:278-301` and `formatPassthroughUpstreamError` (`passthrough-error.ts:42-90`).
  - Adapter: `adapter-dispatch.ts:990` (`formatErrorResponse(upstreamResponse.status, "upstream_error", "Provider error 402: …")`).
  - Combo: `core-combo-failure.ts:101` (`formatErrorResponse(response.status, …)`).
  - `classifyError` (`src/lib/errors.ts:247-254`) has no "insufficient balance" branch, so `code` stays null.
- **Key pools do not rotate on 402.** `rotateProviderTransportOn429/401` are the only rotators
  (`src/providers/key-failover.ts:528-600`). So with one DeepSeek key, the 402 arrives on the
  first try.
- **Do not reuse** `httpStatusFromTerminalError` for the client status: it maps
  `insufficient_quota` to **429** (`errors.ts:484`), which Grok would retry 15 times.

### Recommended mapping (Grok surface only, non-xAI provider, client-facing only)
1. **Where:** one outermost choke point, after the request log has captured the real status. That is
   `serve-options.ts:1372-1375`, wrapped around `responseWithDeferredRequestLog(...)`.
   - That wrapper logs `response.status` and reads the body (`src/server/relay.ts:719-728`).
   - So remapping *after* it keeps `usage.jsonl` at 402. It also keeps the pool, combo cooldown and
     health accounting at 402 (`core-codex-account.ts:224`, `core-combo-failure.ts:118`, `combos/failover.ts:464,568`).
   - It covers passthrough, adapter and combo-exhaustion in one place. Mirror it in `chat-completions.ts` for chat clients.
2. **When:** `logCtx.surface === "grok"`, `response.status === 402`, a non-SSE body, and
   `logCtx.provider !== "xai"`. A genuine xAI 402 keeps its native upsell.
3. **What:** **HTTP 400**, `Content-Type: application/json`, **no `Retry-After`**:
   `{"error":{"type":"insufficient_quota","code":"insufficient_quota","message":"DeepSeek: Insufficient Balance (provider returned HTTP 402 Payment Required; top up the DeepSeek account or switch model) (request_id: …)"}}`.
   Grok renders this as "Bad request — API error (status 400 Bad Request): insufficient_quota: DeepSeek: Insufficient Balance …".
   - 400 is never retried, has no upsell, and has no reauth.
   - **The message must not contain the substring `status 402`**, because Grok matches it
     case-insensitively. Write `HTTP 402` instead.
   - It must not contain `run out of credits`, even at 400. That phrase is harmless alone, but it
     is unsafe if a 403 is ever reused.
4. **Why not the others:**
   - 403 works, as the logs show, but it is titled "You don't have permission to do this" and
     upsells if any provider text contains "run out of credits".
   - **429 and 5xx cause a 15× retry loop.**
   - 402 is the bug itself.
5. Optional hardening:
   - Apply the same remap to a **403** on the grok surface whose provider text contains
     "run out of credits" (OpenRouter-style wording).
   - Add a `classifyError` branch for `insufficient balance` and `status 402`, returning
     `insufficient_quota`, so the code is typed on every surface. This touches all clients, so
     keep it separate.
   - Tests:
     - A grok surface with a non-xAI 402 gets 400 and the message, and the log status stays 402.
     - An xAI 402 is unchanged.
     - The codex surface is unchanged.
     - Combo exhaustion is covered.
   - Structure docs: `structure/transports/responses.md` and `structure/providers/xai-grok.md`.
