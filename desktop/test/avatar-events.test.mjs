#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/events.js — the avatar state machine.
 *
 * Two structural properties carry this file:
 *
 *   1. EXHAUSTIVENESS. The signals arrive from four independently-evolving
 *      places (turn assembly, the approval card, queue progress, the sync
 *      status line). "Which signal broke the avatar" must never be a question,
 *      so the machine is swept over the full state × signal cross product and
 *      asserted to always land on a real state — with unknown signals as no-ops
 *      rather than throws.
 *
 *   2. NO TIMERS. The machine owns no clock, so idle dozing is tested by handing
 *      it a timestamp. If someone later adds a setTimeout inside the module,
 *      `tick` stops being the only way to doze and the timing tests here start
 *      failing on their own rather than leaking a handle in production.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const events = require('../lib/avatar/events.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}
function assertDeep(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${b}\n  actual:   ${a}`);
}

const { STATES, SIGNALS, TABLE, DEFAULT_IDLE_TIMEOUT_MS } = events;

// ---------------------------------------------------------------------------
// the vocabulary
// ---------------------------------------------------------------------------
{
  assertEqual(STATES.length, 10, 'there are ten states');
  assertEqual(new Set(STATES).size, STATES.length, 'state names are unique');
  assertEqual(STATES[0], 'idle', 'the machine starts in idle');
  for (const s of STATES) assert(events.isState(s), `isState agrees that ${s} is a state`);
  assert(!events.isState('flying'), 'isState rejects a state that does not exist');
  assert(!events.isState(undefined), 'isState rejects undefined');
  assert(Object.isFrozen(STATES) && Object.isFrozen(SIGNALS), 'the vocabularies are frozen');

  // Every transition target in the table is a real state or a function.
  for (const s of STATES) {
    for (const [signal, target] of Object.entries(TABLE[s] || {})) {
      if (typeof target === 'string') {
        assert(events.isState(target), `${s} --${signal}--> ${target} is a real state`);
      } else {
        assert(typeof target === 'function', `${s} --${signal}--> is a state or a function`);
      }
    }
  }
  // A transition may never be declared for a state that does not exist.
  for (const s of Object.keys(TABLE)) assert(events.isState(s), `table row ${s} is a real state`);
  assert(events.transitions().length > 20, 'the transition list is populated');
}

// ---------------------------------------------------------------------------
// expressions cover every state
// ---------------------------------------------------------------------------
{
  for (const s of STATES) {
    const expr = events.expressionFor(s);
    assert(typeof expr === 'string' && expr.length, `${s} has an expression`);
    assert(expr !== 'neutral' || s === 'idle', `${s} has a distinct expression rather than the fallback`);
  }
  assertEqual(events.expressionFor('idle'), 'neutral', 'idle is neutral');
  assertEqual(events.expressionFor('awaiting-you'), 'waiting', 'a pending approval reads as waiting');
  assertEqual(events.expressionFor('dozing'), 'sleepy', 'dozing reads as sleepy');
  assertEqual(events.expressionFor('bogus-state'), 'neutral', 'an unknown state falls back rather than throwing');
}

// ---------------------------------------------------------------------------
// exhaustive sweep: no signal from any state can break the machine
// ---------------------------------------------------------------------------
{
  const hostile = ['', ' ', '__proto__', 'constructor', 'toString', null, undefined, 42, {}, [], 'TURN.START', 'turn.start '];
  for (const start of STATES) {
    for (const signal of SIGNALS) {
      const m = events.createMachine({ state: start });
      const res = m.send(signal);
      assert(events.isState(res.state), `${start} --${signal}--> ${res.state} is a real state`);
      assertEqual(m.state, res.state, `${start} --${signal}--> the machine's state matches the result`);
    }
    for (const signal of hostile) {
      const m = events.createMachine({ state: start });
      const res = m.send(signal);
      assert(events.isState(res.state), `${start} --${JSON.stringify(signal)}--> stays valid`);
      assertEqual(res.changed, false, `${start} --${JSON.stringify(signal)}--> is a no-op, not a transition`);
      assertEqual(res.state, start, `${start} --${JSON.stringify(signal)}--> does not move the machine`);
    }
  }
  // Signals are matched exactly: no case-folding, no trimming.
  const m = events.createMachine();
  assertEqual(m.send('TURN.START').state, 'idle', 'signals are case-sensitive');
  assertEqual(m.send(' turn.start').state, 'idle', 'signals are not trimmed');
}

// ---------------------------------------------------------------------------
// a real turn, signal by signal
// ---------------------------------------------------------------------------
{
  const m = events.createMachine();
  assertEqual(m.state, 'idle', 'starts idle');

  assertEqual(m.send('turn.start').state, 'listening', 'a turn puts the avatar on listen');
  assertEqual(m.send('turn.stream').state, 'thinking', 'the first token makes it think');
  assertEqual(m.send('tool.read').state, 'reading', 'a read tool shows reading');
  assertEqual(m.send('tool.write').state, 'writing', 'a write tool shows writing');
  assertEqual(m.send('tool.run').state, 'running', 'a shell tool shows running');
  assertEqual(m.send('queue.progress').state, 'running', 'queue progress keeps it running');
  assertEqual(m.send('turn.stream').state, 'thinking', 'returning to the model reads as thinking');

  // The approval card wins over whatever was happening.
  assertEqual(m.send('approval.card').state, 'awaiting-you', 'an approval card interrupts');
  assertEqual(m.send('approval.card').state, 'awaiting-you', 're-rendering the card is idempotent');
  assertEqual(m.send('tool.read').state, 'awaiting-you', 'the avatar does not wander off while a card is open');
  assertEqual(m.send('approval.decided').state, 'thinking', 'deciding the card resumes work');

  // A finished turn either celebrates or settles.
  assertEqual(m.send('turn.end', { green: true }).state, 'celebrating', 'a green turn celebrates');
  assertEqual(m.send('celebrate.done').state, 'idle', 'the celebration ends');

  // A turn that was never started cannot be ended: from idle, turn.end is a
  // no-op rather than a phantom celebration.
  assertEqual(events.createMachine().send('turn.end', { green: true }).state, 'idle', 'turn.end from idle does nothing');

  const quiet = events.createMachine();
  quiet.send('turn.start');
  assertEqual(quiet.send('turn.end').state, 'idle', 'a turn that ends without green just settles');
  assertEqual(quiet.send('turn.end', { green: false }).state, 'idle', 'green:false is not green');

  // A turn ended mid-tool still resolves.
  const mid = events.createMachine();
  mid.send('turn.start');
  mid.send('tool.write');
  assertEqual(mid.send('turn.end', { green: true }).state, 'celebrating', 'a turn can end while a tool is showing');
}

// ---------------------------------------------------------------------------
// sync errors are loud and recoverable
// ---------------------------------------------------------------------------
{
  for (const start of STATES) {
    if (start === 'error') continue;
    const m = events.createMachine({ state: start });
    assertEqual(m.send('sync.error').state, 'error', `${start} shows a sync error`);
  }
  const m = events.createMachine();
  m.send('sync.error');
  assertEqual(m.state, 'error', 'a sync error shows');
  assertEqual(m.send('sync.error').state, 'error', 'repeating the error stays in error');
  assertEqual(m.send('sync.ok').state, 'idle', 'recovery clears the error');
  const m2 = events.createMachine();
  m2.send('sync.error');
  assertEqual(m2.send('turn.start').state, 'listening', 'a new turn clears the error');
}

// ---------------------------------------------------------------------------
// idle: only idle dozes, and only after the timeout
// ---------------------------------------------------------------------------
{
  assert(DEFAULT_IDLE_TIMEOUT_MS >= 60_000, 'the idle timeout is minutes, not seconds');

  const m = events.createMachine({ now: 0 });
  assertEqual(m.tick(DEFAULT_IDLE_TIMEOUT_MS - 1).changed, false, 'just under the timeout, still awake');
  assertEqual(m.state, 'idle', 'still idle');
  assertEqual(m.tick(DEFAULT_IDLE_TIMEOUT_MS).state, 'dozing', 'at the timeout it dozes');
  assertEqual(m.send('poke').state, 'idle', 'a poke wakes it');
  assertEqual(m.send('turn.start').state, 'listening', 'a new turn wakes it too');

  // A long turn must never be interrupted by the avatar falling asleep.
  for (const busy of ['listening', 'thinking', 'reading', 'writing', 'running', 'awaiting-you', 'celebrating', 'error']) {
    const b = events.createMachine({ state: busy });
    const res = b.tick(10 * DEFAULT_IDLE_TIMEOUT_MS);
    assertEqual(res.changed, false, `${busy}: never dozes mid-work`);
    assertEqual(b.state, busy, `${busy}: stays put`);
  }

  // Activity resets the timer — including a signal that is a no-op.
  const a = events.createMachine({ now: 0 });
  a.setNow(1000);
  a.send('turn.stream'); // no-op from idle, but it is still the user's engine talking
  assertEqual(a.lastActivity, 1000, 'a no-op activity signal still counts as activity');
  assertEqual(a.tick(1000 + DEFAULT_IDLE_TIMEOUT_MS - 1).changed, false, 'so the timeout restarts from it');
  assertEqual(a.tick(1000 + DEFAULT_IDLE_TIMEOUT_MS).state, 'dozing', 'and dozes a full timeout later');

  // A non-activity signal does not keep it awake.
  const q = events.createMachine({ now: 0 });
  q.setNow(10_000);
  q.send('celebrate.done'); // not an activity signal
  assertEqual(q.lastActivity, 0, 'a non-activity signal does not reset the timer');

  // setNow alone never dozes — the caller drives tick.
  const s = events.createMachine({ now: 0 });
  s.setNow(10 * DEFAULT_IDLE_TIMEOUT_MS);
  assertEqual(s.state, 'idle', 'setNow does not doze on its own');
  assertEqual(s.tick(10 * DEFAULT_IDLE_TIMEOUT_MS).state, 'dozing', 'the following tick does');

  // The clock never goes backwards.
  const back = events.createMachine({ now: 5000 });
  assertEqual(back.setNow(1), 5000, 'setNow ignores a clock that moves backwards');
  assertEqual(back.tick(1).changed, false, 'tick ignores a backwards clock too');

  // A junk timeout falls back to the default rather than dozing instantly.
  for (const bad of [0, -1, NaN, 'soon', null]) {
    const j = events.createMachine({ now: 0, idleTimeoutMs: bad });
    assertEqual(j.tick(1).changed, false, `idleTimeoutMs=${JSON.stringify(bad)} falls back to the default`);
  }
  const zero = events.createMachine({ now: 0, idleTimeoutMs: 10 });
  assertEqual(zero.tick(10).state, 'dozing', 'an explicit short timeout is honoured (tests can be fast)');
}

// ---------------------------------------------------------------------------
// history, listeners, reset
// ---------------------------------------------------------------------------
{
  const m = events.createMachine();
  const seen = [];
  const off = m.on((e) => seen.push(e));
  m.send('turn.start');
  m.send('turn.stream');
  assertEqual(seen.length, 2, 'listeners see every signal');
  assertDeep(Object.keys(seen[0]).sort(), ['changed', 'meta', 'prev', 'signal', 'state', 't'], 'the event shape is the documented one');
  assertEqual(seen[1].prev, 'listening', 'the event carries the previous state');
  assertEqual(seen[1].state, 'thinking', 'and the new one');
  assertEqual(seen[1].signal, 'turn.stream', 'and the signal');

  off();
  m.send('tool.read');
  assertEqual(seen.length, 2, 'unsubscribing stops delivery');

  // A listener that throws must not take the machine — or the turn — with it.
  const good = [];
  const m2 = events.createMachine();
  m2.on(() => {
    throw new Error('subscriber blew up');
  });
  const unsub = m2.on((e) => good.push(e.state));
  const res = m2.send('turn.start');
  assertEqual(res.state, 'listening', 'a throwing listener does not roll back the transition');
  assertEqual(good.length, 1, 'later listeners still run after one throws');
  unsub();

  let typeThrew = false;
  try {
    m2.on('not a function');
  } catch {
    typeThrew = true;
  }
  assert(typeThrew, 'on() refuses a non-function listener');

  // History is bounded, and keeps the most recent.
  const h = events.createMachine({ historyLimit: 5 });
  for (let i = 0; i < 50; i += 1) h.send('turn.stream');
  assertEqual(h.history.length, 5, 'history is capped at the configured limit');
  assertEqual(h.history[h.history.length - 1].signal, 'turn.stream', 'history keeps the most recent events');
  const unbounded = events.createMachine();
  for (let i = 0; i < 500; i += 1) unbounded.send('turn.stream');
  assert(unbounded.history.length <= 64, 'the default history limit keeps a long session bounded');

  // reset() empties everything and silences subscribers.
  const r = events.createMachine();
  r.on(() => {
    throw new Error('should have been cleared');
  });
  r.send('turn.start');
  assertEqual(r.reset(0), 'idle', 'reset returns to idle');
  assertEqual(r.state, 'idle', 'and the state is idle');
  assertEqual(r.history.length, 0, 'reset clears history');
  assertEqual(r.send('turn.start').state, 'listening', 'reset leaves a working machine');
  assertEqual(r.history.length, 1, 'and history resumes from empty');

  // tick bookkeeping is visible for tests.
  const t = events.createMachine({ now: 0 });
  t.tick(1);
  t.tick(2);
  assertEqual(t.ticks, 2, 'ticks are counted');
}

// ---------------------------------------------------------------------------
// construction is total: every way of starting yields a usable machine
// ---------------------------------------------------------------------------
{
  for (const bad of [undefined, null, 42, 'idle', [], { state: 'bogus' }, { state: 7 }, { state: null }]) {
    const m = events.createMachine(bad);
    assertEqual(m.state, 'idle', `createMachine(${JSON.stringify(bad)}) falls back to idle`);
    assert(events.isState(m.send('turn.start').state), `createMachine(${JSON.stringify(bad)}) is usable`);
  }
  assertEqual(events.createMachine({ state: 'dozing' }).state, 'dozing', 'a valid starting state is honoured');
  assertEqual(events.createMachine({ state: 'dozing' }).expression, 'sleepy', 'and its expression follows');
}

console.log('avatar-events.test.mjs ok');
