#!/usr/bin/env node
/**
 * Unit tests for desktop/renderer/stream-policy.js — the two pure decisions
 * behind a live streaming turn (transcript auto-scroll, and telling a
 * deliberate stop apart from a real failure). Follows the ../test/max-tokens
 * convention: plain Node, no DOM and no window.aegis.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  nearBottom,
  shouldFollow,
  isCancellation,
  stopAppliesTo,
  salvageTurn,
  toolMark,
  STICK_SLOP_PX,
} = require('../desktop/renderer/stream-policy.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** Scroll metrics helper: content of `scrollHeight`, view of `clientHeight`. */
const at = (scrollHeight, scrollTop, clientHeight) => ({ scrollHeight, scrollTop, clientHeight });

// ------------------------------------------------------------------- nearBottom
assert(STICK_SLOP_PX === 48, `expected stick slop 48, got ${STICK_SLOP_PX}`);

// Exactly pinned to the tail.
assert(nearBottom(at(1000, 600, 400)) === true, 'exact bottom counts as near bottom');

// Within the slop budget: a scrollbar appearing mid-stream leaves the view a
// few pixels short, and the follow must survive that.
assert(nearBottom(at(1000, 570, 400)) === true, 'within slop still counts as following');

// Just past the budget is a deliberate scroll away, not sub-pixel drift.
assert(nearBottom(at(1000, 500, 400)) === false, 'past slop is not near bottom');

// Scrolled to the very top of a long transcript.
assert(nearBottom(at(10000, 0, 400)) === false, 'top of a long transcript is not near bottom');

// A transcript shorter than its viewport is trivially at the bottom.
assert(nearBottom(at(100, 0, 400)) === true, 'content shorter than viewport is near bottom');

// Malformed/absent metrics must not throw — scrollMetrics() can return null
// before the transcript exists, and init() wires the listener unconditionally.
assert(nearBottom(null) === true, 'null metrics degrades to near bottom without throwing');
assert(nearBottom(undefined) === true, 'undefined metrics degrades without throwing');
assert(nearBottom({}) === true, 'empty metrics degrades without throwing');
assert(nearBottom({ scrollHeight: 'x', scrollTop: null, clientHeight: NaN }) === true,
  'non-numeric metrics degrade without throwing');

// An explicit slop overrides the default.
assert(nearBottom(at(1000, 400, 400), 250) === true, 'explicit slop is honored');
assert(nearBottom(at(1000, 400, 400), 0) === false, 'zero slop requires an exact pin');

// ----------------------------------------------------------------- shouldFollow
// force wins over everything: sending, and an approval card blocking the turn.
assert(shouldFollow(at(10000, 0, 400), { force: true }) === true, 'force overrides the reader scroll');
assert(shouldFollow(null, { force: true }) === true, 'force works without metrics');
assert(
  shouldFollow(at(10000, 0, 400), { force: true, userScrolledUp: true }) === true,
  'force overrides an explicit scroll-away'
);

// The reported bug: the reader scrolls up mid-stream and the view must stay put.
assert(
  shouldFollow(at(10000, 0, 400), { userScrolledUp: true }) === false,
  'a scrolled-up reader is never dragged back to the tail'
);

// The flag is checked before the measurement on purpose: a reflow can briefly
// measure as "at the bottom" while the reader is nowhere near it.
assert(
  shouldFollow(at(1000, 600, 400), { userScrolledUp: true }) === false,
  'userScrolledUp vetoes even metrics that measure as near-bottom'
);

// Nothing scrolled away, still at the tail -> follow.
assert(shouldFollow(at(1000, 600, 400), {}) === true, 'at the tail with no veto -> follow');
assert(shouldFollow(at(1000, 600, 400)) === true, 'omitted opts -> follow');

// Scrolled away by position alone -> do not fight the reader.
assert(shouldFollow(at(10000, 0, 400), {}) === false, 'scrolled away by position -> no follow');

// ------------------------------------------------------------- isCancellation
// Primary signal: the flag this renderer sets before it calls cancel.
assert(
  isCancellation(new Error('Error invoking remote method'), { userStopped: true }) === true,
  'userStopped is the primary signal, whatever the message says'
);
assert(
  isCancellation({ message: 'anything' }, { userStopped: true }) === true,
  'userStopped wins over an unrecognised message'
);
assert(isCancellation(null, { userStopped: true }) === true, 'userStopped wins over a null error');

// No flag, no error -> not a cancellation.
assert(isCancellation(null, {}) === false, 'null error with no flag is not a cancellation');
assert(isCancellation(undefined) === false, 'undefined error is not a cancellation');

// error.name survives within the renderer even though IPC drops it.
{
  const err = new Error('whatever');
  err.name = 'AbortError';
  assert(isCancellation(err, {}) === true, 'AbortError name is recognised');
}
{
  const err = new Error('whatever');
  err.code = 'ABORT_ERR';
  assert(isCancellation(err, {}) === true, 'ABORT_ERR code is recognised');
}

// The backstop: real abort phrasings, as each layer spells them.
assert(isCancellation(new Error('This operation was aborted'), {}) === true,
  'undici "This operation was aborted" is recognised');
assert(isCancellation(new Error('The user aborted a request.'), {}) === true,
  'Chromium "The user aborted a request." is recognised');
assert(isCancellation(new Error('signal is aborted without reason'), {}) === true,
  'AbortSignal reason is recognised');
assert(isCancellation('The user aborted a request.', {}) === true,
  'a bare string error is handled');

// The caveat this list exists for: a dropped socket contains the word "abort"
// but is a genuine failure. Relabelling it as a stop would hide the error and
// strand the user with a silently truncated answer.
assert(isCancellation(new Error('ECONNABORTED: connection aborted by peer'), {}) === false,
  'ECONNABORTED is a transport failure, not a user stop');
assert(isCancellation(new Error('socket hang up'), {}) === false,
  'socket hang up is not a user stop');
assert(isCancellation(new Error('aborted'), {}) === false,
  'a bare "aborted" is too weak to attribute to the user');
assert(isCancellation(new Error('request timed out'), {}) === false, 'a timeout is a failure');
assert(isCancellation(new Error('402 insufficient aegis-key balance'), {}) === false,
  'a billing refusal is a failure, not a stop');
assert(isCancellation(new Error(''), {}) === false, 'an empty message is not a stop');
assert(isCancellation(42, {}) === false, 'a non-string, non-Error rejection is not a stop');
assert(isCancellation({}, {}) === false, 'an object without message/name is not a stop');

// ------------------------------------------------------------------ stopAppliesTo
// One comparison answers two questions that used to be two flags: "is this the
// turn I am already stopping?" (do not re-enter) and "is this turn even the one
// running?" (never reach a successor).

// Idle: nothing to stop.
assert(stopAppliesTo(null, null) === false, 'a stop with no running turn does nothing');

// The ordinary case: a live turn nobody has stopped yet.
assert(stopAppliesTo(7, null) === true, 'a stop reaches the turn that is running');

// A second press while the first abort is still unwinding — same turn, already
// asked. Re-entering would re-cancel the same transport.
assert(stopAppliesTo(7, 7) === false, 'a second press on the turn already stopping is ignored');

// The stale request: turn 7 was stopped, turn 8 is running. The successor is
// live and has not been stopped, so a press *now* legitimately reaches it — the
// successor is protected by the two writers keeping the pair consistent, not by
// this comparison refusing. `send()` claims a new turn with
// `stoppedTurn = null`, and app.js only ever writes `stoppedTurn = runningTurn`,
// so the live invariant is:
//     stoppedTurn === null || stoppedTurn === runningTurn
// Under it, `runningTurn !== stoppedTurn` means exactly "not already stopping",
// which is the idempotency rule. Assert the invariant holds for every pair
// app.js can actually produce, and the successor case explicitly.
assert(stopAppliesTo(8, 7) === true, 'a live successor turn is stoppable (it was never asked to stop)');
assert(stopAppliesTo(8, null) === true, 'which is the same state as a fresh turn');
for (const running of [null, 0, 1, 7]) {
  for (const stopped of [null, running]) {
    const ok = running !== null && stopped !== running;
    assert(
      stopAppliesTo(running, stopped) === ok,
      `reachable pair (running=${running}, stopped=${stopped})`
    );
  }
}
// A stop cannot be attributed to a turn that is not the running one: that is
// the catch's `stoppedTurn === myTurn`, and the flag it replaced is what let an
// old stop relabel a later, unrelated failure.
assert(
  stopAppliesTo(7, 7) === false && stopAppliesTo(7, null) === true,
  'a stop is spent on the turn it was asked of, and only that turn'
);

// Token 0 is falsy but a real turn: `if (runningTurn)` would call this idle.
assert(stopAppliesTo(0, null) === true, 'turn token 0 is a running turn, not an absence');

// ------------------------------------------------------------------ salvageTurn
// Three outcomes, kept distinct so the label cannot drift from the salvage.

{
  const answer = salvageTurn({ streamedText: 'the answer', reasoningText: 'thinking' });
  assert(answer.kind === 'answer', 'streamed text wins');
  assert(answer.text === 'the answer', 'and it is what gets shown');
  assert(answer.reasoning === 'thinking', 'with the deliberation kept alongside');
}

{
  // Cut off mid-deliberation: real content the user asked to keep, and not a
  // failure — but showing it as the answer would be a lie about what arrived.
  const only = salvageTurn({ streamedText: '', reasoningText: 'thinking' });
  assert(only.kind === 'reasoning-only', 'deliberation alone is its own outcome');
  assert(only.text === 'thinking', 'and its text is what survives');
  assert(only.reasoning === '', 'moving it to the answer must not duplicate it');
}

{
  const empty = salvageTurn({});
  assert(empty.kind === 'empty', 'nothing streamed is its own outcome');
  assert(empty.text.length > 0, 'an empty salvage still yields a placeholder, never a blank bubble');
  assert(empty.reasoning === '', 'and no deliberation');
}

// Typed garbage must not reach the transcript as a literal `undefined`.
{
  const junk = salvageTurn({ streamedText: 42, reasoningText: { a: 1 } });
  assert(junk.kind === 'empty', 'non-string streamed content is not text');
  assert(typeof junk.text === 'string', 'and the placeholder is a string');
  assert(salvageTurn(null).kind === 'empty', 'a missing input is empty, not a crash');
  // Whitespace-only text is still text the provider sent, so it is preserved
  // rather than reformatted — trimming here would be a silent edit.
  assert(salvageTurn({ streamedText: ' ' }).kind === 'answer', 'whitespace counts as streamed');
}

// -------------------------------------------------------------------- toolMark
// A tool call whose result never arrived — the mid-abort case — is neither a
// success nor a failure, and the old `ok === false ? ✗ : ✓` drew it as ✓.
assert(toolMark({ ok: true }) === '✓', 'a completed call is a tick');
assert(toolMark({ ok: false }) === '✗', 'a failed call is a cross');
assert(toolMark({}) === '⊘', 'a call with no result at all is marked interrupted, not succeeded');
assert(toolMark({ ok: null }) === '⊘', 'a null result is not a success');
assert(toolMark({ ok: 'false' }) === '⊘', 'only a literal false is a failure — no string coercion');
assert(toolMark(null) === '⊘', 'a missing tool record is interrupted, not a crash');

console.log('stream-policy tests passed');
