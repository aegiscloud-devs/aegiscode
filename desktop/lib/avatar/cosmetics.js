'use strict';

/**
 * cosmetics.js — the cosmetics pack format and its validator (Phase 24).
 *
 * WHY A FORMAT AT ALL. Spec §3 says the avatar is *data, not art*: a persona is
 * one JSON record and a look is a layered SVG assembled from a part manifest, so
 * "adding a seasonal set" is adding a file. `lib/avatar/packs/*.pack.json` is
 * that file's shape. A pack is deliberately DUMB — ids, labels and the parts that
 * compose a look — because a pack the user can hand-edit is a pack that can be
 * checked, and a pack that could do something is a pack that could be a bug.
 *
 * THE PAYWALL LINE IS A VALIDATOR RULE, NOT A PROMISE (spec §3, §6, invariant 8:
 * *sell cosmetics only — never XP, levels, recall breadth, approval friction or
 * personalization*). `level.js` owns the unlock table; a pack never declares its
 * own price or its own entitlement, it only *references* an unlock id that must
 * already exist there, and `validatePack` refuses the pack unless the unlock's
 * `paid` flag agrees with the pack's tier and its namespace agrees with the
 * pack's kind. `auditPacks` then sweeps the whole pack for anything that smells
 * like capability — `xp`, `recallEntries`, `approvals`, `toolGrants`,
 * `modelFloor`, `price`, `entitlement`, … — recursively, at any depth, under any
 * casing. So a future "paid pack that also raises your recall limit" is not a
 * policy violation somebody has to notice in review: it is a pack that fails to
 * load. That is the same trick `level.js` uses for the approval carve-outs (make
 * the wrong thing unrepresentable) applied to the thing the product sells.
 *
 * Validation is REPAIR-ORIENTED like `persona.js`, with the difference that the
 * hard errors are the point: a pack is an artifact, not the user's own file, so
 * an unrepairable pack is dropped (`ok: false`, `pack: null`) rather than coerced
 * into something that ships. Unknown *item* ids are the one soft case — a pack
 * from a newer build should load with a warning and render the parts it does
 * know, rather than blanking a look the user paid for.
 *
 * Pure apart from `loadPacks`/`shippedPacks`, which read the packs directory and
 * are the only reason `node:fs` is imported at all. No Electron, no settings.
 */

const fs = require('node:fs');
const path = require('node:path');
const personaModule = require('./persona.js');
const level = require('./level.js');

/** Bump when the record shape changes. A newer pack is reported, not guessed at. */
const SCHEMA_VERSION = 1;

/** What a pack may be *about*. One pack, one kind — a mixed pack cannot be gated. */
const KINDS = Object.freeze(['outfit', 'expressions', 'palette', 'voice']);

/** Free or paid. `paid` is a claim ABOUT the unlock table, verified below. */
const TIERS = Object.freeze(['free', 'paid']);

/**
 * Pack kind → the unlock-id namespace it is allowed to reference. `expressions`
 * is plural in the persona and singular in the unlock table (`expression.core`);
 * that mismatch is exactly why this table exists rather than a `startsWith`.
 */
const KIND_UNLOCK_PREFIX = Object.freeze({
  outfit: 'outfit',
  expressions: 'expression',
  palette: 'palette',
  voice: 'voice',
});

/** Kind → the `persona.PARTS` list an item id must be drawn from. */
const KIND_PART_LIST = Object.freeze({
  outfit: 'outfit',
  expressions: 'expressionPack',
  palette: 'palette',
  voice: null, // voices are not persona parts — see voice.js / BUILTIN_VOICES
});

/**
 * Persona ids and unlock ids are not the same vocabulary — a seasonal SET is
 * `seasonal-winter` in the persona and `outfit.seasonal` in the level table.
 * This is the canonical alias table; `renderer/avatar/pane.js` carries the same
 * pair for the gating lookup and `test/avatar-cosmetics.test.mjs` asserts the
 * two agree, so the tables cannot drift apart silently.
 */
const UNLOCK_ALIASES = Object.freeze({
  'outfit.seasonal-winter': 'outfit.seasonal',
  'outfit.archive-coat': 'outfit.archive',
});

/**
 * Keys a pack may NEVER carry, matched case-insensitively and at ANY depth.
 * Every entry here is a field some other module reads to decide what the user
 * is allowed to do: `capabilities()` in level.js, the tool gate, the model
 * picker, the recall path — plus the money fields, because pricing and
 * entitlement live in the store, never in an artifact the user can edit.
 */
const FORBIDDEN_KEYS = Object.freeze([
  'xp', 'xpbonus', 'xpmultiplier', 'level', 'levels', 'unlocklevel', 'minlevel', 'maxlevel',
  'recall', 'recallentries', 'recalltokens', 'memory', 'memorywriteback',
  'approval', 'approvals', 'autoapprove', 'autoapproveclasses', 'approvalfriction',
  'grant', 'grants', 'toolgrant', 'toolgrants', 'capability', 'capabilities',
  'offdevice', 'offdevicegrants', 'modelfloor', 'proactivity', 'queuedrain',
  'importassistant', 'tokens', 'budget', 'pricetokens',
  'price', 'prices', 'amount', 'currency', 'cost', 'sku', 'entitlement', 'entitlements',
  'checkout', 'purchase', 'subscription', 'trial',
  // the clone vectors (non-goal: "no voice cloning of real people")
  'sample', 'samples', 'sampleurl', 'recording', 'recordingurl', 'sourceaudio', 'voiceprint',
]);

/** Second net: any key we did not name but that reads like a capability knob. */
const FORBIDDEN_KEY_PATTERN = /(xp|level|recall|approval|grant|capabilit|offdevice|proactiv|entitlement|price|clone|voiceprint)/i;

/** Structural caps. A pack is a cosmetics artifact, not a distribution channel. */
const LIMITS = Object.freeze({
  id: 48,
  name: 60,
  label: 48,
  summary: 240,
  author: 60,
  license: 40,
  unlocks: 8,
  items: 24,
  parts: 6,
});

/** Only files matching this suffix are loaded — a stray README.json is not a pack. */
const PACK_SUFFIX = '.pack.json';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The unlock row behind an id, or null. The level table is the only authority. */
function unlockById(id) {
  return level.UNLOCKS.find((u) => u.id === id) || null;
}

/** `outfit.seasonal-winter` → `outfit.seasonal` for the ones that differ. */
function unlockIdFor(kind, itemId) {
  return UNLOCK_ALIASES[`${kind}.${itemId}`] || `${kind}.${itemId}`;
}

/**
 * Every forbidden key in a pack-shaped value, at any depth.
 *
 * @param {unknown} node
 * @param {string} [at] path prefix, for the error message
 * @returns {string[]} dotted paths, e.g. `["items.2.grants"]`
 */
function forbiddenKeys(node, at = '') {
  const hits = [];
  if (Array.isArray(node)) {
    node.forEach((child, i) => hits.push(...forbiddenKeys(child, `${at}${at ? '.' : ''}${i}`)));
    return hits;
  }
  if (!isPlainObject(node)) return hits;
  for (const [key, value] of Object.entries(node)) {
    const here = `${at}${at ? '.' : ''}${key}`;
    const flat = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (FORBIDDEN_KEYS.includes(flat) || FORBIDDEN_KEY_PATTERN.test(key)) hits.push(here);
    hits.push(...forbiddenKeys(value, here));
  }
  return hits;
}

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // Same treatment as persona text: a pack label lands in a UI (and, for an
  // expression pack, eventually in a tooltip), so it stays one clean line.
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate one pack.
 *
 * @param {unknown} raw parsed JSON (or anything hand-written)
 * @returns {{ ok: boolean, pack: object|null, errors: string[], warnings: string[],
 *            forbidden: string[] }}
 *   `ok: false` means DO NOT ship it: `pack` is null and `errors` says why. The
 *   split between errors and warnings is deliberate — an unknown *item id* is a
 *   warning (a newer build's part renders as a label with no art), while
 *   anything touching the paywall line is an error.
 */
function validatePack(raw) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      pack: null,
      errors: ['cosmetics pack must be a JSON object'],
      warnings,
      forbidden: [],
    };
  }

  // --- the line, checked before anything structural ------------------------
  const forbidden = forbiddenKeys(raw);
  for (const where of forbidden) {
    errors.push(
      `cosmetics packs may not carry \`${where}\` — a pack sells LOOKS only, never XP, ` +
        'levels, recall breadth, approval friction or personalization (docs/avatar-plan.md §3)',
    );
  }

  if (Number.isInteger(raw.schema) && raw.schema > SCHEMA_VERSION) {
    errors.push(`pack schema ${raw.schema} is newer than this build supports (${SCHEMA_VERSION})`);
  }

  // --- identity -----------------------------------------------------------
  const id = clean(raw.id, LIMITS.id);
  if (!id || !SLUG.test(id)) {
    errors.push(`pack id must be a kebab-case slug (got ${JSON.stringify(raw.id)})`);
  }
  const name = clean(raw.name, LIMITS.name);
  if (!name) errors.push('pack needs a name');

  const kind = KINDS.includes(raw.kind) ? raw.kind : null;
  if (!kind) errors.push(`pack kind must be one of ${KINDS.join(' | ')} (got ${JSON.stringify(raw.kind)})`);

  const tier = TIERS.includes(raw.tier) ? raw.tier : null;
  if (!tier) errors.push(`pack tier must be "free" or "paid" (got ${JSON.stringify(raw.tier)})`);

  // --- unlocks: the only thing that makes a pack free or paid --------------
  const rawUnlocks = Array.isArray(raw.unlocks) ? raw.unlocks : [];
  const unlocks = [];
  if (!rawUnlocks.length) {
    errors.push('pack must reference at least one unlock id from lib/avatar/level.js (a pack cannot create one)');
  }
  if (rawUnlocks.length > LIMITS.unlocks) {
    errors.push(`at most ${LIMITS.unlocks} unlocks per pack (got ${rawUnlocks.length})`);
  }
  for (const rawUnlock of rawUnlocks.slice(0, LIMITS.unlocks)) {
    const unlock = unlockById(rawUnlock);
    if (!unlock) {
      errors.push(
        `unknown unlock ${JSON.stringify(rawUnlock)} — the level table (level.js UNLOCKS) is the only ` +
          'authority on what exists and what is paid',
      );
      continue;
    }
    if (kind && unlock.id.split('.')[0] !== KIND_UNLOCK_PREFIX[kind]) {
      errors.push(`${unlock.id} is not a ${kind} unlock — a pack may only gate its own kind`);
    }
    if (tier && unlock.paid !== (tier === 'paid')) {
      errors.push(
        `tier "${tier}" contradicts unlock ${unlock.id} (paid: ${unlock.paid}) — ` +
          'the level table decides what is paid, not the pack',
      );
    }
    if (!unlocks.includes(unlock.id)) unlocks.push(unlock.id);
  }

  // --- items --------------------------------------------------------------
  const partListName = kind ? KIND_PART_LIST[kind] : null;
  const partList = partListName ? personaModule.PARTS[partListName] : null;
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  if (!rawItems.length) errors.push('pack needs at least one item');
  if (rawItems.length > LIMITS.items) errors.push(`at most ${LIMITS.items} items per pack (got ${rawItems.length})`);

  const items = [];
  const seen = new Set();
  for (const rawItem of rawItems.slice(0, LIMITS.items)) {
    if (!isPlainObject(rawItem)) {
      warnings.push('a non-object item was dropped');
      continue;
    }
    const itemId = clean(rawItem.id, LIMITS.id);
    if (!itemId || !SLUG.test(itemId)) {
      warnings.push(`item id must be a kebab-case slug (got ${JSON.stringify(rawItem.id)}) — dropped`);
      continue;
    }
    if (seen.has(itemId)) {
      warnings.push(`duplicate item ${itemId} — dropped`);
      continue;
    }
    seen.add(itemId);

    let known = true;
    if (partList && !partList.includes(itemId)) {
      // Soft on purpose: a pack authored for a newer manifest should still load,
      // and the pane already renders an id it has no art for as a labelled row.
      known = false;
      warnings.push(`item ${itemId} is not in this build's ${partListName} manifest — it will render without art`);
    }
    if (kind === 'voice') {
      const engine = String(rawItem.engine || '').trim().toLowerCase();
      if (!['local', 'system'].includes(engine)) {
        errors.push(
          `voice item ${itemId} must name engine "local" or "system" (got ${JSON.stringify(rawItem.engine)}) — ` +
            'voice never leaves the device',
        );
        known = false;
      }
      if (rawItem.consent !== 'synthetic') {
        errors.push(
          `voice item ${itemId} must declare consent: "synthetic" — no pack may ship a voice cloned from a real person`,
        );
        known = false;
      }
    }

    const parts = Array.isArray(rawItem.parts)
      ? rawItem.parts
          .map((p) => clean(p, LIMITS.id))
          .filter((p) => Boolean(p))
          .slice(0, LIMITS.parts)
      : [];
    const allParts = new Set(Object.values(personaModule.PARTS).flat().filter((v) => typeof v === 'string'));
    for (const part of parts) {
      if (!allParts.has(part)) warnings.push(`item ${itemId} names part ${part}, which this build has no art for`);
    }

    items.push(
      Object.freeze({
        id: itemId,
        label: clean(rawItem.label, LIMITS.label) || itemId,
        known,
        parts: Object.freeze(parts),
        unlock: unlockIdFor(kind || 'outfit', itemId),
        // Carried through for voice items only, and carried through *verbatim*
        // rather than dropped: `auditPacks` re-checks `consent` on the loaded
        // object, so the boot audit is a second opinion on the raw pack instead
        // of a re-run of the validator's own conclusion.
        ...(kind === 'voice'
          ? { engine: clean(rawItem.engine, 16).toLowerCase(), consent: clean(rawItem.consent, 16).toLowerCase() }
          : {}),
      }),
    );
  }

  // Unknown top-level keys are dropped rather than carried, for the same reason
  // persona.js drops them: an artifact that accumulates junk is an artifact whose
  // contents nobody can reason about.
  const knownKeys = ['schema', 'id', 'name', 'kind', 'tier', 'unlocks', 'items', 'author', 'license', 'summary'];
  for (const key of Object.keys(raw)) {
    if (!knownKeys.includes(key)) warnings.push(`unknown pack key ${JSON.stringify(key)} — ignored`);
  }

  if (errors.length) return { ok: false, pack: null, errors, warnings, forbidden };

  return {
    ok: true,
    errors,
    warnings,
    forbidden,
    pack: Object.freeze({
      schema: SCHEMA_VERSION,
      id,
      name,
      kind,
      tier,
      paid: tier === 'paid',
      unlocks: Object.freeze(unlocks),
      items: Object.freeze(items),
      author: clean(raw.author, LIMITS.author),
      license: clean(raw.license, LIMITS.license),
      summary: clean(raw.summary, LIMITS.summary),
    }),
  };
}

/**
 * The paywall line as a function. `validatePack` already refuses a pack whose
 * tier contradicts its unlock, so today this can only fire on a pack built by
 * something other than the validator (a hand-assembled object, a future loader
 * path) — which is exactly why it exists: `store.verifyAtBoot()` runs it over
 * the shipped set at launch, so the line fails loudly rather than being trusted.
 *
 * @returns {string[]} one string per violation, empty when the packs are clean.
 */
function auditPacks(packs) {
  const violations = [];
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!isPlainObject(pack)) continue;
    const label = pack.id || '(unnamed pack)';
    const bad = forbiddenKeys(pack);
    for (const where of bad) violations.push(`${label}: forbidden field ${where}`);

    const tier = pack.tier === 'paid' ? 'paid' : 'free';
    const unlocks = Array.isArray(pack.unlocks) ? pack.unlocks : [];
    if (!unlocks.length) violations.push(`${label}: no unlock — a pack that grants nothing is not a cosmetic`);
    for (const id of unlocks) {
      const unlock = unlockById(id);
      if (!unlock) {
        violations.push(`${label}: unlock ${id} does not exist in the level table`);
        continue;
      }
      if (unlock.paid !== (tier === 'paid')) {
        violations.push(`${label}: tier ${tier} contradicts unlock ${id} (paid: ${unlock.paid})`);
      }
    }
    if (pack.kind === 'voice') {
      for (const item of pack.items || []) {
        if (!item || item.consent !== 'synthetic') {
          violations.push(`${label}: voice item ${item && item.id} is not declared synthetic`);
        }
      }
    }
  }
  return violations;
}

/** Resolve a pack's directory (shipped packs live next to this file). */
function packsDir(dir) {
  return dir || path.join(__dirname, 'packs');
}

/**
 * Read every `*.pack.json` in a directory and validate it.
 *
 * A broken pack never throws and never takes the others down with it: it comes
 * back in `rejected` with its errors, which is what the free/paid UI needs to
 * tell the user *why* a set did not appear. Missing directory ⇒ no packs, no
 * drama (a build with the directory stripped is not a crash).
 *
 * @returns {{ packs: object[], rejected: Array<{file: string, errors: string[]}>, warnings: string[], dir: string }}
 */
function loadPacks(dir) {
  const root = packsDir(dir);
  const out = { packs: [], rejected: [], warnings: [], dir: root };
  let names;
  try {
    names = fs.readdirSync(root).filter((n) => n.endsWith(PACK_SUFFIX)).sort();
  } catch (err) {
    out.warnings.push(`no cosmetics packs at ${root} (${err.code || err.message})`);
    return out;
  }
  for (const file of names) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (err) {
      out.rejected.push({ file, errors: [`not valid JSON: ${err.message}`] });
      continue;
    }
    const result = validatePack(raw);
    for (const warning of result.warnings) out.warnings.push(`${file}: ${warning}`);
    if (!result.ok) {
      out.rejected.push({ file, errors: result.errors });
      continue;
    }
    out.packs.push(result.pack);
  }
  return out;
}

/** Just the shipped packs (throws nothing — see loadPacks). */
function shippedPacks() {
  return loadPacks().packs;
}

/**
 * Boot audit over the shipped set: every violation `auditPacks` knows about,
 * plus a rejection reason for any pack that will not load at all.
 */
function verifyShipped(packs) {
  const violations = [];
  let list = packs;
  if (!Array.isArray(list)) {
    const loaded = loadPacks();
    list = loaded.packs;
    for (const bad of loaded.rejected) {
      violations.push(`${bad.file}: ${bad.errors.join('; ')}`);
    }
  }
  violations.push(...auditPacks(list));
  return { ok: violations.length === 0, violations, packs: list };
}

/**
 * The free/paid line, joined to the level table — the one structure a docs page,
 * a test and (later) the customization pane can all read instead of each
 * re-deriving it. Every row names the level that unlocks it, because that is the
 * whole claim: **the level earns the cosmetic, money may only ever skip nothing
 * but taste.**
 *
 * @returns {Array<{packId, packName, kind, tier, paid, unlockId, level, label, items: string[]}>}
 */
function catalog(packs) {
  const rows = [];
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!isPlainObject(pack) || !Array.isArray(pack.unlocks)) continue;
    for (const unlockId of pack.unlocks) {
      const unlock = unlockById(unlockId);
      rows.push({
        packId: pack.id,
        packName: pack.name,
        kind: pack.kind,
        tier: pack.tier,
        paid: Boolean(unlock && unlock.paid),
        unlockId,
        level: unlock ? unlock.level : null,
        label: unlock ? unlock.label : unlockId,
        items: (pack.items || []).map((i) => i.id),
      });
    }
  }
  return rows;
}

/** `{ free: [...], paid: [...] }` — the demonstrable line, in one call. */
function freePaidLine(packs) {
  const rows = catalog(packs);
  return {
    free: rows.filter((r) => !r.paid),
    paid: rows.filter((r) => r.paid),
  };
}

module.exports = {
  SCHEMA_VERSION,
  KINDS,
  TIERS,
  KIND_UNLOCK_PREFIX,
  KIND_PART_LIST,
  UNLOCK_ALIASES,
  FORBIDDEN_KEYS,
  LIMITS,
  PACK_SUFFIX,
  unlockById,
  unlockIdFor,
  forbiddenKeys,
  validatePack,
  auditPacks,
  packsDir,
  loadPacks,
  shippedPacks,
  verifyShipped,
  catalog,
  freePaidLine,
};
