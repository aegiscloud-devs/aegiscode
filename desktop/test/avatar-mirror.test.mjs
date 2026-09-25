#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/mirror.js — the per-holder cloud mirror
 * (PLAN Phase 29.1; docs/avatar-identity-plan.md §6).
 *
 * The load-bearing leg is the ORDERING test. Two machines that both appended to
 * one holder's ledger reconcile in either order, and the level must be the same
 * both ways — that is what "the ledger is append-only and order-independent"
 * means when it is a claim rather than a hope. The second leg is its negative
 * control: the union fed back in must not change the level, because a mirror
 * that double-counts a row would inflate a level every time it synced.
 *
 * The other three legs are refusals: a fingerprint cannot name a session (it
 * would orphan the mirror on key rotation), a foreign holder's rows are never
 * read, and a synced `facets` blob is dropped because facets refold locally.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const mirror = require('../lib/avatar/mirror.js');
const xp = require('../lib/avatar/xp.js');
const profile = require('../lib/avatar/profile.js');

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
  if (a !== b) throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${b}\n  actual:   ${a}`);
}
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-mirror-'));
}

const A = 'h_7f3a91c2ab44';
const B = 'h_1c04bb77de91';
const T0 = 1730000000000;

/** Three real, priced events — the kinds `xp.js` pays for. */
function machineOne() {
  return [
    { v: 1, t: T0, kind: 'memory.saved', ref: 'e-1', xp: 10 },
    { v: 1, t: T0 + 1000, kind: 'memory.recalled', ref: 'e-1', xp: 2 },
  ];
}
function machineTwo() {
  return [
    { v: 1, t: T0 + 2000, kind: 'memory.recalled', ref: 'e-2', xp: 2 },
    { v: 1, t: T0 + 3000, kind: 'memory.corrected', ref: 'e-2', xp: 6 },
  ];
}

// ---------------------------------------------------------------------------
// 1. sessions are named by holder id, never by a fingerprint
// ---------------------------------------------------------------------------

{
  const scope = mirror.scopeFor(A);
  assertEqual(scope.ledger, `avatar:ledger:${A}`, 'the ledger session names the holder');
  assertEqual(scope.profile, `avatar:profile:${A}`, 'the profile session names the holder');
  assertDeep(scope.sessions, [`avatar:ledger:${A}`, `avatar:profile:${A}`], 'both sessions, in a stable order');
  assertEqual(mirror.sessionFor(A, 'profile'), `avatar:profile:${A}`, 'explicit profile kind');
  assertEqual(mirror.sessionFor(A, 'nonsense'), `avatar:ledger:${A}`, 'an unknown kind falls back to ledger, not a third namespace');

  // A fingerprint is not a holder id: `avatar:ledger:<fingerprint>` would orphan
  // every mirrored row the moment the key rotated (§6). Refused by shape.
  const fingerprint = 'a3f1c8d90b21';
  assert(!/^h_/.test(fingerprint), 'the fixture really is a fingerprint, not an id');
  let refused = false;
  try {
    mirror.sessionFor(fingerprint);
  } catch (err) {
    refused = /holder id/.test(err.message);
  }
  assert(refused, 'a fingerprint is refused as a session name, by shape');
  let refusedAgain = false;
  try {
    mirror.sessionFor(`h_${'z'.repeat(12)}`);
  } catch (err) {
    refusedAgain = true;
  }
  assert(refusedAgain, 'a non-hex holder-shaped id is refused too');

  const named = mirror.holderOfSession(`avatar:ledger:${A}`);
  assertDeep(named, { holderId: A, kind: 'ledger' }, 'a session parses back to its holder');
  assertEqual(mirror.holderOfSession('chat:1234'), null, 'an ordinary memory session names no holder');
}

// ---------------------------------------------------------------------------
// 2. THE ORDERING LEG — both interleavings reconcile to one level
// ---------------------------------------------------------------------------

{
  const one = machineOne();
  const two = machineTwo();

  const forwards = mirror.reconcile(one, two);
  const backwards = mirror.reconcile(two, one);

  assertDeep(forwards.ids, backwards.ids, 'the union is byte-identical in either order');
  assertDeep(forwards.rows, backwards.rows, 'and so are the rows');
  assertEqual(
    mirror.levelFor(forwards.rows),
    mirror.levelFor(backwards.rows),
    'two machines that appended in opposite orders agree on the level'
  );
  assertEqual(forwards.rows.length, 4, 'the union keeps every distinct row');
  assertEqual(forwards.added, 4, 'all four rows are new to the other side');
  assertEqual(forwards.shared, 0, 'nothing was shared yet');
  assertEqual(forwards.dropped, 0, 'nothing malformed was dropped');
  assertDeep(xp.evaluate(forwards.rows).level, xp.evaluate(backwards.rows).level, 'and on the same derive() output');

  // The negative control: feed the union back in as both sides. A mirror that
  // double-counts would move the level here — that is the failure that hurts.
  const again = mirror.reconcile(forwards.rows, forwards.rows);
  assertDeep(again.rows, forwards.rows, 'reconciling the union with itself changes nothing');
  assertEqual(again.shared, 4, 'and every row is recognised as shared');
  assertEqual(mirror.levelFor(again.rows), mirror.levelFor(forwards.rows), 'the level is stable across a re-sync');

  // A three-way interleaving of the same rows in a shuffled order: same level.
  const shuffled = [...one, ...two].slice().reverse();
  assertEqual(mirror.levelFor(mirror.reconcile(shuffled, []).rows), mirror.levelFor(forwards.rows), 'a reversed input is the same level');

  // Same id, different payload (a row the cloud already gave an id to): the
  // deterministic winner is the same from either side. Content-addressed ids
  // cannot collide here by construction — different rows simply differ — so
  // this leg uses the `id` an explicit-id row carries.
  const a = { id: 'row-9', v: 1, t: T0, kind: 'memory.saved', ref: 'e-9', xp: 10 };
  const b = { id: 'row-9', v: 1, t: T0, kind: 'memory.saved', ref: 'e-9', xp: 10, note: 'extra' };
  const ab = mirror.reconcile([a], [b]);
  const ba = mirror.reconcile([b], [a]);
  assertEqual(ab.conflicts.length, 1, 'a same-id/different-payload pair is reported as a conflict');
  assertDeep(ab.rows, ba.rows, 'and resolved identically from either side');
  assertEqual(ab.rows.length, 1, 'a conflict still yields one row, never two');
  assertEqual(ab.rows[0].note, 'extra', 'the richer payload wins, deterministically');
}

// ---------------------------------------------------------------------------
// 3. a foreign holder's rows are never read; a blob is never applied
// ---------------------------------------------------------------------------

{
  const one = machineOne();
  const pushed = one.map((row) => mirror.encodeRow('ledger', row, A));
  assert(pushed.every(Boolean), 'every ledger row encodes');
  assertDeep(pushed.map((row) => row.session), one.map(() => `avatar:ledger:${A}`), 'each row lands in the holder session');
  assertEqual(pushed[0].id, mirror.rowId(one[0]), 'the memory row id IS the mirror row id (union-by-row-id)');
  const decoded = mirror.decodeRow(pushed[0], A);
  assert(decoded.ok && decoded.kind === 'ledger', 'a pushed row decodes back');
  assertDeep(decoded.row, one[0], 'round-trip is lossless');

  // The same batch read as holder B: every row is foreign (and dropped).
  const mine = mirror.readMirror(pushed, A);
  const theirs = mirror.readMirror(pushed, B);
  assertEqual(mine.ledger.length, one.length, 'holder A reads its own mirror');
  assertEqual(theirs.ledger.length, 0, 'holder B reads none of it');
  assertEqual(theirs.foreign.length, one.length, 'and every row is classified foreign, not silently ignored');

  // A synced profile blob: recognised, refused, and never folded in.
  const blob = {
    id: 'blob-1',
    session: `avatar:profile:${A}`,
    content: JSON.stringify({ mirror: 'profile', row: { facets: [{ id: 'vocabulary', key: 'engine', value: 'LEAKED', sources: ['e-9'] }] } }),
  };
  const read = mirror.readMirror([blob], A);
  assertEqual(read.blobs.length, 1, 'a facets payload is classified as a blob');
  assert(read.blobs[0].includes('refold locally'), 'and the reason says why');

  const entries = [
    { id: 'e-1', content: 'the repo calls it the engine, not the CLI', session: 'chat:1', holder: A, t: T0 },
    { id: 'e-2', content: 'ship the mirror behind the sync switch', session: 'chat:1', holder: A, t: T0 + 1 },
    { id: 'e-3', content: 'holder B dropped this row', session: 'chat:9', holder: B, t: T0 + 2 },
  ];
  const folded = mirror.refold({ holder: A, entries, ledger: one, remote: read, now: T0 + 5000 });
  assert(folded.refused.some((why) => why.includes('refold locally')), 'refold records that it refused the synced blob');
  // A caller that hands the blob over directly is refused just as loudly.
  const direct = mirror.refold({ holder: A, entries, ledger: one, remote: { profile: { facets: [{ id: 'vocabulary', value: 'LEAKED' }] } } });
  assert(direct.refused.some((why) => why.includes('dropped remote profile')), 'a directly supplied profile blob is dropped too');
  assert(!JSON.stringify(direct.profile).includes('LEAKED'), 'and its facets never reach the fold');
  assert(!JSON.stringify(folded.profile).includes('LEAKED'), 'the blob\'s value never reaches the fold');
  assertEqual(folded.orphaned.length, 0, 'every facet cites an entry that is present locally');
  const cited = new Set(folded.profile.facets.flatMap((facet) => facet.sources));
  assert(!cited.has('e-3'), 'holder B\'s entry is never citable');
  for (const id of cited) assert(['e-1', 'e-2'].includes(id), `cited id ${id} is holder A's`);

  // Negative control: the same fold WITHOUT the rows it cites loses the facet —
  // proof the facet is derived locally rather than copied from the payload.
  const noEntries = mirror.refold({ holder: A, entries: [], ledger: one, remote: read, now: T0 + 5000 });
  assertEqual(noEntries.profile.facets.length, 0, 'with no entries there are no facets, blob or not');
  assertEqual(noEntries.profile.coldStart, true, 'and the profile reads as a cold start');
}

// ---------------------------------------------------------------------------
// 4. entry rows travel for the fold, but only stamped ones
// ---------------------------------------------------------------------------

{
  const entries = [
    { id: 'e-1', content: 'a holder A note', holder: A, t: T0 },
    { id: 'e-2', content: 'a holder B note', holder: B, t: T0 },
    { id: 'e-3', content: 'an unattributed legacy note', t: T0 },
  ];
  const plan = mirror.pushPlan({ holderId: A, ledger: machineOne() }, { entries });
  assert(plan.ok, 'the push plan is built');
  assertDeep(plan.sessions, [`avatar:ledger:${A}`, `avatar:profile:${A}`], 'the push names both reserved sessions');
  const entryRows = plan.rows.filter((row) => row.session === `avatar:profile:${A}`);
  assertEqual(entryRows.length, 2, 'holder A\'s entry and the unattributed one travel; B\'s does not');
  assert(!plan.rows.some((row) => String(row.content).includes('holder B note')), 'holder B\'s text never enters the plan');

  // A row carrying key material is refused rather than mirrored. The value is
  // assembled at runtime on purpose: `.githooks/pre-commit` scans staged text for
  // `sk-[A-Za-z0-9]{16,}` and would (correctly, if bluntly) refuse to commit the
  // test that proves the refusal — the assembled value is byte-identical to the
  // one the guard hunts for, so the assertion below still exercises the real path.
  const keyShaped = ['sk', 'abcdefghijklmnopqrstuvwxyz012345'].join('-');
  const withKey = mirror.encodeRow('ledger', { t: T0, kind: 'memory.saved', ref: keyShaped }, A);
  assertEqual(withKey, null, 'a row carrying something key-shaped is refused');
}

// ---------------------------------------------------------------------------
// 5. the delete queue is scoped, durable and honest about failure
// ---------------------------------------------------------------------------

{
  const dir = tempDir();
  const first = mirror.queueDelete(dir, A, { t: T0, reason: 'holder-forgotten' });
  assert(first.ok, 'the delete is queued');
  assertDeep(first.sessions, [`avatar:ledger:${A}`, `avatar:profile:${A}`], 'scoped to the holder\'s two sessions');
  assert(!JSON.stringify(first.rows).includes(B), 'nothing about another holder is queued');
  assertEqual(mirror.queueDelete(dir, A, { t: T0 + 1 }).duplicate, true, 'queueing again is idempotent');
  mirror.queueDelete(dir, B, { t: T0 + 2 });
  assertEqual(mirror.readDeleteQueue(dir).length, 2, 'two holders, two requests');

  // A delete that fails stays pending: an offline machine must not forget what
  // it owes the cloud (the same rule as lib/sync/memory-queue.js).
  const failed = await mirror.drainDeleteQueue(dir, async (session) => {
    if (session.endsWith(A)) throw new Error('offline');
  });
  assertEqual(failed.ok, false, 'a failed drain reports failure');
  assertEqual(failed.failed, 2, 'both of A\'s reserved sessions are reported as failed');
  assertEqual(failed.deleted, 2, 'and both of B\'s succeeded — the drain is per session, not all-or-nothing');
  const afterFail = mirror.readDeleteQueue(dir);
  assertEqual(afterFail.filter((row) => row.holderId === A && !row.done).length, 1, 'A\'s request is still pending');
  assertEqual(afterFail.filter((row) => row.holderId === B && row.done).length, 1, 'B\'s request completed');
  assertDeep(afterFail.find((row) => row.holderId === B).deleted, [`avatar:ledger:${B}`, `avatar:profile:${B}`], 'and records what it deleted');

  const retry = await mirror.drainDeleteQueue(dir, async () => {});
  assertEqual(retry.ok, true, 'a retry with the network back drains what is left');
  assertEqual(mirror.readDeleteQueue(dir).every((row) => row.done), true, 'nothing is left pending');

  // The queue file lives above the holder directories, so a forget that removes
  // the directory cannot remove the request with it.
  assertEqual(path.basename(mirror.deleteQueuePath(dir)), mirror.DELETE_FILE, 'the queue file is the documented one');
  assert(!mirror.deleteQueuePath(dir).includes('/holders/'), 'and it lives outside every holder directory');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 6. the mirrored rows are the ones the profile actually folds
// ---------------------------------------------------------------------------

{
  // A round trip through the wire format must reproduce the same profile the
  // local fold produces: the mirror carries inputs, so the fold is identical.
  const entries = [
    { id: 'e-1', content: 'use the engine name, not the CLI', holder: A, t: T0 },
    { id: 'e-2', content: 'the engine lives in aegiscodex-dev', holder: A, t: T0 + 1 },
    { id: 'e-3', content: 'engine, engine, engine', holder: A, t: T0 + 2 },
    { id: 'e-4', content: 'ship the engine', holder: A, t: T0 + 3 },
    { id: 'e-5', content: 'the engine again', holder: A, t: T0 + 4 },
  ];
  const ledger = machineOne();
  const local = profile.fold({ holder: A, entries, ledger, now: T0 + 10 });
  const arrived = entries.map((entry) => mirror.decodeRow(mirror.encodeRow('entry', entry, A), A));
  assert(arrived.every((row) => row.ok), 'every entry row decodes');
  const remote = {
    ledger: ledger.map((row) => mirror.decodeRow(mirror.encodeRow('ledger', row, A), A).row),
    entries: arrived.map((row) => row.row),
  };
  const folded = mirror.refold({ holder: A, entries: [], ledger: [], remote, now: T0 + 10 });
  assertDeep(folded.profile.facets, local.profile.facets, 'a mirror round trip folds to the same facets as the local fold');
}

console.log('avatar-mirror.test.mjs ok');
