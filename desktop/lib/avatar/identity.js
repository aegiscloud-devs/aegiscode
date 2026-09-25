'use strict';

/**
 * identity.js — whose memory it is.
 *
 * `docs/avatar-plan.md` made memory the value; value is meaningless
 * unattributed. This module answers exactly one question — *which holder is at
 * the keyboard* — from signals the caller already has, and it answers with a
 * **proposal plus provenance**, never with a merge.
 *
 * The precedence (identity plan §2) is deliberate and ordered by how much the
 * signal actually proves:
 *
 *   explicit        `AEGIS_AVATAR_HOLDER` / persona `identity.holderId`.
 *                   Deliberate beats inferred — CI and power users need it.
 *   account         a cloud account id. Survives key rotation.
 *   keyFingerprint  `sha256(key).slice(0, FINGERPRINT_LENGTH)`, computed in
 *                   main. The only signal a fresh install has.
 *   local           a minted `h_<12 hex>`: single-user offline machines.
 *
 * Four rules, and each one is an assertion in `desktop/test/avatar-identity
 * .test.mjs` rather than a sentence in a doc:
 *
 *  1. **A fingerprint is not an identity.** It says "same credential", not
 *     "same person" — two holders on one box can legitimately share a key. So a
 *     fingerprint match that disagrees with the registry's active holder
 *     returns `conflict: { a, b, reason }` and *both rows keep existing*. Nothing
 *     here ever moves data between holders.
 *  2. **No key material, anywhere.** `fingerprint()` is the only thing that sees
 *     a key, it is one-way and truncated, and `resolve()` accepts a fingerprint
 *     *by shape* (12 lowercase hex) or not at all: a raw key, or an untruncated
 *     64-char digest, is rejected and warned about rather than trusted. Nothing
 *     returned by this module can carry a long high-entropy hex run, so a caller
 *     cannot accidentally log one.
 *  3. **The OS user name is a hint, never an id.** `neo` on two machines is two
 *     relationships and `neo` on a shared box is not a person, so `osUser` can
 *     only ever influence `displayName`.
 *  4. **Resolution is pure and never writes.** `holders.json` is validated,
 *     repaired and copied; the input registry is never mutated, and the fields
 *     `proposal`/`conflict`/`needsMint` exist precisely so main writes the file
 *     with the user's confirmation (Phase 26) instead of this module guessing.
 *
 * Pure: no fs, no Electron, no crypto import — the caller supplies `hash` so
 * this file is testable in plain Node exactly like `lib/sync/*`.
 */

const persona = require('./persona.js');

/** Bump when the registry record shape changes; `migrate` walks it forward. */
const SCHEMA_VERSION = 1;

/**
 * `sha256(apiKey).slice(0, 12)` (identity plan §2). Short on purpose: it is an
 * index for a registry row, not an authenticator.
 */
const FINGERPRINT_LENGTH = 12;

/** A registry is an index of at most this many holders. */
const MAX_HOLDERS = 32;
const MAX_DISPLAY_NAME = 40;
const MAX_ACCOUNT_ID = 64;

/** Minted ids: `h_` + 12 lowercase hex, matching the plan's examples. */
const HOLDER_ID_RE = /^h_[0-9a-f]{12}$/;
/**
 * Ids accepted *from the outside* (env, persona, registry file): wider than we
 * mint, still narrow. Capped at 16 hex so no field this module returns can
 * contain a 20+ character hex run (rule 2) even when the caller passes one.
 */
const HOLDER_ID_SHAPE = /^h_[0-9a-f]{8,16}$/;
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;
/** Account ids are opaque server-side strings; this is a shape check only. */
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{3,63}$/;
/** Anything that looks like key material rather than a name or an id. */
const KEY_SHAPE = /^(?:sk|pk|gsk|xox[baprs]|ghp|glpat|aegis)[-_][A-Za-z0-9_-]{6,}/i;
const LONG_HEX = /[0-9a-f]{20,}/i;
const BEARER = /^Bearer\s+\S+/i;

/** The neutral fallback. Never the OS user name, never a guess. */
const DEFAULT_DISPLAY_NAME = 'You';

// ---------------------------------------------------------------------------
// hashing helpers — the caller owns the hash
// ---------------------------------------------------------------------------

/** Accept a hex string or a byte array (Buffer/Uint8Array) and return hex. */
function toHex(value) {
  if (typeof value === 'string') {
    const flat = value.trim().toLowerCase().replace(/\s+/g, '');
    return /^[0-9a-f]+$/.test(flat) ? flat : null;
  }
  if (value instanceof Uint8Array || Array.isArray(value)) {
    let out = '';
    for (const byte of value) {
      const b = Number(byte);
      if (!Number.isInteger(b) || b < 0 || b > 255) return null;
      out += b.toString(16).padStart(2, '0');
    }
    return out || null;
  }
  return null;
}

/**
 * One-way, truncated digest of a credential. **The only function in the tree
 * that sees a raw key.**
 *
 * @param {(input: string) => string|Uint8Array} hash caller's digest (e.g.
 *   `(s) => crypto.createHash('sha256').update(s).digest('hex')`)
 * @param {string} key the credential
 * @returns {string|null} 12 lowercase hex, or `null` for anything unusable —
 *   `null` rather than a throw because a missing key is the fresh-install case,
 *   not an error.
 */
function fingerprint(hash, key) {
  if (typeof hash !== 'function') return null;
  if (typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  let digest;
  try {
    digest = hash(trimmed);
  } catch {
    return null;
  }
  const hex = toHex(digest);
  if (!hex || hex.length < FINGERPRINT_LENGTH) return null;
  return hex.slice(0, FINGERPRINT_LENGTH);
}

/** Shape check only — this says "a fingerprint could look like this". */
function isFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT_RE.test(value.trim().toLowerCase());
}

/**
 * Does this look like a secret rather than an identifier? Used to refuse an
 * account id, a display hint, or a fingerprint that is really a key.
 */
function looksLikeRawKey(value) {
  if (typeof value !== 'string') return false;
  const flat = value.trim();
  if (!flat) return false;
  return KEY_SHAPE.test(flat) || BEARER.test(flat) || LONG_HEX.test(flat);
}

/**
 * Deterministic local id minting: `h_` + 12 hex of `hash(seed)`.
 *
 * Deterministic on purpose — the same machine seed produces the same id on a
 * reinstall, which is what keeps "the ledger survives a reinstall"
 * (`avatar-plan.md` §1.5) true for an install that never had a cloud key.
 *
 * @returns {string|null} `null` when there is nothing trustworthy to mint from;
 *   the caller then falls back to random bytes (main, Phase 26).
 */
function mintHolderId(hash, seed) {
  if (typeof hash !== 'function') return null;
  if (typeof seed !== 'string' || !seed.trim()) return null;
  let digest;
  try {
    digest = hash(seed.trim());
  } catch {
    return null;
  }
  const hex = toHex(digest);
  if (!hex || hex.length < FINGERPRINT_LENGTH) return null;
  const id = `h_${hex.slice(0, FINGERPRINT_LENGTH)}`;
  return HOLDER_ID_RE.test(id) ? id : null;
}

// ---------------------------------------------------------------------------
// the registry — `holders.json`, an index and not the data
// ---------------------------------------------------------------------------

/** A display name is a single line of UI text, capped, and never a digest. */
function cleanDisplay(value, fallback = DEFAULT_DISPLAY_NAME) {
  if (typeof value !== 'string') return fallback;
  // A hint that looks like a credential is not shown as one.
  if (looksLikeRawKey(value)) return fallback;
  const flat = persona.cleanText(value, MAX_DISPLAY_NAME);
  return flat || fallback;
}

function numOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A short label that is safe to put in a warning: a value we could not accept is
 * never echoed back, because the caller may have handed us a credential in the
 * wrong slot (rule 2). `warnings` travels into main's log, so echoing it would
 * be the leak this module exists to prevent.
 */
function safeLabel(value) {
  if (typeof value !== 'string' || !value.trim()) return '(empty)';
  const flat = value.trim();
  if (flat.length > 24 || looksLikeRawKey(flat)) return '(withheld)';
  return flat;
}

/** A valid, mappable holder id from an outside source, or `null`. */
function holderIdShape(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return HOLDER_ID_SHAPE.test(id) ? id : null;
}

function emptyRegistry() {
  return { schema: SCHEMA_VERSION, active: null, holders: [] };
}

/**
 * Walk an old record forward. With one schema version this is trivial, but the
 * mechanism exists now so that adding v2 is a table entry rather than a
 * discovery that shipped registries cannot be read.
 */
const MIGRATIONS = Object.freeze({
  // 0 → 1: pre-schema registries are partial records; normalisation fills them.
  0: (raw) => Object.assign({}, raw),
});

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { registry: emptyRegistry(), migrated: false, fromSchema: 0 };
  let current = raw;
  let version = Number.isInteger(current.schema) ? current.schema : 0;
  let migrated = false;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    current = step ? step(current) : current;
    version += 1;
    migrated = true;
  }
  return { registry: current, migrated, fromSchema: Number.isInteger(raw.schema) ? raw.schema : 0 };
}

/**
 * Validate and repair a registry.
 *
 * Repair-oriented like `persona.js`: the only hard errors are "not an object"
 * and "schema from the future", because this is a file the user can hand-edit
 * and a bad row must not take the app down. Everything else is coerced, dropped
 * or repaired and reported in `warnings`.
 *
 * @returns {{ ok: boolean, registry: object, errors: string[], warnings: string[], migrated: boolean }}
 */
function validate(raw) {
  const errors = [];
  const warnings = [];

  if (raw === undefined || raw === null) {
    return { ok: true, registry: emptyRegistry(), errors, warnings: ['no holders registry yet — starting empty'], migrated: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, registry: emptyRegistry(), errors: ['holders.json must be a JSON object'], warnings, migrated: false };
  }
  if (Number.isInteger(raw.schema) && raw.schema > SCHEMA_VERSION) {
    return {
      ok: false,
      registry: emptyRegistry(),
      errors: [`holders schema ${raw.schema} is newer than this build supports (${SCHEMA_VERSION})`],
      warnings,
      migrated: false,
    };
  }

  const { registry: migratedRegistry, migrated } = migrate(raw);
  const src = migratedRegistry;

  const rows = [];
  const seen = new Set();
  const rawHolders = Array.isArray(src.holders) ? src.holders : [];
  if (src.holders !== undefined && !Array.isArray(src.holders)) {
    warnings.push('holders must be an array — ignored');
  }
  for (const rawRow of rawHolders) {
    if (rows.length >= MAX_HOLDERS) {
      warnings.push(`at most ${MAX_HOLDERS} holders — extra rows dropped`);
      break;
    }
    if (!rawRow || typeof rawRow !== 'object' || Array.isArray(rawRow)) {
      warnings.push('a holder row was not an object — dropped');
      continue;
    }
    const id = holderIdShape(rawRow.id);
    if (!id) {
      warnings.push(`holder id ${safeLabel(rawRow.id)} is not h_ plus 8-16 hex — row dropped`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`duplicate holder id ${id} — the later row was dropped`);
      continue;
    }
    seen.add(id);

    let fingerprintValue = typeof rawRow.fingerprint === 'string' ? rawRow.fingerprint.trim().toLowerCase() : null;
    if (fingerprintValue && !FINGERPRINT_RE.test(fingerprintValue)) {
      // The row survives; the bad fingerprint does not. A malformed digest is a
      // repair, not a reason to lose the holder's display name and timestamps.
      warnings.push(`holder ${id} fingerprint is not ${FINGERPRINT_LENGTH} lowercase hex — dropped from the row`);
      fingerprintValue = null;
    }

    let accountId = null;
    if (rawRow.accountId !== undefined && rawRow.accountId !== null) {
      const candidate = typeof rawRow.accountId === 'string' ? rawRow.accountId.trim() : '';
      if (candidate && ACCOUNT_ID_RE.test(candidate) && !looksLikeRawKey(candidate)) accountId = candidate;
      else warnings.push(`holder ${id} accountId was rejected by shape`);
    }

    rows.push({
      id,
      displayName: cleanDisplay(rawRow.displayName, id),
      fingerprint: fingerprintValue,
      accountId,
      personaName: cleanDisplay(rawRow.personaName, null),
      createdAt: numOrNull(rawRow.createdAt),
      lastSeenAt: numOrNull(rawRow.lastSeenAt),
    });
  }

  // Two rows on one fingerprint is exactly the case that makes "a fingerprint
  // is not an identity" load-bearing (§3/§6): it is legal, and resolve() reports
  // it rather than merging the rows.
  const byFingerprint = new Map();
  for (const row of rows) {
    if (!row.fingerprint) continue;
    if (byFingerprint.has(row.fingerprint)) {
      warnings.push(`holders ${byFingerprint.get(row.fingerprint)} and ${row.id} share one key fingerprint — resolve() proposes, never merges`);
    } else {
      byFingerprint.set(row.fingerprint, row.id);
    }
  }

  let active = typeof src.active === 'string' ? holderIdShape(src.active) : null;
  if (src.active !== undefined && src.active !== null && src.active !== '' && !active) {
    warnings.push(`active ${safeLabel(src.active)} is not a holder id — repaired`);
  }
  if (active && !rows.some((row) => row.id === active)) {
    warnings.push(`active holder ${active} is not in the registry — repaired`);
    active = null;
  }
  if (!active && rows.length) active = rows[0].id;

  for (const key of Object.keys(src)) {
    if (!['schema', 'active', 'holders'].includes(key)) {
      warnings.push(`unknown registry key ${safeLabel(key)} — ignored`);
    }
  }

  return { ok: true, errors, warnings, migrated, registry: { schema: SCHEMA_VERSION, active, holders: rows } };
}

/** Convenience: validate and hand back just the record. */
function load(raw) {
  return validate(raw).registry;
}

/** Shallow-merge a patch onto a valid registry, then re-validate. */
function update(current, patch) {
  const base = validate(current).registry;
  if (!patch || typeof patch !== 'object') return validate(base);
  const merged = {
    schema: SCHEMA_VERSION,
    active: patch.active !== undefined ? patch.active : base.active,
    holders: patch.holders !== undefined ? patch.holders : base.holders,
  };
  return validate(merged);
}

function findHolder(registry, id) {
  const wanted = holderIdShape(id);
  if (!wanted) return null;
  return load(registry).holders.find((row) => row.id === wanted) || null;
}

function findByFingerprint(registry, value) {
  if (!isFingerprint(value)) return null;
  const wanted = String(value).trim().toLowerCase();
  return load(registry).holders.find((row) => row.fingerprint === wanted) || null;
}

/** Every row on one fingerprint, id-ascending. Usually 0 or 1; 2 is legal. */
function allByFingerprint(registry, value) {
  if (!isFingerprint(value)) return [];
  const wanted = String(value).trim().toLowerCase();
  return load(registry)
    .holders.filter((row) => row.fingerprint === wanted)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function findByAccount(registry, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const wanted = value.trim();
  return load(registry).holders.find((row) => row.accountId === wanted) || null;
}

function hasFingerprint(registry, value) {
  return Boolean(findByFingerprint(registry, value));
}

/**
 * Append a holder row. An invalid row comes back as a warning on an unchanged
 * registry rather than a throw — the same contract as `persona.validate`.
 * The first valid row also becomes `active`, because a registry with one holder
 * and no active holder is a state main would have to guess its way out of.
 */
function addHolder(current, holder) {
  const base = validate(current).registry;
  if (base.holders.length >= MAX_HOLDERS) {
    return update(base, {});
  }
  const next = update(base, { holders: base.holders.concat([holder]) });
  if (!next.registry.active && next.registry.holders.length === base.holders.length + 1) {
    return update(next.registry, { active: next.registry.holders[next.registry.holders.length - 1].id });
  }
  return next;
}

function setActive(current, id) {
  const base = validate(current).registry;
  const wanted = holderIdShape(id);
  if (wanted && base.holders.some((row) => row.id === wanted)) return update(base, { active: wanted });
  return validate(base);
}

/** Phase 29 «forget»: drop one row, and re-point `active` if it was that row. */
function removeHolder(current, id) {
  const base = validate(current).registry;
  const wanted = holderIdShape(id);
  if (!wanted || !base.holders.some((row) => row.id === wanted)) return validate(base);
  const holders = base.holders.filter((row) => row.id !== wanted);
  return update(base, { holders, active: base.active === wanted ? null : base.active });
}

/** Record a sighting. `t` is caller-supplied so this stays clock-free. */
function touch(current, id, t) {
  const base = validate(current).registry;
  const wanted = holderIdShape(id);
  const when = numOrNull(t);
  if (!wanted || when === null || !base.holders.some((row) => row.id === wanted)) return validate(base);
  const holders = base.holders.map((row) => (
    row.id === wanted ? Object.assign({}, row, { lastSeenAt: Math.max(row.lastSeenAt ?? when, when) }) : row
  ));
  return update(base, { holders });
}

// ---------------------------------------------------------------------------
// resolution
// ---------------------------------------------------------------------------

/** Per-rung confidence: how much the signal actually proves (identity plan §2). */
const CONFIDENCE = Object.freeze({
  explicit: 1,
  account: 0.9,
  keyFingerprint: 0.6,
  local: 0.4,
});

/**
 * Decide which holder is at the keyboard.
 *
 * @param {object} signals
 * @param {string} [signals.explicit]        `AEGIS_AVATAR_HOLDER` or persona `identity.holderId`
 * @param {string} [signals.account]         cloud account id, when the server gives one
 * @param {string} [signals.keyFingerprint]  output of `fingerprint()` — never a key
 * @param {string} [signals.local]           the minted id main keeps in `__avatar` settings
 * @param {string} [signals.osUser]          display hint ONLY (rule 3)
 * @param {string} [signals.machineSeed]     stable per-machine entropy for `mintHolderId`
 * @param {(s: string) => string|Uint8Array} [signals.hash] the caller's digest
 * @param {object} [registry]                parsed (or unparsed) `holders.json`
 * @returns {{ holderId: string|null, source: string|null, confidence: number,
 *             displayName: string, conflict: {a: string, b: string, reason: string}|null,
 *             known: boolean, needsMint: boolean, proposal: object|null, warnings: string[] }}
 *   `conflict.a` is what you would be switching away from (the registry's
 *   active holder, or the losing signal's holder) and `conflict.b` is the
 *   proposal. Returned so main can show a "who is at the keyboard?" card
 *   (Phase 28) instead of switching silently.
 */
function resolve(signals, registry) {
  const raw = signals && typeof signals === 'object' ? signals : {};
  const reg = load(registry);
  const active = reg.active;
  const warnings = [];

  // --- signal intake: every rung is shape-checked before it is believed ----
  const explicit = holderIdShape(raw.explicit);
  if (raw.explicit !== undefined && raw.explicit !== null && raw.explicit !== '' && !explicit) {
    warnings.push('explicit holder id ignored: expected h_ plus 8-16 hex');
  }

  let account = null;
  if (raw.account !== undefined && raw.account !== null && raw.account !== '') {
    const candidate = typeof raw.account === 'string' ? raw.account.trim() : '';
    if (candidate && ACCOUNT_ID_RE.test(candidate) && !looksLikeRawKey(candidate)) account = candidate;
    else warnings.push('account signal ignored: rejected by shape');
  }

  let keyFingerprint = null;
  if (raw.keyFingerprint !== undefined && raw.keyFingerprint !== null && raw.keyFingerprint !== '') {
    // Rule 2, the load-bearing one: an already-computed fingerprint or nothing.
    if (isFingerprint(raw.keyFingerprint)) keyFingerprint = String(raw.keyFingerprint).trim().toLowerCase();
    else warnings.push('keyFingerprint ignored: expected the 12-hex output of fingerprint(), not a key or a full digest');
  }

  const local = holderIdShape(raw.local);
  if (raw.local !== undefined && raw.local !== null && raw.local !== '' && !local) {
    warnings.push('local holder id ignored: expected h_ plus 8-16 hex');
  }

  // Rule 3: the OS user name reaches `displayName` and nothing else.
  const hint = cleanDisplay(raw.osUser, null);
  const hash = typeof raw.hash === 'function' ? raw.hash : null;
  const seed = typeof raw.machineSeed === 'string' && raw.machineSeed.trim() ? raw.machineSeed : null;

  function finish(parts) {
    const holderId = parts.holderId || null;
    const row = holderId ? reg.holders.find((r) => r.id === holderId) || null : null;
    // A fingerprint that matches no registry row proves nothing about who this
    // is, so it can never *select* a holder. It can only be proposed for
    // binding onto the holder that WAS resolved, which main writes only after
    // the user confirms (Phase 26) — this module never writes anything. Built
    // here rather than in the last rung so every rung reports it identically:
    // an explicit persona import with a freshly rotated key is the same
    // question as a fresh install with one.
    const proposal = holderId && keyFingerprint && !hasFingerprint(reg, keyFingerprint)
      ? { kind: 'bind-fingerprint', holderId, fingerprint: keyFingerprint }
      : null;
    return {
      holderId,
      source: holderId ? parts.source : null,
      confidence: holderId ? parts.confidence : 0,
      displayName: row ? row.displayName : hint || DEFAULT_DISPLAY_NAME,
      conflict: parts.conflict || null,
      known: Boolean(row),
      needsMint: Boolean(parts.needsMint),
      proposal,
      warnings,
    };
  }

  // --- rung 1: deliberate beats inferred --------------------------------
  if (explicit) {
    return finish({ holderId: explicit, source: 'explicit', confidence: CONFIDENCE.explicit });
  }

  const byAccount = account ? findByAccount(reg, account) : null;
  const fpRows = keyFingerprint ? allByFingerprint(reg, keyFingerprint) : [];
  const byFingerprint = fpRows.length ? (fpRows.find((row) => row.id === active) || fpRows[0]) : null;

  // --- rung 2: account (survives key rotation) ---------------------------
  if (byAccount && byFingerprint && byAccount.id !== byFingerprint.id) {
    // Both strong signals landed on existing holders, and they disagree. The
    // account is the stronger claim; the disagreement is reported, not hidden.
    return finish({
      holderId: byAccount.id,
      source: 'account',
      confidence: CONFIDENCE.account,
      conflict: { a: byFingerprint.id, b: byAccount.id, reason: 'account-vs-fingerprint' },
    });
  }
  if (byFingerprint && fpRows.length > 1) {
    // One credential, two rows: legal (a shared BYOK key) and never merged.
    const chosen = fpRows.find((row) => row.id === active) || fpRows[0];
    const other = fpRows.find((row) => row.id !== chosen.id);
    return finish({
      holderId: chosen.id,
      source: 'keyFingerprint',
      confidence: CONFIDENCE.keyFingerprint,
      conflict: { a: other.id, b: chosen.id, reason: 'duplicate-fingerprint' },
    });
  }
  if (byAccount) {
    return finish({
      holderId: byAccount.id,
      source: 'account',
      confidence: CONFIDENCE.account,
      conflict: active && active !== byAccount.id ? { a: active, b: byAccount.id, reason: 'account' } : null,
    });
  }
  if (byFingerprint) {
    return finish({
      holderId: byFingerprint.id,
      source: 'keyFingerprint',
      confidence: CONFIDENCE.keyFingerprint,
      // A fingerprint match PROPOSES a rebind. Both rows survive; main asks.
      conflict: active && active !== byFingerprint.id ? { a: active, b: byFingerprint.id, reason: 'key-fingerprint' } : null,
    });
  }

  // --- rung 4: local ------------------------------------------------------
  let holderId = local || holderIdShape(active);
  let needsMint = false;
  if (!holderId) {
    holderId = hash && seed ? mintHolderId(hash, seed) : null;
    if (!holderId) {
      needsMint = true;
      warnings.push('no holder signal is available — main must mint a local holder id');
    }
  }

  // A fingerprint that matches no row cannot select a holder here; `finish()`
  // turns it into a bind proposal for whichever holder did resolve.
  return finish({ holderId, source: 'local', confidence: CONFIDENCE.local, needsMint });
}

module.exports = {
  SCHEMA_VERSION,
  FINGERPRINT_LENGTH,
  MAX_HOLDERS,
  MAX_DISPLAY_NAME,
  DEFAULT_DISPLAY_NAME,
  CONFIDENCE,
  HOLDER_ID_RE,
  HOLDER_ID_SHAPE,
  FINGERPRINT_RE,
  fingerprint,
  mintHolderId,
  isFingerprint,
  looksLikeRawKey,
  safeLabel,
  cleanDisplay,
  emptyRegistry,
  migrate,
  validate,
  load,
  update,
  findHolder,
  findByFingerprint,
  allByFingerprint,
  findByAccount,
  hasFingerprint,
  addHolder,
  setActive,
  removeHolder,
  touch,
  resolve,
};
