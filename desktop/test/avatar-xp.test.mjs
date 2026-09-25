#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/xp.js — the XP ledger, its curve, and the
 * anti-farming rules.
 *
 * The load-bearing test here is the fuzz at the bottom: the plan's exit
 * criterion for Phase 19 is "no event sequence can pay XP for volume alone",
 * and that is only a real claim if it is asserted against a hostile generator
 * rather than against the examples I happened to think of. The bound it checks
 * (SINGLE_DAY_XP_CEILING) is derived analytically from the geometric series in
 * `dayScale`, so the test is checking the implementation against the math.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const xp = require('../lib/avatar/xp.js');
const { tierFor } = require('../lib/avatar/tiers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
function assertClose(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${expected} ±${tol}\n  actual:   ${actual}`);
  }
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5, 9, 0, 0);

// ---------------------------------------------------------------------------
// what earns XP
// ---------------------------------------------------------------------------
{
  assertEqual(xp.xpFor('memory.saved'), 10, 'a durable save pays 10');
  assertEqual(xp.xpFor('memory.recalled'), 1, 'a recall pays 1');
  assertEqual(xp.xpFor('memory.reinforced'), 5, 'a reinforcement pays 5');
  assertEqual(xp.xpFor('memory.corrected'), 15, 'a correction pays 15');
  assertEqual(xp.xpFor('memory.imported'), 2, 'an import pays 2');
  assertEqual(xp.xpFor('idea.logged'), 10, 'a logged idea pays 10');
  assertEqual(xp.xpFor('build.green'), 20, 'a green build pays 20');

  for (const kind of xp.VOLUME_KINDS) {
    assertEqual(xp.xpFor(kind), 0, `${kind} pays nothing — volume is not work`);
  }
  assertEqual(xp.xpFor('some.future.event'), 0, 'an unknown kind pays nothing by default');
  assertEqual(xp.xpFor(undefined), 0, 'a missing kind pays nothing');
  assertEqual(xp.xpFor({}), 0, 'a non-string kind pays nothing');

  // The table must never pay more for a volume kind than for real work.
  assert(xp.MAX_BASE === 20, `MAX_BASE tracks the table (got ${xp.MAX_BASE})`);
}

// ---------------------------------------------------------------------------
// the curve
// ---------------------------------------------------------------------------
{
  assertEqual(xp.xpForLevel(1), 0, 'L1 costs nothing');
  assertEqual(xp.xpForLevel(2), 125, 'L2 = 125');
  assertEqual(xp.xpForLevel(5), 800, 'L5 = 800 (matches the plan table)');
  assertEqual(xp.xpForLevel(10), 2925, 'L10 = 2925 (matches the plan table)');
  assertEqual(xp.xpForLevel(20), 10925, 'L20 = 10925');
  assertEqual(xp.xpForLevel(35), 32300, 'L35 = 32300');

  // levelForXp is the exact inverse of xpForLevel, boundaries included.
  for (let level = 1; level <= 60; level += 1) {
    const at = xp.xpForLevel(level);
    assertEqual(xp.levelForXp(at), level, `xpForLevel(${level}) is exactly level ${level}`);
    if (level > 1) {
      assertEqual(xp.levelForXp(at - 1), level - 1, `one XP short of L${level} is L${level - 1}`);
    }
  }
  assertEqual(xp.levelForXp(0), 1, 'zero XP is level 1');
  assertEqual(xp.levelForXp(-500), 1, 'negative XP clamps to level 1');
  assertEqual(xp.levelForXp(1e12), xp.levelForXp(1e12), 'huge XP does not hang');

  const p = xp.progressAt(125 + 50);
  assertEqual(p.level, 2, 'progress reports the right level');
  assertEqual(p.xpIntoLevel, 50, 'progress counts into the level');
  assertEqual(p.xpForNext, xp.xpForLevel(3) - xp.xpForLevel(2), 'progress knows the next step');
  assertClose(xp.progressAt(xp.xpForLevel(1)).progress, 0, 1e-9, 'L1 starts at 0%');

  // tiers
  assertEqual(tierFor(1).name, 'Familiar', 'L1 is Familiar');
  assertEqual(tierFor(4).name, 'Familiar', 'L4 is still Familiar');
  assertEqual(tierFor(5).name, 'Trusted', 'L5 is Trusted');
  assertEqual(tierFor(10).name, 'Companion', 'L10 is Companion');
  assertEqual(tierFor(19).name, 'Companion', 'L19 is still Companion');
  assertEqual(tierFor(20).name, 'Confidant', 'L20 is Confidant');
  assertEqual(tierFor(35).name, 'Archivist', 'L35 is Archivist');
  assertEqual(tierFor(9999).name, 'Archivist', 'the top band is open-ended');
  assertEqual(tierFor(0).name, 'Familiar', 'below L1 clamps to Familiar');
}

// ---------------------------------------------------------------------------
// replay basics
// ---------------------------------------------------------------------------
{
  assertEqual(xp.evaluate([]).xp, 0, 'an empty ledger is level 1');
  assertEqual(xp.evaluate([]).level, 1, 'an empty ledger reports level 1');
  assertEqual(xp.evaluate(null).level, 1, 'a null ledger does not throw');
  assertEqual(xp.evaluate('nonsense').level, 1, 'a non-array ledger does not throw');

  // One save = 10 XP = still level 1.
  const one = xp.evaluate([xp.makeEntry('memory.saved', {}, { t: T0 })]);
  assertEqual(one.xp, 10, 'a single save pays 10');
  assertEqual(one.level, 1, 'one save is not a level');
  assertEqual(one.events, 1, 'the event count is the ledger length');
  assertEqual(one.byKind['memory.saved'], 10, 'per-kind totals are reported');

  // Dimensioning: the Nth paid event of a day is scaled down.
  assertClose(xp.dayScale(0), 1, 1e-12, 'the first event of a day pays in full');
  assertClose(xp.dayScale(20), 0.5, 1e-12, 'the 21st event pays half');
  assertClose(xp.dayScale(40), 0.25, 1e-12, 'the 41st pays a quarter');
  assert(xp.dayScale(200) < 1e-3, 'far down the curve the payoff is negligible');

  // The `xp` field on a ledger line is advisory; replay ignores it.
  const tampered = [
    { t: T0, kind: 'memory.saved', xp: 999999 },
    { t: T0, kind: 'turn.completed', xp: 999999 },
  ];
  assertEqual(xp.evaluate(tampered).xp, 10, 'a tampered xp field cannot inflate a level');

  // Determinism: same lines, same level, whatever order they came off disk.
  const ledger = [];
  for (let i = 0; i < 40; i += 1) {
    ledger.push(xp.makeEntry(i % 3 === 0 ? 'memory.saved' : 'memory.recalled', {
      ref: `e${i}`,
      session: `s${i % 5}`,
      turn: `t${i}`,
    }, { t: T0 + i * 1000 }));
  }
  const forward = xp.evaluate(ledger);
  const backward = xp.evaluate(ledger.slice().reverse());
  assertClose(backward.xp, forward.xp, 1e-9, 'replay is order-independent for distinct timestamps');
  assertEqual(backward.level, forward.level, 'replay is order-independent for the level too');

  // A higher level never costs you XP.
  let prev = -1;
  for (let i = 0; i < ledger.length; i += 1) {
    const now = xp.evaluate(ledger.slice(0, i)).xp;
    assert(now >= prev, 'adding a paid event never lowers XP');
    prev = now;
  }
}

// ---------------------------------------------------------------------------
// caps and dedupe
// ---------------------------------------------------------------------------
{
  // 5 recalls per turn, and only from distinct refs/sessions.
  const recalls = [];
  for (let i = 0; i < 10; i += 1) {
    recalls.push(xp.makeEntry('memory.recalled', { ref: `r${i}`, session: 's1', turn: 'turn-1' }, { t: T0 + i }));
  }
  const capped = xp.evaluate(recalls);
  assertEqual(capped.reasons['turn-cap'], 5, 'five recalls pay per turn, five are capped');
  assertEqual(capped.suppressedEvents, 5, 'the capped recalls are reported as suppressed');
  assert(capped.xp < 6, `a turn cannot pay more than 5 XP in recalls (got ${capped.xp})`);

  // A second turn pays again.
  const twoTurns = recalls.slice(0, 5).concat(
    recalls.map((e, i) => Object.assign({}, e, { turn: 'turn-2', t: T0 + 100 + i, session: 's2' })),
  );
  assert(xp.evaluate(twoTurns).xp > capped.xp, 'a new turn earns recall XP again');

  // One fact is not a slot machine: same ref, same session, pays once.
  const repeat = [
    xp.makeEntry('memory.recalled', { ref: 'same', session: 'sX', turn: 'turn-1' }, { t: T0 }),
    xp.makeEntry('memory.recalled', { ref: 'same', session: 'sX', turn: 'turn-2' }, { t: T0 + 1 }),
    xp.makeEntry('memory.recalled', { ref: 'same', session: 'sX', turn: 'turn-3' }, { t: T0 + 2 }),
  ];
  const deduped = xp.evaluate(repeat);
  assertEqual(deduped.reasons['duplicate-session'], 2, 'the same ref from one session pays once');
  assertEqual(deduped.xp, 1, 'three recalls of one fact pay 1 XP total');

  // …but recalling it in a *different* session does pay. Placed on the next day
  // so the day-decay factor is 1 and the expectation stays exact.
  const crossSession = repeat.concat(
    xp.makeEntry('memory.recalled', { ref: 'same', session: 'sY', turn: 'turn-4' }, { t: T0 + DAY }),
  );
  const across = xp.evaluate(crossSession);
  assertEqual(across.xp, 2, 'a recall from a new session pays again');
  assertEqual(across.reasons['duplicate-session'], 2, 'only the same-session repeats are held back');

  // Imports: 200 per source, so ten imported tools cannot jump ten levels.
  const imports = [];
  for (let i = 0; i < 400; i += 1) {
    imports.push(xp.makeEntry('memory.imported', { ref: `m${i}`, source: 'foreign-tool' }, { t: T0 + i }));
  }
  const importEval = xp.evaluate(imports);
  assertEqual(importEval.reasons['source-cap'], 200, '200 imports per source pay, the rest are capped');
  assert(importEval.xp < 100, `400 imports from one source pay well under 100 XP (got ${importEval.xp.toFixed(2)})`);
  assert(importEval.level < 2, 'a 400-entry import cannot even reach level 2 on its own');

  // A second source pays independently — the cap is per source, not global.
  // On its own day, so the day-decay factor starts fresh.
  const twoSources = imports.slice(0, 200).concat(
    imports.slice(0, 200).map((e, i) => Object.assign({}, e, { source: 'other-tool', t: T0 + DAY + i })),
  );
  assert(xp.evaluate(twoSources).xp > importEval.xp, 'a second source earns its own import XP');
  assert(((xp.evaluate(twoSources).reasons['source-cap']) ?? 0) === 0, 'two sources of 200 are both under the cap');
}

// ---------------------------------------------------------------------------
// §1.4 decay: recalls of deleted entries are dropped, savings stay
// ---------------------------------------------------------------------------
{
  const entries = [
    xp.makeEntry('memory.saved', { ref: 'gone' }, { t: T0 }),
    xp.makeEntry('memory.saved', { ref: 'kept' }, { t: T0 + 1 }),
    xp.makeEntry('memory.recalled', { ref: 'gone', session: 's1', turn: 'turn-1' }, { t: T0 + 2 }),
    xp.makeEntry('memory.recalled', { ref: 'kept', session: 's1', turn: 'turn-1' }, { t: T0 + 3 }),
  ];
  const withAll = xp.evaluate(entries);
  const reconciled = xp.evaluate(entries, { liveRefs: ['kept'] });

  assertEqual(reconciled.reasons['ref-gone'], 1, 'the recall of a deleted entry is dropped');
  assertEqual(reconciled.droppedEvents, 1, 'dropped recalls are counted');
  assertClose(reconciled.xp, withAll.xp - 1, 1e-9, 'exactly the missing recall is deducted');
  assert(
    reconciled.byKind['memory.saved'] === withAll.byKind['memory.saved'],
    'savings survive a memory shrink — you did that work',
  );
  // Passed as an array as well as a Set.
  assertClose(xp.evaluate(entries, { liveRefs: new Set(['kept']) }).xp, reconciled.xp, 1e-9, 'liveRefs accepts a Set');
}

// ---------------------------------------------------------------------------
// held levels (§1.4: never regress while the user is watching)
// ---------------------------------------------------------------------------
{
  const small = [xp.makeEntry('memory.saved', {}, { t: T0 })];
  const held = { level: 9, session: 'sess-A' };

  const sameSession = xp.evaluate(small, { held, session: 'sess-A' });
  assertEqual(sameSession.rawLevel, 1, 'the derived level is honestly reported');
  assertEqual(sameSession.level, 9, 'a held level is shown instead of a regression');
  assertEqual(sameSession.settledLevel, 1, 'the settled level is available to the HUD');
  assertEqual(sameSession.held, true, 'the held flag is set');

  const nextSession = xp.evaluate(small, { held, session: 'sess-B' });
  assertEqual(nextSession.level, 1, 'a new session settles to the derived level');
  assertEqual(nextSession.held, false, 'the held flag is cleared');

  // A held level never *raises* the number.
  const rich = [xp.makeEntry('build.green', {}, { t: T0 })];
  const rising = xp.evaluate(rich, { held: { level: 1, session: 'sess-A' }, session: 'sess-A' });
  assert(rising.level >= 1, 'a held level never lowers a real one');
  assertEqual(rising.held, false, 'no need to hold a level that went up');

  assertEqual(xp.nextHeld(sameSession, 'sess-A').level, 9, 'nextHeld carries the shown level forward');
  assertEqual(xp.nextHeld(sameSession, 'sess-A').session, 'sess-A', 'nextHeld carries the session');
}

// ---------------------------------------------------------------------------
// the ledger file format
// ---------------------------------------------------------------------------
{
  const entries = [
    xp.makeEntry('memory.saved', { ref: 'a', session: 's1' }, { t: T0 }),
    xp.makeEntry('memory.recalled', { ref: 'a', session: 's1', turn: 'turn-1' }, { t: T0 + 1 }),
  ];
  const text = xp.formatLedger(entries);
  assert(text.endsWith('\n'), 'jsonl is newline-terminated');
  assertEqual(text.trim().split('\n').length, 2, 'one line per entry');
  assertEqual(xp.makeEntry('memory.saved', {}, { t: T0 }).v, xp.LEDGER_VERSION, 'entries carry a version');
  assertEqual(JSON.parse(text.split('\n')[0]).xp, 10, 'the advisory xp field is recorded');

  const round = xp.parseLedger(text);
  assertEqual(round.entries.length, 2, 'the ledger round-trips');
  assertEqual(round.corrupt, 0, 'a clean ledger has no corrupt lines');

  // A process killed mid-append leaves a truncated final line. Losing the whole
  // level to that would be absurd, so it is skipped and counted.
  const truncated = xp.parseLedger(`${text}{"t":123,"kind":"memory.sa`);
  assertEqual(truncated.entries.length, 2, 'a truncated final line does not lose the ledger');
  assertEqual(truncated.corrupt, 1, 'the truncated line is counted as corrupt');

  const mixed = xp.parseLedger('{"kind":"memory.saved"}\n\nnot json\n{"nope":1}\n');
  assertEqual(mixed.entries.length, 1, 'lines without a kind are not treated as events');
  assertEqual(mixed.corrupt, 2, 'both bad lines are counted');

  assertEqual(xp.parseLedger('').entries.length, 0, 'an empty file parses to an empty ledger');
  assertEqual(xp.parseLedger(null).entries.length, 0, 'a missing file parses to an empty ledger');
  assertEqual(xp.formatLedger(null), '', 'formatting nothing yields nothing');
}

// ---------------------------------------------------------------------------
// FUZZ — the Phase 19 exit criterion
// ---------------------------------------------------------------------------
{
  // mulberry32: a tiny seeded PRNG, so a failure is reproducible from the seed.
  function rng(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const PAID = Object.keys(xp.XP_TABLE);
  const POOL = PAID.concat(xp.VOLUME_KINDS).concat(['turn.ended', 'whatever.new', '']);

  const pickKind = (r) => POOL[Math.floor(r() * POOL.length)];

  function randomEntry(r, dayCount) {
    const kind = pickKind(r);
    const day = Math.floor(r() * dayCount);
    const fields = {
      ref: `ref-${Math.floor(r() * 8)}`,
      session: `sess-${Math.floor(r() * 3)}`,
      turn: `turn-${Math.floor(r() * 4)}`,
      source: `src-${Math.floor(r() * 2)}`,
    };
    return xp.makeEntry(kind, fields, { t: T0 + day * DAY + Math.floor(r() * DAY) });
  }

  const EPS = 1e-6;
  const CEILING = xp.SINGLE_DAY_XP_CEILING;
  assertClose(CEILING, 20 * 29.3566, 0.01, 'the single-day ceiling matches the geometric series');

  for (const seed of [1, 2, 3, 7, 11, 42, 99, 1234, 65535, 987654321]) {
    const r = rng(seed);
    const entries = [];
    const n = 200 + Math.floor(r() * 5000);
    for (let i = 0; i < n; i += 1) entries.push(randomEntry(r, 6));

    const out = xp.evaluate(entries);

    // 1. No calendar day may pay more than the ceiling, however many events it
    //    holds. This is the anti-farming invariant, checked empirically.
    for (const [day, total] of Object.entries(out.byDay)) {
      assert(
        total <= CEILING + EPS,
        `seed ${seed}: day ${day} paid ${total.toFixed(3)} XP, above the ceiling ${CEILING.toFixed(3)}`,
      );
    }

    // 2. A ledger of pure volume pays exactly nothing.
    const pureVolume = entries.filter((e) => xp.VOLUME_KINDS.includes(e.kind));
    if (pureVolume.length) {
      assertEqual(xp.evaluate(pureVolume).xp, 0, `seed ${seed}: pure volume paid nothing`);
    }

    // 3. Adding unbounded extra volume events cannot move the total by even 1 XP.
    const withVolume = entries.concat(
      Array.from({ length: 5000 }, (_, i) => xp.makeEntry('token.spent', { note: `${i}` }, { t: T0 + i })),
    );
    assertClose(xp.evaluate(withVolume).xp, out.xp, EPS, `seed ${seed}: 5000 volume events added no XP`);

    // 4. A recall loop is a no-op: 5000 plays of the same ref/session pays at
    //    most the first. Measured on its own ledger, because *inserting* an
    //    eligible event into an existing day legitimately reshuffles that day's
    //    shared decay budget (see the chronology test below).
    const sameRecall = xp.makeEntry('memory.recalled', { ref: 'loop', session: 's-loop', turn: 'turn-loop' }, { t: T0 });
    const spun = Array.from({ length: 5000 }, (_, i) => Object.assign({}, sameRecall, { t: T0 + i }));
    assert(xp.evaluate(spun).xp <= 1 + EPS, `seed ${seed}: 5000 identical recalls paid at most 1 XP`);

    // 5. Appending in time order (how the ledger is actually written) never
    //    lowers the total — the shared daily budget can only ever bite events
    //    that come after it. Checked on a bounded prefix: the property is
    //    per-append, and evaluating 5000 nested prefixes costs minutes for no
    //    extra coverage.
    const chrono = entries.slice().sort((a, b) => a.t - b.t).slice(0, 200);
    let running = -1;
    for (let i = 1; i <= chrono.length; i += 1) {
      const next = xp.evaluate(chrono.slice(0, i)).xp;
      assert(next >= running, `seed ${seed}: appending event ${i} (${chrono[i - 1].kind}) lowered the total`);
      running = next;
    }

    // 5. Results are never negative, never NaN.
    assert(Number.isFinite(out.xp) && out.xp >= 0, `seed ${seed}: XP is a finite non-negative number`);
    assert(Number.isFinite(out.level) && out.level >= 1, `seed ${seed}: level is a finite positive integer`);
    assertEqual(out.level, xp.levelForXp(out.xp), `seed ${seed}: level is exactly the curve inversion`);
    assertEqual(out.level, out.rawLevel, `seed ${seed}: no held level was passed, so nothing is held`);
  }

  // The headline consequence, stated as a test: you cannot buy L5 in one day by
  // any means whatsoever. 800 XP is required; a day tops out near 587.
  assert(CEILING < xp.xpForLevel(5), `a single day (max ${CEILING.toFixed(0)} XP) cannot reach L5 (${xp.xpForLevel(5)} XP)`);

  const flood = [];
  for (let i = 0; i < 200000; i += 1) {
    flood.push(xp.makeEntry('build.green', { ref: `b${i}`, session: `s${i % 10}`, turn: `t${i}` }, { t: T0 + i }));
  }
  const flooded = xp.evaluate(flood);
  assert(flooded.xp <= CEILING + EPS, `200k green builds in one day paid ${flooded.xp.toFixed(2)}, ceiling ${CEILING.toFixed(2)}`);
  assert(flooded.level < 5, `200k events in one day still cannot reach L5 (got L${flooded.level})`);

  // The honest path: XP grows with *days of real work*, not with events. This
  // also pins the pacing, so a future curve tweak that makes L10 a weekend
  // fails here rather than in a design review.
  const honest = [];
  for (let d = 0; d < 60; d += 1) {
    honest.push(xp.makeEntry('memory.saved', { ref: `m${d}`, session: `s${d}` }, { t: T0 + d * DAY }));
    honest.push(xp.makeEntry('build.green', { ref: `g${d}`, session: `s${d}` }, { t: T0 + d * DAY + 1000 }));
    honest.push(xp.makeEntry('memory.saved', { ref: `n${d}`, session: `s${d}` }, { t: T0 + d * DAY + 2000 }));
  }
  const earned = xp.evaluate(honest);
  assert(earned.days === 60, 'sixty distinct days are counted');
  assert(earned.xp > 2000 && earned.xp < 2500, `two months of daily work earns ~2300 XP (got ${earned.xp})`);
  assertEqual(earned.level, 8, 'three good events a day for two months is level 8');
  assert(earned.level < 10, 'L10 stays a months-long relationship, not a fortnight');
  assert(earned.byDay[Object.keys(earned.byDay)[0]] < 40, 'a single day of this pace pays under 40 XP');

  // A heavy user gets there faster, but still not in one sitting.
  const heavy = [];
  for (let d = 0; d < 60; d += 1) {
    for (let i = 0; i < 15; i += 1) {
      heavy.push(xp.makeEntry('memory.saved', { ref: `h${d}-${i}`, session: `s${d}` }, { t: T0 + d * DAY + i * 100 }));
    }
  }
  const heavyEval = xp.evaluate(heavy);
  assert(heavyEval.xp > earned.xp, 'fifteen paid events a day out-earns three');
  // ~113 XP/day at the shared daily budget ⇒ ~6.8k over 60 days, which lands on
  // the L16 boundary. The band is the claim; L16 itself is not load-bearing.
  assert(heavyEval.level >= 15 && heavyEval.level <= 17, `15 events/day for two months is high-teens (got L${heavyEval.level})`);
  assert(heavyEval.level > earned.level, 'the heavy user stays ahead of the steady one');
  for (const [day, total] of Object.entries(heavyEval.byDay)) {
    assert(total <= CEILING + EPS, `heavy day ${day} respects the ceiling (${total.toFixed(1)} ≤ ${CEILING.toFixed(1)})`);
  }
}

console.log('avatar-xp.test.mjs ok');
