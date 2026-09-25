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
  replayableContent,
  isPlaceholderContent,
  replayHistory,
  liveMeterDue,
  toolMark,
  STICK_SLOP_PX,
  LIVE_METER_MIN_GROWTH,
  LIVE_METER_GROWTH_FRACTION,
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

// --------------------------------------------------------- replayableContent
//
// What a turn contributes to the REPLAYED history, as opposed to what it shows
// on screen. These were the same string and that was a loop: a cancelled turn
// whose only output was deliberation had that deliberation promoted to `text`
// for the bubble (correct) and then pushed into threadMessages and written
// through sync.append (not correct). The next turn handed the model its own
// unfinished sentence as its prior reply, so it finished the same sentence —
// the same words every turn, and openSession rebuilt the thread from the
// stored rows, so it survived a reopen.
{
  const only = salvageTurn({ streamedText: '', reasoningText: 'thinking out loud' });
  assert(only.kind === 'reasoning-only', 'the deliberation-only turn is classified');
  assert(replayableContent(only.kind, only.text) === '(stopped: reasoning only)',
    'a deliberation-only turn replays as an annotation, never as the prose');
  assert(replayableContent(only.kind, only.text) !== only.text,
    'and specifically not as the string the model would try to continue');

  const empty = salvageTurn({});
  assert(replayableContent(empty.kind, empty.text) === '(stopped before any output)',
    'a turn with nothing at all replays as its own annotation');

  // A real partial answer is real prose and is replayed verbatim — collapsing
  // this to an annotation too would throw away the interrupted answer the user
  // pressed Escape to keep.
  const partial = salvageTurn({ streamedText: 'The first half of the answer' });
  assert(partial.kind === 'answer', 'streamed text is an answer');
  assert(replayableContent(partial.kind, partial.text) === partial.text,
    'an interrupted answer is replayed verbatim, not annotated');

  assert(replayableContent(undefined, 'keep me') === 'keep me',
    'an unknown kind falls through to the text rather than inventing a label');
}

// ------------------------------------------------------ isPlaceholderContent
// The recognition half: which stored rows are annotations rather than prose.
// openSession filters with this, so it is what stops a replayed loop from
// coming back with the window.
{
  assert(isPlaceholderContent('(stopped: reasoning only)'), 'a reasoning-only annotation is recognised');
  assert(isPlaceholderContent('(stopped before any output)'), 'an empty-stop annotation is recognised');
  assert(isPlaceholderContent('(empty response)'), 'the success-path empty label is recognised');
  assert(isPlaceholderContent('(no response)'), 'the legacy empty label is recognised');
  assert(isPlaceholderContent('  (empty response)  '), 'and whitespace does not defeat it');

  assert(!isPlaceholderContent('The first half of the answer'), 'real prose is not a placeholder');
  assert(!isPlaceholderContent('reasoning only'), 'the parenthesised form is required — bare words are prose');
  assert(!isPlaceholderContent(''), 'an empty string is not a placeholder');
  assert(!isPlaceholderContent(null), 'null is not a placeholder');
  assert(!isPlaceholderContent(undefined), 'undefined is not a placeholder');
  assert(!isPlaceholderContent(42), 'a non-string is not a placeholder');

  // Round trip: everything replayableContent writes must be recognised.
  for (const kind of ['reasoning-only', 'empty']) {
    assert(isPlaceholderContent(replayableContent(kind, 'x')),
      `${kind}: the annotation it writes is one the reopen filter strips`);
  }
}

// --------------------------------------------------------------- replayHistory
//
// The two halves have to hold at once, which is what this pins: nothing that is
// not the model's own prose reaches the wire, AND the roles still alternate.
// Either alone is a bug — keeping the annotations replays a label as if the
// model said it; dropping them leaves two `user` rows adjacent, which strict
// providers reject outright.
{
  const convo = [
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: '(stopped: reasoning only)' },
    { role: 'user', content: 'second question' },
    { role: 'assistant', content: 'a real answer' },
  ];
  const out = replayHistory(convo);
  assert(out.length === 2, `the annotation leaves the replay (got ${out.length} rows)`);
  assert(out.every((m, i) => i === 0 || m.role !== out[i - 1].role),
    'and the roles still alternate — this is the check the drop alone would fail');
  assert(out[0].role === 'user' && out[1].role === 'assistant',
    'the thread still opens on the user and answers');
  assert(out[1].content === 'a real answer', 'real prose is replayed verbatim');
  assert(out[0].content.includes('first question') && out[0].content.includes('second question'),
    'no user text is lost: the two questions are folded into one turn, not discarded');
  assert(out[0].content !== 'second question',
    'folding joins, it does not replace');

  // The empty success path, which is the other way a turn contributes nothing.
  const empties = replayHistory([
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: '(empty response)' },
    { role: 'user', content: 'q2' },
  ]);
  assert(empties.length === 1 && empties[0].role === 'user',
    'an empty response is neither replayed as a reply nor left as a hole');
  assert(empties[0].content.includes('q1') && empties[0].content.includes('q2'),
    'both prompts survive the fold');
  assert(!empties.some((m) => m.content.includes('(empty response)')),
    'and the label the model never said is nowhere on the wire');

  // A stopped turn that DID produce answer text is real prose: it stays, and it
  // keeps the thread alternating by itself.
  const kept = replayHistory([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'the interrupted half of the answer' },
    { role: 'user', content: 'carry on' },
  ]);
  assert(kept.length === 3, 'an interrupted answer is not folded away');
  assert(kept[1].content === 'the interrupted half of the answer',
    'the half the user pressed Escape to keep is still replayed');

  // Empty and non-prose rows are not messages.
  assert(replayHistory([]).length === 0, 'an empty thread is an empty replay');
  assert(replayHistory(null).length === 0, 'a missing thread is an empty replay');
  assert(replayHistory([null, undefined, {}]).length === 0,
    'a row with no role and no content is not a turn');
  assert(replayHistory([{ role: 'user', content: '   ' }]).length === 0,
    'an empty-content row is dropped rather than sent as an empty block');
  assert(replayHistory([{ role: 'system', content: 'you are aegis' }]).length === 0,
    'a system row is not promoted into a user turn');

  // A thread that begins with the model talking to itself is not a conversation
  // the provider will accept, and there is no user request for it to answer.
  const orphan = replayHistory([
    { role: 'assistant', content: 'a reply to nothing' },
    { role: 'user', content: 'q' },
  ]);
  assert(orphan.length === 1 && orphan[0].role === 'user',
    'a leading assistant row is dropped, so the replay opens on the user');

  // Not aliased: the caller keeps mutating threadMessages after the snapshot,
  // and mutating it must not rewrite the history already handed to the model.
  const live = [{ role: 'user', content: 'q' }, { role: 'user', content: 'q2' }];
  const snapshot = replayHistory(live);
  live[0].content = 'mutated after the snapshot';
  assert(snapshot[0].content === 'q\n\nq2',
    'the snapshot is a copy, not a view of the live thread');

  // Round trip with the writer: everything the stop path writes is something the
  // replay strips.
  for (const kind of ['reasoning-only', 'empty']) {
    const r = replayHistory([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: replayableContent(kind, 'x') },
    ]);
    assert(r.length === 1 && r[0].role === 'user',
      `${kind}: what the stop path stores is stripped on replay`);
  }
}

// ----------------------------------------------------------------- liveMeterDue
//
// The claim being pinned is cheapness with a bounded lag, not a particular
// threshold: the meter may skip frames, but it must never skip a frame while
// sitting further below the truth than its own step allows.
assert(LIVE_METER_MIN_GROWTH === 256, `expected a 256-char floor, got ${LIVE_METER_MIN_GROWTH}`);

assert(liveMeterDue(0, 0) === false, 'an empty stream has nothing to measure');
assert(liveMeterDue(0, 255) === false, 'below the floor the meter waits, so a tiny reply does not thrash');
assert(liveMeterDue(0, 256) === true, 'at the floor it is due');
assert(liveMeterDue(1000, 500) === false, 'a stream that did not grow is not due — and a shrink cannot fire it');
assert(liveMeterDue(0, undefined) === false, 'no stream is not a recompute');
assert(liveMeterDue(undefined, 500) === true, 'nothing measured yet counts as due once there is enough to measure');

// Proportional step: at 100k chars the step is 1/32 of the stream (3125), so the
// floor is no longer what decides.
assert(liveMeterDue(100000 - 3124, 100000) === false, 'just under 1/32 of a long stream is not yet due');
assert(liveMeterDue(100000 - 3125, 100000) === true, '1/32 of a long stream is due — the floor is the only fixed part');

// The whole point: a turn that streams one character at a time must not
// re-estimate the accumulated text on every frame. This is the shape of the
// real painter — 100k frames, 100k chars — and the recompute count has to come
// out far below the frame count or the guard is decorative.
{
  const total = 100000;
  let measured = 0;
  let recomputes = 0;
  let maxLag = 0;
  for (let streamChars = 1; streamChars <= total; streamChars++) {
    if (!liveMeterDue(measured, streamChars)) {
      maxLag = Math.max(maxLag, streamChars - measured);
      continue;
    }
    measured = streamChars;
    recomputes++;
  }
  assert(
    recomputes < 400,
    `100k chars cost ${recomputes} estimates — the guard must bring this far under the frame count`
  );
  assert(
    recomputes > 10,
    `only ${recomputes} estimates in 100k chars means the meter stopped moving, which is the bug this preview exists to fix`
  );
  // And the lag it bought that with is bounded by its own step: at 4 chars per
  // token the figure never trails the truth by more than ~3%.
  assert(
    maxLag <= Math.ceil(total / LIVE_METER_GROWTH_FRACTION),
    `lag ${maxLag} chars exceeds the 1/${LIVE_METER_GROWTH_FRACTION} step the rule promises`
  );
  assert(maxLag <= total / 32, `lag ${maxLag} is more than 3% of the stream — visible on the counter`);
}

// A short reply is a different regime on purpose: still under the floor, so it
// keeps updating as it types rather than waiting for a proportion it will never
// reach.
assert(liveMeterDue(0, 300) && liveMeterDue(300, 600) && liveMeterDue(600, 900),
  'a sub-2k reply updates on the fixed floor, so the meter still moves while it is short');

// ------------------------------------------------- the quick-launcher push path
// `handleQuickLauncherPush` (app.js) pushes a user/assistant pair straight into
// `threadMessages` with only a truthiness guard (`if (!prompt || !response)
// return`) and no placeholder or folding pass. That path is a second writer to
// the same array the cancel-loop fix was written for, so these assertions pin
// that whatever it pushes still cannot reach the model as a reply.
const afterQuickLauncher = (response) => {
  const thread = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'ql prompt' },
    { role: 'assistant', content: response },
  ];
  return replayHistory(thread);
};

// A whitespace-only response passes the caller's `!response` test, so it does
// arrive here. It must not arrive at the model.
assert(
  afterQuickLauncher('   ').length === 3 &&
    afterQuickLauncher('   ')[2].content === 'ql prompt',
  'a whitespace-only quick-launcher response must not be replayed as the model\'s prior reply'
);
assert(
  !afterQuickLauncher('(empty response)').some((m) => m.content === '(empty response)'),
  'a placeholder annotation pushed by the quick launcher must not be replayed as prose'
);
assert(
  afterQuickLauncher('a real answer').length === 4,
  'a real quick-launcher answer is still replayed — the guard must not swallow genuine turns'
);

// The push does not fold, so a failed turn can leave two `user` rows before it.
// Strict providers reject non-alternating threads, so the fold has to happen
// here rather than at the push site.
const failedTurnThenPush = replayHistory([
  { role: 'user', content: 'first' },
  { role: 'user', content: 'ql prompt' },
  { role: 'assistant', content: 'an answer' },
]);
assert(
  failedTurnThenPush.map((m) => m.role).join(',') === 'user,assistant',
  `a push after a turn that left no assistant row must still alternate, got ${failedTurnThenPush.map((m) => m.role).join(',')}`
);

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
