'use strict';

/**
 * level.js — what a level actually buys.
 *
 * RULE ZERO, and the reason this module is a pure function instead of a feature
 * flag soup: **a bonus may only be a knob the engine already takes.** Levelling
 * never invents a code path; it widens the values of parameters turn assembly,
 * the tool host and the companion behaviours already read. Recall breadth is
 * `memorySearch`'s `limit`. The model floor is the model picker's minimum. The
 * queue drain is a tool grant the host already understands. If a proposed bonus
 * cannot be expressed as one of those, it is not a bonus — it is a new feature
 * wearing a level as a disguise.
 *
 * `capabilities(level)` is therefore the ONE object the rest of the app reads,
 * and it is deliberately written so the safety-relevant entries are *not* a
 * function of level at all: `approvals.write`, `approvals.shell`,
 * `approvals.network` and `approvals.offDevice` are literally the same frozen
 * values at every level. That is what makes the carve-outs below assertable
 * rather than merely promised — there is no branch to get wrong.
 *
 * The carve-outs (asserted in `test/avatar-level.test.mjs` AND enforced at
 * runtime by `verifyInvariants`, which main calls at boot):
 *
 *   - Approval gates for writes, shell and network are level-independent.
 *     Levelling must never widen blast radius.
 *   - `memoryWriteback` is always true and never gated on level: memory is the
 *     source of XP, so gating it would be a feedback deadlock.
 *   - Nothing level-gated may send data off-device (publishing, posting, email).
 *   - `AEGIS_*` env overrides win over capabilities for automation and CI — and
 *     they too cannot widen write/shell/network approval.
 *
 * Pure: no fs, no Electron, no process access except the `env` the caller
 * passes. See `docs/avatar-plan.md` §2.
 */

const { TIERS, tierFor, tierIndex } = require('./tiers.js');

/**
 * The four approval classes that are NOT a function of level. Frozen once and
 * shared by every capabilities object, so `caps.approvals.write` is the same
 * string for a brand-new install and a level-40 archivist.
 */
const LEVEL_INDEPENDENT_APPROVALS = Object.freeze({
  write: 'ask',
  shell: 'ask',
  network: 'ask',
  offDevice: 'ask',
});

/** Classes that may ever be auto-approved. Writes/shell/network never appear. */
const AUTO_APPROVABLE_CLASSES = Object.freeze(['read', 'diff']);

/** Levels at which each tier's headline bonus lands. Kept next to the tier table. */
const GATES = Object.freeze({
  hints: 2,
  brief: 5,
  ideaLog: 5,
  autoApproveDiff: 10,
  sessionReflection: 10,
  voice: 10,
  reasoningFloor: 20,
  queueDrain: 20,
  importAssistant: 35,
});

/**
 * Cosmetic unlocks. Cosmetics are the ONLY thing this product may ever sell, so
 * the free/paid line is expressed here as data: an id with a `paid` flag and
 * nothing else. No unlock in this table is allowed to gate XP, a level, recall
 * breadth, or approval friction — `verifyInvariants` checks the *capability*
 * side of that; the table itself only ever lists presentation ids.
 */
const UNLOCKS = Object.freeze([
  Object.freeze({ id: 'expression.core', level: 1, kind: 'expressions', paid: false, label: 'Core expressions' }),
  Object.freeze({ id: 'outfit.hoodie', level: 1, kind: 'outfit', paid: false, label: 'Hoodie' }),
  Object.freeze({ id: 'outfit.tshirt', level: 1, kind: 'outfit', paid: false, label: 'T-shirt' }),
  Object.freeze({ id: 'palette.amber', level: 1, kind: 'palette', paid: false, label: 'Amber' }),
  Object.freeze({ id: 'outfit.headphones', level: 5, kind: 'outfit', paid: false, label: 'Headphones' }),
  Object.freeze({ id: 'expression.trusted', level: 5, kind: 'expressions', paid: false, label: 'Trusted expressions' }),
  Object.freeze({ id: 'palette.slate', level: 5, kind: 'palette', paid: false, label: 'Slate' }),
  Object.freeze({ id: 'outfit.layers', level: 5, kind: 'outfit', paid: false, label: 'Outfit layers' }),
  Object.freeze({ id: 'expression.companion', level: 10, kind: 'expressions', paid: false, label: 'Companion expressions' }),
  Object.freeze({ id: 'voice.core', level: 10, kind: 'voice', paid: false, label: 'Voice (local)' }),
  Object.freeze({ id: 'expression.confidant', level: 20, kind: 'expressions', paid: false, label: 'Confidant expressions' }),
  Object.freeze({ id: 'outfit.seasonal', level: 20, kind: 'outfit', paid: true, label: 'Seasonal set' }),
  Object.freeze({ id: 'expression.archivist', level: 35, kind: 'expressions', paid: false, label: 'Archivist expressions' }),
  Object.freeze({ id: 'outfit.archive', level: 35, kind: 'outfit', paid: true, label: 'Archive set' }),
]);

const PROACTIVITY_ORDER = Object.freeze(['off', 'hints', 'brief']);

function clampLevel(level) {
  const n = Math.floor(typeof level === 'number' && Number.isFinite(level) ? level : 1);
  return Math.max(1, n);
}

function atLeast(level, gate) {
  return clampLevel(level) >= gate;
}

/** Ids unlocked at or below `level`. */
function unlockedBy(level) {
  const n = clampLevel(level);
  return UNLOCKS.filter((u) => u.level <= n).map((u) => u.id);
}

/** The next unlock(s) to dangle in the HUD, or null at the top of the table. */
function nextUnlock(level) {
  const n = clampLevel(level);
  const ahead = UNLOCKS.filter((u) => u.level > n);
  if (!ahead.length) return null;
  const level_ = Math.min(...ahead.map((u) => u.level));
  return {
    level: level_,
    unlocks: ahead.filter((u) => u.level === level_).map((u) => ({ id: u.id, label: u.label, kind: u.kind, paid: u.paid })),
  };
}

function lowerProactivity(a, b) {
  const ia = PROACTIVITY_ORDER.indexOf(a);
  const ib = PROACTIVITY_ORDER.indexOf(b);
  if (ia < 0) return b;
  if (ib < 0) return a;
  return PROACTIVITY_ORDER[Math.min(ia, ib)];
}

/** The proactivity ceiling a level earns, before the user's preference lowers it. */
function proactivityCeiling(level) {
  if (atLeast(level, GATES.brief)) return 'brief';
  if (atLeast(level, GATES.hints)) return 'hints';
  return 'off';
}

/**
 * The one object the rest of the app reads.
 *
 * @param {number} level
 * @param {object} [opts]
 * @param {'off'|'hints'|'brief'} [opts.userProactivity] the user's own setting.
 *   A preference can only ever LOWER proactivity — a level is not something the
 *   user can talk themselves out of, but a chatty companion is.
 */
function capabilities(level, opts = {}) {
  const n = clampLevel(level);
  const tier = tierFor(n);
  const autoApproveClasses = AUTO_APPROVABLE_CLASSES.filter(
    (cls) => cls === 'read' || atLeast(n, GATES.autoApproveDiff),
  );

  const approvals = Object.freeze({
    read: 'auto',
    diff: autoApproveClasses.includes('diff') ? 'auto' : 'ask',
    ...LEVEL_INDEPENDENT_APPROVALS,
  });

  const proactivity = opts.userProactivity === undefined
    ? proactivityCeiling(n)
    : lowerProactivity(proactivityCeiling(n), opts.userProactivity);

  return Object.freeze({
    level: n,
    tier: tier.name,
    tierIndex: tierIndex(n),

    // recall breadth — literally memorySearch's limit/token budget
    recallEntries: 4 + Math.floor(n / 2),
    recallTokens: 1500 + 250 * n,

    // never gated (feedback deadlock) — see header
    memoryWriteback: true,

    autoApproveClasses: Object.freeze(autoApproveClasses.slice()),
    approvals,

    toolGrants: Object.freeze(atLeast(n, GATES.queueDrain) ? ['queue.drain'] : []),
    modelFloor: atLeast(n, GATES.reasoningFloor) ? 'reasoning' : null,

    proactivity,
    proactivityCeiling: proactivityCeiling(n),

    companion: Object.freeze({
      morningBrief: atLeast(n, GATES.brief),
      ideaLog: atLeast(n, GATES.ideaLog),
      sessionReflection: atLeast(n, GATES.sessionReflection),
      voice: atLeast(n, GATES.voice),
      queueDrain: atLeast(n, GATES.queueDrain),
      importAssistant: atLeast(n, GATES.importAssistant),
    }),

    cosmeticsUnlocked: Object.freeze(unlockedBy(n)),
    offDeviceGrants: Object.freeze([]),
  });
}

// ---------------------------------------------------------------------------
// carve-outs
// ---------------------------------------------------------------------------

/**
 * Which invariants this capabilities object violates. Empty array = safe.
 * `verifyInvariants` runs this over the whole level range; main runs it at boot
 * so a future edit that gates a write approval on level fails loudly at launch
 * instead of silently weakening the gate.
 */
function carveOuts(caps) {
  const violations = [];
  if (!caps || typeof caps !== 'object') return ['capabilities missing'];

  for (const cls of ['write', 'shell', 'network', 'offDevice']) {
    const got = caps.approvals && caps.approvals[cls];
    if (got !== 'ask') violations.push(`approval for ${cls} must stay "ask", got ${JSON.stringify(got)}`);
  }
  for (const cls of caps.autoApproveClasses || []) {
    if (!AUTO_APPROVABLE_CLASSES.includes(cls)) {
      violations.push(`class ${cls} is not auto-approvable at any level`);
    }
  }
  for (const cls of ['write', 'shell', 'network', 'offDevice']) {
    if ((caps.autoApproveClasses || []).includes(cls)) {
      violations.push(`class ${cls} must never be auto-approved`);
    }
  }
  if (caps.memoryWriteback !== true) {
    violations.push('memoryWriteback must stay true at every level (XP would deadlock)');
  }
  if (!Array.isArray(caps.offDeviceGrants) || caps.offDeviceGrants.length) {
    violations.push('nothing level-gated may send data off-device');
  }
  for (const grant of caps.toolGrants || []) {
    if (/publish|post|email|upload|deploy|broadcast/i.test(String(grant))) {
      violations.push(`tool grant ${grant} reaches off-device`);
    }
  }
  return violations;
}

/** Throws on the first violation. Used by tests and by main at boot. */
function assertCarveOuts(caps) {
  const bad = carveOuts(caps);
  if (bad.length) throw new Error(`avatar capabilities violate a carve-out: ${bad.join('; ')}`);
  return caps;
}

/**
 * Sweep a level range and assert every invariant, plus monotonicity: a higher
 * level may never grant LESS than a lower one (a bonus that disappears as you
 * level is a bug that reads as a punishment).
 */
function verifyInvariants(levels) {
  const list = levels || Array.from({ length: 60 }, (_, i) => i + 1);
  const violations = [];
  let prev = null;
  for (const level of list) {
    const caps = capabilities(level);
    for (const v of carveOuts(caps)) violations.push(`L${level}: ${v}`);
    if (prev) {
      const checks = [
        ['recallEntries', (c) => c.recallEntries],
        ['recallTokens', (c) => c.recallTokens],
      ];
      for (const [name, get] of checks) {
        if (get(caps) < get(prev)) violations.push(`L${level}: ${name} shrank from ${get(prev)} to ${get(caps)}`);
      }
      for (const cls of AUTO_APPROVABLE_CLASSES) {
        const was = prev.autoApproveClasses.includes(cls);
        const now = caps.autoApproveClasses.includes(cls);
        if (was && !now) violations.push(`L${level}: auto-approve for ${cls} was taken away`);
      }
      if (prev.modelFloor === 'reasoning' && caps.modelFloor !== 'reasoning') {
        violations.push(`L${level}: reasoning model floor was taken away`);
      }
      if (PROACTIVITY_ORDER.indexOf(caps.proactivity) < PROACTIVITY_ORDER.indexOf(prev.proactivity)) {
        violations.push(`L${level}: proactivity dropped to ${caps.proactivity}`);
      }
    }
    prev = caps;
  }
  return violations;
}

// ---------------------------------------------------------------------------
// env overrides (automation / CI)
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * `AEGIS_*` wins over capabilities, because a headless CI run must not have its
 * recall breadth decided by someone's XP. Overrides may widen recall and lower
 * proactivity freely; they may NOT touch the level-independent approvals, and an
 * attempt to auto-approve writes/shell/network is ignored (and reported in
 * `ignored`) rather than honoured.
 */
function applyEnvOverrides(caps, env) {
  const e = env || {};
  const ignored = [];
  const out = Object.assign({}, caps);
  const int = (v) => {
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  if (e.AEGIS_AVATAR_DISABLE !== undefined && TRUTHY.has(String(e.AEGIS_AVATAR_DISABLE).toLowerCase())) {
    out.proactivity = 'off';
    out.modelFloor = null;
    out.toolGrants = Object.freeze([]);
  }

  const entries = int(e.AEGIS_RECALL_ENTRIES);
  if (entries !== null) out.recallEntries = entries;
  const tokens = int(e.AEGIS_RECALL_TOKENS);
  if (tokens !== null) out.recallTokens = tokens;

  if (e.AEGIS_PROACTIVITY !== undefined) {
    const want = String(e.AEGIS_PROACTIVITY).toLowerCase();
    if (PROACTIVITY_ORDER.includes(want)) {
      out.proactivity = lowerProactivity(out.proactivity, want);
    } else {
      ignored.push(`AEGIS_PROACTIVITY=${e.AEGIS_PROACTIVITY}`);
    }
  }

  if (e.AEGIS_MODEL_FLOOR !== undefined) {
    const want = String(e.AEGIS_MODEL_FLOOR).toLowerCase();
    if (want === 'reasoning') out.modelFloor = 'reasoning';
    else if (want === 'off' || want === 'none') out.modelFloor = null;
    else ignored.push(`AEGIS_MODEL_FLOOR=${e.AEGIS_MODEL_FLOOR}`);
  }

  if (e.AEGIS_AUTO_APPROVE !== undefined) {
    const want = String(e.AEGIS_AUTO_APPROVE)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const dangerous = want.filter((c) => !AUTO_APPROVABLE_CLASSES.includes(c));
    if (dangerous.length) ignored.push(`AEGIS_AUTO_APPROVE=${dangerous.join(',')}`);
    const safe = want.filter((c) => AUTO_APPROVABLE_CLASSES.includes(c));
    if (safe.length) {
      out.autoApproveClasses = Object.freeze(Array.from(new Set([...(out.autoApproveClasses || []), ...safe])));
      out.approvals = Object.freeze({ ...out.approvals, ...Object.fromEntries(safe.map((c) => [c, 'auto'])) });
    }
  }

  return { caps: out, ignored };
}

module.exports = {
  LEVEL_INDEPENDENT_APPROVALS,
  AUTO_APPROVABLE_CLASSES,
  GATES,
  UNLOCKS,
  PROACTIVITY_ORDER,
  TIERS,
  tierFor,
  tierIndex,
  capabilities,
  proactivityCeiling,
  unlockedBy,
  nextUnlock,
  carveOuts,
  assertCarveOuts,
  verifyInvariants,
  applyEnvOverrides,
};
