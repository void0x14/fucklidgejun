# ADR-0097 — decision recorded under "Google tool-call wire-name restore"

- Contract owner: [providers/google.md](../providers/google.md#google-tool-call-wire-name-restore)

## Decision record

- 목적과 의도: stop hash-suffixed Gemini wire names from failing the turn closed at the
  undeclared-tool guard when the model echoes them back without the `_<sha8>` suffix
  (incident 2026-09-26: declared `tavily_tavily-search` echoed as `tavily_tavily_search`).
- 기존 구현 및 제약 조건: `toolNameCodec` in `src/adapters/google-wire-compiler.ts`
  restored through exact-match `fromWire` only; any deviation passed through unchanged and
  the guard in `src/bridge/sse.ts` / `src/bridge/response-json.ts` rejected it as undeclared.
- 검토한 주요 대안: teach the guard the codec mapping; normalize separators at the guard;
  restore through a stem index inside the compiler.
- 선택한 방식: the compiler keeps a cleaned-stem to declared-original index alongside the
  exact map; restore tries exact, then full-stem, then one trailing `_<hex{1,8}>` strip,
  each only while the stem names exactly one declaration. Ambiguous stems and unknown names
  pass through so the guard keeps failing closed on real strangers.
- 다른 대안 대신 이 방식을 선택한 이유: the compiler owns the lossy transform, so it owns
  the recovery; touching the guard would widen a security boundary, and separator
  normalization at the guard cannot know which declaration a bare stem meant.
- 장점, 단점 및 영향: hash-dropping echoes of uniquely-stemmed tools now dispatch instead of
  failing the turn; ambiguous echoes still fail closed; no wire bytes change.
