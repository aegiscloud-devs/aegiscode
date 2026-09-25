'use strict';

/**
 * events.js — the avatar's state machine, driven by real engine signals.
 *
 * Two decisions shape this file:
 *
 * 1. NO TIMERS INSIDE. A machine that owns a `setTimeout` is a machine that
 *    leaks one, keeps the Electron process alive at quit, and cannot be tested
 *    without sleeping. The caller passes `tick(now)` — main already has a clock
 *    and the renderer already runs a frame loop — so idle-timeout behaviour is
 *    deterministic and instant in tests.
 *
 * 2. UNKNOWN SIGNALS ARE NO-OPS, NEVER THROWS. The signals come from turn
 *    assembly, the approval card, the queue progress renderer and the sync
 *    status line — four places that will grow new events over time. A machine
 *    that throws on an unrecognised signal turns every future feature into a
 *    crash in the avatar, so the default transition is "stay put".
 *
 * The states are the ones `docs/avatar-plan.md` §4 lists, wired to signals that
 * already exist: turn start/stream/end, `tool.*` from the tool host, the
 * approval card, queue progress, and sync status. No new event bus.
 *
 * Pure: no DOM, no Electron, no fs.
 */

const STATES = Object.freeze([
  'idle',
  'listening',
  'thinking',
  'reading',
  'writing',
  'running',
  'awaiting-you',
  'celebrating',
  'dozing',
  'error',
]);

const SIGNALS = Object.freeze([
  'turn.start',
  'turn.stream',
  'turn.end',
  'tool.read',
  'tool.write',
  'tool.run',
  'approval.card',
  'approval.decided',
  'queue.progress',
  'sync.error',
  'sync.ok',
  'celebrate.done',
  'poke',
  'reset',
  'idle.timeout',
]);

/** Signals that mean "the user or the engine is doing something". */
const ACTIVITY_SIGNALS = Object.freeze([
  'turn.start',
  'turn.stream',
  'tool.read',
  'tool.write',
  'tool.run',
  'approval.card',
  'approval.decided',
  'queue.progress',
  'poke',
]);

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** turn.end celebrates only when the turn actually produced something green. */
function afterTurnEnd(meta) {
  return meta && meta.green ? 'celebrating' : 'idle';
}

/**
 * Transition table: state → signal → next state.
 *
 * A value may be a state name or a `(meta) => state` function. A missing entry
 * means no transition (state unchanged, `changed: false`).
 *
 * `sync.error` is listed on every non-error state rather than special-cased in
 * code, so reading the table tells you the whole machine.
 */
const TABLE = Object.freeze({
  idle: {
    'turn.start': 'listening',
    'approval.card': 'awaiting-you',
    'queue.progress': 'running',
    'idle.timeout': 'dozing',
    'sync.error': 'error',
    reset: 'idle',
  },
  listening: {
    'turn.start': 'listening',
    'turn.stream': 'thinking',
    'tool.read': 'reading',
    'tool.write': 'writing',
    'tool.run': 'running',
    'approval.card': 'awaiting-you',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  thinking: {
    'turn.stream': 'thinking',
    'tool.read': 'reading',
    'tool.write': 'writing',
    'tool.run': 'running',
    'approval.card': 'awaiting-you',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  reading: {
    'tool.read': 'reading',
    'tool.write': 'writing',
    'tool.run': 'running',
    'turn.stream': 'thinking',
    'approval.card': 'awaiting-you',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  writing: {
    'tool.write': 'writing',
    'tool.read': 'reading',
    'tool.run': 'running',
    'turn.stream': 'thinking',
    'approval.card': 'awaiting-you',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  running: {
    'tool.run': 'running',
    'tool.read': 'reading',
    'tool.write': 'writing',
    'queue.progress': 'running',
    'turn.stream': 'thinking',
    'approval.card': 'awaiting-you',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  'awaiting-you': {
    'approval.card': 'awaiting-you',
    'approval.decided': 'thinking',
    'turn.end': afterTurnEnd,
    'sync.error': 'error',
    reset: 'idle',
  },
  celebrating: {
    'celebrate.done': 'idle',
    'turn.start': 'listening',
    'sync.error': 'error',
    reset: 'idle',
  },
  dozing: {
    poke: 'idle',
    'turn.start': 'listening',
    'approval.card': 'awaiting-you',
    'sync.error': 'error',
    reset: 'idle',
  },
  error: {
    reset: 'idle',
    'sync.ok': 'idle',
    'turn.start': 'listening',
    'sync.error': 'error',
  },
});

/**
 * Expression id per state. The renderer maps these to the persona's expression
 * pack; keeping the mapping here means Phase 22 needs no state knowledge.
 */
const EXPRESSIONS = Object.freeze({
  idle: 'neutral',
  listening: 'attentive',
  thinking: 'focused',
  reading: 'focused',
  writing: 'focused',
  running: 'focused',
  'awaiting-you': 'waiting',
  celebrating: 'happy',
  dozing: 'sleepy',
  error: 'concerned',
});

/** Is this a state we know how to draw / reason about? */
function isState(state) {
  return STATES.includes(state);
}

function expressionFor(state) {
  return EXPRESSIONS[state] || 'neutral';
}

/**
 * Build a machine.
 *
 * @param {object} [opts]
 * @param {string} [opts.state] starting state (default 'idle')
 * @param {number} [opts.now] starting clock, ms
 * @param {number} [opts.idleTimeoutMs] silence before `idle` → `dozing`
 * @param {number} [opts.historyLimit] transition log length (default 64)
 */
function createMachine(opts) {
  // A default parameter only covers `undefined`; `createMachine(null)` would
  // throw on property access. Construction is total on purpose — main builds
  // this from whatever the config file happened to contain.
  const o = opts && typeof opts === 'object' ? opts : {};
  const idleTimeoutMs = Number.isFinite(o.idleTimeoutMs) && o.idleTimeoutMs > 0
    ? o.idleTimeoutMs
    : DEFAULT_IDLE_TIMEOUT_MS;
  let state = isState(o.state) ? o.state : 'idle';
  let clock = Number.isFinite(o.now) ? o.now : 0;
  let lastActivity = clock;
  let tickCount = 0;
  const historyLimit = Number.isFinite(o.historyLimit) && o.historyLimit > 0 ? o.historyLimit : 64;
  const history = [];
  const listeners = new Set();

  function emit(event) {
    history.push(event);
    if (history.length > historyLimit) history.shift();
    for (const fn of listeners) {
      try {
        fn(event);
      } catch {
        // A subscriber that throws must not take the machine (or the turn) with
        // it — the state is already updated by the time listeners run.
      }
    }
  }

  /**
   * Send a signal.
   * @param {string} signal
   * @param {object} [meta] e.g. { green: true } on turn.end
   * @returns {{ changed: boolean, state: string, prev: string, signal: string }}
   */
  function send(signal, meta) {
    const prev = state;
    const row = TABLE[state] || {};
    const target = row[String(signal)];
    let next = state;
    if (typeof target === 'function') next = target(meta || {});
    else if (typeof target === 'string') next = target;

    if (!isState(next)) next = state;
    const changed = next !== prev;
    if (changed) {
      state = next;
    }
    if (ACTIVITY_SIGNALS.includes(String(signal))) {
      lastActivity = clock;
    }
    emit({ signal: String(signal), prev, state, changed, meta: meta || null, t: clock });
    return { changed, state, prev, signal: String(signal) };
  }

  /**
   * Advance the clock and let the machine decide whether silence has become
   * `dozing`. Returns the same shape as `send`, with `signal: null` when the
   * clock moved but nothing transitioned — the common case.
   *
   * Deliberately conservative: only `idle` dozes. A long-running turn, an open
   * approval card, or a stream that is thinking must never be interrupted by
   * the avatar falling asleep.
   */
  function tick(now) {
    if (Number.isFinite(now)) clock = Math.max(clock, now);
    tickCount += 1;
    if (state !== 'idle') return { changed: false, state, prev: state, signal: null };
    if (clock - lastActivity < idleTimeoutMs) return { changed: false, state, prev: state, signal: null };
    return send('idle.timeout');
  }

  return {
    get state() {
      return state;
    },
    get expression() {
      return expressionFor(state);
    },
    get lastActivity() {
      return lastActivity;
    },
    get ticks() {
      return tickCount;
    },
    history,
    send,
    tick,
    /** Set the clock without evaluating an idle timeout. */
    setNow(now) {
      if (Number.isFinite(now)) clock = Math.max(clock, now);
      return clock;
    },
    on(fn) {
      if (typeof fn !== 'function') throw new TypeError('listener must be a function');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset(now) {
      listeners.clear();
      history.length = 0;
      state = 'idle';
      lastActivity = Number.isFinite(now) ? now : clock;
      return state;
    },
  };
}

/** Every (state, signal) pair the machine can act on. Used to fuzz the table. */
function transitions() {
  const out = [];
  for (const state of STATES) {
    for (const signal of Object.keys(TABLE[state] || {})) {
      out.push({ state, signal });
    }
  }
  return out;
}

module.exports = {
  STATES,
  SIGNALS,
  ACTIVITY_SIGNALS,
  EXPRESSIONS,
  TABLE,
  DEFAULT_IDLE_TIMEOUT_MS,
  isState,
  expressionFor,
  createMachine,
  transitions,
};
