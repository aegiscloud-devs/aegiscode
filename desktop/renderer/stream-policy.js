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
 * What a salvaged turn may contribute to the history that gets replayed —
 * as opposed to what it shows on screen.
 *
 * These were the same string, and on a cancelled turn that was a loop.
 * `salvageTurn` promotes the deliberation to `text` so the bubble is not
 * empty, which is right for the screen; but that same string was pushed into
 * `threadMessages` and written through `sync.append`, so the next turn fed the
 * model its own truncated chain-of-thought back as its prior reply. A model
 * handed an unfinished sentence finishes it — the same words every time,
 * because the same incomplete prefix went back every time. It survived a
 * reopen, and `openSession` rebuilds `threadMessages` from the stored rows, so
 * the loop outlived the session that started it.
 *
 * So the screen keeps the deliberation (labelled `reasoning only`) and the
 * history gets an annotation instead. The annotation is deliberate rather than
 * a blank: a stopped turn is a real exchange and the row still carries the
 * ledger fields the rolling meter folds — only the prose is replaced, so
 * billing and the token total are unchanged.
 */
function replayableContent(kind, text) {
  if (kind === 'reasoning-only') return '(stopped: reasoning only)';
  if (kind === 'empty') return '(stopped before any output)';
  return text;
}

/**
 * The history a turn is actually replayed with: the same rows, minus anything
 * that is not the model's own prose, with runs of one role folded together.
 *
 * Both halves are needed at once, and each one alone breaks the other.
 * Keeping the annotations replayed a label as if the model had said it — the
 * loop `replayableContent` exists to stop. Dropping them left two `user` rows
 * adjacent whenever the turn between them contributed nothing (a cancel, an
 * empty response), and strict providers reject a non-alternating thread
 * outright: the fix for the loop would have turned the next turn into a 400 on
 * exactly the messages that needed it most. So the run is folded instead —
 * nothing that is not prose reaches the wire, and the roles still alternate.
 *
 * A runaway of empty rows disappears for the same reason: a message with no
 * content is not a message, and the provider would reject the empty block.
 * A leading assistant row goes too — there is no user request for it to
 * answer, so replaying it as the start of the conversation is a thread that
 * begins with the model talking to itself. The current prompt travels
 * separately (`prompt`, appended after `messages`), so nothing of the user's
 * is lost by either drop.
 *
 * Display and the ledger are untouched by design: openSession draws the
 * bubbles from `msgs` and folds the meter with `rollMessages(msgs)`, both
 * before this is called, so only what goes back to the model changes.
 */
function replayHistory(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    // Same rows openSession always replayed: user and assistant. A `system`
    // row was never part of the renderer's thread and is not promoted to one
    // here.
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = typeof m.content === 'string' ? m.content
      : typeof m.text === 'string' ? m.text : '';
    if (!content.trim()) continue;
    if (m.role === 'assistant' && isPlaceholderContent(content)) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role === 'assistant') out.shift();
  return out;
}

/** True for the annotations above — rows that must never be replayed as prose. */
function isPlaceholderContent(content) {
  const t = typeof content === 'string' ? content.trim() : '';
  if (!t) return false;
  return (
    t === '(stopped: reasoning only)' ||
    t === '(stopped before any output)' ||
    t === '(empty response)' ||
    t === '(no response)'
  );
}

/** The smallest stream growth, in characters, that earns a live-meter recompute. */
const LIVE_METER_MIN_GROWTH = 256;

/** …and the fraction of the whole stream that must have arrived since the last
 *  one: a recompute comes due once the stream has grown by 1/this. */
const LIVE_METER_GROWTH_FRACTION = 32;

/**
 * Whether the live token meter is due to be recomputed, given how much of the
 * stream it last measured and how much of the stream has arrived now.
 *
 * The meter is paint-driven — `renderRollMeter` is called from inside the rAF
 * painter — and each recompute estimates the WHOLE accumulated reply plus
 * reasoning trace. `estimateTokens` counts code points by spreading the string
 * into an array (`[...String(text)].length`), so one estimate is linear in the
 * stream AND allocates a character-per-entry array. Per frame that is linear
 * per frame, i.e. quadratic over the turn, and it was measured on the thread
 * the user is trying to scroll: 0.37ms a frame on a 20k-char reply (2.2% of a
 * 60fps budget), 1.5ms at 100k (9%), 7.7ms at 400k (46%).
 *
 * The step is proportional rather than a fixed interval so the lag is bounded
 * at both ends. A short reply still updates every `LIVE_METER_MIN_GROWTH`
 * characters, so the number visibly moves; a long one updates once per 1/32 of
 * itself, which at the CLI's 4-chars-per-token rate means the figure can sit at
 * most ~3% below the truth before its next step — invisible on a token counter.
 *
 * Nothing about the settled number depends on this cadence: the turn's
 * committed value comes from `foldRoll`'s single estimate over the finished
 * text, which every exit path writes (success, stop, and error), and a reopened
 * thread is rebuilt by `rollMessages`. This only decides how often the preview
 * is allowed to cost anything.
 */
function liveMeterDue(measured, streamChars) {
  const now = Number(streamChars) || 0;
  const grown = now - (Number(measured) || 0);
  if (grown <= 0) return false;
  const step = Math.max(LIVE_METER_MIN_GROWTH, Math.floor(now / LIVE_METER_GROWTH_FRACTION));
  return grown >= step;
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
    replayableContent,
    isPlaceholderContent,
    replayHistory,
    liveMeterDue,
    toolMark,
    STICK_SLOP_PX,
    LIVE_METER_MIN_GROWTH,
    LIVE_METER_GROWTH_FRACTION,
  };
}
