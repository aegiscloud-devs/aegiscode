'use strict';

/**
 * Pure decisions behind a live streaming turn: whether the transcript is
 * allowed to follow the stream, and whether a rejection means the user asked
 * to stop. Kept out of app.js — like budget.js — so both rules are
 * unit-testable from plain Node without a DOM or window.aegis. app.js only
 * calls into this.
 *
 * Both rules exist because a running turn used to own the transcript: it
 * re-pinned the view on every chunk (so earlier turns could not be read) and
 * it reported a deliberate stop as a failure (so interrupting lost the answer
 * already on screen).
 */

/** Distance from the bottom still counted as "following the stream". */
const STICK_SLOP_PX = 48;

/**
 * Is the view at (or effectively at) the tail? A few pixels of slack absorbs
 * sub-pixel layout and a scrollbar that appears mid-stream; without it the
 * follow silently stops a fraction short.
 */
function nearBottom(metrics, slop) {
  const m = metrics || {};
  const budget = Number.isFinite(slop) ? slop : STICK_SLOP_PX;
  const scrollHeight = Number(m.scrollHeight) || 0;
  const scrollTop = Number(m.scrollTop) || 0;
  const clientHeight = Number(m.clientHeight) || 0;
  return scrollHeight - scrollTop - clientHeight <= budget;
}

/**
 * May the transcript be scrolled to the bottom right now? `force` is for the
 * cases where the view genuinely must move (the user just sent, or a card is
 * blocking the turn); otherwise the reader's explicit scroll-away wins.
 *
 * The flag is checked before the measurement on purpose: a mid-stream reflow
 * can momentarily measure as "at the bottom" while the reader is nowhere near
 * it, which is exactly the case where re-pinning feels like a hijack.
 */
function shouldFollow(metrics, opts) {
  const o = opts || {};
  if (o.force) return true;
  if (o.userScrolledUp) return false;
  return nearBottom(metrics, o.slop);
}

/**
 * Signatures of a real abort, as each layer spells it: Chromium's fetch
 * ("The user aborted a request."), undici/Node ("This operation was aborted"),
 * and an AbortSignal's own reason ("signal is aborted without reason").
 *
 * Deliberately NOT a bare /abort/i. A dropped socket surfaces as
 * "ECONNABORTED: connection aborted by peer" or "socket hang up", which
 * contains the same word but is a genuine transport failure — matching it
 * would relabel a real error as a deliberate stop and strand the user with a
 * silently truncated answer.
 */
const ABORT_SIGNATURES = [
  /AbortError/,
  /\boperation was aborted\b/i,
  /\buser aborted\b/i,
  /\brequest\s+aborted\b/i,
  /\bsignal is aborted\b/i,
  /\baborted without reason\b/i,
];

/**
 * Did the user ask for this turn to stop? The abort travels back over IPC,
 * which rebuilds the Error object and drops `name`/`code` — the renderer only
 * sees a wrapped message. So the caller's own flag is the primary signal, and
 * the signatures above are a backstop for an abort this renderer did not
 * initiate.
 */
function isCancellation(err, opts) {
  const o = opts || {};
  if (o.userStopped) return true;
  if (!err) return false;
  if (err.name === 'AbortError' || err.code === 'ABORT_ERR') return true;
  const msg = typeof err === 'string' ? err : err.message;
  if (typeof msg !== 'string') return false;
  return ABORT_SIGNATURES.some((re) => re.test(msg));
}

/**
 * Should a stop request reach the turn running right now?
 *
 * `runningTurn` is the token of the turn in progress (null when idle) and
 * `stoppedTurn` is the token already asked to stop. The abort is not
 * instantaneous — the transport has to unwind before `send()`'s catch runs — so
 * a second press lands on a turn that is still nominally running. That second
 * press is the *same* intent and must not re-enter.
 *
 * The two writers keep the pair consistent: app.js only ever assigns
 * `stoppedTurn = runningTurn`, and claiming a new turn sets `stoppedTurn = null`
 * alongside `runningTurn = myTurn`. So `stoppedTurn` is never some *other*
 * turn's number, and `runningTurn !== stoppedTurn` means exactly "not already
 * stopping". What keeps a finished turn's stop off its successor is that
 * invariant plus the catch's `stoppedTurn === myTurn` — not a refusal here. A
 * press on a live successor is legitimate and does reach it.
 */
function stopAppliesTo(runningTurn, stoppedTurn) {
  if (runningTurn == null) return false;
  return runningTurn !== stoppedTurn;
}

/**
 * What a cancelled turn leaves on screen, and what it honestly is.
 *
 * `streamedText || reasoningText` collapsed two different outcomes into one
 * string: a turn cut off after real answer text, and a turn cut off with
 * deliberation but no answer. The second is not a failure and the user should
 * keep it, but folding it in as if it were the answer loses the distinction —
 * so the case is named here and the caller labels it. With neither, the
 * placeholder is still returned rather than an empty bubble.
 */
function salvageTurn(input) {
  const i = input || {};
  const streamed = typeof i.streamedText === 'string' ? i.streamedText : '';
  const reasoning = typeof i.reasoningText === 'string' ? i.reasoningText : '';
  if (streamed) return { text: streamed, reasoning: reasoning, kind: 'answer' };
  if (reasoning) return { text: reasoning, reasoning: '', kind: 'reasoning-only' };
  return { text: '(stopped before any output)', reasoning: '', kind: 'empty' };
}

/**
 * The status glyph for one tool-activity line.
 *
 * Only an explicit `true` is a ✓. A call with no `ok` at all is a call whose
 * result never arrived — the tool-call-mid-abort case — and drawing it as ✓
 * claimed success for work the turn never finished. It gets its own mark
 * instead of ✗, because interrupted is not the same as failed.
 */
function toolMark(tool) {
  const t = tool || {};
  if (t.ok === true) return '✓';
  if (t.ok === false) return '✗';
  return '⊘';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    nearBottom,
    shouldFollow,
    isCancellation,
    stopAppliesTo,
    salvageTurn,
    toolMark,
    STICK_SLOP_PX,
  };
}
