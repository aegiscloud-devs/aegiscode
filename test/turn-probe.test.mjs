// Negative control for the Phase 14 turn anchor (desktop/test/turn-probe.js).
//
// Phase 14 replaced "liveText().length > minLen" with a wait that additionally
// requires the live row to be at or past the row count seen BEFORE the submit
// (`since`) and to be the newest row. An anchoring change is exactly the kind
// that can be added and then pass for the wrong reason: if the predicate always
// returned truthy, every leg would go green and the anchor would prove nothing.
//
// So this suite feeds the REAL predicate source — required from the same module
// the Electron driver evaluates in the renderer, not a copy of it — states that
// the defect class actually produces, and asserts it comes back falsy:
//
//   1. a stale row left over from a previous leg, long enough and still
//      carrying a cancel button (so `liveRow()` picks it) but *before* `since`;
//   2. a row carrying a cancel button that is not the newest row.
//
// Both are asserted against the BARE length predicate as well (the one the
// driver used before this phase), and it is asserted to be TRUTHY there. That
// pair is what makes these negative controls falsifiable: it shows the stale
// state really does satisfy the old wait, so the anchor is doing the work
// rather than the row being harmless anyway.
//
// No Electron binary, no DISPLAY, no network — this runs inside the unit-test
// step alongside `test/*.test.mjs`, so CI covers the assertion every run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { TURN_PROBE, TURN_STATE, ROW_COUNT, runProbe } = require('../desktop/test/turn-probe.js');
const DRIVER = path.join(HERE, '..', 'desktop', 'test', 'electron-smoke-main.js');

// ── a fake DOM slice, exactly as wide as the probe touches ────────────────
// The selectors are whitelisted and anything else throws: if the probe starts
// reading state this fake does not model, the test fails loudly instead of
// silently evaluating against `undefined` and passing.
function makeRow({ cancel = false, body = '', reasoning = '', meta = '' } = {}) {
  return {
    querySelector(sel) {
      if (sel === '.cancel-btn') return cancel ? { cancelBtn: true } : null;
      if (sel === '.body') return { textContent: body };
      if (sel === '.reasoning') return { textContent: reasoning };
      if (sel === '.meta') return { textContent: meta };
      throw new Error(`fake DOM: unexpected row selector ${sel}`);
    },
  };
}

function makeDoc(rows, { sendDisabled = false } = {}) {
  return {
    querySelectorAll(sel) {
      if (sel === '#messages .msg') return rows;
      throw new Error(`fake DOM: unexpected document selector ${sel}`);
    },
    getElementById(id) {
      if (id === 'send') return { disabled: sendDisabled };
      throw new Error(`fake DOM: unexpected element id ${id}`);
    },
  };
}

const filler = (n) => 'x'.repeat(n);

// The predicate the driver used BEFORE Phase 14 — kept here only as the
// comparison that shows the stale states below really were satisfiable. The old
// wait measured a single field of the live row and nothing else, which is the
// whole defect: `liveRow()` is "the first row carrying a cancel button", so a
// leftover row answers for a turn that has not started streaming yet.
const BARE_LENGTH_PROBE = (minLen, field = '.body') => `
  var bare = liveRow();
  var el = bare ? bare.querySelector(${JSON.stringify(field)}) : null;
  var n = el ? el.textContent.length : 0;
  return n > ${minLen} ? { len: n } : 0;
`;

// ── 1. a stale row that predates the submit ────────────────────────────────
test('the anchored probe rejects a live-looking row left over from a previous leg', () => {
  // One row on screen, still wearing a cancel button (a leg whose teardown has
  // not unwound yet), already far past the length threshold — the transcript a
  // successor leg saw when it timed out.
  const stale = makeDoc([makeRow({ cancel: true, body: filler(5000) })]);
  const since = 1; // the successor submitted when the transcript held 1 row
  const minLen = 1200;

  // The old wait: satisfied immediately, by a turn that is not this one. This
  // is the flake.
  assert.ok(
    runProbe(BARE_LENGTH_PROBE(minLen), stale),
    'the bare length predicate must be satisfiable by the stale row — otherwise ' +
      'this negative control proves nothing about the anchor',
  );
  // The replacement: row index 0 is < since 1, so it is not this turn's row.
  assert.ok(
    !runProbe(TURN_PROBE(minLen, '.body', since), stale),
    'the anchored probe must reject a row that existed before this turn was submitted',
  );
});

// ── 2. a cancel-button row that is not the newest row ──────────────────────
test('the anchored probe rejects a non-newest row carrying a cancel button', () => {
  // A streaming turn is always appended last, so a cancel button on anything
  // but the last row means `liveRow()` found a leftover, not the live turn.
  const doc = makeDoc([
    makeRow({ cancel: true, body: filler(5000), meta: 'a previous leg' }),
    makeRow({ cancel: false, body: 'the real turn, still short' }),
  ]);

  assert.ok(
    runProbe(BARE_LENGTH_PROBE(1200), doc),
    'the bare length predicate again satisfies itself from the leftover row',
  );
  // `since` is satisfied (0 >= 0), so the newest-row clause is what refuses it.
  assert.ok(
    !runProbe(TURN_PROBE(1200, '.body', 0), doc),
    'the anchored probe must refuse a cancel-button row that is not the newest row',
  );
  // And a since that excludes it refuses for the other reason too — both
  // clauses are load-bearing, so both are exercised.
  assert.ok(!runProbe(TURN_PROBE(1200, '.body', 1), doc));
});

// ── 3. the anchors accept the genuine article (the control is not vacuous) ─
test('the anchored probe accepts this turn streaming on the newest row', () => {
  const doc = makeDoc([
    makeRow({ body: filler(400), meta: 'earlier turn' }),
    makeRow({ cancel: true, body: filler(2000) }),
  ]);

  assert.deepEqual(runProbe(TURN_PROBE(1200, '.body', 1), doc), {
    len: 2000,
    index: 1,
    rows: 2,
    since: 1,
  });
  // Exactly at the threshold is still "not enough": the wait is `> minLen`.
  assert.equal(runProbe(TURN_PROBE(2000, '.body', 1), doc), 0);
  assert.equal(runProbe(TURN_PROBE(1999, '.body', 1), doc).len, 2000);
  // No live row at all (teardown finished) is falsy, not a crash.
  assert.equal(runProbe(TURN_PROBE(0, '.body', 0), makeDoc([])), 0);
  assert.equal(
    runProbe(TURN_PROBE(0, '.body', 0), makeDoc([makeRow({ body: filler(99) })])),
    0,
  );
});

// ── 4. the same anchor on the reasoning field (where LAST_STOPPED bit) ─────
test('the anchored probe applies to the reasoning-only leg, not just .body', () => {
  // The reasoning-only leg is the one a last-stopped lookup made read as a
  // product failure one run in three, so its field is controlled separately.
  const stale = makeDoc([makeRow({ cancel: true, reasoning: filler(900) })]);
  assert.ok(runProbe(BARE_LENGTH_PROBE(600, '.reasoning'), stale));
  assert.ok(!runProbe(TURN_PROBE(600, '.reasoning', 1), stale));

  const live = makeDoc([
    makeRow({ reasoning: filler(900) }), // answered, unwound
    makeRow({ cancel: true, reasoning: filler(700) }),
  ]);
  assert.deepEqual(runProbe(TURN_PROBE(600, '.reasoning', 1), live), {
    len: 700,
    index: 1,
    rows: 2,
    since: 1,
  });
});

// ── 5. the timeout instrument reports the row it was reading ───────────────
test('TURN_STATE names the live row and the row lengths the probe is judging', () => {
  const state = runProbe(
    TURN_STATE,
    makeDoc([
      makeRow({ body: filler(10), meta: 'earlier' }),
      makeRow({ cancel: true, body: filler(3000), meta: 'live' }),
    ]),
  );
  assert.deepEqual(state.live, 1, 'the observe probe must name the row liveRow() picked');
  assert.equal(state.liveLen, 3000);
  assert.deepEqual(
    state.rows.map((r) => [r.i, r.cancel, r.body]),
    [[0, false, 10], [1, true, 3000]],
  );
  // The stale case: the observe probe reports the leftover as `live`, which is
  // why a timeout message is diagnosable rather than a bare "timed out".
  const staleState = runProbe(TURN_STATE, makeDoc([makeRow({ cancel: true, body: filler(7) })]));
  assert.equal(staleState.live, 0);
  assert.equal(staleState.liveLen, 7);
  assert.equal(runProbe(ROW_COUNT, makeDoc([makeRow(), makeRow()])), 2);
});

// ── 6. anti-drift: the anchor exists once, and the driver uses it ──────────
test('the driver evaluates the shared probe rather than a private copy', () => {
  const driver = fs.readFileSync(DRIVER, 'utf8');
  assert.match(
    driver,
    /require\('\.\/turn-probe\.js'\)/,
    'the driver must require the shared probe module',
  );
  assert.ok(
    !driver.includes('i !== rows.length - 1'),
    'the driver carries a second copy of the anchor expression — a copy is where ' +
      'this assertion stops tracking the predicate that actually runs in the renderer',
  );
  assert.ok(
    !/const\s+TURN_PROBE\s*=/.test(driver),
    'the driver defines its own TURN_PROBE again',
  );
});
