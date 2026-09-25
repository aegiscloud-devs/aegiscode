'use strict';

/**
 * store.js — the main process's half of level authority (Phase 20).
 *
 * Phase 19 shipped the avatar core as five pure modules with no IO at all:
 * `xp.js` knows what an event is worth and how a ledger replays into a level,
 * `level.js` knows what a level buys, but neither can read a file or a clock.
 * This file is the missing half and it deliberately owns *only* the two things
 * the pure modules refuse to: the filesystem and the process's own memory of
 * what it has seen.
 *
 * Three rules shape everything below.
 *
 *  1. THE LEDGER IS THE ONLY STATE. There is no counter, no cached level, no
 *     "xp so far" anywhere in this file. `append()` writes one line; `state()`
 *     replays the whole file through `xp.evaluate()`. A hand-edited line — or a
 *     bug in this file — cannot inflate a level, because nothing here is
 *     trusted on the way out. The `xp` field written into each line is
 *     advisory (a convenience for `jq`), exactly as `xp.js` documents.
 *
 *  2. WRITES ARE APPEND-ONLY AND SINGLE-SYSCALL. `fs.appendFileSync` with the
 *     default O_APPEND is one write(2) per line, so a second process (the app
 *     launched twice is refused a second instance lock, but the CLI and the MCP
 *     plugin read the same home) can never rewrite a line under us, and a
 *     process killed mid-append loses at most the last line — which
 *     `xp.parseLedger()` is explicitly tolerant of.
 *
 *  3. LEVEL NEVER GATES A WRITE. The hook helpers below (`awardSave`,
 *     `awardQueued`, `awardRecalls`, `awardImports`) only ever *observe* the
 *     memory path; none of them can refuse it. `memoryWriteback` is not even
 *     consulted here, because memory is the source of XP and gating it would be
 *     the feedback deadlock `level.js` documents. The same goes for the
 *     approval classes: nothing in this file is reachable from the tool gate,
 *     which is what makes `test/avatar-approval-carveout.test.mjs` a statement
 *     about the design rather than a promise.
 *
 * Node-only (fs + path + crypto), no Electron import, injectable `dir`/`now`/
 * `env` — so the whole phase is testable in plain `node --test`, the same way
 * `lib/sync/*` and `lib/local/*` are.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const xp = require('./xp.js');
const level = require('./level.js');

/** `<userData>/avatar/ledger.jsonl` — the one path this module owns. */
const LEDGER_DIR = 'avatar';
const LEDGER_FILE = 'ledger.jsonl';
/** Hex chars of the content fingerprint kept per observed ref. */
const DIGEST_CHARS = 16;

function avatarHome(dir) {
  return path.join(dir, LEDGER_DIR);
}

function ledgerPath(dir) {
  return path.join(avatarHome(dir), LEDGER_FILE);
}

/** Content fingerprint for upsert/correction detection — never stored. */
function fingerprint(text) {
  return crypto
    .createHash('sha1')
    .update(String(text == null ? '' : text))
    .digest('hex')
    .slice(0, DIGEST_CHARS);
}

/**
 * A stable, content-addressed id for a memory entry that arrived without one.
 *
 * This is not decoration. aegis1's `/api/memory/save` upserts on
 * `(user_id, id)` and drops any entry carrying no `id`/`content`, so a caller
 * that sends a bare `{text}` (the renderer's "remember" box does exactly that)
 * has its write silently discarded — and a renderer-side counter would then be
 * paying XP for memory that does not exist. Deriving the id from the normalised
 * text makes that save real *and* idempotent: re-remembering the same fact
 * upserts one row instead of duplicating it, which is precisely the
 * "same fact re-observed" event `xp.js` pays `memory.reinforced` for.
 */
function memoryEntryId(entry) {
  const source = (entry && entry.source) || 'aegis-desktop';
  const text = String((entry && (entry.content != null ? entry.content : entry.text)) || '');
  return `note-${fingerprint(`${source}|${text.trim().toLowerCase()}`)}`;
}

/**
 * Give a plain memory entry the identity the memory path requires (id +
 * content + the metadata aegis1 keys rows on), leaving an entry that already
 * has them untouched. Fields the caller set always win.
 */
function normalizeMemoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const text =
    typeof entry.content === 'string' && entry.content
      ? entry.content
      : typeof entry.text === 'string'
        ? entry.text
        : '';
  if (!text) return entry;
  const out = Object.assign({}, entry);
  if (!out.content) out.content = text;
  if (!out.role) out.role = 'user';
  if (!out.source) out.source = 'aegis-desktop';
  if (!out.id) out.id = memoryEntryId(out);
  return out;
}

/**
 * Create the store for one user-data directory.
 *
 * @param {object} opts
 * @param {string} opts.dir                `<userData>` — the ledger's parent.
 * @param {() => number} [opts.now]        injectable clock (tests).
 * @param {object} [opts.env]              `AEGIS_*` overrides source.
 * @param {(msg: string) => void} [opts.log]
 */
function createAvatarStore({ dir, now = () => Date.now(), env = process.env, log = () => {} } = {}) {
  if (!dir || typeof dir !== 'string') {
    throw new Error('createAvatarStore: a user-data directory is required');
  }

  const file = ledgerPath(dir);
  /** Parsed-ledger cache, invalidated by size+mtime (another process may write). */
  let cache = null;
  /** sessionId -> level, for §1.4 "a level never regresses while you watch". */
  const held = new Map();
  /** Memory refs this process has observed to exist (reads, saves, recalls). */
  const live = new Set();
  /** ref -> fingerprint of the content last seen under it (upsert detection). */
  const digests = new Map();
  /** Refs observed to be gone; the only thing that can drop recall credit (§1.4). */
  const gone = new Set();

  function readParsed() {
    try {
      const st = fs.statSync(file);
      if (cache && cache.size === st.size && cache.mtimeMs === st.mtimeMs) return cache.parsed;
      const parsed = xp.parseLedger(fs.readFileSync(file, 'utf8'));
      cache = { size: st.size, mtimeMs: st.mtimeMs, parsed };
      return parsed;
    } catch (err) {
      if (err && err.code === 'ENOENT') return { entries: [], corrupt: 0 };
      // A ledger we cannot read is not a reason to take the app down: report it
      // and replay what we have (nothing), which reads as L1 — the honest
      // answer, and the one that gates no behaviour.
      log(`aegis: could not read ${file}: ${err && err.message}`);
      return { entries: [], corrupt: 0, error: (err && err.message) || 'unreadable' };
    }
  }

  /**
   * Append one ledger line. One syscall, O_APPEND, `mkdir -p` first: a ledger
   * line is a few dozen bytes, far below any pipe buffer, so this cannot tear.
   */
  function appendLine(entry) {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, line);
      if (cache) {
        cache = {
          size: cache.size + Buffer.byteLength(line),
          mtimeMs: 0, // unknown after our own write; force one stat on the next read
          parsed: { entries: cache.parsed.entries.concat([entry]), corrupt: cache.parsed.corrupt },
        };
      }
      return entry;
    } catch (err) {
      // Losing a ledger line costs XP, never memory: always reported, never
      // thrown at a caller whose real work (the save) already succeeded.
      log(`aegis: could not append to ${file}: ${err && err.message}`);
      cache = null;
      return entry;
    }
  }

  /** Append one event. `kind` must be one `xp.js` pays for, or it pays zero. */
  function award(kind, fields = {}) {
    const t = typeof fields.t === 'number' && fields.t ? fields.t : now();
    const entry = xp.makeEntry(kind, Object.assign({}, fields, { t }), { t });
    return appendLine(entry);
  }

  /**
   * Record that a memory ref exists in the cloud, with the content currently
   * under it. Returns what the *save* was, in the vocabulary `xp.js` prices:
   *
   *   'new'     — an id we have never seen: a durable save (`memory.saved`)
   *   'same'    — the same id AND the same content: an upsert, the fact
   *               re-observed (`memory.reinforced`)
   *   'changed' — the same id carrying different text: we replaced an entry
   *               (`memory.corrected`)
   *
   * Ids are aegis1's identity (`ON CONFLICT (user_id, id)`), so this is the
   * server's own notion of "the same entry", not a heuristic over prose.
   */
  function observe(ref, text) {
    if (ref == null || ref === '') return 'new';
    const id = String(ref);
    const digest = fingerprint(text);
    const prior = digests.get(id);
    const known = live.has(id);
    digests.set(id, digest);
    live.add(id);
    if (prior === undefined) return known ? 'same' : 'new';
    return prior === digest ? 'same' : 'changed';
  }

  /** Refs that currently exist, as far as this process knows. Null = never looked. */
  function liveRefs() {
    if (!live.size) return null;
    const set = new Set(live);
    for (const ref of gone) set.delete(ref);
    return set;
  }

  /**
   * Derive the current state: replay → level → capabilities, with the `AEGIS_*`
   * env overrides applied (they win, so a headless run's breadth is not decided
   * by someone's XP).
   */
  function state(opts = {}) {
    const session = opts.session == null ? null : opts.session;
    const parsed = readParsed();
    const heldRec = session != null ? held.get(session) || null : null;
    const derived = xp.evaluate(parsed.entries, {
      liveRefs: liveRefs(),
      held: heldRec,
      session,
    });
    const overridden = level.applyEnvOverrides(level.capabilities(derived.level), opts.env || env);
    // Remember what the user was shown, so a later reconcile cannot make the
    // level tick downwards mid-session (§1.4).
    if (session != null) held.set(session, xp.nextHeld(derived, session));
    return Object.assign({}, derived, {
      capabilities: overridden.caps,
      envIgnored: overridden.ignored,
      ledger: { file, entries: parsed.entries.length, corrupt: parsed.corrupt || 0 },
    });
  }

  /** Just the caps object — the ONE thing turn assembly reads (§2). */
  function capabilities(opts = {}) {
    return state(opts).capabilities;
  }

  /** Award a durable cloud save, classified by the observation index. */
  function awardSave(entry = {}, fields = {}) {
    const ref = entry && entry.id != null ? String(entry.id) : null;
    const text = entry && (entry.content != null ? entry.content : entry.text);
    const klass = observe(ref, text);
    const kind =
      klass === 'new' ? 'memory.saved' : klass === 'changed' ? 'memory.corrected' : 'memory.reinforced';
    const written = award(
      kind,
      Object.assign({ ref, source: entry && entry.source }, fields)
    );
    return { kind, ref: ref, class: klass, entry: written };
  }

  /** Award an offline save that landed in the local queue instead of the cloud. */
  function awardQueued(entry = {}, fields = {}) {
    const ref = entry && entry.id != null ? String(entry.id) : null;
    observe(ref, entry && (entry.content != null ? entry.content : entry.text));
    const written = award('memory.queued', Object.assign({ ref, source: entry && entry.source }, fields));
    return { kind: 'memory.queued', ref, entry: written };
  }

  /**
   * Award the recalls a turn actually injected. Capped at
   * `xp.RECALL_PER_TURN_CAP` *lines*, so the ledger never carries a burst of
   * unpaid events: breadth is what a level buys, XP is not. The returned count
   * is "how many paid", not "how many were injected".
   */
  function awardRecalls(entries, opts = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const capped = list.slice(0, xp.RECALL_PER_TURN_CAP);
    for (const entry of capped) {
      observe(entry && entry.id, entry && (entry.content != null ? entry.content : entry.text));
      award('memory.recalled', {
        ref: entry && entry.id != null ? String(entry.id) : null,
        session: opts.session,
        turn: opts.turn,
      });
    }
    return { awarded: capped.length, injected: list.length };
  }

  /**
   * Award an import batch. Capped per source per call at
   * `xp.IMPORT_PER_SOURCE_CAP` — the same ceiling the replay applies ledger-wide,
   * enforced here too so a ten-tool import cannot write 100k lines.
   */
  function awardImports(entries, opts = {}) {
    const list = Array.isArray(entries) ? entries : [];
    const capped = list.slice(0, xp.IMPORT_PER_SOURCE_CAP);
    for (const entry of capped) {
      observe(entry && entry.id, entry && (entry.content != null ? entry.content : entry.text));
      award('memory.imported', {
        ref: entry && entry.id != null ? String(entry.id) : null,
        source: opts.source,
        session: opts.session,
      });
    }
    return { awarded: capped.length, injected: list.length };
  }

  /**
   * The only way recall credit is ever dropped (§1.4): an entry the caller knows
   * is gone. Nothing in the desktop deletes memory yet — the per-holder forget
   * surface arrives with Phases 26–29 — so this is the seam, exercised by tests
   * today and by that surface later. Savings deliberately survive: you did that
   * work, and it stays done.
   */
  function markGone(refs) {
    const list = Array.isArray(refs) ? refs : [refs];
    for (const ref of list) {
      if (ref != null && ref !== '') gone.add(String(ref));
    }
    return gone.size;
  }

  /**
   * Boot check: sweep the whole level range through `level.js`'s own invariant
   * checker. main() calls this before it hands the caps to anything, and drops
   * the avatar entirely if it throws — a capabilities object that weakens the
   * write/shell/network gate must not be used for anything, least of all as an
   * excuse to keep running with it.
   */
  function verifyAtBoot() {
    const violations = level.verifyInvariants();
    level.assertCarveOuts(level.capabilities(1));
    return { ok: violations.length === 0, violations };
  }

  return {
    dir,
    file,
    read: readParsed,
    append: award,
    award,
    observe,
    awardSave,
    awardQueued,
    awardRecalls,
    awardImports,
    markGone,
    liveRefs,
    state,
    capabilities,
    verifyAtBoot,
  };
}

module.exports = {
  LEDGER_DIR,
  LEDGER_FILE,
  avatarHome,
  ledgerPath,
  fingerprint,
  memoryEntryId,
  normalizeMemoryEntry,
  createAvatarStore,
};
