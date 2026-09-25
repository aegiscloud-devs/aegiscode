'use strict';

/**
 * xp.js — the avatar's XP ledger: what earns XP, what provably cannot, and the
 * pure replay that turns a ledger into a level.
 *
 * The design constraint comes first, because it is the whole reason this file
 * exists rather than a counter incremented somewhere in main:
 *
 *   XP IS PAID FOR MEMORY THAT WAS RETRIEVED AND USED, NEVER FOR VOLUME.
 *
 * A counter that grows with tokens, turns, messages or time-in-app rewards the
 * chattiest user, and a level that means "you typed a lot" means nothing. So
 * the paid events are the ones on the existing memory path (save / recall /
 * reinforce / correct / import) plus two that require work to have happened (a
 * green build, a logged idea). Everything else pays zero — by omission, which
 * is the only kind of rule that survives a new event kind being added.
 *
 * Three properties are load-bearing:
 *
 * 1. LEVEL IS DERIVED, NOT STORED. `evaluate()` replays the ledger from the
 *    rules every time. The `xp` field written into each ledger line is
 *    ADVISORY (a convenience for tools and for humans reading the file), and
 *    replay deliberately ignores it. That makes a hand-edited ledger — or a
 *    buggy writer — unable to inflate a level, and it makes the anti-farming
 *    rules apply at replay time as well as append time.
 *
 * 2. DIMINISHING RETURNS ARE A HARD CEILING, NOT A VIBE. The Nth paid event of
 *    a day pays `base * 0.5^(N/20)`. That geometric series converges, so one
 *    day can never pay more than `MAX_BASE * 29.36 ≈ 587 XP` no matter how many
 *    events are thrown at it. Since L5 costs 800, "farm a single day" is
 *    mathematically impossible rather than merely discouraged. `SINGLE_DAY_XP_
 *    CEILING` is exported so the fuzz test can assert the bound rather than
 *    trusting this comment.
 *
 * 3. CAPS ARE PER-IDENTITY, NOT PER-CALL. Five recalls per turn, two hundred
 *    imports per source. Without the second one, importing ten foreign tools
 *    would jump ten levels in an afternoon.
 *
 * Pure: no fs, no Electron, no clock of its own. Every function takes the
 * ledger, entries and timestamps from the caller, so the whole module is
 * testable in plain `node --test`, exactly like `lib/sync/*`.
 */

const { tierFor } = require('./tiers.js');

/** Paid events and their base rate. Anything not listed here pays zero. */
const XP_TABLE = Object.freeze({
  'memory.saved': 10,
  'memory.queued': 3,
  'memory.recalled': 1,
  'memory.reinforced': 5,
  'memory.corrected': 15,
  'memory.imported': 2,
  'idea.logged': 10,
  'build.green': 20,
});

/**
 * Kinds that look like activity and pay nothing. Not needed for correctness
 * (the table above already omits them) — they are named so the intent is
 * explicit and so a test can pin each one at zero. If someone later adds
 * `turn.completed: 1` to XP_TABLE, that test fails.
 */
const VOLUME_KINDS = Object.freeze([
  'token.spent',
  'turn.started',
  'turn.completed',
  'message.sent',
  'time.elapsed',
  'app.opened',
  'keystroke',
  'scroll',
]);

/** At most this many recall events pay per turn. */
const RECALL_PER_TURN_CAP = 5;
/** At most this many imports pay per foreign source. */
const IMPORT_PER_SOURCE_CAP = 200;
/** The Nth paid event of a day is scaled by 0.5^(N / this). */
const DAILY_SOFT_CAP = 20;

/** Ledger line schema version. */
const LEDGER_VERSION = 1;

/** Curve: xpForLevel(n) = 100*(n-1) + 25*(n-1)^2 → L2=125, L5=800, L10=2925. */
const CURVE_LINEAR = 100;
const CURVE_QUADRATIC = 25;

const MAX_BASE = Math.max(...Object.values(XP_TABLE));

/**
 * Geometric sum of the per-day decay factors: sum(0.5^(i/20)) for i=0..∞.
 * ~29.357. Multiplied by the largest base rate it bounds a single day's XP no
 * matter how many events are recorded.
 */
const DAY_CEILING_MULTIPLE = 1 / (1 - 2 ** (-1 / DAILY_SOFT_CAP));
const SINGLE_DAY_XP_CEILING = MAX_BASE * DAY_CEILING_MULTIPLE;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/** UTC calendar day key. Invalid timestamps share the 'unknown' bucket. */
function dayKey(t) {
  const ms = num(t);
  if (!ms) return 'unknown';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().slice(0, 10);
}

/** Base rate for a kind, 0 for anything unpaid (including unknown kinds). */
function xpFor(kind) {
  return XP_TABLE[String(kind)] ?? 0;
}

/**
 * Decay factor applied to the (n+1)-th paid event of a day, n 0-based.
 * Exported because the tests assert the bound analytically, not by sampling.
 */
function dayScale(n) {
  const i = Math.max(0, Math.floor(num(n)));
  return 0.5 ** (i / DAILY_SOFT_CAP);
}

// ---------------------------------------------------------------------------
// the curve
// ---------------------------------------------------------------------------

/** Total XP required to reach `level`. L1 = 0. */
function xpForLevel(level) {
  const n = Math.max(1, Math.floor(num(level) || 1)) - 1;
  return CURVE_LINEAR * n + CURVE_QUADRATIC * n * n;
}

/**
 * Inverse of `xpForLevel`, closed-form then nudged. The closed form is exact
 * for integers but floating point can land a hair either side of a boundary
 * (xp == 125 must be L2, never L1), so the nudge loop corrects it. Bounded to
 * a couple of iterations in practice.
 */
function levelForXp(xp) {
  const total = Math.max(0, num(xp));
  let n = Math.floor((-CURVE_LINEAR + Math.sqrt(CURVE_LINEAR ** 2 + 4 * CURVE_QUADRATIC * total)) / (2 * CURVE_QUADRATIC));
  if (!Number.isFinite(n) || n < 0) n = 0;
  while (xpForLevel(n + 2) <= total) n += 1;
  while (n > 0 && xpForLevel(n + 1) > total) n -= 1;
  return n + 1;
}

/** Progress into the current level, 0..1, with the numbers the HUD shows. */
function progressAt(xp) {
  const total = Math.max(0, num(xp));
  const level = levelForXp(total);
  const floorAt = xpForLevel(level);
  const nextAt = xpForLevel(level + 1);
  const span = Math.max(1, nextAt - floorAt);
  return {
    level,
    xp: total,
    xpIntoLevel: total - floorAt,
    xpForNext: nextAt - floorAt,
    nextAt,
    progress: Math.min(1, Math.max(0, (total - floorAt) / span)),
  };
}

// ---------------------------------------------------------------------------
// replay — the single source of truth
// ---------------------------------------------------------------------------

/**
 * Replay a ledger into { xp, level, ... }.
 *
 * @param {Array<object>} entries ledger lines, any order
 * @param {object} [opts]
 * @param {Set<string>|Array<string>} [opts.liveRefs] currently-live memory entry
 *   ids. When supplied, `memory.recalled` credit for refs that no longer exist
 *   is dropped (§1.4 decay) while *savings* survive — you did that work, and it
 *   stays done. Omit to score every recall in the ledger.
 * @param {object} [opts.held] { level, session } from the current session
 * @param {string} [opts.session] the session being evaluated
 */
function evaluate(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  // Deterministic replay: the same set of lines always scores the same, in the
  // same order, regardless of how they were read off disk.
  list.sort((a, b) => num(a && a.t) - num(b && b.t));

  const liveRefs = opts.liveRefs instanceof Set
    ? opts.liveRefs
    : Array.isArray(opts.liveRefs)
      ? new Set(opts.liveRefs.map(String))
      : null;

  const dayCount = new Map();
  const turnCount = new Map();
  const sourceCount = new Map();
  const lastRecall = new Map();

  const byKind = Object.create(null);
  const byDay = Object.create(null);
  const reasons = Object.create(null);

  let total = 0;
  let unpaid = 0;
  let suppressed = 0;
  let dropped = 0;

  for (const raw of list) {
    const e = raw && typeof raw === 'object' ? raw : {};
    const kind = String(e.kind ?? '');
    const base = xpFor(kind);
    const day = dayKey(e.t);
    let reason = 'ok';
    let gain = 0;

    if (base <= 0) {
      reason = 'unpaid-kind';
    } else if (kind === 'memory.recalled') {
      const ref = str(e.ref);
      if (liveRefs && ref && !liveRefs.has(ref)) {
        // §1.4 — the entry this recall was paid for is gone.
        reason = 'ref-gone';
        dropped += 1;
      } else {
        const turn = str(e.turn) ?? str(e.session) ?? '(unknown-turn)';
        if ((turnCount.get(turn) ?? 0) >= RECALL_PER_TURN_CAP) {
          reason = 'turn-cap';
        } else if (ref && lastRecall.get(ref) === str(e.session)) {
          // One fact must not be a slot machine: the same entry recalled twice
          // from the same session pays once.
          reason = 'duplicate-session';
        } else {
          turnCount.set(turn, (turnCount.get(turn) ?? 0) + 1);
          if (ref) lastRecall.set(ref, str(e.session));
        }
      }
    } else if (kind === 'memory.imported') {
      const src = str(e.source) ?? '(unknown-source)';
      if ((sourceCount.get(src) ?? 0) >= IMPORT_PER_SOURCE_CAP) {
        reason = 'source-cap';
      } else {
        sourceCount.set(src, (sourceCount.get(src) ?? 0) + 1);
      }
    }

    if (reason === 'ok') {
      const n = dayCount.get(day) ?? 0;
      dayCount.set(day, n + 1);
      gain = base * dayScale(n);
      total += gain;
      byKind[kind] = (byKind[kind] ?? 0) + gain;
      byDay[day] = (byDay[day] ?? 0) + gain;
    } else if (reason === 'unpaid-kind') {
      unpaid += 1;
    } else {
      suppressed += 1;
    }

    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }

  const rounded = Math.floor(total);
  const projection = progressAt(rounded);

  // §1.4 held-level semantics: a level never silently regresses *while the user
  // is watching*. If this session already showed a higher level, report that
  // one and flag it; the next session settles to the derived value.
  const held = opts.held && typeof opts.held === 'object' ? opts.held : null;
  const sameSession = held && held.session != null && opts.session != null
    ? held.session === opts.session
    : false;
  const heldLevel = held ? Math.max(1, Math.floor(num(held.level) || 1)) : 1;
  const isHeld = Boolean(sameSession && heldLevel > projection.level);

  return Object.assign({}, projection, {
    xp: rounded,
    rawXp: total,
    rawLevel: projection.level,
    level: isHeld ? heldLevel : projection.level,
    held: isHeld,
    settledLevel: projection.level,
    tier: tierFor(isHeld ? heldLevel : projection.level).name,
    byKind,
    byDay,
    reasons,
    events: list.length,
    unpaidEvents: unpaid,
    suppressedEvents: suppressed,
    droppedEvents: dropped,
    days: Object.keys(byDay).length,
  });
}

/** Alias — the spec calls the replay "derive"; both names read well. */
const derive = evaluate;

/**
 * The held-level record to persist after rendering a projection, so the next
 * render in the same session keeps showing the same number.
 */
function nextHeld(projection, session) {
  return {
    level: Math.max(1, Math.floor(num(projection && projection.level) || 1)),
    session: session ?? null,
  };
}

// ---------------------------------------------------------------------------
// ledger lines
// ---------------------------------------------------------------------------

/**
 * Build a ledger line. `xp` is advisory — see the header — and is recorded on
 * the line so a human (or `jq`) can see what the event was worth at the time.
 */
function makeEntry(kind, fields = {}, opts = {}) {
  const k = String(kind ?? '');
  const t = num(opts.t) || num(fields.t) || 0;
  const entry = {
    v: LEDGER_VERSION,
    t,
    kind: k,
    xp: xpFor(k),
  };
  for (const key of ['ref', 'session', 'turn', 'source', 'note', 'metrics']) {
    if (fields[key] !== undefined && fields[key] !== null) entry[key] = fields[key];
  }
  return entry;
}

/** Serialize ledger lines to jsonl. Unparseable lines are skipped, not written. */
function formatLedger(entries) {
  if (!Array.isArray(entries)) return '';
  return entries
    .filter((e) => e && typeof e === 'object' && typeof e.kind === 'string')
    .map((e) => JSON.stringify(e))
    .join('\n')
    .concat(entries.length ? '\n' : '');
}

/**
 * Parse jsonl into ledger lines. Tolerant on purpose: a truncated final line is
 * the normal result of a process killed mid-append, and losing the whole level
 * to it would be absurd.
 */
function parseLedger(text) {
  if (typeof text !== 'string' || !text) return { entries: [], corrupt: 0 };
  const entries = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') {
        entries.push(parsed);
      } else {
        corrupt += 1;
      }
    } catch {
      corrupt += 1;
    }
  }
  return { entries, corrupt };
}

module.exports = {
  XP_TABLE,
  VOLUME_KINDS,
  RECALL_PER_TURN_CAP,
  IMPORT_PER_SOURCE_CAP,
  DAILY_SOFT_CAP,
  LEDGER_VERSION,
  MAX_BASE,
  DAY_CEILING_MULTIPLE,
  SINGLE_DAY_XP_CEILING,
  xpFor,
  dayScale,
  dayKey,
  xpForLevel,
  levelForXp,
  progressAt,
  tierFor,
  evaluate,
  derive,
  nextHeld,
  makeEntry,
  formatLedger,
  parseLedger,
};
