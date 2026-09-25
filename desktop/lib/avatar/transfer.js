'use strict';

/**
 * transfer.js — persona export, persona import and per-holder forget
 * (PLAN Phase 29; docs/avatar-identity-plan.md §5 and §7.3).
 *
 * A persona is taste. Memory is not. This file exists to keep those two apart
 * across the one boundary where they would otherwise merge — moving a persona
 * between holders and machines — and to make forgetting a holder actually mean
 * it. Three claims, each a leg in `desktop/test/avatar-transfer.test.mjs`:
 *
 *  1. **Export strips memory.** `exportPersona()` writes an allowlist document
 *     (`schema`, `kind`, `attribution`, `persona`, and *summaries* of the ledger
 *     and profile) and then runs it through `assertNoMemory()`, which fails the
 *     export if any source entry's text, any entry id, or the holder's
 *     fingerprint appears anywhere in the serialised document. Facet `value`s
 *     are memory-derived prose and are dropped: what travels is the facet's
 *     *shape* (`id`, `key`, `confidence`, times), never the sentence the fold
 *     wrote. §5 is explicit that the export contains `holderId`, `ledger` and
 *     `profile` — and that any entry text is stripped — so the summaries are
 *     counts and levels, not rows.
 *
 *  2. **Import never imports XP.** A level is not a thing you can hand someone
 *     (§5). `importPersona()` ignores `doc.ledger` however loudly it claims a
 *     level, creates a **new holder by default**, writes only the persona, and
 *     returns the holder's real, freshly-read level — which is 1. Rebind mode
 *     (`{ mode:'rebind', confirm:true }`) writes taste onto an existing holder
 *     and leaves that holder's ledger *untouched*: adopting someone's taste must
 *     not cost you your own memory, in either direction.
 *
 *  3. **Forget is real, and it is per holder** (§7.3). `forgetHolder()` queues a
 *     cloud delete scoped to that holder's two reserved sessions (via
 *     `mirror.js`, so the request outlives the directory it deletes), removes
 *     the holder's directory, and drops its registry row. Every other holder's
 *     directory, rows and registry entry are untouched — asserted directly, in
 *     both directions, because "forget A" quietly forgetting B is the failure
 *     that would make this feature unshippable.
 *
 * Pure Node (fs + path + crypto), no Electron. The registry and the directory
 * layout belong to `holders.js`; this module deliberately owns none of them.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const holders = require('./holders.js');
const identity = require('./identity.js');
const mirror = require('./mirror.js');
const personaModule = require('./persona.js');
const profileModule = require('./profile.js');

/** The shareable document's file name (§5) and its `kind` marker. */
const EXPORT_FILE = 'aegis-persona.json';
const EXPORT_KIND = 'aegis-persona';
const EXPORT_SCHEMA = 1;

/** Fields of a persona that are taste, and therefore travel. */
const PERSONA_PARTS = Object.freeze([
  'schema',
  'identity',
  'presentation',
  'expressions',
  'voice',
  'register',
  'appearance',
]);

/** Minimum length of a string we bother looking for in the export. */
const MIN_LEAK_CHARS = 8;

// --------------------------------------------------------------- helpers ----

function mintId(seed) {
  const source = typeof seed === 'string' && seed ? seed : crypto.randomBytes(16).toString('hex');
  const id = identity.mintHolderId((value) => crypto.createHash('sha1').update(value).digest(), source);
  return id || `h_${crypto.createHash('sha1').update(source).digest('hex').slice(0, identity.FINGERPRINT_LENGTH)}`;
}

/** Every string inside `value`, depth-first. Used by the leak check. */
function stringsIn(value, out = [], depth = 0) {
  if (depth > 8 || value == null) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const item of Array.isArray(value) ? value : Object.values(value)) stringsIn(item, out, depth + 1);
  return out;
}

/**
 * Does the export still carry memory? Returns the leaks it found rather than
 * throwing, so the caller can refuse to write the file *and* say why.
 *
 * `secret` is what the exporting holder actually knows: entry texts and ids, the
 * registry row's fingerprint. A leak is any of those appearing in the document —
 * not a similarity score, an actual substring.
 */
function assertNoMemory(doc, secret = {}) {
  const text = JSON.stringify(doc == null ? null : doc);
  const leaks = [];
  const needles = [];

  for (const row of Array.isArray(secret.entries) ? secret.entries : []) {
    const id = row && row.id != null ? String(row.id) : '';
    if (id.length >= MIN_LEAK_CHARS) needles.push({ what: 'entry id', value: id });
    const body = row && (row.content != null ? row.content : row.text);
    if (typeof body === 'string' && body.trim().length >= MIN_LEAK_CHARS) {
      needles.push({ what: 'entry text', value: body.trim() });
    }
  }
  for (const id of Array.isArray(secret.entryIds) ? secret.entryIds : []) {
    if (String(id).length >= MIN_LEAK_CHARS) needles.push({ what: 'entry id', value: String(id) });
  }
  if (secret.fingerprint) needles.push({ what: 'fingerprint', value: String(secret.fingerprint) });
  for (const key of Array.isArray(secret.keys) ? secret.keys : []) {
    if (String(key).length >= MIN_LEAK_CHARS) needles.push({ what: 'key material', value: String(key) });
  }

  for (const needle of needles) {
    if (text.includes(needle.value)) leaks.push(`${needle.what} leaked: ${needle.value.slice(0, 24)}…`);
  }
  // Key material is checked by shape too: a fingerprint's *prefix* would leak
  // even when the full string does not.
  if (secret.fingerprint && secret.fingerprint.length >= MIN_LEAK_CHARS) {
    const short = String(secret.fingerprint).slice(0, MIN_LEAK_CHARS);
    if (text.includes(short) && !leaks.some((leak) => leak.includes('fingerprint'))) {
      leaks.push('fingerprint prefix leaked');
    }
  }
  return { ok: leaks.length === 0, leaks };
}

// ---------------------------------------------------------------- export ----

/**
 * Build the shareable document from a holder's loaded state.
 *
 * Never throws on a malformed profile: a summary that cannot be computed is
 * simply absent, because "the export is missing a count" is a smaller failure
 * than "the export failed".
 */
function exportPersona(state, opts = {}) {
  const id = state && state.holderId ? String(state.holderId) : null;
  if (!id || !identity.HOLDER_ID_RE.test(id)) {
    return { ok: false, reason: 'exportPersona: expected a loaded holder state', doc: null };
  }

  const verified = personaModule.validate(state.persona);
  const persona = {};
  for (const part of PERSONA_PARTS) {
    if (verified.persona[part] !== undefined) persona[part] = verified.persona[part];
  }
  persona.identity = Object.assign({}, persona.identity, { holderId: id });

  const ledger = Array.isArray(state.ledger) ? state.ledger : [];
  const byKind = {};
  let firstAt = null;
  let lastAt = null;
  for (const row of ledger) {
    if (!row || typeof row !== 'object') continue;
    const kind = String(row.kind || 'unknown');
    byKind[kind] = (byKind[kind] || 0) + 1;
    const t = Number(row.t);
    if (Number.isFinite(t)) {
      firstAt = firstAt === null ? t : Math.min(firstAt, t);
      lastAt = lastAt === null ? t : Math.max(lastAt, t);
    }
  }

  const profile = state.profile && typeof state.profile === 'object' ? state.profile : {};
  const facets = Array.isArray(profile.facets) ? profile.facets : [];
  const doc = {
    schema: EXPORT_SCHEMA,
    kind: EXPORT_KIND,
    exportedAt: typeof opts.now === 'number' ? opts.now : 0,
    attribution: { holderId: id, displayName: state.displayName || null },
    // Taste. Register, presentation, voice, names — exactly §5's list.
    persona,
    // Shape, not sentences: counts, level and facet keys. No facet `value`, no
    // `sources`, no entry ids — a facet's prose is memory, not taste.
    ledger: {
      rows: ledger.length,
      level: Number.isFinite(Number(state.level)) ? Number(state.level) : 1,
      byKind,
      firstAt,
      lastAt,
    },
    profile: {
      coldStart: Boolean(profile.coldStart) || facets.length === 0,
      facetCount: facets.length,
      budget: { tokens: profileModule.BUDGET_TOKENS, used: (profile.budget && profile.budget.used) || 0 },
      facets: facets.map((facet) => ({
        id: facet.id,
        key: facet.key,
        confidence: facet.confidence,
        tokens: facet.tokens,
        firstSeen: facet.firstSeen,
        lastSeen: facet.lastSeen,
      })),
    },
  };

  const secret = {
    entries: opts.entries,
    entryIds: facets.flatMap((facet) => (Array.isArray(facet.sources) ? facet.sources : [])),
    fingerprint: opts.fingerprint || null,
    keys: opts.keys,
  };
  const check = assertNoMemory(doc, secret);
  if (!check.ok) return { ok: false, reason: check.leaks.join('; '), leaks: check.leaks, doc: null };
  return { ok: true, doc, leaks: [], warnings: verified.warnings || [] };
}

/**
 * Load the holder, export it, verify it, and only then write
 * `aegis-persona.json` (0600, tmp + rename). A document that failed the leak
 * check is never written: the file is the thing that gets shared.
 */
function writeExport(dir, holderId, opts = {}) {
  const state = opts.state || holders.loadState(dir, holderId);
  const fingerprint = (() => {
    const row = holders.holderRow(holders.readRegistry(dir), state.holderId);
    return row && row.fingerprint ? row.fingerprint : null;
  })();
  const built = exportPersona(state, Object.assign({ fingerprint }, opts));
  if (!built.ok) return { ok: false, reason: built.reason, leaks: built.leaks || [], file: null, doc: null };

  const file = opts.dest || path.join(String(dir), EXPORT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(built.doc, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return { ok: true, file, doc: built.doc, leaks: [], warnings: built.warnings };
}

// ---------------------------------------------------------------- import ----

function readDoc(input) {
  if (typeof input === 'string') {
    try {
      return JSON.parse(fs.readFileSync(input, 'utf8'));
    } catch (err) {
      return null;
    }
  }
  return input && typeof input === 'object' ? input : null;
}

/**
 * Import a persona document.
 *
 * `mode: 'new'` (the default) mints a fresh holder and gives it *this* persona;
 * the export's ledger is ignored entirely, so a shared persona confers taste and
 * nothing else. `mode: 'rebind'` requires `confirm: true` — the same explicit
 * confirm the conflict card demands — and writes the persona onto an existing
 * holder without touching its ledger, because the memory is that holder's.
 */
function importPersona(dir, input, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : 0;
  const doc = readDoc(input);
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'importPersona: expected a persona document' };
  const kind = String(doc.kind || '');
  if (kind && kind !== EXPORT_KIND) {
    return { ok: false, reason: `importPersona: not an ${EXPORT_KIND} document (kind "${kind}")` };
  }
  if (!doc.persona || typeof doc.persona !== 'object') {
    return { ok: false, reason: 'importPersona: document carries no persona' };
  }

  const mode = opts.mode === 'rebind' ? 'rebind' : 'new';
  const registry = opts.registry || holders.readRegistry(dir);

  if (mode === 'rebind') {
    const wanted = String(opts.holderId || (doc.attribution && doc.attribution.holderId) || '')
      .trim()
      .toLowerCase();
    if (!identity.HOLDER_ID_RE.test(wanted) || !holders.holderRow(registry, wanted)) {
      return { ok: false, reason: 'importPersona: rebind needs an existing holder id' };
    }
    if (opts.confirm !== true) {
      return { ok: false, reason: 'importPersona: rebind requires an explicit confirm', requiresConfirm: true };
    }
    const before = holders.loadState(dir, wanted, { registry });
    const next = personaModule.validate(Object.assign({}, doc.persona, {
      identity: Object.assign({}, doc.persona.identity, { holderId: wanted }),
    }));
    if (opts.persist !== false) holders.writePersona(dir, wanted, next.persona);
    const after = holders.loadState(dir, wanted, { registry });
    return {
      ok: true,
      mode,
      holderId: wanted,
      created: false,
      persona: next.persona,
      warnings: next.warnings || [],
      // Untouched by construction, and reported so a caller can assert it.
      ledger: { before: before.ledger.length, after: after.ledger.length, imported: false },
      level: after.level,
      xpImported: false,
    };
  }

  const minted = opts.holderId ? identity.HOLDER_ID_RE.test(String(opts.holderId)) ? String(opts.holderId) : null : null;
  const id = minted || mintId(opts.seed);
  const created = holders.ensureHolder(dir, {
    id,
    displayName: opts.displayName || (doc.attribution && doc.attribution.displayName) || undefined,
    now,
    registry,
    persist: opts.persist !== false,
  });
  const holderId = created.row ? created.row.id : id;
  const next = personaModule.validate(Object.assign({}, doc.persona, {
    identity: Object.assign({}, doc.persona.identity, { holderId }),
  }));
  if (opts.persist !== false) holders.writePersona(dir, holderId, next.persona);

  // A new holder starts at L1 with an empty ledger. `doc.ledger` is read for
  // nothing: importing XP would make a level something you can hand someone.
  const after = holders.loadState(dir, holderId, { registry: created.registry });
  return {
    ok: true,
    mode,
    holderId,
    created: created.created,
    persona: next.persona,
    warnings: next.warnings || [],
    ledger: { before: 0, after: after.ledger.length, imported: false },
    level: after.level,
    xpImported: false,
  };
}

// ---------------------------------------------------------------- forget ----

function listFiles(dir) {
  try {
    return fs.readdirSync(dir).sort();
  } catch (err) {
    return [];
  }
}

/**
 * Forget one holder, for real (§7.3).
 *
 * Order matters and is deliberate: the cloud-delete request is queued *first*,
 * then the directory is removed, then the registry row is dropped. If the
 * process dies between any two steps the result is a request for a holder that
 * still exists (harmless, resumable) rather than a deleted holder whose cloud
 * copy nobody remembers to delete.
 */
function forgetHolder(dir, holderId, opts = {}) {
  const id = String(holderId == null ? '' : holderId).trim().toLowerCase();
  if (!identity.HOLDER_ID_RE.test(id)) {
    return { ok: false, reason: 'forgetHolder: expected a holder id (h_ + 8-16 hex)', holderId: null };
  }
  const registry = opts.registry || holders.readRegistry(dir);
  const row = holders.holderRow(registry, id);
  if (!row && opts.force !== true) {
    return { ok: false, reason: `unknown holder ${id}`, holderId: id };
  }

  const now = typeof opts.now === 'number' ? opts.now : 0;
  const queued = mirror.queueDelete(dir, id, { t: now, reason: 'holder-forgotten' });

  const home = holders.holderDir(dir, id);
  const files = listFiles(home);
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch (err) {
    return {
      ok: false,
      reason: `could not remove ${home}: ${(err && err.message) || 'error'}`,
      holderId: id,
      queued,
    };
  }

  const without = identity.removeHolder(registry, id);
  const remaining = (without.holders || []).map((entry) => entry.id);
  let active = without.active;
  if (!active && remaining.length) active = opts.active && remaining.includes(opts.active) ? opts.active : remaining[0];
  const next = holders.writeRegistry(dir, Object.assign({}, without, { active: active || null }));

  return {
    ok: true,
    holderId: id,
    removed: { dir: home, files },
    queued: { sessions: queued.sessions || mirror.scopeFor(id).sessions, duplicate: Boolean(queued.duplicate) },
    active: next.active,
    registry: next,
    remaining,
  };
}

module.exports = {
  EXPORT_FILE,
  EXPORT_KIND,
  EXPORT_SCHEMA,
  PERSONA_PARTS,
  MIN_LEAK_CHARS,
  mintId,
  stringsIn,
  assertNoMemory,
  exportPersona,
  writeExport,
  importPersona,
  forgetHolder,
};
