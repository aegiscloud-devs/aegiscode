#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/cosmetics.js — the pack format and the line
 * the product is allowed to sell.
 *
 * The load-bearing tests are the REFUSALS. A validator that accepts the three
 * shipped packs proves only that the shipped set is well-formed; what matters is
 * that a pack carrying `xp`, a nested `grants` object, a `price`, or a `tier`
 * that contradicts the unlock table **cannot load at all**. Each case below
 * feeds a deliberately corrupt pack and asserts the rejection fires with a
 * message naming the offending field — so if a future edit loosens the check,
 * the test fails instead of the product quietly selling capability.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require = createRequire(import.meta.url);
const cosmetics = require('../lib/avatar/cosmetics.js');
const level = require('../lib/avatar/level.js');
const persona = require('../lib/avatar/persona.js');
const pane = require('../renderer/avatar/pane.js');

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

/** A valid basis for the tamper tests: every case below changes ONE thing. */
function basePack(over = {}) {
  return {
    schema: 1,
    id: 'test-pack',
    name: 'Test Pack',
    kind: 'outfit',
    tier: 'free',
    unlocks: ['outfit.hoodie'],
    items: [{ id: 'hoodie', label: 'Hoodie', parts: ['hoodie'] }],
    ...over,
  };
}

/** Validate a tampered pack and assert it was refused, naming `needle`. */
function assertRefused(pack, needle, why) {
  const result = cosmetics.validatePack(pack);
  assert(!result.ok, `refused: ${why}`);
  assertEqual(result.pack, null, `no pack object survives: ${why}`);
  assert(
    result.errors.some((e) => e.includes(needle)),
    `the error names ${needle}: ${why}\n  errors: ${JSON.stringify(result.errors)}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// 1. the shipped set loads, and stays on the right side of the line
// ---------------------------------------------------------------------------
{
  const loaded = cosmetics.loadPacks();
  assertDeep(loaded.rejected, [], 'every shipped pack validates');
  assertEqual(loaded.packs.length, 3, 'three packs ship (spec: 2–3, so the line is demonstrable)');
  assert(
    loaded.packs.some((p) => p.tier === 'paid') && loaded.packs.some((p) => p.tier === 'free'),
    'the shipped set contains both a free and a paid pack',
  );

  const audit = cosmetics.verifyShipped();
  assert(audit.ok, `the shipped set passes the boot audit: ${JSON.stringify(audit.violations)}`);
  assertEqual(audit.violations.length, 0, 'no violations');

  // Item ids must exist in the manifest this build renders from, or the user
  // pays for a set that draws nothing.
  for (const pack of loaded.packs) {
    for (const item of pack.items) {
      assert(item.known, `${pack.id}/${item.id} is a real ${pack.kind} id in persona.PARTS`);
      assert(item.label.length > 0, `${pack.id}/${item.id} has a human label`);
    }
  }

  // A pack may only reference the level table; it can never add to it.
  const unlockIds = new Set(level.UNLOCKS.map((u) => u.id));
  for (const row of cosmetics.catalog(loaded.packs)) {
    assert(unlockIds.has(row.unlockId), `${row.unlockId} exists in level.UNLOCKS`);
    assert(row.level !== null, `${row.unlockId} carries the level that earns it`);
  }

  const line = cosmetics.freePaidLine(loaded.packs);
  assert(line.free.length > 0, 'the free side of the line is populated');
  assert(line.paid.length > 0, 'the paid side of the line is populated');
  assert(line.paid.every((r) => r.paid === true), 'every paid row is backed by a paid unlock');
  assert(line.free.every((r) => r.paid === false), 'every free row is backed by a free unlock');

  // The demonstrable claim: a paid pack changes LOOKS only. Stated as data —
  // the paid unlock ids must be cosmetics ids and nothing else.
  const paidRows = line.paid.map((r) => r.unlockId);
  for (const n of [1, 10, 20, 35]) {
    const caps = level.capabilities(n);
    for (const id of paidRows) {
      assert(caps.cosmeticsUnlocked.includes(id) === (n >= 20), `L${n}: ${id} is earned by level, not bought`);
    }
    assert(!JSON.stringify(caps.approvals).includes('seasonal'), 'a paid pack never appears in the approval map');
    assert(caps.modelFloor === null || n >= 20, `L${n}: no paid cosmetic buys the model floor`);
  }
}

// ---------------------------------------------------------------------------
// 2. THE LINE — every way a pack could try to buy capability, refused
// ---------------------------------------------------------------------------
{
  assertRefused(basePack({ xp: 500 }), 'xp', 'a pack may not carry XP');
  assertRefused(basePack({ level: 40 }), 'level', 'a pack may not mint a level');
  assertRefused(basePack({ unlocks: ['outfit.seasonal'], tier: 'paid', recallEntries: 99 }), 'recallEntries', 'a pack may not widen recall');
  assertRefused(basePack({ approvals: { write: 'auto' } }), 'approvals', 'a pack may not loosen an approval');
  assertRefused(basePack({ toolGrants: ['queue.drain'] }), 'toolGrants', 'a pack may not grant a tool');
  assertRefused(basePack({ modelFloor: 'reasoning' }), 'modelFloor', 'a pack may not buy a model floor');
  assertRefused(basePack({ proactivity: 'brief' }), 'proactivity', 'a pack may not buy proactivity');
  assertRefused(basePack({ price: 4.99 }), 'price', 'pricing lives in the store, not in the artifact');
  assertRefused(basePack({ entitlement: 'pro' }), 'entitlement', 'entitlement lives in the store, not in the artifact');
  assertRefused(basePack({ sku: 'aegis-winter' }), 'sku', 'a pack cannot name its own SKU');

  // Depth and casing are not an escape hatch: the scan is recursive and
  // case-insensitive, because "we only check the top level" is the defect a
  // reviewer would never see.
  assertRefused(
    basePack({ items: [{ id: 'hoodie', label: 'Hoodie', grants: { write: 'auto' } }] }),
    'items.0.grants',
    'a nested grant is caught, with its path',
  );
  assertRefused(
    basePack({ items: [{ id: 'hoodie', label: 'Hoodie', meta: { nested: { XP: 40 } } }] }),
    'items.0.meta.nested.XP',
    'a deeply nested, upper-cased XP is caught',
  );
  assertRefused(
    basePack({ unlocks: ['outfit.seasonal'], tier: 'paid', items: [{ id: 'seasonal-winter', autoApproveClasses: ['write'] }] }),
    'autoApproveClasses',
    'the camelCase form of an approval field is caught',
  );

  // Tier is a claim ABOUT the level table, and a false one is a hard error in
  // both directions — "paid" for something the level table gives away, and
  // "free" for something it charges for.
  assertRefused(basePack({ tier: 'paid' }), 'contradicts unlock outfit.hoodie', 'free unlock cannot be sold');
  assertRefused(
    basePack({ tier: 'free', unlocks: ['outfit.seasonal'], items: [{ id: 'seasonal-winter' }] }),
    'contradicts unlock outfit.seasonal',
    'a paid unlock cannot be given away by a free pack',
  );
  assertRefused(basePack({ unlocks: ['outfit.invisible-hat'] }), 'unknown unlock', 'a pack cannot invent an unlock');
  assertRefused(basePack({ unlocks: [] }), 'at least one unlock', 'a pack that grants nothing is not a pack');
  assertRefused(basePack({ unlocks: ['palette.amber'] }), 'not a outfit unlock', 'a pack may only gate its own kind');
  // Control: the same shape with a matching kind IS accepted, so the refusal
  // above is about the mismatch and not about palettes being unsupported.
  const palettePack = cosmetics.validatePack(
    basePack({ kind: 'palette', unlocks: ['palette.amber'], items: [{ id: 'amber', label: 'Amber' }] }),
  );
  assert(palettePack.ok, `an honest palette pack is accepted: ${JSON.stringify(palettePack.errors)}`);

  // Structural refusals.
  assertEqual(cosmetics.validatePack(null).ok, false, 'null is not a pack');
  assertEqual(cosmetics.validatePack('{"id":"x"}').ok, false, 'a string is not a pack');
  assertEqual(cosmetics.validatePack([basePack()]).ok, false, 'an array is not a pack');
  assertRefused(basePack({ schema: 2 }), 'newer than this build', 'a future schema is reported, not guessed at');
  assertRefused(basePack({ id: 'Seasonal Winter!' }), 'kebab-case slug', 'ids are slugs');
  assertRefused(basePack({ name: '' }), 'needs a name', 'a pack needs a name');
  assertRefused(basePack({ kind: 'skin' }), 'kind must be one of', 'unknown kinds are refused');
  assertRefused(basePack({ tier: 'expensive' }), 'tier must be', 'unknown tiers are refused');
  assertRefused(basePack({ items: [] }), 'at least one item', 'a pack needs items');
  assertRefused(
    basePack({ items: Array.from({ length: cosmetics.LIMITS.items + 1 }, (_, i) => ({ id: `hat-${i}` })) }),
    'at most',
    'the item cap is enforced',
  );

  // Voice packs: local only, synthetic only. There is no field for a sample.
  assertRefused(
    basePack({ kind: 'voice', unlocks: ['voice.core'], items: [{ id: 'aegis-neutral', engine: 'local' }] }),
    'consent: "synthetic"',
    'a voice item must declare synthetic provenance',
  );
  assertRefused(
    basePack({ kind: 'voice', unlocks: ['voice.core'], items: [{ id: 'my-friend', engine: 'cloud', consent: 'synthetic' }] }),
    'voice never leaves the device',
    'a voice item cannot name a remote engine',
  );
  assertRefused(
    basePack({ kind: 'voice', unlocks: ['voice.core'], items: [{ id: 'aegis-neutral', engine: 'local', consent: 'synthetic', sampleUrl: 'https://example.com/me.wav' }] }),
    'sampleUrl',
    'a voice pack cannot carry a recording of a person',
  );
  const voicePack = cosmetics.validatePack(
    basePack({ kind: 'voice', unlocks: ['voice.core'], items: [{ id: 'aegis-neutral', engine: 'local', consent: 'synthetic' }] }),
  );
  assert(voicePack.ok, `an honest voice pack loads: ${JSON.stringify(voicePack.errors)}`);
  assertEqual(voicePack.pack.items[0].consent, 'synthetic', 'consent survives normalisation for the boot audit');
  assertEqual(cosmetics.auditPacks([voicePack.pack]).length, 0, 'and the audit agrees');
  assert(
    cosmetics.auditPacks([{ ...voicePack.pack, items: [{ id: 'x', engine: 'local' }] }]).some((v) => /not declared synthetic/.test(v)),
    'the boot audit re-checks consent rather than trusting the validator',
  );

  // `auditPacks` is a second opinion on raw shapes too (a hand-built pack object
  // that never went through validatePack).
  assert(
    cosmetics.auditPacks([{ id: 'sneaky', tier: 'free', unlocks: ['outfit.seasonal'], kind: 'outfit', items: [] }]).length > 0,
    'the audit catches a hand-assembled pack the validator would have refused',
  );
  assertEqual(cosmetics.auditPacks([]).length, 0, 'no packs, no violations');
}

// ---------------------------------------------------------------------------
// 3. repair, not rejection, for the things a newer build may not know
// ---------------------------------------------------------------------------
{
  const newer = cosmetics.validatePack(
    basePack({ items: [{ id: 'hoodie' }, { id: 'jetpack-9', label: 'Jetpack' }] }),
  );
  assert(newer.ok, 'a pack naming a part this build has no art for still loads');
  assertEqual(newer.pack.items.length, 2, 'its items are kept');
  assertEqual(newer.pack.items[0].known, true, 'known item flagged known');
  assertEqual(newer.pack.items[1].known, false, 'unknown item flagged, not dropped');
  assert(newer.warnings.some((w) => /jetpack-9/.test(w)), 'the unknown item is reported to the user');

  const dupes = cosmetics.validatePack(basePack({ items: [{ id: 'hoodie' }, { id: 'hoodie' }] }));
  assertEqual(dupes.pack.items.length, 1, 'duplicate items are deduped');
  assert(dupes.warnings.some((w) => /duplicate/.test(w)), 'and reported');

  const junk = cosmetics.validatePack(basePack({ tagline: 'buy now' }));
  assertEqual(Object.prototype.hasOwnProperty.call(junk.pack, 'tagline'), false, 'unknown keys are dropped');
  assert(junk.warnings.some((w) => /tagline/.test(w)), 'and reported');

  const sloppy = cosmetics.validatePack(basePack({ items: [{ id: 'hoodie', label: '  Hoodie\n  (warm)  ' }] }));
  assertEqual(sloppy.pack.items[0].label, 'Hoodie (warm)', 'labels are flattened to one clean line');

  // Defaults: a minimal-but-honest pack validates rather than being rejected for
  // missing prose.
  const minimal = cosmetics.validatePack(basePack());
  assert(minimal.ok, 'metadata is optional');
  assertEqual(minimal.pack.author, '', 'missing author is empty, not undefined');
  assertEqual(minimal.pack.items[0].label, 'Hoodie', 'a missing label falls back to the id');
}

// ---------------------------------------------------------------------------
// 4. loading from disk: one bad file never takes the good ones down
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-packs-'));
  fs.writeFileSync(path.join(dir, 'good.pack.json'), JSON.stringify(basePack()));
  fs.writeFileSync(path.join(dir, 'broken.pack.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'hostile.pack.json'), JSON.stringify(basePack({ id: 'hostile', xp: 10 })));
  fs.writeFileSync(path.join(dir, 'notes.json'), 'this is not a pack and must not be parsed');
  fs.writeFileSync(path.join(dir, 'README.md'), '# packs');

  const loaded = cosmetics.loadPacks(dir);
  assertEqual(loaded.packs.length, 1, 'the good pack loads');
  assertEqual(loaded.packs[0].id, 'test-pack', 'and it is the right one');
  assertEqual(loaded.rejected.length, 2, 'the unparseable and the hostile pack are both rejected');
  assert(loaded.rejected.some((r) => r.file === 'broken.pack.json'), 'invalid JSON is reported by file');
  assert(
    loaded.rejected.some((r) => r.file === 'hostile.pack.json' && r.errors.some((e) => /xp/.test(e))),
    'the hostile pack is rejected for the right reason',
  );

  const missing = cosmetics.loadPacks(path.join(dir, 'nope'));
  assertDeep(missing.packs, [], 'a missing directory yields no packs');
  assert(missing.warnings.length > 0, 'and says so instead of throwing');

  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 5. the vocabulary cannot drift from the renderer's gating lookup
// ---------------------------------------------------------------------------
{
  assertDeep(
    pane.UNLOCK_ALIASES,
    cosmetics.UNLOCK_ALIASES,
    'the pane and the pack format share one alias table (persona id → unlock id)',
  );

  // Every aliased persona id must be a real manifest id AND a real unlock.
  const unlockIds = new Set(level.UNLOCKS.map((u) => u.id));
  for (const [key, unlockId] of Object.entries(cosmetics.UNLOCK_ALIASES)) {
    const [kind, itemId] = key.split('.');
    assert(persona.PARTS[kind].includes(itemId), `${key} is a real ${kind} id`);
    assert(unlockIds.has(unlockId), `${key} → ${unlockId} is a real unlock`);
  }

  // The shipped paid pack's item is reachable through the pane's gating path:
  // its derived unlock id must be the paid one, or the pack would render as free.
  const seasonal = cosmetics.shippedPacks().find((p) => p.id === 'seasonal-winter');
  assertEqual(seasonal.items[0].unlock, 'outfit.seasonal', 'the seasonal coat maps to the paid unlock');
  const caps = level.capabilities(1);
  assert(
    !caps.cosmeticsUnlocked.includes(seasonal.items[0].unlock),
    'and at level 1 it is locked, which is what makes it worth paying for',
  );
}

console.log('avatar-cosmetics.test.mjs ok');
