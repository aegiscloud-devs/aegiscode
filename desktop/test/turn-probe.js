'use strict';

/**
 * The turn anchor — PLAN Phase 14 (harness determinism), successor-turn timeout.
 *
 * This module exists so the predicate the smoke run actually evaluates and the
 * predicate the negative control asserts on are **the same text**, not two
 * copies that can drift. A copied predicate is the exact "assertion that can
 * never fail" defect class this repo keeps finding: if someone dropped the
 * anchor from `TURN_PROBE` here, a copy inside the test would keep asserting
 * rejection and stay green while the real wait regressed.
 *
 * It is therefore a plain CommonJS module with no Electron import:
 *   - `desktop/test/electron-smoke-main.js` (Electron main process) requires it
 *     and evaluates the strings in the real renderer via `executeJavaScript`;
 *   - `test/turn-probe.test.mjs` (no Electron binary, CI-visible) requires it
 *     and evaluates the same strings against a tiny fake DOM.
 *
 * Nothing here is shipped: `desktop/test/` is outside the package `files` list.
 */

/**
 * How the driver finds the turn that is running right now.
 *
 * Not `.pending`: app.js clears that class on the first paint (`paintStream`
 * removes it so the typing dots stop), so mid-stream it is already gone. The
 * cancel button is the real marker — it exists for exactly as long as a
 * cancellable turn is in flight and disappears with the bubble when the turn
 * ends (`setBusy(false)` removes the whole row).
 */
const HELPERS = `
  function liveRow() {
    var rows = document.querySelectorAll('#messages .msg');
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].querySelector('.cancel-btn')) return rows[i];
    }
    return null;
  }
  function liveText() {
    var r = liveRow();
    if (!r) return '';
    var b = r.querySelector('.body');
    return b ? b.textContent : '';
  }
  function liveReasoning() {
    var r = liveRow();
    if (!r) return '';
    var el = r.querySelector('.reasoning');
    return el ? el.textContent : '';
  }
`;

// The transcript as `liveText()` sees it: every row, which one carries the
// cancel button (so which one `liveRow()` picks), and how long each body is.
// Passed as the `observe` probe to the waits that depend on the live row, so a
// timeout names the row it was reading instead of just failing.
const TURN_STATE = `
  var rows = document.querySelectorAll('#messages .msg');
  var out = { rows: [], live: -1, liveLen: liveText().length,
              sendDisabled: document.getElementById('send').disabled };
  Array.prototype.forEach.call(rows, function (r, i) {
    var b = r.querySelector('.body');
    var m = r.querySelector('.meta');
    var c = r.querySelector('.cancel-btn');
    if (c && out.live === -1) out.live = i;
    out.rows.push({
      i: i,
      cancel: Boolean(c),
      body: b ? b.textContent.length : -1,
      meta: m ? m.textContent.slice(0, 40) : ''
    });
  });
  return out;
`;

const ROW_COUNT = `return document.querySelectorAll('#messages .msg').length;`;

// The anchor every "this turn has streamed enough" wait is built on.
//
// Length alone is not an anchor. `liveRow()` returns the FIRST row carrying a
// cancel button, so a wait keyed only on `liveText().length > N` can be
// satisfied by a row left over from an earlier leg — the same defect class as
// the `LAST_STOPPED` lookup that made the reasoning-only leg read as a product
// failure one run in three, and as the preset leg's stale-row predicate. Two
// extra facts pin the reading to THIS turn: the live row must be newer than the
// row count observed before the submit (`since`), and it must be the newest
// row, because a streaming turn is always appended last. A stale row can no
// longer satisfy the wait by accident.
//
// The rejection half is not assumed — `test/turn-probe.test.mjs` feeds this
// exact source a stale row and asserts it returns falsy.
const TURN_PROBE = (minLen, field, since) => `
  var rows = document.querySelectorAll('#messages .msg');
  var r = liveRow();
  if (!r) return 0;
  var i = Array.prototype.indexOf.call(rows, r);
  if (i < ${since} || i !== rows.length - 1) return 0;
  var el = r.querySelector(${JSON.stringify(field)});
  var n = el ? el.textContent.length : 0;
  return n > ${minLen} ? { len: n, index: i, rows: rows.length, since: ${since} } : 0;
`;

/**
 * The one wrapper both callers use to evaluate a probe body.
 *
 * The driver runs it inside the renderer via `executeJavaScript`; the negative
 * control runs it through `runProbe` below. Keeping the wrapping here is what
 * makes the two evaluations the same evaluation.
 */
function wrap(body) {
  return `(function(){${HELPERS}${body}})()`;
}

/**
 * Evaluate a probe body against any object shaped like the DOM slice the
 * helpers touch (`querySelectorAll('#messages .msg')`, `getElementById('send')`).
 * Node-side only — the driver never calls this.
 *
 * `return ` is how the completion value of the wrapped IIFE is obtained here:
 * `executeJavaScript` resolves to exactly that value in the renderer, so the
 * two evaluations agree down to the result shape.
 */
function runProbe(body, doc) {
  return new Function('document', `return ${wrap(body)}`)(doc);
}

module.exports = { HELPERS, TURN_STATE, ROW_COUNT, TURN_PROBE, wrap, runProbe };
