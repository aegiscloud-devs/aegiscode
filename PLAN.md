# AEGISCODE-PLUGIN — PLAN

Canonical execution plan for this repo (MCP plugin + Electron desktop host +
shared thin client). The full product spec lives in `docs/product-plan.md`
(§4–§10); this file is the reconciler-driven queue of the remaining work.

A phase is **done** when its heading carries ✅ *and* its line in the Status
checklist is `[x]`. The first unchecked phase is the next unit of autonomous
work.

Status:

- [x] Phase 1 — P0 cloud pass-through & model-first vocabulary
- [x] Phase 2 — P1 desktop 4-class engine modules (transport + storage)
- [x] Phase 3 — P1 IPC + preload + renderer class picker + packaging
- [x] Phase 4 — §9 tests + thin-shell guard re-wording
- [x] Phase 5 — P2 metadata-driven per-model output ceiling
- [x] Phase 6 — P3 cloud conversation sync (replace the push stub)
- [x] Phase 7 — P3 memory-follows-user from any model class
- [x] Phase 8 — P3.5 renderer testability: prove the DOM paths, not just pure policy
- [x] Phase 9 — P3.6 headless Electron smoke in CI (scroll-hold + interrupt)
- [x] Phase 10 — P3.7 stream lifecycle hardening (abort re-entrancy, partial salvage)
- [x] Phase 11 — P3.8 endpoint policy: record the shipped rule, close the ⊘ gap
- [x] Phase 12 — P4 release: cut 0.7.8 / 6.7.8
- [x] Phase 13 — CI unblock: self-hosted runner
- [x] Phase 14 — harness determinism: the successor-turn timeout
- [ ] Phase 15 — desktop parity I/IV: engine core (`aegis` + `byok` only)
- [ ] Phase 16 — desktop parity II/IV: renderer, tools, packaging
- [ ] Phase 17 — desktop parity III/IV: CLI vendor tree + test sweep
- [ ] Phase 18 — desktop parity IV/IV: harness re-point + docs

---

## Phase 1 ✅ — P0 cloud pass-through & model-first vocabulary

Done. The client no longer fabricates model ids and never invents a tier.

- `client/aegis.js` `chatCompletion()` omits `model` when absent (server default);
  `mode` forwarded verbatim only when supplied; `max_tokens` default 1024 → 4096.
- `mcp/server.js` `mode` enum → free-form string; `max_tokens` cap 8192 → 64000;
  `aegis_byok_set` provider enum → free-form string.
- Docs/vocabulary swept (`nexus-*` spellings removed).

Commits: `5b47346`, `92178a6`, `f00705c`, `86b122f`, `88e2e0a`.

## Phase 2 ✅ — P1 desktop 4-class engine modules (transport + storage)

Done. Pure-core modules land test-first, no Electron imports.

- `desktop/lib/local/{context,providers,ollama,engine}.js` — OpenAI-compatible +
  Anthropic Messages direct streaming transport, Ollama probe/list/chat,
  model-class registry with per-session `AbortController`.
- `desktop/lib/settings.js` — main-process key store (safeStorage-aware, masked previews).
- `desktop/lib/sync/sessions.js` — crash-safe local session persistence with a
  monotonic `seq` tiebreaker (fixes same-millisecond ordering).

Commit: `e1001bf`. Unit tests: `test/local-context`, `test/local-providers`,
`test/local-engine`, `test/settings`, `test/sync-sessions` — green.

## Phase 3 ✅ — P1 IPC + preload + renderer class picker + packaging

Done. One UI, four model classes, all streaming, all key-safe.

- `desktop/main.js` `model:`/`sync:` dispatch backed by the transport modules;
  `model:chat` streams deltas over `CHAT_DELTA_CHANNEL` like the cloud path.
- `desktop/preload.js` `window.models.*` / `window.sync.*`; full keys never cross the bridge.
- `desktop/renderer/*` 5-class picker (Aegis Cloud / BYOK / Ollama / OpenAI-compat /
  Anthropic), always-on model select, maxTokens picker, provider settings pane,
  sessions pane, cancel button; dropped legacy `payload.mode='smart'`.
- `electron-builder.yml` + version 0.2.0 → 0.3.0; `predist.mjs` packages `lib/**`.

Commit: `ab1bcf7`. Tests: `test/model-dispatch.mjs`, `test/desktop-shell.mjs` (15-channel whitelist) — green.

## Phase 4 ✅ — §9 tests + thin-shell guard re-wording

Done.

- `test/client.test.mjs` asserts body-builder model omission, no `nexus-*`, BYOK
  defaults, messages-supersede-prompt/system (commit `86822ab`).
- CI thin-shell guard re-worded to an explicit path allowlist: transport permitted
  (`desktop/lib/local/*`, `desktop/lib/sync/*`, `desktop/lib/settings.js`), brain
  forbidden (commit `410c380`).

---

## Phase 5 ✅ — P2 metadata-driven per-model output ceiling

Done. `listModels()` was already pass-through raw (asserted, not assumed); the
desktop maxTokens picker now clamps to each model's real ceiling.

- `client/aegis.js` `listModels()` unchanged — `apiGet` returns parsed JSON
  verbatim, no stripping. Asserted by a new `listModels()` pass-through
  fetch-stub test in `test/client.test.mjs` (`max_output`/`context_window`
  survive the round trip; models without metadata aren't backfilled).
- `desktop/renderer/max-tokens.js` — new standalone pure helper,
  `maxTokensCeiling(meta) = min(64000, meta.max_output)` when `max_output` is
  a positive finite number, else the flat 64000 fallback. Dual
  CommonJS/browser export like `client/aegis.js`, loaded as a sibling classic
  `<script>` before `app.js` (`index.html`) so it's unit-testable without
  `window.aegis`/`window.models`.
- `desktop/renderer/app.js` `loadModels()` now records raw model objects in a
  `modelMeta` map and calls `applyMaxTokensClamp()`, which disables
  `max-tokens` `<option>`s above the selected model's ceiling (clamping the
  current selection down if needed) and appends `· max output: N` to the
  model hint when the ceiling is below 64k. A `model-select` change listener
  re-clamps when the user switches models mid-class; custom classes
  (openai-compat/anthropic, no metadata available) always get the flat
  fallback.
- `test/max-tokens.test.mjs` — new unit test for the pure ceiling helper
  (below/above/absent/non-numeric/zero/negative `max_output`).

Exit criteria:
- `listModels()` output with `max_output`/`context_window` is returned unmodified. ✅
- The maxTokens picker reflects a selected model's `max_output` when metadata is
  present, and 64k otherwise. ✅
- `cd desktop && npm run check` and `node test/*.mjs` stay green. ✅

## Phase 6 ✅ — P3 cloud conversation sync (replace the push stub)

Done. Local pending-queue half landed with full push/pull wiring against the
aegis1 conversation-sync contract (`/api/conversations/sync`), reusing the
existing memory-token auth — no new credential flow.

- `desktop/lib/sync/sessions.js`: `pending` flag set on every
  `appendMessage`/`upsertSession`, cleared by `markSynced(dir, id, remote)`;
  `markPending(dir, id)` re-queues; `listPending(dir)`; `mergeRemoteSessions(dir,
  remoteSessions)` (last-write-wins by `updatedAt`, local `pending` always wins
  over remote).
- `client/aegis.js`: `conversationSyncPush(transcript)` / `conversationSyncPull()`
  — `POST /api/conversations/sync` authenticated with the cached memory token
  (`getMemoryToken()`/`memoryHeaders()`), mirroring `memorySave`/`memoryPull`.
- `desktop/main.js` `createSyncDispatch(sessions, dir, aegis)`: `push` uploads
  every pending session and calls `markSynced` per success; `pull` merges the
  remote list via `mergeRemoteSessions`; `status` reports
  `{ count, pending, cloud, lastSyncAt }`. `aegis` is optional — with no key
  (`hasCloud()` false) both `push`/`pull` resolve `{ ok:false, reason }`,
  never throw. `model:listModels` and `sync:status` fire a fire-and-forget
  `heartbeatRetry()` push of pending sessions.
- `desktop/preload.js` adds `window.sync.pull`; `renderer/index.html` +
  `app.js` add a "Sync now" button (`syncNow()`) and a sync-status line
  (`renderSyncStatus()`) wired on init.
- Tests: `test/sync-sessions.test.mjs` (pending-queue + `markSynced`/`markPending`/
  `mergeRemoteSessions` round-trips), `test/model-dispatch.mjs` (offline
  `push`/`pull`/`status` branches + a stubbed-cloud push/pull/status round-trip),
  `test/client.test.mjs` (`conversationSyncPush`/`Pull` auth with the memory
  token, never the raw API key).

Exit criteria:
- `sessions.json` marks a session `pending` until pushed, and `markSynced` clears it. ✅
- With AEGIS key + reachable aegis1: `sync:push` uploads and clears pending;
  `sync:pull` rehydrates a session from a second machine. ✅ (wired to the
  documented contract; end-to-end verification against the live aegis1 endpoint
  is pending that server work landing — aegis1 `PLAN.md` Phase 3).
- With no key/network: all local flows still work; `sync:status` reports
  `cloud:false` without throwing. ✅
- Unit + smoke tests green. ✅

## Phase 7 ✅ — P3 memory-follows-user from any model class

Done. Every assistant message, from any of the four model classes, can be
pinned to cloud memory and survives being offline when it happens.

- `desktop/renderer/app.js` `addMessage(role, text, meta, sessionId)` renders a
  "remember" button on assistant messages when a `sessionId` is supplied — both
  the live `send()` path and reopened session history (`openSession()`).
  `rememberMessage(text, sessionId, btn)` calls `aegis.memorySave({ text,
  source: 'aegis-desktop', session: sessionId })`, mirroring the MCP saver shape
  (`source: 'claude-code'`, `session: args.session`, `mcp/server.js`).
- `desktop/lib/sync/memory-queue.js` — new pure module, same crash-safe
  temp-file-rename pattern as `sessions.js`: `enqueue(dir, entry)` appends to
  `<dir>/memory-queue.json`, `listQueued(dir)` reads it back.
- `desktop/main.js` `saveMemoryWithQueue(aegis, dir, entry)`: the `aegis:memorySave`
  IPC handler now tries the cloud save first and, on any failure (no key,
  offline), queues the entry locally and resolves `{ ok: true, queued: true,
  reason }` instead of throwing — the renderer's "remember" click never
  surfaces an error for the no-key case. `createIpcDispatch`/`registerIpc` take
  an optional `dir` (threaded from `bootstrap()`'s `resolveUserDataDir(app)`,
  reused by `createEngine` too) — omitted, the old throw-through behaviour is
  unchanged (back-compat for existing callers).
- `createSyncDispatch(...).push()` (the same function "Sync now" and the
  `listModels`/`status` heartbeat retry already call) now also flushes
  `memory-queue.json` once a cloud client is available, retrying each queued
  entry via `aegis.memorySave` and re-queuing only the ones that still fail —
  reusing the Phase 6 retry-on-heartbeat wiring exactly as scoped, no new IPC
  channel needed.
- Tests: `test/memory-queue.test.mjs` (new, pure module round-trip),
  `test/desktop-shell.mjs` (memorySave queues on failure when `dir` is given,
  still throws without one), `test/model-dispatch.mjs` (`push()` flushes a
  pre-queued memory entry via a stub `aegis.memorySave` once cloud is
  reachable).

Exit criteria:
- Clicking "remember" on a message from an Ollama/custom class writes memory via
  `aegis.memorySave` with `source: 'aegis-desktop'` + `session: <id>`. ✅
- With a key present, that memory is found by `memorySearch` from another
  machine. ✅ (writes through the existing `memorySave` cloud path unchanged —
  same server contract Phase 1 already verified for `memorySearch`.)
- With no key, the save queues locally without throwing. ✅

Server-side memory sync (`/api/memory/*` with `memory_token`) already exists in
aegis1 — this phase is client-side only.

---

## Prerequisites (out of repo)

aegis1 server work that unblocks Phases 5–6 is tracked in the **aegis1** repo's
own `PLAN.md` (P4.2 catalog metadata → Phase 5; P4.5 conversation-sync endpoint →
Phase 6). Phase 7 is unblocked today (memory sync already shipped).

---

## Phase 8 ✅ — P3.5 renderer testability: prove the DOM paths, not just pure policy

Done. `desktop/renderer/transcript-view.js` extracts `rafPainter`, the
follow-only-at-tail scroll veto, and `stopPendingTurn` into a pure,
DOM-injected module (`document`/`requestAnimationFrame` passed in, not
imported), so `test/renderer-dom.test.mjs` exercises the real coalescing,
veto, and Escape-interrupt logic against a minimal fake DOM instead of
re-describing the policy in the abstract. `test/renderer-wiring.test.mjs`
extended to the now 5 sibling scripts + 10 globals, asserting no orphaned
script and that `app.js` actually wires the transcript policy in. Verified
by deleting each of the script tag, the scroll veto, and the Escape handler
in turn — each one fails a test.

Commit: `2c30678`.

Exit criteria:
- Removing the script tag, the `userScrolledUp` veto, or the Escape handler
  each fails a test — verified by actually removing each in a worktree. ✅
- `npm run check` + the `test/**/*.test.mjs` glob run in CI (already wired);
  no test file may depend on being run by hand. ✅

## Phase 9 ✅ — P3.6 headless Electron smoke in CI (scroll-hold + interrupt)

Done. `test/electron-smoke.mjs` launches the real Electron binary (headless,
`xvfb-run` when no `DISPLAY` is present, otherwise the existing display) against
a stubbed local HTTP server speaking the cloud pool's SSE wire format — no
network, no key, no provider spend. `desktop/test/electron-smoke-main.js` drives
a live turn inside the window, scrolls up mid-stream, and asserts the
transcript holds position, then fires Escape and asserts the partial answer is
salvaged and labelled "stopped by you" rather than lost or reported as an
error. Fixed while closing this phase out (live-run, not just read):
- `window.__aegisSmoke` (frozen, read-only) exposes `transcript.isScrolledUp()`/
  `metrics()` to the injected driver script, which previously read `transcript`
  as a bare global and silently got `null` — an unfalsifiable scroll assertion.
- `SCROLL_UP` now establishes a genuine tail (`scrollTop = scrollHeight`) before
  scrolling to 0, instead of asserting `scrollTop === 0` right after setting it
  — a check that could only ever pass.
- The "salvaged is partial" assertion compares against the full stream length
  the stub would have sent (`AEGIS_SMOKE_COMPLETE_LEN`), not the visible text
  length at the instant Escape fired — the old comparison raced the renderer's
  in-flight frame and flaked (23/0, 22/1, 20/3 across identical runs).
- `CHUNK_COUNT` raised 400 → 4000 (10s → 100s of stub drip): a live run against
  the real display caught the stub completing for real before Escape fired,
  under ordinary desktop load — a false "nothing was interrupted" caused by the
  test's own timing budget, not the app. Escape still fires within ~1s in
  practice, so this doesn't slow a healthy run.
- Wired as a second CI job (`electron-smoke` in `.github/workflows/ci.yml`):
  installs `xvfb` + desktop deps, runs with no cloud credentials or outbound
  network.

Verified locally: 5 consecutive green runs against a real X display
(`OK — 45 passed, 0 failed`, ~5s each) after the CHUNK_COUNT fix; one of the
pre-fix runs reproduced the exact race described above.

Commits: `7b73a8d` (harness scaffolding) + the CI-wiring/flake-fix commit that
closes this phase.

Exit criteria:
- CI fails if scrolling up mid-stream loses the reader's position. ✅
- CI fails if Escape does not terminate a streamed turn. ✅
- The job runs with no cloud credentials and no outbound network dependency. ✅

## Phase 10 ✅ — P3.7 stream lifecycle hardening (abort re-entrancy, partial salvage)

Scope. The abort path was written to make *one* interruption safe. Its edges are
unverified, and each is reachable by an ordinary user:

- **Re-entrancy.** Escape pressed twice, or Escape arriving after the stream
  already ended: `stopPendingTurn()` must be idempotent and must not cancel a
  *subsequent* turn.
- **Send while cancelling.** A new turn started during teardown must not be
  killed by the previous abort.
- **Partial salvage.** `isCancellation` already distinguishes a deliberate stop
  from a transport error (`ECONNABORTED` / dropped socket must **not** be
  relabelled "stopped by you" — pinned in `test/stream-policy.test.mjs`); the
  DOM-side salvage of `streamedText || reasoningText` needs the same treatment.
- **Reasoning-only streams.** A turn that produced deliberation but no answer
  text before the abort should still surface something.
- **Tool-call streams mid-abort** — a turn cancelled between tool call and
  result.

Done (`4194e95`, harness falsifiability `c04eb4e`). The global `userStopped`
flag is gone; a turn now carries its own identity, and the three edges that
were reachable by an ordinary user are decisions in a pure module rather than
branches inside the send loop.

- `renderer/stream-policy.js` owns the new rules: `stopAppliesTo(runningTurn,
  stoppedTurn)` (idempotency), `salvageTurn({streamedText, reasoningText})`
  (answer / reasoning-only / empty, as distinct outcomes), and `toolMark(tool)`
  (✓ / ✗ / ⊘ — only a literal `true` is a tick, no string coercion).
- `renderer/app.js` tracks `turnSeq` / `runningTurn` / `stoppedTurn`. `send()`
  claims its token, `stopPendingTurn()` is idempotent, `newChat()` drops the
  tokens, and the `finally` is guarded so a teardown belonging to an outgoing
  turn cannot disarm its successor.
- `renderer/transcript-view.js` ignores `e.repeat`, so a held Escape cannot
  stop the *next* turn.
- **A correction worth keeping:** what stops a stale abort is the token
  invariant — `stoppedTurn` is cleared when a successor claims a turn, and the
  catch only honours `stoppedTurn === myTurn`. It is *not* `stopAppliesTo`:
  `stopAppliesTo(8, 7)` is deliberately `true`, because a live successor *is*
  stoppable. The module comment says so, and the test pins that pair as
  reachable rather than asserting a false invariant.
- Smoke legs, all in the real DOM: `double-press-both-consumed` /
  `-one-bubble` / `-no-pending` / `-no-error` / `-cancelled-once`,
  `stale-escape-inert` / `-called-no-cancel` / `-keeps-send`, `successor-*`
  (4), `reasoning-only-streamed-no-answer` / `-labelled` / `-not-empty`.
- **The falsifiability fix is the part that mattered.** `double-press-cancelled-once`
  originally counted `models.cancel` invocations by wrapping the renderer's
  bridge object — which silently never installed, because `preload.js` exposes
  it frozen (`contextBridge.exposeInMainWorld('models', Object.freeze(models))`).
  The check read `0` and passed unconditionally: removing `stopAppliesTo`'s
  guard still produced 92/92. It now wraps `createLocalEngine` in the **main**
  process, where `engine.cancel` is a call-time lookup — and deleting the guard
  fails the check (`models.cancel ran 2 time(s) across two Escape presses`).

Exit criteria:
- Escape is idempotent; a second press never affects another turn. ✅
  (`stopAppliesTo` unit-pinned; `double-press-cancelled-once` now proves
  exactly one abort reaches the engine, and the control fails when the guard is
  removed.)
- A dropped socket surfaces as an error, never as "stopped by you". ✅
  (`isCancellation` pinned against `ECONNABORTED`, undici's "This operation was
  aborted", and Chromium's "The user aborted a request." in
  `test/stream-policy.test.mjs`.)
- Cancelling a reasoning-only or tool-call turn leaves the user with the
  partial output instead of an empty bubble. ✅ for reasoning-only — a
  labelled-but-empty bubble is the exact defect that leg exists for.
  `toolMark`'s ⊘ is unit-pinned only; that is Phase 11.

Verified at this commit: `test/electron-smoke.mjs` — 98 passed, 0 failed;
71 root suites + 2 desktop-local, 0 failures; `npm run check` exit 0.

---

## Phase 11 ✅ — P3.8 endpoint policy: record the shipped rule, close the ⊘ gap

Scope. The local-only endpoint rule is **enforced in code but unrecorded in the
plan**, and one doc line now contradicts the binary.

- Shipped rule: `desktop/lib/local/endpoints.js` (`isLocalEndpoint`,
  fail-closed — scheme checked before host, so `ftp://box.local` is rejected
  rather than riding the `.local` suffix). It is enforced at two seams:
  `desktop/lib/settings.js` refuses to **store** a remote URL for a direct-dial
  row (`openai-compat` / `anthropic` / `custom:*`), and
  `desktop/lib/local/engine.js` refuses to **dial** one before any transport
  call. The storage gate is keyed on the row, not the value, so BYOK's own
  `baseURL: ''` rows stay storable.
- Doc drift: `docs/product-plan.md` §2 lists "OpenAI-compatible direct" and
  "Anthropic-compatible direct" as taking a "user baseURL" with no locality
  restriction, while §12 decision 2 already reads "Local = direct from desktop;
  cloud = relay through the pool". The shipped rule is the stricter one, so
  §2 must be corrected to match rather than the code relaxed.
- The last real coverage hole: `toolMark`'s ⊘ ("interrupted, not succeeded") is
  pinned by `test/stream-policy.test.mjs` only. Nothing proves an aborted tool
  call renders ⊘ in the DOM rather than ✓.

Exit criteria:
- `docs/product-plan.md` §2 and §12 state the local-only rule explicitly, and
  no line describes a remote direct-dial `baseURL` as permitted.
- The plan records which lanes bill and which do not: `aegis` and `byok` are
  relayed and billed; `openai-compat` / `anthropic` / `custom:*` are direct-dial
  and local-only; `ollama` is the free lane and carries no user URL at all
  (`engine.js` calls it with no `baseURL`, so it falls through to
  `http://localhost:11434`).
- The plan records that a remote provider is reached through `byok` (billed),
  not by a preset — i.e. the GUI's former `api.deepseek.com/anthropic` presets
  moved lanes rather than being removed.
- The storage and dispatch seams each have a test that fails if the check is
  removed, and the classifier's boundaries (`127.0.0.1`, `localhost`, `10.x`,
  `172.20.x`, `192.168.x`, `[::1]`, `*.local` allowed; `api.z.ai`,
  `api.openai.com`, `172.32.x`, `192.169.x`, non-http schemes and unparseable
  input refused) stay pinned.
- A DOM leg renders an aborted tool call as ⊘. ✅ — but **not** through the
  transcript, and that is the finding rather than a shortcut. `engine.js` emits
  `phase: 'run'` before the tool executes and `phase: 'done'` (always with an
  explicit boolean `ok`) after, and both transcript handlers deliberately drop
  the run frame (`if (chunk.tool.phase === 'run') { …; return; }`) so a tool is
  never printed twice. No stub payload can therefore make the transcript draw
  ⊘: the only frame that reaches `toolActivityLabel` there carries a real `ok`,
  so it can only ever be ✓ or ✗. The leg rides the queue lane instead, which
  renders a raw run frame — `autonomous.js` emits
  `{ type: 'tool', taskId, tool: chunk.tool }` with no phase filter, main
  forwards it verbatim over `QUEUE_PROGRESS_CHANNEL`, and
  `renderQueueProgress` has no phase guard either. Three outcomes, three glyphs,
  one row: `queue-run-frame-marked-interrupted` (⊘),
  `queue-done-frame-marked-ok` (✓), `queue-failed-frame-marked-cross` (✗), plus
  `queue-run-frame-not-marked-ok` and `queue-run-frame-names-the-tool`.
  One synthetic element, stated plainly: the driver sends the event rather than
  a draining worker, because a real drain needs a queue file, a cwd, and an
  agent loop returning `tool_calls`. Everything downstream of the channel is
  production code.

  The falsifiability control was run, not assumed: restoring `toolMark`'s
  former `ok === false ? '✗' : '✓'` fails both ⊘ checks with
  `#queue-hint read "#7 → writeFile NOTES.md ✓"` — a success tick for a call
  that had not finished, which is the defect the branch exists for. `✗` and ✓
  correctly kept passing, so the ⊘ checks are specific and not merely noisy.

Recorded correction, from the Phase 10 leg this subsumes. What stops a stale
abort reaching a live successor is the turn-token invariant, **not**
`stopAppliesTo`: `stopAppliesTo(8, 7)` is deliberately `true`, because a live
successor *is* stoppable. The doc comment and the assertion were both rewritten
to the reachable-pair invariant rather than the claim the code does not make.

Harness fix in the same commit. `reasoning-only-labelled` failed roughly one run
in three, and it was a harness race, not a product defect: `LAST_STOPPED` scanned
the whole transcript for the *last* stopped bubble, and three earlier legs
already leave stopped bubbles behind — so the `waitFor` was truthy the instant it
was asked and asserted against the **successor's** bubble, a turn it never drove.
The failing meta read `3 calls` where the control read `4 calls`, which is the
direct confirmation. Replaced by `STOPPED_STATE` + `pollStopped(win, count + 1)`,
anchored on one more stopped bubble than before and deliberately **not** on the
label, because waiting on the assertion would make the assertion unfalsifiable —
the same defect in a new costume.

Open reliability item, observed once and not yet fixed: one smoke run in four
during this phase died with `timed out waiting for the successor turn to stream`
(`liveText().length > 1200` within `waitFor`'s 20s). That leg is **not** touched
by this diff, so it is recorded as its own concern rather than folded into this
phase — but it is a claim about the harness's determinism, and it is not yet
either reproduced deliberately or proven pre-existing.

Verified at this commit: `test/electron-smoke.mjs` — **110 passed, 0 failed**,
three consecutive runs; 71 root suites + 2 desktop-local, 0 failures; `npm run
check` exit 0 in both packages.

---

## Phase 12 ✅ — P4 release: cut 0.7.8 / 6.7.8

Scope. Two packages were bumped and neither was published; the owner's decision
was **both**.

Outcome, all four exit criteria met:

- The bump is committed as `dac8609` (`cli/package.json` 6.7.7 → 6.7.8;
  `desktop/package.json` + lockfile 0.7.7 → 0.7.8), that commit also carries the
  plan updates, and `git status --porcelain` is empty at `dac8609`.
- The suites and smoke pass **after** the bump, re-run at the pushed commit and
  not carried over from before it: 71 root suites + 2 desktop-local, 0
  failures; `test/electron-smoke.mjs` **110 passed, 0 failed** (exit 0);
  `npm run check` exit 0 in both packages.
- `npm publish` succeeded for both, and the published versions were confirmed
  against the registry rather than read off the publish banner:
  `npm view aegiscode version` → `6.7.8`, `npm view aegis-desktop version` →
  `0.7.8`, with `dist-tags.latest` moved on both. The first two registry polls
  still returned the *old* versions, so a zero exit code alone would have
  reported a release nobody could install yet.
- No build artifact is tracked: `git ls-files` matches nothing for `*.tgz`,
  `desktop/release/`, or `node_modules/`, and the pre-commit guards were not
  bypassed.

Tarball contents were checked, not assumed. A correct version number says
nothing about whether the release ships the work it was cut for, so both
published tarballs were inspected: `aegis-desktop@0.7.8` contains
`renderer/preset-fill.js`, `renderer/stream-policy.js`,
`renderer/transcript-view.js` and `lib/local/endpoints.js`, and the two files the
CLI vendors (`renderer/usage.js`, `lib/local/endpoints.js`, per
`cli/scripts/predist.mjs`) are present and byte-identical to their desktop
counterparts.

Recorded correction. An earlier report placed the bumped `cli/package.json` in
`aegiscodex-dev`; that repo has no `cli/` directory at all. All three bumped
files live in this repo.

Carried forward, not fixed here: CI never ran. Every job on these pushes failed
in 1–4s with *"The job was not started because your account is locked due to a
billing issue"*, so no GitHub job has executed on any commit in this phase. The
local runs above are the only verification that exists. See Phase 13.

---

## Phase 13 ✅ — CI unblock: self-hosted runner

Scope. CI had been dead across at least the last four pushes and the failure was
not code — it was a GitHub billing lock, so the jobs never start. Nothing was
compiled, tested, or smoke-run remotely; every green result in Phases 8–12 was
local only. Self-hosted runners are not billed, and
`/home/neo/actions-runner-plugin/` already existed for exactly this purpose
(`bin/`, `config.sh`, `env.sh`, `externals/` are extracted) but was never
registered — there was no `.runner` file, and
`gh api repos/aegisinfo/aegiscode-plugin/actions/runners` returned
`total_count: 0`.

Outcome, all four exit criteria met:

- **Runner online.** `aegis-plugin-local` (actions-runner v2.335.1) is registered
  repo-scoped against `aegisinfo/aegiscode-plugin`, single supervised instance,
  and reports `online` via the API. The agent name is deliberate: it is not
  `/home/neo/actions-runner`, which is a *different* runner registered as agent
  `neo` against `aegisinfo/ae-guix` and was left untouched.
- **Both jobs complete green, on a self-hosted runner.** Run `35526452848` on
  `d30ef8b`: `Validate wrapper` **success** (17/17 steps) and
  `Headless Electron smoke (P3.6)` **success**. `Install xvfb` is `skipped`,
  which is the self-hosted path taking the runner's own `DISPLAY` as designed.
- **The billing lock is genuinely bypassed** — the fact that could not be
  verified before. Run `35525622224` was the first GitHub job ever to *execute*
  in this repo: it went `in_progress` on the runner instead of dying in 1–4s.
  Routing is gated to `push` events only, via repo variable
  `CI_RUNNER=["self-hosted"]`, because this repo is public and a PR from a fork
  would otherwise execute untrusted code on the machine holding local
  credentials. Unset the variable to revert to `ubuntu-latest`.
- **The smoke job reproduces the local result**: `110 passed / 0 failed`, not
  merely a zero exit code.

CI immediately found a real defect that local runs could never have seen. On a
fresh checkout `test/cli-approval.test.mjs` died with `Cannot find module
.../cli/vendor/desktop/lib/local/engine.js`. Both `cli/vendor/` and
`desktop/vendor/` are **gitignored** (`.gitignore:8-9`, zero tracked files) and
are staged only at publish time by each package's `predist` script — so a fresh
checkout does not have them, and the local suite was green only because
publishing 6.7.8 had left those trees staged on disk. Two further suites
(`npm-update-channel`, `packaging`) failed on the same cause; CI aborts at the
first failing test, so it never reached them. Fixed in `d30ef8b` by running both
`predist` scripts as step 0 (pure fs copy + byte-equality verify — no network, no
dependencies) and asserting the staged files exist.

A second, quieter hole was found while fixing the first: the unit-test glob was
`find test -name '*.test.mjs'`, which **cannot see** `desktop/test/*.test.mjs`.
`deep-link` and `renderer-diff` therefore never ran in CI at all — the same
"silently never ran" class the glob comment in that file already warns about.
Both test roots are now listed explicitly and the orphan guard covers both. The
CI log itself confirms **73 test files** executed, including both desktop-local
suites, up from 71 discoverable before.

Falsifiability. The staging fix was negative-controlled rather than assumed: on a
pristine clone with the staging step omitted, the unit-test step exits **1**; with
it, all 13 `validate` steps pass. The whole job sequence was replayed locally
from the `run` blocks extracted out of `ci.yml` on a fresh `git clone`, so the
pass is not an artifact of the working tree.

Recorded corrections.

- An earlier report claimed the runner was "not running" (`NO_RUNNER_PROC`). That
  was a **bad `pgrep` pattern** — it matched `Runner.Worker|runner/Runner`
  against a process that is really `Runner.Listener` — and acting on it spawned a
  duplicate worker that then had to be killed. The runner had been online the
  whole time.
- The first reproduction used `git archive HEAD`, which has **no `.git`
  directory**, so tests calling `git check-ignore` / `git ls-files` reported three
  *false* failures (`cli-package` among them). A real `git clone` is the correct
  reproduction and is what the numbers above come from.

Carried forward, not fixed here. The runner is running **detached, not as a
service**, so it dies on reboot and CI stops running silently. The scope/service
decision the phase flagged is still open: repo-scoped was chosen, `svc.sh
install` was deliberately not run because that is a system-level change.
See Phase 14 for the remaining harness-flake work.

---

## Phase 14 ✅ — harness determinism: the successor-turn timeout

Scope. One smoke run in four during Phase 11 died with
`timed out waiting for the successor turn to stream`
(`liveText().length > 1200` within `waitFor`'s 20s). That leg is not touched by
the Phase 11 diff, and it has neither been reproduced deliberately nor proven
pre-existing.

Done. The instrument is the wait itself, not a bystander assertion beside it.
Every "this turn has streamed enough" wait now goes through `waitForTurn` in
`desktop/test/electron-smoke-main.js`, which returns how long the wait actually
took and which row satisfied it, and the predicate it polls is the shared
`TURN_PROBE` in `desktop/test/turn-probe.js` — the same text the negative
control evaluates, not a copy. Two facts pin the reading to *this* turn: the
live row (`liveRow()` = the first row carrying a cancel button) must be at or
past the row count observed before the submit (`since`), and it must be the
newest row, because a streaming turn is always appended last. Each of the four
anchored waits is recorded as a named check (`primary-wait-anchored`,
`double-press-wait-anchored`, `successor-wait-anchored`,
`reasoning-only-wait-anchored`), so a wait satisfied by a previous leg's
leftover row fails CI instead of passing quietly; the margin and the anchor of
every wait also travel back to the wrapper on an `SMOKE_WAITS` line, which is
what makes the N-run loop able to read them. `AEGIS_SMOKE_STALL_STREAM=<n>`
turns any leg into a deliberately stalled one — a few chunks, then a response
left open and quiet — so the timeout path is reachable on demand rather than
only in the wild.

N-run margin. `AEGIS_SMOKE_REPEAT=8 node test/electron-smoke.mjs`, run twice
from the repo root on the real display (Electron + `DISPLAY=:0`): **16/16 runs
green, exit 0**, `OK — 8 run(s), 0 failed` each time. Deadline is 20000ms per
wait; worst observed waited time and margin per leg, across all 16 runs:

- `primary` — worst 1255ms of 20000ms (**margin 18745ms**), on run 8 of the
  first collection; typical 1231–1253ms. It is the slowest leg of the four
  because it is the only one waiting on 3000 chars (`waitForTurn(win,
  rowsBefore, 3000, ...)`) rather than 600–1200, which at the stub's 25ms drip
  is ~42 chunks of real stream time. Anchor `row 1 >= since 0 / 2 rows` in every
  run.
- `doublePress` — worst 317ms of 20000ms (**margin 19683ms**); anchor
  `row 3 >= since 2 / 4 rows` in every run.
- `successor` — worst 533ms of 20000ms (**margin 19467ms**); across the 16 runs
  min 511ms, median 514–515ms, max 533ms. Anchor
  `row 5 >= since 4 / 6 rows` in every run.
- `reasoningOnly` — worst 317ms of 20000ms (**margin 19683ms**); anchor
  `row 7 >= since 6 / 8 rows` in every run.

The anchors are not just reported, they are asserted: the row indexes above are
the `index >= since` / `index === rows - 1` pair read off the same probe
evaluation that let each wait through, and all four `*-wait-anchored` checks pass
on all 16 runs. What the numbers settle is the phase's actual question: the leg
that died in Phase 11 was **never near its deadline**. The successor wait is
satisfied in ~0.5s — 2.6% of the 20s it has — so the failure was not slowness,
and no wall-clock budget change would have fixed it. It was a predicate with no
anchor that a leftover row could leave unsatisfied, and the anchored predicate
plus the deliberately stalled leg are what make that state observable on demand.

Falsifiability, both halves verified live rather than asserted:

- **Deleting the anchor clause turns 3 tests red.** Removing the single line
  `if (i < since || i !== rows.length - 1) return 0;` from `TURN_PROBE` in
  `desktop/test/turn-probe.js` makes
  `node --test test/turn-probe.test.mjs` report **3 pass / 3 fail** (the two
  stale-row rejections and the reasoning-field rejection); restoring the line
  returns it to 6/6. Each of those tests also asserts the *bare* length probe
  is satisfied by the same stale state, so the control cannot be vacuous — it
  shows the leftover row really did answer the old wait.
- **The original timeout is reproducible on purpose.**
  `AEGIS_SMOKE_STALL_STREAM=2 node test/electron-smoke.mjs` exits **1** with the
  exact Phase 11 message — `timed out waiting for the successor turn to stream`
  — now carrying the transcript it was reading
  (`row 5, cancel=true, body=408, sendDisabled=true`) instead of a bare
  "timed out". 68 passed, 24 failed, and the failures name the missing legs
  (`stub-was-used: 3 streams, expected 4`) rather than reporting only
  `driver-ok: false`.

Exit criteria:
- The failure is reproduced deliberately, or the timeout's margin is measured
  and shown to be the cause. ✅ Both: 16 runs measured (worst margin 18745ms,
  successor worst 533ms of 20000ms) **and** reproduced deliberately via
  `AEGIS_SMOKE_STALL_STREAM=2` → exit 1.
- The leg either stops flaking over N consecutive runs or its wait gains an
  anchor that cannot be satisfied by a previous leg's state. ✅ Both: 16/16
  green, and the wait now requires `index >= since` **and**
  `index === rows - 1`.
- A negative control proves any replacement assertion can fail. ✅ Deleting the
  anchor clause → 3 of 6 `turn-probe` tests red; the stall switch → the real
  timeout, exit 1.

Recorded correction from the earlier attempt at this measurement. The first
N-run loop reported every run as failed with "no waits evidence" even though the
runs were green: it parsed `SMOKE_EVIDENCE` out of the wrapper's stdout, but
that line is consumed one process down inside the driver and never re-emitted
upward, so the loop was reading the wrong process tree. The wrapper now prints
its own `SMOKE_WAITS` line from the evidence it already holds, which is the line
the loop parses. That defect was in the instrument, not the harness.

Not carried forward: CI still runs the default single iteration. The N-run loop
is opt-in via `AEGIS_SMOKE_REPEAT`, because 16 runs of the full harness cost
minutes and the anchor assertion — the part that detects the defect — runs in
every single iteration and in the unit-test step.

Commit closing this phase: `893d6b9` (instrument + anchors, on top of `bf8c2fa`),
plus the plan-closure commit.

---

## Prerequisites (out of repo)

aegis1 server work for Phases 8–12 is none — these are desktop- and
release-side. The server-side upgrade plan lives in the **aegis1** repo's own
`PLAN.md` (Phase 4 billing integrity → no silent money loss; Phase 5 reserve
pricing honesty → the hold that spurious-402s funded accounts; Phase 6 provider
hygiene).

---

## Phase 15 ⬜ — desktop parity I/IV: the engine core (`aegis` + `byok` only)

**Status: D1 resolved (re-point at `aegis`).** This is **slice 1 of 4** — the
atomic engine core. Phases 16–18 continue it; do not start them in this phase.

### Goal

The CLI already ships exactly two model classes — `HOST_CLASSES = ['aegis',
'byok']` in `cli/src/engine.js` (done in `c0598de`). The desktop still ships
five. The four phases together make the desktop match: **`aegis` (Aegis Cloud)
and `byok` (bring your own provider key) survive; `ollama`, `openai-compat` and
`anthropic` are removed entirely.**

"Removed entirely" means the class, its transport module, its endpoint-policy
guards and its renderer affordances all go — not merely hidden from the picker.
A class that is unreachable from the UI but still present in the engine is
exactly the silent-fallback shape this repo has been burned by before (see the
`REQUIRES_STATED_BUDGET` note in Phase 5 and the "no saved key" error text).

### What stays vs. what goes

`byok` is **one** class covering many upstream providers (`anthropic`,
`deepseek`, `openai`, …). Those names must survive everywhere they name a
*provider*; only the *model class* named `anthropic` dies. Conflating the two
is the single easiest way to break this refactor — hence step 15.0.

| Symbol | Fate | Why |
| --- | --- | --- |
| `CLASSES` entries `aegis`, `byok` | **keep** | the two shipping classes |
| `byok:*` settings rows, `byokNamespace()`, `splitByokModel()`, `aegis.byokChatCompletion` | **keep** | the byok lane, untouched by this phase |
| `"anthropic"` / `"openai"` / `"deepseek"` as **byok provider ids** | **keep** | upstream names, not classes |
| `CLASSES` entries `ollama`, `openai-compat`, `anthropic` | **delete** | no longer shipping |
| `CUSTOM_CLASSES` constant (`engine.js:78`) | **delete** | defined solely for the two custom classes |
| `REQUIRES_STATED_BUDGET` (`engine.js:141`) | **delete** | keyed on class `anthropic` only; no class needs a stated budget once it is gone |
| same constant, mirrored at `desktop/renderer/budget.js:95` | **delete** | Phase 16 — move together or the renderer diverges |
| `desktop/lib/local/ollama.js` | **delete** | only the `ollama` class imports it |
| `desktop/lib/local/providers.js` | **delete** | `anthropicMessages`/`openaiCompatible` are reached only by the custom classes; `byok` goes through `aegis.byokChatCompletion` and `aegis` through the cloud client |
| `desktop/lib/local/endpoints.js` | **delete** | `isLocalEndpoint`/`remoteRefusal`/`isDirectDialRow` police custom endpoints only — see 15.3 |

### Execution contract — read this before editing anything

1. **Split, don't swallow.** Phases 15–18 are four separate phases *because* the
   single-phase form already failed once (2026-09-21: the worker exhausted its
   round budget mid-refactor and the runner auto-committed a non-runnable
   `engine.js`). Work only the slice named in the phase header.
2. **Land atomically.** `desktop/` must be runnable at every commit. Never
   remove a signature member before its consumers (that is precisely what
   produced the broken state).
3. **The runner auto-commits whatever is in the tree when you stop.** So if you
   cannot finish *and* verify inside your round budget,
   `git checkout -- <the files you touched>` **before you stop**. A phase left
   unstarted is recoverable; a committed broken tree is not, and it is worse
   than no progress.
4. **Spend rounds on edits, not exploration.** The step numbers below name the
   files and line anchors; read only those. Do not re-derive the plan.
5. **Baseline once.** 15.0 records it; nothing later re-runs the whole matrix
   until the slice is complete.

### Steps (this phase: engine core only)

**15.0 — Baseline + the provider/class distinction.**
Record the green baseline (`desktop`: `npm run check`; each `npm run test:*`;
`node test/desktop-shell.mjs`; the CLI's `npm test` from `cli/`) so a later red
run can be attributed. **Known pre-existing red at HEAD, not yours to fix here:**
`desktop` `npm run test:engine` fails at `test/local-engine.test.mjs:1265` —
`ASSERT FAILED: unconfigured provider is refused, got No key for "anthropic"
yet…`. Record it verbatim as the baseline exception; Phase 17 owns that test.
Then enumerate every `anthropic`/`openai`/`deepseek` occurrence and classify it
as *byok provider name* (keep) or *custom model class* (delete). Do not
bulk-substitute.

**15.1 — Engine registry (`desktop/lib/local/engine.js`).** Drop the
`./endpoints.js` import (line 51); delete `CUSTOM_CLASSES` (78); cut `CLASSES`
(88–94) to `aegis` + `byok`; delete `REQUIRES_STATED_BUDGET` (141) and drop the
now-meaningless `cls` parameter from `reasoningBudget()` plus its call site
(193); remove `ollama`/`providers` from `createLocalEngine`'s signature (397).
Then rework every consumer **in the same commit** — `customStatus()` (690–702),
`listClasses()` (698), `listModels()` (726–774), `dispatch()` (964, 1037–1038),
the direct-dial gate in `chat()` (1207–1228), and the
`cls === 'aegis' || cls === 'ollama'` checks (1139, 1143).

**15.2 — `desktop/main.js`.** Drop `require('./lib/local/ollama.js')` (65),
the `ollama`/`providers` args to `createLocalEngine` (810–822), and `ollama`
from the object returned at 1333.

**15.3 — `desktop/lib/settings.js`.** Remove the `isLocalEndpoint` /
`remoteRefusal` / `isDirectDialRow` import (25) and the direct-dial guard at
180–183 (incl. the comment at 166–170, which documents custom-endpoint policy).
`endpoints.js` then has zero non-test importers → delete the module. Also drop
`test/preset-fill.test.mjs:183`'s `require` of it.

### Decision D1 — what drives the in-process tool loop? (RESOLVED)

**Take (a): re-point the harnesses at `aegis`. (c) is NOT authorized. (b) is
the fallback only if a re-pointed leg cannot be made to go red on a negative
control.**

Verification (read, not asserted): the approval gate is **class-independent**.
`gatedExecuteTool` (`desktop/lib/local/engine.js:608`) is called from the shared
tool loop at `:1572`, and that loop is entered whenever
`toolsEnabled = cls !== 'byok' && tools !== false` (`:1106`, `:1554`) — true for
`aegis`, false for `byok`. `toolSchemas` is built for `wire = 'openai'` and sent
through the pooled path (`dispatch()` → `aegis.chatCompletion`, whose body
comment records "The pool forwards `tools` to the provider and returns
tool_calls"). Crucially `extractToolCalls` (`:274`) already normalises the
pool's shape by name: "the Aegis pool relays the upstream OpenAI shape
verbatim" (`choices[0].message.tool_calls`). So an `aegis` turn against a stub
that returns OpenAI-shape `tool_calls` drives the *same* in-process gate the
custom classes drive today.

Therefore the harness comment at `desktop/test/marketing-shots-main.js:35-38`
("The cloud class relays tool_calls but has no approval gate in this build") is
**stale/incorrect** — Phase 18 fixes that comment; it is not evidence for (b).

The harness work itself lands in Phase 18 (it needs the engine to be stable
first). Do not touch the harnesses in this phase.

### Exit criteria (this phase)

- `desktop/lib/local/engine.js`, `main.js` and `settings.js` are runnable and
  free of dangling references: `grep -n "isLocalEndpoint\|remoteRefusal\|CUSTOM_CLASSES\|ollama\.\|providers\." desktop/lib/local/engine.js desktop/main.js desktop/lib/settings.js`
  returns only *byok-provider* occurrences (if any), never a call into a
  removed module. `node --check` each file.
- `CLASSES` lists exactly `aegis` and `byok`.
- `desktop/lib/local/endpoints.js` is deleted, with no non-test `require` left.
- `desktop`: `npm run check` clean. `npm run test:engine` may remain red **only**
  with the same pre-existing `local-engine.test.mjs:1265` assertion recorded in
  15.0; any *new* failure is yours to fix before you stop.
- `git status` clean; nothing pushed to `origin/main`.

### Not in scope (later phases)

Renderer/`tools.js`/packaging (Phase 16), the CLI vendor tree and the test
sweep (Phase 17), the harness re-point + negative controls and the docs
(Phase 18). Anything under `/home/neo/aegiscodex-dev` (the live engine — off
limits absent an explicit instruction naming it), and the queued `aegis1` rex
bump.

---

## Phase 16 ⬜ — desktop parity II/IV: renderer, tools, packaging

**Slice 2 of 4.** Requires Phase 15 landed. Same execution contract.

**16.1 — Renderer.** `desktop/renderer/app.js`: delete `CUSTOM_CLASSES` (167),
the custom placeholders (178–179), the custom endpoint wire specs (199–211),
the ollama hint (2698), the two provider entries at 2862–2863, and the stale
comment at 3363. `desktop/renderer/budget.js:95`: delete the
`REQUIRES_STATED_BUDGET` mirror. **Verify 2862–2863 first** — if those entries
feed the *byok provider* list rather than the class list, they stay. Check
`desktop/renderer/usage.js:134` too: a comment about a settled charge naming
"a direct provider, ollama, a custom endpoint" needs rewording, not deleting.

**16.2 — `desktop/lib/local/tools.js`.** `anthropicTools` /
`anthropicToOpenaiTools` and the `wire === 'anthropic'` branch (222–269) look
dead or nearly so, since the surviving classes are OpenAI-wire (`aegis`) or
stateless (`byok`). **Confirm before deleting** — if anything in the aegis path
still selects the anthropic wire, this step is dropped and the reason recorded.
`tools.js`'s `T.toolsFor(wire, …)` must keep working for `wire === 'openai'`.

**16.3 — `desktop/lib/local/ollama.js` + `providers.js` deletion.** Once 15.1,
15.2, 16.1 and 16.2 have removed every importer, delete both modules and
`desktop/lib/local/endpoints.js`'s last stragglers. Prove it by grep before
deleting, not by inspection.

**16.4 — `desktop/package.json`.** Remove `providers.js`, `ollama.js` and
`endpoints.js` from the `check` script; they no longer exist.

**Exit criteria.** No reachable path constructs, dispatches to, or names a
removed class — proven by `grep -rn "ollama\|openai-compat\|CUSTOM_CLASSES" desktop/`
returning nothing outside byok-provider ids and unrelated words. The renderer's
class picker offers exactly two classes (mirror the CLI check that confirmed
`HOST_CLASSES`). `npm run check` clean; every `npm run test:*` green except the
recorded pre-existing `test:engine` assertion. `test/desktop-shell.mjs` green.

---

## Phase 17 ⬜ — desktop parity III/IV: CLI vendor tree + the test sweep

**Slice 3 of 4.** Requires Phase 16 landed.

**17.1 — CLI vendor tree.** `cli/src/engine.js` still passes `ollama` and
`providers` stubs into the vendored engine (85–97); remove them. Regenerate
`cli/vendor/` with `cli/scripts/predist.mjs` — `test/cli-sync.test.mjs` asserts
the tree matches source, and `providers.js`/`endpoints.js`/`ollama.js` drop out
of the staging list. `.github/workflows/ci.yml:61` asserts
`cli/vendor/desktop/lib/local/engine.js` exists; that must keep passing.

**17.2 — Test sweep.** Heaviest references first: `test/local-engine.test.mjs`
(77), `test/aegis-key.test.mjs` (26), `test/preset-fill.test.mjs` (19),
`test/budget.test.mjs` (19), `test/model-dispatch.mjs` (10),
`test/local-tools.test.mjs` (10), then the 1–3 reference files
(`cli-approval`, `autonomous-mode`, `sync-sessions`, `session-rounds`,
`aegis-reasoning`, `round-cap`, `cloud-usage`, `budget-authority`). Delete
`test/endpoints.test.mjs` and `test/local-providers.test.mjs` outright — they
test modules this work deletes. Where a case exists *only* to cover a removed
class, delete it; where it covers shared behaviour **through** a removed class
as a convenient driver, re-point it at `aegis` (or a fixture) rather than
deleting the assertion, and negative-control the re-point.

**17.3 — The `test:engine` failure.** `test/local-engine.test.mjs:1265`'s
"unconfigured provider is refused" case must end this phase **either** green
because its subject moved to a surviving class, **or** deliberately deleted with
one line in the report saying which assertion replaced it — never silently
dropped. This is the pre-existing baseline red recorded in 15.0.

**Exit criteria.** `find test desktop/test -name '*.test.mjs'` all green;
`test/desktop-shell.mjs` and `test/smoke.mjs` green; `cli`'s `npm test` and
`npm run check` green; `cli-sync` green. `git status` clean.

---

## Phase 18 ⬜ — desktop parity IV/IV: harness re-point, then docs

**Slice 4 of 4.** Requires Phase 17 landed.

**18.1 — Re-point the harnesses at `aegis` (D1 option (a)).**
`desktop/test/electron-smoke-main.js` and `desktop/test/marketing-shots-main.js`
currently drive their turns with `class: 'openai-compat'` (smoke 508/592,
shots 99/341/352) pointed at a loopback stub. Re-point those driven turns to
`class: 'aegis'` with `AEGIS_API_BASE` on the loopback stub (already required by
the boot gate) and have the stub answer with OpenAI-shape `tool_calls`, which
`extractToolCalls` normalises.

- **Negative-control every re-pointed leg**: break the thing the leg claims to
  test (e.g. make the gate auto-approve) and confirm the leg goes **red** before
  you trust its green. A re-pointed leg that still passes when the gate is
  removed is the silent coverage loss D1 warns about — report it as a FAIL, and
  fall back to D1 option **(b)** (keep `providers.js`/`endpoints.js` as
  test-only fixtures) rather than shipping a leg that tests nothing.
- **`electron-smoke-main.js:508/592`'s blocked-class leg** asserts
  `endpoints.js` policy as behaviour. That feature is being deleted, so the
  assertion has no subject left: **retire that leg explicitly** and say so in
  the report. Do not quietly re-point it at `aegis` to keep a green tick.

**18.2 — Docs.** `desktop/README.md`, root `README.md`, `cli/README.md`, and
`docs/byok-and-cloud-api.md`, `docs/product-plan.md`,
`docs/launch-copy-x-youtube.md`, `docs/marketing-plan-social.md`,
`docs/reddit-drafts.md`. The CLI's README was already rewritten in `c0598de`;
use that wording. **Also fix the stale comment at
`desktop/test/marketing-shots-main.js:35-38`** (the "cloud class has no
approval gate" claim that D1 disproved). Grep the docs for the removed class
names and rewrite every hit that describes shipping behaviour — the marketing
copy's class list is user-visible.

**Exit criteria.** `npm run shots` still produces its PNGs (or the report states
plainly which states are no longer reachable and why). `find test desktop/test
-name '*.test.mjs'` all green; `npm run check` clean repo-wide; `git status`
clean; nothing pushed to `origin/main` without the user's say-so. Mark the
`## Phase 15` heading ✅ with a note that 15–18 shipped as one refactor, and
check off all four Status lines.
