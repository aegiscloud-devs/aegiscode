'use strict';

/**
 * machine.js — the avatar's face, driven by the engine's real signals
 * (PLAN Phase 22: "expression state machine bound to `lib/avatar/events.js`
 * signals").
 *
 * The state machine itself is NOT re-implemented here. `lib/avatar/events.js`
 * is a pure module with no timers and no DOM, and index.html loads that same
 * file into the renderer (its UMD tail publishes `AegisAvatarEvents`), so the
 * face follows the *exact* table the engine's events are described by — not a
 * copy of it that can drift. What this file adds is the only thing the pure
 * module deliberately refuses to know: which real renderer event in this app
 * means which signal.
 *
 * The mapping is the interesting part, and it is one table, testable in
 * isolation:
 *
 *   send / setBusy(true)      → turn.start
 *   a streamed delta          → turn.stream
 *   setBusy(false)            → turn.end {green}
 *   a tool frame              → tool.read | tool.write | tool.run (by NAME)
 *   the approval card         → approval.card / approval.decided
 *   queue progress            → queue.progress
 *   connection state          → sync.error / sync.ok
 *   typing in the composer    → poke
 *
 * `signalForTool` is deliberately conservative: a tool this table has never
 * heard of (a new tool, a commissioned pack, an MCP server's verb) reads as
 * `tool.run` — "the agent is doing something" — rather than being mapped to
 * `reading`, which would understate what is happening on the user's machine.
 * Understating activity on the face of the thing doing it is the wrong way to
 * be wrong.
 *
 * Nothing here throws on an unknown signal: `events.js` made unknown signals
 * no-ops precisely so that tomorrow's feature cannot crash the avatar, and the
 * wrapper below preserves that.
 */

'use strict';

const pkg = typeof window !== 'undefined' && window.AegisAvatarEvents
  ? { events: window.AegisAvatarEvents, parts: window.AegisAvatarParts || null }
  : typeof module !== 'undefined' && module.exports
    ? { events: require('../../lib/avatar/events.js'), parts: require('./parts.js') }
    : { events: null, parts: null };

if (!pkg.events) throw new Error('avatar/machine.js: lib/avatar/events.js must be loaded first');

/** Tool names → the signal the face shows. Order matters: first match wins. */
const TOOL_SIGNALS = Object.freeze([
  Object.freeze({
    signal: 'tool.write',
    re: /^(write|edit|apply|patch|create|mkdir|append|save|delete|remove|move|rename|memorysave|memory_save)/i,
  }),
  Object.freeze({
    signal: 'tool.read',
    re: /^(read|open|list|ls|glob|grep|search|find|cat|stat|memorysearch|memory_search|memorylist|recall)/i,
  }),
  Object.freeze({
    signal: 'tool.run',
    re: /^(run|shell|bash|exec|spawn|test|build|npm|node|python|fetch|http|curl|websearch|browser)/i,
  }),
]);

/** The tool name a frame is about, whichever shape the frame arrived in. */
function toolName(tool) {
  if (!tool) return '';
  if (typeof tool === 'string') return tool;
  return String(tool.name || tool.tool || tool.id || '');
}

/**
 * Which signal a tool call is worth. Unknown verbs are `tool.run` — see header.
 * A read frame is the ONLY thing that may say "reading".
 */
function signalForTool(tool) {
  const name = toolName(tool);
  for (const row of TOOL_SIGNALS) if (row.re.test(name)) return row.signal;
  return 'tool.run';
}

/**
 * Wrap the shared machine with the app's vocabulary.
 *
 * @param {object} [opts]
 * @param {object} [opts.machine] an `events.createMachine()` instance (tests inject one)
 * @param {number} [opts.idleTimeoutMs] silence before `dozing`
 * @param {function} [opts.onChange] called with `{ state, expression, label, signal }`
 */
function createAvatarSignals(opts = {}) {
  const machine = opts.machine || pkg.events.createMachine({
    state: opts.state,
    now: opts.now,
    idleTimeoutMs: opts.idleTimeoutMs,
  });
  const listeners = new Set();
  let lastSent = null;

  function labelFor(expression) {
    const table = pkg.parts && pkg.parts.EXPRESSIONS;
    return (table && table[expression] && table[expression].label) || expression;
  }

  function announce(signal) {
    const payload = {
      state: machine.state,
      expression: machine.expression,
      label: labelFor(machine.expression),
      signal: signal == null ? null : String(signal),
    };
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch {
        // A listener that throws must not take the turn with it: app.js calls
        // this from the chat delta path.
      }
    }
    return payload;
  }

  function send(signal, meta) {
    lastSent = String(signal);
    machine.send(signal, meta);
    return announce(signal);
  }

  const api = {
    machine,
    get state() {
      return machine.state;
    },
    get expression() {
      return machine.expression;
    },
    get label() {
      return labelFor(machine.expression);
    },
    get lastSignal() {
      return lastSent;
    },
    signal: send,
    /** turn.start / turn.stream / turn.end — the chat path, in order. */
    turnStart(meta) {
      return send('turn.start', meta);
    },
    stream() {
      return send('turn.stream');
    },
    turnEnd(meta) {
      return send('turn.end', meta);
    },
    /** A tool frame: the signal is picked from the tool's name. */
    tool(tool) {
      return send(signalForTool(tool), { tool: toolName(tool) });
    },
    approvalCard() {
      return send('approval.card');
    },
    approvalDecided() {
      return send('approval.decided');
    },
    /** Queue progress frames; the machine treats them as activity. */
    queue() {
      return send('queue.progress');
    },
    syncOk() {
      return send('sync.ok');
    },
    syncError(meta) {
      return send('sync.error', meta);
    },
    poke() {
      return send('poke');
    },
    celebrateDone() {
      return send('celebrate.done');
    },
    reset() {
      return send('reset');
    },
    /** The caller owns the clock — see events.js's "NO TIMERS INSIDE". */
    tick(now) {
      const out = machine.tick(now);
      if (out.changed) announce('idle.timeout');
      return out;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    off(fn) {
      return listeners.delete(fn);
    },
  };
  return api;
}

const API = Object.freeze({
  createAvatarSignals,
  signalForTool,
  toolName,
  TOOL_SIGNALS,
  STATES: pkg.events.STATES,
  SIGNALS: pkg.events.SIGNALS,
  EXPRESSIONS: pkg.events.EXPRESSIONS,
  expressionFor: pkg.events.expressionFor,
});

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatarMachine = API;
