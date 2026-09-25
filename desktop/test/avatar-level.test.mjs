#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/level.js — the capabilities ladder.
 *
 * The load-bearing tests here are the two that check the product's promises
 * rather than its arithmetic:
 *
 *   1. CARVE-OUTS. Level must never widen the blast radius. The write/shell/
 *      network/offDevice approvals are level-independent, and the guardrail that
 *      says so has to actually FIRE — a test that only ever runs `carveOuts` on
 *      objects this module produced proves nothing, so the tampering test below
 *      feeds it a hand-broken capabilities object and asserts it is caught.
 *
 *   2. THE PAYWALL LINE. Cosmetics are the only sellable thing. That is only
 *      true if no paid unlock id can reach a capability-granting field, which is
 *      asserted here across the whole level range instead of trusted to review.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const level = require('../lib/avatar/level.js');
const { TIERS } = require('../lib/avatar/tiers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

const LEVELS = Array.from({ length: 60 }, (_, i) => i + 1);
const { GATES } = level;

// ---------------------------------------------------------------------------
// the invariant sweep
// ---------------------------------------------------------------------------
{
  const violations = level.verifyInvariants();
  assertDeep(violations, [], 'the whole 1..60 ladder satisfies every invariant');

  // Same claim, but stated as properties rather than "the function said so", so
  // a future edit to verifyInvariants itself cannot make this vacuous.
  let prev = null;
  for (const n of LEVELS) {
    const caps = level.capabilities(n);
    assert(caps.recallEntries >= 4, `L${n}: recall breadth starts at a useful floor`);
    assert(caps.recallTokens >= 1500, `L${n}: recall token budget has a floor`);
    if (prev) {
      assert(caps.recallEntries >= prev.recallEntries, `L${n}: recallEntries never shrinks`);
      assert(caps.recallTokens >= prev.recallTokens, `L${n}: recallTokens never shrinks`);
      assert(
        level.PROACTIVITY_ORDER.indexOf(caps.proactivity) >= level.PROACTIVITY_ORDER.indexOf(prev.proactivity),
        `L${n}: proactivity never regresses`,
      );
    }
    prev = caps;
  }
  assert(level.capabilities(60).recallEntries > level.capabilities(1).recallEntries, 'levelling visibly widens recall');
}

// ---------------------------------------------------------------------------
// carve-outs: level never widens the blast radius
// ---------------------------------------------------------------------------
{
  for (const n of LEVELS) {
    const caps = level.capabilities(n);
    for (const cls of ['write', 'shell', 'network', 'offDevice']) {
      assertEqual(caps.approvals[cls], 'ask', `L${n}: ${cls} still asks`);
    }
    assertEqual(caps.approvals.read, 'auto', `L${n}: reads never ask`);
    assert(caps.autoApproveClasses.every((c) => c === 'read' || c === 'diff'), `L${n}: only read/diff are auto-approvable`);
    assertDeep(caps.offDeviceGrants, [], `L${n}: nothing sends data off-device`);
    assertEqual(caps.memoryWriteback, true, `L${n}: memory write-back is never level-gated (XP would deadlock)`);
  }

  // The guardrail has to fire, or it is decoration.
  const at30 = level.capabilities(30);
  const tampered = Object.assign({}, at30, {
    approvals: Object.assign({}, at30.approvals, { write: 'auto' }),
  });
  const caught = level.carveOuts(tampered);
  assert(caught.length === 1, `tampering with the write approval is caught exactly once (got ${caught.length})`);
  assert(/write/.test(caught[0]), 'the violation names the offending class');
  let threw = false;
  try {
    level.assertCarveOuts(tampered);
  } catch {
    threw = true;
  }
  assert(threw, 'assertCarveOuts throws on a tampered capabilities object');
  assertEqual(level.assertCarveOuts(at30), at30, 'assertCarveOuts returns the caps when they are clean');

  // Every other carve-out must also be detectable, one at a time.
  const breakages = [
    ['approval for shell', Object.assign({}, at30, { approvals: Object.assign({}, at30.approvals, { shell: 'auto' }) })],
    ['auto-approved write', Object.assign({}, at30, { autoApproveClasses: ['read', 'write'] })],
    ['gated write-back', Object.assign({}, at30, { memoryWriteback: false })],
    ['off-device grant', Object.assign({}, at30, { offDeviceGrants: ['telemetry'] })],
    ['publishing tool grant', Object.assign({}, at30, { toolGrants: ['queue.drain', 'x.publish'] })],
    ['missing caps', null],
    ['non-object', 42],
  ];
  for (const [label, broken] of breakages) {
    assert(level.carveOuts(broken).length > 0, `carve-outs detect: ${label}`);
  }
}

// ---------------------------------------------------------------------------
// gates land exactly where the table says
// ---------------------------------------------------------------------------
{
  assertEqual(level.capabilities(GATES.autoApproveDiff - 1).approvals.diff, 'ask', 'diff still asks at L9');
  assertEqual(level.capabilities(GATES.autoApproveDiff).approvals.diff, 'auto', 'diff auto-approves at L10');

  assertEqual(level.capabilities(GATES.reasoningFloor - 1).modelFloor, null, 'no model floor at L19');
  assertEqual(level.capabilities(GATES.reasoningFloor).modelFloor, 'reasoning', 'reasoning floor at L20');
  assertEqual(level.capabilities(35).modelFloor, 'reasoning', 'the reasoning floor is never taken away again');

  assertDeep(level.capabilities(GATES.queueDrain - 1).toolGrants, [], 'no queue.drain below L20');
  assertDeep(level.capabilities(GATES.queueDrain).toolGrants, ['queue.drain'], 'queue.drain at L20');

  const companionGates = {
    morningBrief: GATES.brief,
    ideaLog: GATES.ideaLog,
    sessionReflection: GATES.sessionReflection,
    voice: GATES.voice,
    queueDrain: GATES.queueDrain,
    importAssistant: GATES.importAssistant,
  };
  for (const [flag, gate] of Object.entries(companionGates)) {
    assertEqual(level.capabilities(gate).companion[flag], true, `companion.${flag} is on at its gate L${gate}`);
    if (gate > 1) {
      assertEqual(level.capabilities(gate - 1).companion[flag], false, `companion.${flag} is off at L${gate - 1}`);
    }
  }
  // The everyday-interaction surface the user actually asked for arrives early.
  assertEqual(level.capabilities(5).companion.ideaLog, true, 'idea log is available from L5');
  assertEqual(level.capabilities(5).companion.morningBrief, true, 'morning brief is available from L5');
  assertEqual(level.capabilities(10).companion.voice, true, 'voice is available from L10 and off by default elsewhere');
}

// ---------------------------------------------------------------------------
// proactivity: the user can lower it, never raise it past what they earned
// ---------------------------------------------------------------------------
{
  assertEqual(level.proactivityCeiling(1), 'off', 'L1 stays quiet');
  assertEqual(level.proactivityCeiling(GATES.hints), 'hints', 'hints begin at L2');
  assertEqual(level.proactivityCeiling(GATES.brief), 'brief', 'the brief begins at L5');

  for (const n of LEVELS) {
    const earned = level.proactivityCeiling(n);
    for (const want of level.PROACTIVITY_ORDER) {
      const caps = level.capabilities(n, { userProactivity: want });
      const got = level.PROACTIVITY_ORDER.indexOf(caps.proactivity);
      assert(got <= level.PROACTIVITY_ORDER.indexOf(earned), `L${n}: a preference of "${want}" cannot exceed the earned ceiling`);
      assert(got <= level.PROACTIVITY_ORDER.indexOf(want), `L${n}: a preference of "${want}" is honoured as a cap`);
    }
    assertEqual(caps_proactivityAt(n), earned, `L${n}: with no preference the ceiling is used`);
  }
  function caps_proactivityAt(n) {
    return level.capabilities(n).proactivity;
  }
  assertEqual(level.capabilities(30, { userProactivity: 'off' }).proactivity, 'off', 'a user who wants silence gets silence at L30');
  assertEqual(level.capabilities(30, { userProactivity: 'nonsense' }).proactivity, 'brief', 'an unknown preference is ignored, not honoured');
}

// ---------------------------------------------------------------------------
// level input is clamped and total
// ---------------------------------------------------------------------------
{
  assertEqual(level.capabilities(1).level, 1, 'L1 is L1');
  for (const weird of [0, -1, -1000, NaN, Infinity, null, undefined, '7', {}, []]) {
    const caps = level.capabilities(weird);
    assert(caps.level >= 1, `capabilities(${JSON.stringify(weird)}) clamps to a real level`);
    assertEqual(level.carveOuts(caps).length, 0, `capabilities(${JSON.stringify(weird)}) still satisfies carve-outs`);
  }
  assertEqual(level.capabilities(100000).level, 100000, 'an absurd level does not throw');
}

// ---------------------------------------------------------------------------
// tiers
// ---------------------------------------------------------------------------
{
  let lastIndex = -1;
  for (const n of LEVELS) {
    const band = level.tierFor(n);
    const idx = level.tierIndex(n);
    assert(idx >= lastIndex, `L${n}: the tier index never goes backwards`);
    lastIndex = idx;
    assert(n >= band.min && n <= band.max, `L${n}: falls inside the band it names`);
    assertEqual(level.capabilities(n).tier, band.name, `L${n}: capabilities reports its band`);
    assertEqual(level.capabilities(n).tierIndex, idx, `L${n}: capabilities reports its band index`);
  }
  assertEqual(level.tierFor(1).name, TIERS[0].name, 'tiers.js and level.js agree on the first band');
  assertEqual(level.tierFor(1000000).name, TIERS[TIERS.length - 1].name, 'above the table, the last band holds');
}

// ---------------------------------------------------------------------------
// the paywall line: paid cosmetics can never buy capability
// ---------------------------------------------------------------------------
{
  const paid = level.UNLOCKS.filter((u) => u.paid).map((u) => u.id);
  assert(paid.length > 0, 'there is at least one paid cosmetic to test the line with');

  const capabilityFields = [
    'recallEntries',
    'recallTokens',
    'memoryWriteback',
    'autoApproveClasses',
    'approvals',
    'toolGrants',
    'modelFloor',
    'proactivity',
    'proactivityCeiling',
    'companion',
    'offDeviceGrants',
  ];
  for (const n of LEVELS) {
    const caps = level.capabilities(n);
    const grantSurface = JSON.stringify(capabilityFields.map((f) => caps[f]));
    for (const id of paid) {
      assert(!grantSurface.includes(id), `L${n}: paid unlock ${id} reaches no capability field`);
    }
  }

  // No unlock may gate XP, a level, recall, or approval friction. Word
  // boundaries matter: "expressions" contains "xp" and is a legitimate kind.
  const forbidden = /\b(xp|level|recall|approval|approvals|token|entry|entries|tool|model|grant)\b/i;
  for (const u of level.UNLOCKS) {
    assert(!forbidden.test(u.kind), `unlock kind "${u.kind}" (${u.id}) is presentation, not capability`);
    assert(['expressions', 'outfit', 'palette', 'voice'].includes(u.kind), `unlock ${u.id} has a presentation kind`);
    assert(u.level >= 1, `unlock ${u.id} is reachable`);
  }
  const ids = level.UNLOCKS.map((u) => u.id);
  assertEqual(new Set(ids).size, ids.length, 'no duplicate unlock ids');

  // Cosmetics DO accumulate with level — that is the visible reward.
  assert(level.unlockedBy(35).length > level.unlockedBy(1).length, 'higher levels unlock more cosmetics');
  assertEqual(level.unlockedBy(1).length, 4, 'L1 ships with four free cosmetics');
  assertEqual(level.nextUnlock(1).level, 5, 'L1 is shown the L5 set as its next carrot');
  assertEqual(level.nextUnlock(100), null, 'past the table there is nothing left to dangle');
}

// ---------------------------------------------------------------------------
// env overrides: automation may widen recall, never widen approvals
// ---------------------------------------------------------------------------
{
  const base = level.capabilities(3);
  assertEqual(base.proactivity, 'hints', 'L3 earns hints');

  const disabled = level.applyEnvOverrides(base, { AEGIS_AVATAR_DISABLE: '1' });
  assertEqual(disabled.caps.proactivity, 'off', 'AEGIS_AVATAR_DISABLE silences the companion');
  assertEqual(disabled.caps.modelFloor, null, 'AEGIS_AVATAR_DISABLE drops the model floor');
  assertDeep(disabled.caps.toolGrants, [], 'AEGIS_AVATAR_DISABLE drops tool grants');
  assertEqual(level.carveOuts(disabled.caps).length, 0, 'a disabled avatar still satisfies carve-outs');
  assertDeep(disabled.ignored, [], 'disabling is not an ignored override');

  const widened = level.applyEnvOverrides(base, { AEGIS_RECALL_ENTRIES: '40', AEGIS_RECALL_TOKENS: '9000' });
  assertEqual(widened.caps.recallEntries, 40, 'CI can widen recall entries');
  assertEqual(widened.caps.recallTokens, 9000, 'CI can widen the recall token budget');

  const junk = level.applyEnvOverrides(base, { AEGIS_RECALL_ENTRIES: '-4', AEGIS_RECALL_TOKENS: 'lots' });
  assertEqual(junk.caps.recallEntries, base.recallEntries, 'a non-positive override is ignored');
  assertEqual(junk.caps.recallTokens, base.recallTokens, 'a non-numeric override is ignored');

  // The one that matters: trying to buy your way past an approval gate fails.
  const hostile = level.applyEnvOverrides(base, { AEGIS_AUTO_APPROVE: 'write,shell,network,diff' });
  assertDeep(hostile.caps.autoApproveClasses, ['read', 'diff'], 'only read/diff are honoured from AEGIS_AUTO_APPROVE');
  assertEqual(hostile.caps.approvals.write, 'ask', 'AEGIS_AUTO_APPROVE cannot auto-approve writes');
  assertEqual(hostile.caps.approvals.shell, 'ask', 'AEGIS_AUTO_APPROVE cannot auto-approve shell');
  assertEqual(hostile.caps.approvals.network, 'ask', 'AEGIS_AUTO_APPROVE cannot auto-approve network');
  assertEqual(hostile.caps.approvals.diff, 'auto', 'the safe half of the request still lands');
  assert(hostile.ignored.some((s) => /write/.test(s)), 'the refused classes are reported to the caller');
  assertEqual(level.carveOuts(hostile.caps).length, 0, 'even a hostile override cannot produce a carve-out violation');

  const deduped = level.applyEnvOverrides(base, { AEGIS_AUTO_APPROVE: 'diff, diff ,DIFF' });
  assertDeep(deduped.caps.autoApproveClasses, ['read', 'diff'], 'duplicate override classes are deduped');

  const lowered = level.applyEnvOverrides(level.capabilities(30), { AEGIS_PROACTIVITY: 'off' });
  assertEqual(lowered.caps.proactivity, 'off', 'AEGIS_PROACTIVITY can lower proactivity');
  const raised = level.applyEnvOverrides(level.capabilities(1), { AEGIS_PROACTIVITY: 'brief' });
  assertEqual(raised.caps.proactivity, 'off', 'AEGIS_PROACTIVITY cannot raise proactivity past the earned ceiling');

  const nonsense = level.applyEnvOverrides(base, { AEGIS_PROACTIVITY: 'shout', AEGIS_MODEL_FLOOR: 'sentient' });
  assert(nonsense.ignored.some((s) => /shout/.test(s)), 'an unknown proactivity value is reported');
  assert(nonsense.ignored.some((s) => /sentient/.test(s)), 'an unknown model floor is reported');
  assertEqual(nonsense.caps.proactivity, base.proactivity, 'an unknown proactivity value changes nothing');

  const floored = level.applyEnvOverrides(level.capabilities(1), { AEGIS_MODEL_FLOOR: 'reasoning' });
  assertEqual(floored.caps.modelFloor, 'reasoning', 'CI can force the reasoning floor on');
  const unfloored = level.applyEnvOverrides(level.capabilities(30), { AEGIS_MODEL_FLOOR: 'none' });
  assertEqual(unfloored.caps.modelFloor, null, 'CI can turn the reasoning floor off');

  // Overrides return a copy; the ladder itself is never mutated by an env var.
  assertEqual(level.capabilities(3).recallEntries, base.recallEntries, 'applyEnvOverrides does not mutate its input');
}

console.log('avatar-level.test.mjs ok');
