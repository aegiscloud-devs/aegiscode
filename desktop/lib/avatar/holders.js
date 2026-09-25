'use strict';

/**
 * holders.js — who holds the memory (PLAN Phase 28; docs/avatar-identity-plan.md
 * §3, §4, §5).
 *
 * `identity.js` (Phase 25) decides *which* holder a set of signals points at and
 * refuses to merge two people on a fingerprint match. `profile.js` (Phase 25)
 * folds one holder's entries into bounded, evidence-gated facets. Neither of
 * them owns a directory. This file is that owner — the layout, the registry, the
 * switch, the conflict decision and the "why does it know this" surface — and it
 * is deliberately still pure Node (fs + path only, no Electron, no clock unless
 * one is injected) so the whole phase is testable with `node --test`.
 *
 * The four claims this module exists to make true:
 *
 *  1. **A switch swaps everything together.** `switchHolder()` returns a state
 *     read fresh off disk for the new holder — ledger, persona and profile
 *     cache — and names the holder's memory scope in the same object. There is
 *     no field carried over from the previous holder, and the only thing that
 *     survives in memory is the registry (which is an *index*, not data). The
 *     claim is asserted by comparing the two states byte-for-byte for any field
 *     that could carry holder A's text.
 *
 *  2. **A fingerprint is not an identity.** `applyConflict()` has one default:
 *     *keep separate*. Rebinding two holders behind one fingerprint requires
 *     `{ choice: 'rebind', confirm: true }` — the card's explicit confirm — and
 *     even then it only copies the fingerprint onto the surviving row. Nothing
 *     in this file ever merges two ledgers, two personas or two profiles.
 *
 *  3. **Isolation is applied at the seam, not hoped for.** `entriesForHolder()`
 *     is the client-side filter §3 calls "the assertion that the fix happened":
 *     the server-side scope is the fix, and this is what proves it ran. It is
 *     used by the fold *and* by the recall block, so a leak needs to defeat one
 *     function rather than two call sites — and the Phase 28 test drives two
 *     holders through the real turn assembly and greps the prompt.
 *
 *  4. **Every claim is traceable and deletable.** `provenance()` renders a
 *     facet's `sources` as the underlying entry text, and `forgetFacet()`
 *     removes the facet *and* the entries behind it: the ids go on the holder's
 *     own forget list, which `entriesForHolder()` honours on the next fold, so
 *     the claim cannot silently re-derive from the same row (§4).
 *
 * What is NOT here: any level arithmetic (that is `xp.js` + `store.js`), any
 * prompt text (that is `holder-turn.js`), and any IPC (that is `holder-ipc.js`).
 */

const fs = require('node:fs');
const path = require('node:path');

const identity = require('./identity.js');
const personaModule = require('./persona.js');
const profileModule = require('./profile.js');
const xp = require('./xp.js');

/** `<userData>/avatar/` — the one directory tree this module owns. */
const AVATAR_DIR = 'avatar';
const REGISTRY_FILE = 'holders.json';
const HOLDERS_DIR = 'holders';
const LEDGER_FILE = 'ledger.jsonl';
const PERSONA_FILE = 'persona.json';
const PROFILE_FILE = 'profile.json';
const FORGOTTEN_FILE = 'forgotten.json';

/**
 * The one thing a switch may leave behind. A list, not a sentence: the Phase 28
 * test iterates it, so adding a survivor to the code without adding it here
 * makes the test fail rather than the promise quietly rot.
 */
const SURVIVES_SWITCH = Object.freeze(['registry']);

/** Reserved mirror sessions (§6) — holder id, never a fingerprint. */
const MIRROR_SESSIONS = Object.freeze(['avatar:ledger', 'avatar:profile']);
function mirrorSession(holderId, kind = 'ledger') {
  const suffix = kind === 'profile' ? 'profile' : 'ledger';
  return `avatar:${suffix}:${holderId}`;
}

// ---------------------------------------------------------------- paths ----

function registryPath(dir) {
  return path.join(String(dir), AVATAR_DIR, REGISTRY_FILE);
}

/** The holder's own directory. Ids are shape-checked before they touch a path. */
function holderDir(dir, holderId) {
  const id = safeHolderId(holderId);
  if (!id) throw new Error('holderDir: expected a holder id (h_ + 8-16 hex)');
  return path.join(String(dir), AVATAR_DIR, HOLDERS_DIR, id);
}

function holderPaths(dir, holderId) {
  const base = holderDir(dir, holderId);
  return {
    dir: base,
    ledger: path.join(base, LEDGER_FILE),
    persona: path.join(base, PERSONA_FILE),
    profile: path.join(base, PROFILE_FILE),
    forgotten: path.join(base, FORGOTTEN_FILE),
  };
}

function safeHolderId(value) {
  const id = value == null ? '' : String(value).trim();
  if (!id) return null;
  return identity.HOLDER_ID_RE && identity.HOLDER_ID_RE.test(id) ? id : null;
}

// -------------------------------------------------------------- file IO ----

function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return value;
}

/** Parse a JSONL ledger. Tolerant by construction: a torn last line is skipped. */
function readLedger(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
    } catch (err) {
      // A half-written append is lost XP, never a crash — same rule as store.js.
    }
  }
  return rows;
}

function appendLedgerRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
  return row;
}

// ------------------------------------------------------------ registry ----

/**
 * Read the registry. Anything unreadable or invalid degrades to a fresh empty
 * registry (identity.load validates and migrates), because "the index is gone"
 * must never read as "your memory is gone" — the holder directories are still
 * on disk and a registry rebuild is not a data loss.
 */
function readRegistry(dir) {
  const raw = readJsonFile(registryPath(dir));
  try {
    return identity.load(raw || identity.emptyRegistry());
  } catch (err) {
    return identity.load(identity.emptyRegistry());
  }
}

/** Validate + persist. Returns the validated registry, never the raw input. */
function writeRegistry(dir, registry) {
  const validated = identity.load(registry);
  writeJsonFile(registryPath(dir), validated);
  return validated;
}

function holderRow(registry, holderId) {
  const id = safeHolderId(holderId);
  if (!id) return null;
  return (registry.holders || []).find((row) => row && row.id === id) || null;
}

/**
 * Add a holder (idempotent by id and by fingerprint-free identity) and return
 * `{ registry, row, created }`. Used by a first-run mint and by the conflict
 * card's "keep separate", which is exactly `ensureHolder` with no fingerprint.
 */
function ensureHolder(dir, input = {}) {
  const registry = input.registry || readRegistry(dir);
  const wanted = input.id ? safeHolderId(input.id) : null;
  const existing = wanted ? holderRow(registry, wanted) : null;
  if (existing) return { registry, row: existing, created: false };

  const withRow = identity.addHolder(registry, {
    id: wanted || undefined,
    displayName: input.displayName,
    fingerprint: input.fingerprint,
    accountId: input.accountId,
    now: input.now,
  });
  const validated = identity.load(withRow);
  const row = validated.holders[validated.holders.length - 1] || null;
  if (input.persist !== false) writeRegistry(dir, validated);
  return { registry: validated, row, created: true };
}

// --------------------------------------------------------------- state -----

/** What a level reads as, from this holder's ledger rows alone. */
function levelOf(ledger) {
  try {
    const evaluated = xp.evaluate(Array.isArray(ledger) ? ledger : []);
    return evaluated && Number.isFinite(evaluated.level) ? evaluated.level : 1;
  } catch (err) {
    return 1;
  }
}

/** The forgotten-entry list: what "forget" actually writes. */
function readForgotten(dir, holderId) {
  const parsed = readJsonFile(holderPaths(dir, holderId).forgotten);
  const ids = parsed && Array.isArray(parsed.entries) ? parsed.entries : [];
  return new Set(ids.map(String));
}

function writeForgotten(dir, holderId, ids) {
  const list = Array.from(new Set(Array.from(ids).map(String))).sort();
  writeJsonFile(holderPaths(dir, holderId).forgotten, {
    schema: 1,
    holderId,
    entries: list,
  });
  return new Set(list);
}

function emptyProfile(holderId) {
  return { schema: 1, holderId, facets: [], budget: { tokens: 0, used: 0 }, coldStart: true };
}

/**
 * Load one holder's state — every field read from that holder's own directory,
 * nothing defaulted from a previous holder.
 *
 * @returns {{ holderId:string, displayName:string, ledger:object[],
 *             persona:object, profile:object, forgotten:Set<string>,
 *             level:number, scope:string[] }}
 */
function loadState(dir, holderId, opts = {}) {
  const id = safeHolderId(holderId);
  if (!id) throw new Error('loadState: expected a holder id (h_ + 8-16 hex)');
  const registry = opts.registry || readRegistry(dir);
  const row = holderRow(registry, id);
  const paths = holderPaths(dir, id);
  const ledger = readLedger(paths.ledger);

  const rawPersona = readJsonFile(paths.persona);
  let persona = personaModule.defaultPersona();
  if (rawPersona) {
    try {
      const loaded = personaModule.load(rawPersona);
      persona = loaded && loaded.persona ? loaded.persona : loaded;
    } catch (err) {
      persona = personaModule.defaultPersona();
    }
  } else {
    // A holder with no persona file inherits nothing: it gets the neutral
    // default, so a fresh holder is an unconfigured install (§4, cold start).
    persona = personaModule.defaultPersona();
  }

  const profile = readJsonFile(paths.profile) || emptyProfile(id);
  const forgotten = readForgotten(dir, id);

  return {
    holderId: id,
    displayName: (row && row.displayName) || personaDisplayName(persona) || identity.DEFAULT_DISPLAY_NAME,
    ledger,
    persona,
    profile: profile && profile.holderId === id ? profile : { ...profile, holderId: id },
    forgotten,
    level: levelOf(ledger),
    scope: MIRROR_SESSIONS.map((kind) => mirrorSession(id, kind.split(':')[1])),
  };
}

function personaDisplayName(persona) {
  const name = persona && persona.identity && persona.identity.name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** Persist a folded profile into the holder's own cache file. */
function writeProfile(dir, holderId, profile) {
  const withHolder = { ...(profile || {}), holderId };
  writeJsonFile(holderPaths(dir, holderId).profile, withHolder);
  return withHolder;
}

function writePersona(dir, holderId, persona) {
  writeJsonFile(holderPaths(dir, holderId).persona, { ...(persona || {}), holderId });
  return persona;
}

// -------------------------------------------------------------- switching --

/**
 * Switch the active holder.
 *
 * The returned `state` is loaded *after* the registry write, so a caller cannot
 * accidentally keep rendering the old holder by holding a stale object: every
 * field that can carry holder A's text — ledger, persona, profile, forget list
 * and memory scope — is fresh. `survived` is the honest list of what came
 * across, and it is `['registry']` by construction.
 */
function switchHolder(dir, holderId, opts = {}) {
  const id = safeHolderId(holderId);
  if (!id) return { ok: false, reason: 'expected a holder id (h_ + 8-16 hex)', survived: SURVIVES_SWITCH.slice() };

  const registry = opts.registry || readRegistry(dir);
  if (!holderRow(registry, id) && !opts.create) {
    return { ok: false, reason: `unknown holder ${id}`, survived: SURVIVES_SWITCH.slice() };
  }

  let next = registry;
  if (holderRow(registry, id)) {
    try {
      next = identity.setActive(registry, id);
    } catch (err) {
      next = { ...registry, active: id };
    }
    next = writeRegistry(dir, next);
  } else {
    const created = ensureHolder(dir, { id, displayName: opts.displayName, now: opts.now });
    next = writeRegistry(dir, identity.setActive(created.registry, id));
  }

  const state = loadState(dir, id, { registry: next });
  return {
    ok: true,
    previous: opts.previous || (registry && registry.active) || null,
    state,
    registry: next,
    survived: SURVIVES_SWITCH.slice(),
  };
}

/**
 * Resolve the active holder from signals (identity.resolve — one source of
 * truth for precedence) and, when a signal minted nothing, create the row so
 * the next launch resolves to the same holder.
 */
function resolveActive(dir, signals = {}, opts = {}) {
  const registry = opts.registry || readRegistry(dir);
  const resolution = identity.resolve(signals, registry);
  if (resolution.needsMint || !resolution.holderId) {
    return { registry, resolution, holderId: null, created: false };
  }
  const existing = holderRow(registry, resolution.holderId);
  if (existing) {
    return { registry, resolution, holderId: existing.id, created: false };
  }
  const created = ensureHolder(dir, {
    id: resolution.holderId,
    displayName: resolution.displayName,
    fingerprint: resolution.proposal ? resolution.proposal.fingerprint : undefined,
    now: opts.now,
    registry,
  });
  return { registry: created.registry, resolution, holderId: created.row ? created.row.id : resolution.holderId, created: created.created };
}

/**
 * Apply the conflict card's choice (§2/§3).
 *
 * Default is *keep separate*: two holders stay two holders, and the only thing
 * the fingerprint gets is a note that it is shared. `rebind` requires
 * `confirm: true` — the explicit confirm behind the card — and still never
 * merges data: it moves the fingerprint onto the winner and records the loser
 * as unbound, because a fingerprint is not an identity.
 */
function applyConflict(registry, resolution, choice = {}) {
  const reg = identity.load(registry || identity.emptyRegistry());
  const conflict = resolution && resolution.conflict;
  const target = (resolution && resolution.holderId) || reg.active;
  const action = choice && choice.choice === 'rebind' ? 'rebind' : 'keep-separate';

  if (!conflict || !target) {
    return { ok: false, action, reason: 'no conflict to resolve', registry: reg, requiresConfirm: false };
  }

  const other = conflict.a === target ? conflict.b : conflict.a;
  if (action === 'keep-separate') {
    // Nothing about the rows changes. Keeping the two is not a failure state —
    // it is the outcome the copy on the card recommends.
    return {
      ok: true,
      action,
      registry: reg,
      requiresConfirm: false,
      kept: [target, other].filter(Boolean),
    };
  }

  if (choice.confirm !== true) {
    return {
      ok: false,
      action,
      reason: 'rebind requires an explicit confirm',
      registry: reg,
      requiresConfirm: true,
      kept: [target, other].filter(Boolean),
    };
  }

  const losers = new Set((reg.holders || [])
    .filter((row) => row && row.id !== target && row.id === other)
    .map((row) => row.id));
  const holders = (reg.holders || []).map((row) => {
    if (!row) return row;
    if (row.id === target) {
      return { ...row, fingerprint: resolution.proposal ? resolution.proposal.fingerprint : row.fingerprint };
    }
    if (losers.has(row.id)) return { ...row, fingerprint: undefined };
    return row;
  });

  return {
    ok: true,
    action,
    requiresConfirm: false,
    registry: identity.load({ ...reg, holders }),
    rebound: { kept: target, unbound: Array.from(losers) },
  };
}

// ---------------------------------------------------------------- scope ----

/**
 * The client-side filter (§3). `profile.belongsTo` is the same predicate the
 * fold uses, so there is one definition of "this row is this holder's", and a
 * row with no holder stamp is *unattributed* — it belongs to nobody in
 * particular and therefore to the holder asking, which is what makes a legacy
 * unstamped ledger readable instead of invisible.
 *
 * `clientFilter:false` exists only so the Phase 28 isolation test can prove the
 * filter is load-bearing by removing it and watching the leg go red. It is not
 * reachable from any IPC handler (holder-ipc.js never passes it).
 */
function entriesForHolder(entries, holderId, opts = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const id = safeHolderId(holderId);
  const forgotten = opts.forgotten instanceof Set ? opts.forgotten : new Set();
  if (opts.clientFilter === false || !id) {
    return rows.filter((row) => row && typeof row === 'object' && !forgotten.has(String(rowId(row))));
  }
  return rows.filter((row) => {
    if (!row || typeof row !== 'object') return false;
    if (forgotten.has(String(rowId(row)))) return false;
    try {
      return profileModule.belongsTo(row, id);
    } catch (err) {
      return String(row.holder || '') === id;
    }
  });
}

function rowId(row) {
  if (!row || typeof row !== 'object') return '';
  return row.id != null ? row.id : (row.entryId != null ? row.entryId : '');
}

/**
 * Main stamps the holder on every row it writes; the renderer never supplies it
 * (same reasoning as lib/sync/persist-gate.js). A renderer-supplied `holder`
 * field is overwritten, not merged, so a malformed payload cannot smuggle a row
 * into another holder's fold.
 */
function stampEntry(entry, holderId) {
  const id = safeHolderId(holderId);
  if (!entry || typeof entry !== 'object') return entry;
  if (!id) return { ...entry, holder: undefined };
  return { ...entry, holder: id };
}

// ------------------------------------------------------------ provenance ---

/**
 * "Why does it know this" (§4): a facet's sources rendered as the underlying
 * entry text, in the facet's own source order.
 */
function provenance(profile, entries, facetId, opts = {}) {
  const facets = (profile && Array.isArray(profile.facets)) ? profile.facets : [];
  const facet = facets.find((f) => f && f.id === facetId) || null;
  if (!facet) return { ok: false, reason: `no facet ${facetId}`, facet: null, claims: [] };
  const byId = new Map();
  for (const row of Array.isArray(entries) ? entries : []) {
    const id = rowId(row);
    if (id) byId.set(String(id), row);
  }
  const claims = (Array.isArray(facet.sources) ? facet.sources : []).map((sourceId) => {
    const row = byId.get(String(sourceId)) || null;
    return {
      entryId: String(sourceId),
      // The text is quoted as inert data: this surface renders memory, it never
      // re-emits it as an instruction (holder-turn.js neutralises on the way out).
      text: row ? textOf(row) : '',
      kind: row ? String(row.kind || '') : '',
      at: row && Number.isFinite(Number(row.t)) ? Number(row.t) : null,
      present: Boolean(row),
    };
  });
  return {
    ok: true,
    facet: { id: facet.id, key: facet.key, value: facet.value, confidence: facet.confidence },
    claims,
    missing: claims.filter((c) => !c.present).map((c) => c.entryId),
  };
}

function textOf(row) {
  if (!row || typeof row !== 'object') return '';
  const value = row.text != null ? row.text : (row.content != null ? row.content : row.value);
  return typeof value === 'string' ? value : '';
}

/**
 * Forget one facet: drop the facet from the profile and put the entries behind
 * it on the holder's forget list, which `entriesForHolder()` reads on the next
 * fold — so the claim cannot silently re-derive from the same row.
 *
 * @returns {{ ok:boolean, profile:object, removed:string[], facetIds:string[] }}
 */
function forgetFacet(dir, holderId, profile, facetId) {
  const facets = (profile && Array.isArray(profile.facets)) ? profile.facets : [];
  const facet = facets.find((f) => f && f.id === facetId) || null;
  if (!facet) return { ok: false, reason: `no facet ${facetId}`, profile, removed: [], facetIds: [] };

  const removed = (Array.isArray(facet.sources) ? facet.sources : []).map(String);
  const forgotten = readForgotten(dir, holderId);
  for (const id of removed) forgotten.add(id);
  writeForgotten(dir, holderId, forgotten);

  // A second facet folded from the same entries loses its sources too: dropping
  // nothing but the clicked facet would leave "why does it know this" pointing
  // at entries the holder just deleted.
  const pruned = facets
    .filter((f) => f && f.id !== facet.id)
    .map((f) => {
      const sources = (Array.isArray(f.sources) ? f.sources : []).filter((id) => !forgotten.has(String(id)));
      return { ...f, sources };
    })
    .filter((f) => (Array.isArray(f.sources) ? f.sources.length : 0) > 0);
  const dropped = facets.filter((f) => f && f.id !== facet.id).length - pruned.length;

  const next = {
    ...(profile || {}),
    holderId,
    facets: pruned,
    budget: { tokens: (profile && profile.budget && profile.budget.tokens) || profileModule.BUDGET_TOKENS, used: 0 },
    coldStart: pruned.length === 0,
  };
  writeProfile(dir, holderId, next);
  return {
    ok: true,
    profile: next,
    removed,
    facetIds: [facet.id].concat(dropped > 0 ? pruned.map((f) => f.id) : []),
  };
}

module.exports = {
  AVATAR_DIR,
  REGISTRY_FILE,
  HOLDERS_DIR,
  LEDGER_FILE,
  PERSONA_FILE,
  PROFILE_FILE,
  FORGOTTEN_FILE,
  SURVIVES_SWITCH,
  MIRROR_SESSIONS,
  mirrorSession,
  registryPath,
  holderDir,
  holderPaths,
  readJsonFile,
  writeJsonFile,
  readLedger,
  appendLedgerRow,
  readRegistry,
  writeRegistry,
  holderRow,
  ensureHolder,
  levelOf,
  readForgotten,
  writeForgotten,
  emptyProfile,
  loadState,
  writeProfile,
  writePersona,
  switchHolder,
  resolveActive,
  applyConflict,
  entriesForHolder,
  stampEntry,
  provenance,
  forgetFacet,
};
