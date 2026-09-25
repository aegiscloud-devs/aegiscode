'use strict';

/**
 * mirror.js — the per-holder cloud mirror (PLAN Phase 29;
 * docs/avatar-identity-plan.md §6, extending docs/avatar-plan.md §1.5).
 *
 * Phase 20 put the ledger on disk, Phase 25 made a profile foldable from it and
 * Phase 28 gave every row a holder. All three are local. This file is the half
 * that leaves the machine, and it exists to make four claims true — each of
 * which is a test in `desktop/test/avatar-mirror.test.mjs`, not a paragraph:
 *
 *  1. **The mirror is keyed by holder id, never by fingerprint.**
 *     `sessionFor()` builds `avatar:ledger:<holderId>` /
 *     `avatar:profile:<holderId>` and *refuses* anything that is not a holder
 *     id (`h_<12 hex>`). A fingerprint is a property of a credential and a key
 *     rotation would orphan every mirrored row under it; §6 says the reserved
 *     sessions are named by holder for exactly that reason. The refusal is by
 *     shape, so passing `sha256(key).slice(0,12)` here throws rather than
 *     quietly creating a second, key-shaped namespace.
 *
 *  2. **Reconciliation is union-by-row-id, and therefore order-independent.**
 *     `reconcile()` unions two sides by a content-addressed row id, deduplicates
 *     a row both machines already have, and sorts by `(t, id)`. Two machines
 *     that appended in opposite orders converge on the *same bytes*, and
 *     `derive()`'s order independence (docs/avatar-plan.md §1) makes that the
 *     same level. The Phase 29 ordering test feeds both interleavings and
 *     asserts one level; the idempotence leg asserts feeding the union back in
 *     cannot double a level, which is what would actually hurt.
 *
 *  3. **A profile is never mirrored as a blob.** Only *inputs* travel — ledger
 *     rows and memory entries — and facets are refolded locally by
 *     `profile.fold()`. A synced conclusion cannot be provenance-checked on the
 *     machine that receives it: it would arrive citing entry ids that machine
 *     has never seen, which is precisely the "why does it know this" surface
 *     going dark. `readMirror()` therefore classifies a `facets`-shaped payload
 *     as a blob, reports it, and drops it; `refold()` folds only from rows that
 *     are *present locally*, so a facet can never cite an absent entry.
 *
 *  4. **Forget is real, and it is scoped.** `queueDelete()` writes one durable
 *     request naming the holder's two reserved sessions; `drainDeleteQueue()`
 *     hands each session to the caller's delete function and only marks the row
 *     done when that function resolves. The queue lives at the avatar root, not
 *     inside the holder's directory, so it survives the directory removal that
 *     `transfer.forgetHolder()` performs — a deleted holder whose cloud copy
 *     could not be deleted would otherwise be unrecoverable, and §7.3 counts
 *     the cloud delete as part of the promise (*"forget is real"*).
 *
 * Pure Node (fs + path + crypto), no Electron, injectable clock and delete
 * function, so the whole phase runs under plain `node --test`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const identity = require('./identity.js');
const profileModule = require('./profile.js');
const xp = require('./xp.js');

/** `<userData>/avatar/cloud-deletes.jsonl` — outside every holder directory. */
const DELETE_FILE = 'cloud-deletes.jsonl';
/** Envelope version written into every mirrored memory row. */
const MIRROR_VERSION = 1;
const MIRROR_TAG = 'avatar:mirror';
/** The two kinds that may travel. Anything else is a blob and is refused. */
const MIRROR_KINDS = Object.freeze(['ledger', 'entry']);
const BLOB_KINDS = Object.freeze(['profile', 'facets', 'summary']);
/** Row ids are content-addressed: `L` + 16 hex of the canonical row. */
const ROW_ID_CHARS = 16;

// ------------------------------------------------------------- sessions ----

function holderIdShape(value) {
  const id = value == null ? '' : String(value).trim().toLowerCase();
  return identity.HOLDER_ID_SHAPE.test(id) ? id : null;
}

/**
 * The reserved mirror session for one holder and one kind (§6).
 *
 * Refuses a fingerprint *by shape*: this is the whole point of the section. The
 * session is named by the thing that survives a key rotation.
 */
function sessionFor(holderId, kind = 'ledger') {
  const id = holderIdShape(holderId);
  if (!id) {
    throw new Error(
      'mirror: reserved sessions are named by holder id (h_ + 8-16 hex), never by a fingerprint or a key'
    );
  }
  const suffix = kind === 'profile' ? 'profile' : 'ledger';
  return `avatar:${suffix}:${id}`;
}

/** Both reserved sessions, in a stable order. */
function scopeFor(holderId) {
  return {
    holderId: holderIdShape(holderId),
    ledger: sessionFor(holderId, 'ledger'),
    profile: sessionFor(holderId, 'profile'),
    sessions: [sessionFor(holderId, 'ledger'), sessionFor(holderId, 'profile')],
  };
}

/** Which holder (if any) a mirrored session names. `null` for a foreign string. */
function holderOfSession(session) {
  const text = session == null ? '' : String(session);
  const match = /^avatar:(ledger|profile):(.+)$/.exec(text);
  if (!match) return null;
  const id = holderIdShape(match[2]);
  if (!id) return null;
  return { holderId: id, kind: match[1] };
}

// ----------------------------------------------------------------- rows ----

/**
 * The canonical form of a ledger row: the fields that carry meaning, sorted by
 * key, so a row that arrives with its keys in a different order still hashes
 * to the same id.
 */
function canonical(row) {
  if (!row || typeof row !== 'object') return '';
  const keys = Object.keys(row)
    .filter((key) => row[key] !== undefined && row[key] !== null && key !== 'xp')
    .sort();
  const out = {};
  for (const key of keys) out[key] = row[key];
  return JSON.stringify(out);
}

/**
 * A row's mirror identity.
 *
 * aegis1 has no ledger-row id, and inventing a random one would make the same
 * event mirror twice from two machines — the one failure mode that *would*
 * inflate a level. So identity is the row's own content: the same event written
 * independently on two machines reconciles to one row, and a genuinely different
 * event (different `t`, `kind`, `ref` or `turn`) keeps its own id.
 */
function rowId(row) {
  const explicit = row && (row.id != null ? row.id : row.entryId);
  if (explicit != null && String(explicit) !== '') return String(explicit);
  return `L${crypto.createHash('sha1').update(canonical(row)).digest('hex').slice(0, ROW_ID_CHARS)}`;
}

/**
 * Union two sides by row id. Order-independent by construction: the output is
 * sorted by `(t, id)` and, when both sides carry the same id with different
 * payloads, the surviving copy is chosen by a deterministic rule (more fields
 * wins, then lexicographically smaller canonical form) rather than by whichever
 * argument came first.
 *
 * @returns {{ rows: object[], ids: string[], added: number, shared: number,
 *             conflicts: string[], dropped: number }}
 */
function reconcile(local, remote) {
  const left = Array.isArray(local) ? local : [];
  const right = Array.isArray(remote) ? remote : [];
  const byId = new Map();
  const seen = new Map();
  const sides = new Map();
  const conflicts = [];
  let shared = 0;
  let dropped = 0;

  const put = (row, side) => {
    if (!row || typeof row !== 'object') {
      dropped += 1;
      return;
    }
    const id = rowId(row);
    const prior = byId.get(id);
    const both = sides.get(id) || new Set();
    both.add(side);
    sides.set(id, both);
    if (prior === undefined) {
      byId.set(id, row);
      seen.set(id, canonical(row));
      return;
    }
    shared += 1;
    if (seen.get(id) === canonical(row)) return;
    // Same id, different payload. Deterministic winner, never "last write wins":
    // both machines compute the same answer from the same pair.
    const a = canonical(prior);
    const b = canonical(row);
    const richer = Object.keys(row).length - Object.keys(prior).length;
    const winner = richer > 0 || (richer === 0 && b < a) ? row : prior;
    byId.set(id, winner);
    seen.set(id, canonical(winner));
    if (!conflicts.includes(id)) conflicts.push(id);
  };

  for (const row of left) put(row, 'local');
  for (const row of right) put(row, 'remote');

  const rows = Array.from(byId.values()).sort((a, b) => {
    const ta = Number(a && a.t) || 0;
    const tb = Number(b && b.t) || 0;
    if (ta !== tb) return ta - tb;
    return rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0;
  });

  let added = 0;
  for (const set of sides.values()) if (set.size === 1) added += 1;

  return {
    rows,
    ids: rows.map(rowId),
    added,
    shared,
    conflicts,
    dropped,
  };
}

/** The level a set of rows reads as. Same call `xp.js` makes, nothing more. */
function levelFor(rows) {
  try {
    const evaluated = xp.evaluate(Array.isArray(rows) ? rows : []);
    return evaluated && Number.isFinite(evaluated.level) ? evaluated.level : 1;
  } catch (err) {
    return 1;
  }
}

/** Is this row safe to send? A row carrying key material is not (§2). */
function hasKeyMaterial(row) {
  for (const value of Object.values(row && typeof row === 'object' ? row : {})) {
    if (typeof value === 'string' && identity.looksLikeRawKey && identity.looksLikeRawKey(value)) return true;
  }
  return false;
}

// ------------------------------------------------------------- envelope ----

/**
 * One mirrored row = one memory entry in the holder's reserved session, with the
 * payload as its `content`. The envelope is explicit (`{ mirror: kind, row }`)
 * so `readMirror()` can tell an input from a conclusion without guessing, and
 * so a `facets` payload is *recognisably* a blob rather than an unknown row.
 */
function encodeRow(kind, row, holderId) {
  const wanted = MIRROR_KINDS.includes(kind) ? kind : null;
  if (!wanted || !row || typeof row !== 'object') return null;
  if (hasKeyMaterial(row)) return null;
  const session = sessionFor(holderId, wanted === 'ledger' ? 'ledger' : 'profile');
  return {
    id: wanted === 'ledger' ? rowId(row) : String(rowId(row)),
    content: JSON.stringify({ v: MIRROR_VERSION, mirror: wanted, row }),
    session,
    source: 'aegis-desktop-mirror',
    tags: [MIRROR_TAG, wanted],
  };
}

/** The rows to push for one holder: its ledger, and the entries a fold needs. */
function pushPlan(state, opts = {}) {
  const holderId = holderIdShape(state && state.holderId) || holderIdShape(opts.holderId);
  if (!holderId) return { ok: false, reason: 'pushPlan: expected a holder id', rows: [], sessions: [] };
  const ledgerRows = Array.isArray(state && state.ledger) ? state.ledger : [];
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const rows = [];
  let refused = 0;
  for (const row of ledgerRows) {
    const encoded = encodeRow('ledger', row, holderId);
    if (encoded) rows.push(encoded);
    else refused += 1;
  }
  for (const entry of entries) {
    // Only entries already stamped for this holder travel: an unstamped row
    // belongs to whoever is asking, and mirroring it would hand it to both.
    const encoded = encodeRow('entry', profileModule.belongsTo(entry, holderId) ? entry : null, holderId);
    if (encoded) rows.push(encoded);
    else refused += 1;
  }
  return { ok: true, holderId, rows, refused, sessions: scopeFor(holderId).sessions };
}

/**
 * Decode one mirrored memory row for one holder. Returns a *classification*, not
 * a throw: `blob` (a synced conclusion — refused), `foreign` (another holder's
 * session — dropped, never read), or a decoded `ledger`/`entry` row.
 */
function decodeRow(memoryRow, holderId) {
  const id = holderIdShape(holderId);
  const row = memoryRow && typeof memoryRow === 'object' ? memoryRow : null;
  if (!row) return { ok: false, kind: 'invalid', reason: 'not a row' };
  const named = holderOfSession(row.session);
  if (!named) return { ok: false, kind: 'foreign', reason: `not a reserved mirror session: ${String(row.session)}` };
  if (named.holderId !== id) {
    return { ok: false, kind: 'foreign', reason: `session names ${named.holderId}, not ${id}` };
  }
  let payload = null;
  try {
    payload = JSON.parse(String(row.content == null ? '' : row.content));
  } catch (err) {
    return { ok: false, kind: 'invalid', reason: 'content is not JSON' };
  }
  if (!payload || typeof payload !== 'object') return { ok: false, kind: 'invalid', reason: 'empty envelope' };
  const kind = String(payload.mirror || payload.kind || '');
  const body = payload.row && typeof payload.row === 'object' ? payload.row : payload;
  if (BLOB_KINDS.includes(kind) || Array.isArray(body.facets) || body.profile) {
    // The §6 refusal, stated in code: a folded profile that arrived over the wire
    // is a conclusion we cannot provenance-check, so it is never applied.
    return { ok: false, kind: 'blob', reason: `refusing a synced ${kind || 'profile'} blob — facets refold locally`, session: named };
  }
  if (!MIRROR_KINDS.includes(kind)) return { ok: false, kind: 'invalid', reason: `unknown mirror kind "${kind}"` };
  if (hasKeyMaterial(body)) return { ok: false, kind: 'invalid', reason: 'row carries key material' };
  return { ok: true, kind, row: body, session: named };
}

/**
 * Read a batch of mirrored memory rows for one holder: what arrived, what was
 * refused, and what belonged to someone else.
 */
function readMirror(memoryRows, holderId) {
  const list = Array.isArray(memoryRows) ? memoryRows : [];
  const out = { holderId: holderIdShape(holderId), ledger: [], entries: [], blobs: [], foreign: [], invalid: [] };
  for (const memoryRow of list) {
    const decoded = decodeRow(memoryRow, holderId);
    if (decoded.ok) (decoded.kind === 'ledger' ? out.ledger : out.entries).push(decoded.row);
    else if (decoded.kind === 'blob') out.blobs.push(decoded.reason);
    else if (decoded.kind === 'foreign') out.foreign.push(decoded.reason);
    else out.invalid.push(decoded.reason);
  }
  return out;
}

// --------------------------------------------------------------- refold ----

/**
 * Refold one holder's profile from rows that are *present locally*.
 *
 * `remote` here is a mirror read (or an arbitrary payload); nothing in it is
 * trusted as a conclusion — `payload.profile`/`payload.facets` are dropped
 * explicitly and recorded in `refused`. The fold itself is `profile.fold()`
 * with `holder` supplied, so a facet can only cite an entry id that survived
 * the holder filter (Phase 25's pure-seam isolation) *and* exists in this
 * input (the `citable` set inside the fold).
 */
function refold(input = {}) {
  const holderId = holderIdShape(input.holder);
  const localEntries = Array.isArray(input.entries) ? input.entries : [];
  const localLedger = Array.isArray(input.ledger) ? input.ledger : [];
  const remote = input.remote && typeof input.remote === 'object' ? input.remote : null;

  const refused = [];
  if (remote) {
    for (const key of ['profile', 'facets', 'summary']) {
      if (remote[key] !== undefined) refused.push(`dropped remote ${key}`);
    }
    if (Array.isArray(remote.blobs)) for (const why of remote.blobs) refused.push(why);
  }

  const departed = remote && Array.isArray(remote.ledger) ? remote.ledger : [];
  const arrived = remote && Array.isArray(remote.entries) ? remote.entries : [];
  const ledger = reconcile(localLedger, departed).rows;
  const byLocalId = new Set(localEntries.map((entry) => String(entry && entry.id)));
  const entries = localEntries.concat(
    arrived.filter((entry) => entry && entry.id != null && !byLocalId.has(String(entry.id)))
  );

  const profile = profileModule.fold({
    holder: holderId,
    entries,
    ledger,
    corrections: input.corrections,
    now: input.now,
  });

  const known = new Set(entries.map((entry) => String(entry && entry.id)));
  const orphaned = [];
  for (const facet of profile.facets) {
    for (const source of facet.sources) if (!known.has(String(source))) orphaned.push(`${facet.id}:${source}`);
  }

  return {
    holderId,
    profile,
    ledger,
    entries,
    refused,
    orphaned,
    level: levelFor(ledger),
  };
}

// ----------------------------------------------------------- delete queue ---

function deleteQueuePath(dir) {
  return path.join(String(dir), 'avatar', DELETE_FILE);
}

function readDeleteQueue(dir) {
  let raw = '';
  try {
    raw = fs.readFileSync(deleteQueuePath(dir), 'utf8');
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
      // A torn append loses a delete request, never the whole queue.
    }
  }
  return rows;
}

function writeDeleteQueue(dir, rows) {
  const file = deleteQueuePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(
    tmp,
    rows.map((row) => JSON.stringify(row)).join('\n').concat(rows.length ? '\n' : ''),
    { mode: 0o600 }
  );
  fs.renameSync(tmp, file);
  return rows;
}

/**
 * Queue a scoped cloud delete for one holder: its two reserved sessions, by
 * holder id, and nothing else. Idempotent — a second forget request for the same
 * holder does not add a second row, because the delete is per session and the
 * queue is a set of outstanding requests, not a log.
 *
 * The queue deliberately lives above the holder directory: `transfer.forget()`
 * removes that directory, and the request must outlive it.
 */
function queueDelete(dir, holderId, opts = {}) {
  const scope = scopeFor(holderId);
  if (!scope.holderId) return { ok: false, reason: 'queueDelete: expected a holder id', rows: [] };
  const rows = readDeleteQueue(dir);
  const existing = rows.find((row) => row && row.holderId === scope.holderId && !row.done);
  if (existing) {
    return { ok: true, duplicate: true, holderId: scope.holderId, sessions: scope.sessions.slice(), rows };
  }
  const row = {
    schema: 1,
    id: `del-${scope.holderId}-${typeof opts.t === 'number' ? opts.t : 0}`,
    holderId: scope.holderId,
    sessions: scope.sessions.slice(),
    reason: String(opts.reason || 'holder-forgotten'),
    t: typeof opts.t === 'number' ? opts.t : 0,
    done: false,
  };
  const next = rows.concat([row]);
  writeDeleteQueue(dir, next);
  return { ok: true, duplicate: false, holderId: scope.holderId, sessions: scope.sessions.slice(), row, rows: next };
}

/**
 * Drain the queue: call `send(session)` for every outstanding session and only
 * mark the request done when it resolves without throwing. A failure leaves the
 * row pending — an offline machine must not silently forget what it owes the
 * cloud, which is the same rule as `lib/sync/memory-queue.js`.
 */
async function drainDeleteQueue(dir, send) {
  const rows = readDeleteQueue(dir);
  const fn = typeof send === 'function' ? send : async () => {};
  let deleted = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row || row.done) continue;
    const sessions = Array.isArray(row.sessions) ? row.sessions : [];
    let all = true;
    const errors = [];
    for (const session of sessions) {
      try {
        await fn(session, row.holderId);
        deleted += 1;
      } catch (err) {
        all = false;
        failed += 1;
        errors.push(`${session}: ${(err && err.message) || 'failed'}`);
      }
    }
    if (all) {
      row.done = true;
      row.doneAt = typeof row.t === 'number' ? row.t : 0;
      row.deleted = sessions.slice();
    } else {
      row.errors = errors;
    }
  }
  writeDeleteQueue(dir, rows);
  return { ok: failed === 0, deleted, failed, rows };
}

module.exports = {
  DELETE_FILE,
  MIRROR_VERSION,
  MIRROR_TAG,
  MIRROR_KINDS,
  BLOB_KINDS,
  sessionFor,
  scopeFor,
  holderOfSession,
  canonical,
  rowId,
  reconcile,
  levelFor,
  encodeRow,
  decodeRow,
  pushPlan,
  readMirror,
  refold,
  deleteQueuePath,
  readDeleteQueue,
  writeDeleteQueue,
  queueDelete,
  drainDeleteQueue,
};
