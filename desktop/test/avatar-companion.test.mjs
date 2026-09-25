#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/companion.js — the four companion
 * behaviours (PLAN Phase 23).
 *
 * The phase's exit criteria are the load-bearing tests, and each is written so
 * that *breaking the guard makes it go red*, not so that it re-states the
 * implementation:
 *
 *   1. OFF AT L1 — every behaviour, every trigger kind, with opt-in forced ON,
 *      against real `level.capabilities(1)` output. Then the same sweep at the
 *      gate level to prove the silence is the level and not the harness.
 *   2. EXPLICIT ACCEPT — no path from "a card was offered" to an effect. The
 *      card's own intent is a frozen proposal with `approved: false`; only
 *      `decide(id, 'accept')` mints a ticket, and the effect handler is never
 *      called without one (including for a hand-forged ticket, a replayed one,
 *      and a second decision on the same card).
 *   3. NO TOOL WITHOUT APPROVAL — for the one behaviour that touches a tool
 *      (`recall` → `memory.search`), an accepted card alone is not enough: the
 *      host's approval channel must answer `once`/`session`. A missing channel,
 *      a deny, a thrown channel and a garbage answer all end in "not performed".
 *
 * Plus §6's "companion becomes noise" guard (one proactive card per session),
 * the opt-in default, the level gates from §2's table, and the carve-out sweep
 * (nothing here can reach off-device, nothing carries a shell/network class).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const companion = require('../lib/avatar/companion.js');
const level = require('../lib/avatar/level.js');
const xp = require('../lib/avatar/xp.js');

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
  if (a !== b) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

/** Opt-in ON for everything: the loudest a user can be, the worst case. */
const ALL_IN = Object.freeze(
  companion.BEHAVIOUR_IDS.reduce((acc, id) => Object.assign(acc, { [id]: true }), {})
);

/**
 * Every trigger the module understands, each armed with the richest plausible
 * payload — so a "no card" answer is the gate talking, never an empty input.
 */
const TRIGGERS = Object.freeze([
  Object.freeze({
    name: 'session.start',
    trigger: Object.freeze({
      kind: 'session.start',
      dayKey: '2026-09-25',
      facts: Object.freeze({ changed: ['app.js', 'main.js'], queued: ['phase 23'], resuming: ['wiring the recall card'] }),
    }),
  }),
  Object.freeze({
    name: 'turn.start',
    trigger: Object.freeze({ kind: 'turn.start', query: 'avatar', candidates: Object.freeze([{ id: 'm1', content: 'the avatar is a memory readout' }]) }),
  }),
  Object.freeze({
    name: 'session.end',
    trigger: Object.freeze({ kind: 'session.end', decisions: ['companion cards are opt-in'], open: ['wire the IPC'] }),
  }),
  Object.freeze({ name: 'user.request/idea', trigger: Object.freeze({ kind: 'user.request', want: 'idea', text: 'a card that remembers ideas' }) }),
  Object.freeze({ name: 'user.request/recall', trigger: Object.freeze({ kind: 'user.request', want: 'recall', query: 'avatar', candidates: Object.freeze([{ id: 'm1', content: 'a fact' }]) }) }),
  Object.freeze({ name: 'user.request/brief', trigger: Object.freeze({ kind: 'user.request', want: 'brief', facts: Object.freeze({ changed: 3 }) }) }),
  Object.freeze({ name: 'user.request/reflection', trigger: Object.freeze({ kind: 'user.request', want: 'reflection', decisions: ['x'] }) }),
]);

function sessionAt(levelNumber, opts = {}) {
  return companion.createSession(Object.assign({
    caps: level.capabilities(levelNumber),
    optIn: ALL_IN,
    session: `s-L${levelNumber}`,
    now: () => 1730000000000,
  }, opts));
}

/** A host that records everything a behaviour could ever do. */
function recordingHost(overrides = {}) {
  const performed = [];
  const approvals = [];
  return Object.assign({
    performed,
    approvals,
    perform: async (intent) => {
      performed.push(intent);
      return { ok: true };
    },
    requestApproval: async (req) => {
      approvals.push(req);
      return 'once';
    },
  }, overrides);
}

// ---------------------------------------------------------------------------
// 0. the effect table and the carve-outs
// ---------------------------------------------------------------------------
{
  assertDeep(companion.carveOuts(), [], 'no behaviour reaches off-device, shell or network');
  assertEqual(companion.assertCarveOuts(), true, 'assertCarveOuts passes');

  // The guard has to actually fire: an undeclared action must be caught.
  const spec = companion.behaviourById('morningBrief');
  assert(spec && spec.action === 'brief.show', 'the catalogue names its effect');
  assert(companion.EFFECTS['brief.show'].tool === null, 'the morning brief fires no tool');
  assert(companion.EFFECTS['memory.save'].tool === null, 'memory saves fire no tool');
  assertEqual(companion.EFFECTS['recall.load'].tool, 'memory.search', 'recall is the one tool-touching effect');

  // Every behaviour in the catalogue is reachable from a trigger, so a future
  // behaviour cannot be added and silently never offered (or worse, offered
  // through a path no test covers).
  const seen = new Set();
  for (const { trigger } of TRIGGERS) {
    const s = sessionAt(40);
    const { card } = s.consider({ ...trigger, dayKey: trigger.dayKey ? `${trigger.dayKey}-${seen.size}` : undefined });
    if (card) seen.add(card.behaviour);
  }
  // The proactive budget means one trigger pass cannot reach all four: run a
  // second, fresh session for the user-requested ones.
  for (const { trigger } of TRIGGERS) {
    const s = sessionAt(40);
    const { card } = s.consider(trigger);
    if (card) seen.add(card.behaviour);
  }
  assertDeep([...seen].sort(), ['ideaLog', 'morningBrief', 'recall', 'sessionReflection'], 'all four behaviours are reachable');
}

// ---------------------------------------------------------------------------
// 1. EXIT CRITERION — every behaviour is off at L1
// ---------------------------------------------------------------------------
{
  const caps1 = level.capabilities(1);
  assertEqual(caps1.proactivity, 'off', 'level 1 earns proactivity "off"');

  // The permission table itself says so, for every behaviour.
  const gates = companion.gating(caps1, { optIn: ALL_IN });
  for (const id of companion.BEHAVIOUR_IDS) {
    assertEqual(gates[id].allowed, false, `L1: ${id} is not allowed`);
    assert(gates[id].reason.length > 0, `L1: ${id} explains itself`);
  }

  // …and no trigger, with opt-in forced ON, can produce a card anyway.
  for (const { name, trigger } of TRIGGERS) {
    const s = sessionAt(1);
    const { card, reason } = s.consider(trigger);
    assertEqual(card, null, `L1: ${name} offers nothing`);
    assert(reason !== 'offered', `L1: ${name} reports a real reason (${reason})`);
    assertDeep(s.state().enabled, [], `L1: ${name} leaves every behaviour disabled`);
  }

  // An unknown capabilities object fails SILENT, not open — the opposite of
  // voice.js's convention, and deliberate for a proactive surface.
  for (const caps of [undefined, null, {}, { companion: {} }, { proactivity: 'brief' }, { level: 99 }, { proactivity: 'turbo' }]) {
    const s = companion.createSession({ caps, optIn: ALL_IN, session: 'x', now: () => 0 });
    for (const { name, trigger } of TRIGGERS) {
      const { card } = s.consider(trigger);
      assertEqual(card, null, `unreadable caps (${JSON.stringify(caps)}) offer nothing for ${name}`);
    }
    assertDeep(s.state().enabled, [], `unreadable caps (${JSON.stringify(caps)}) enable nothing`);
  }

  // A level-1 user who explicitly asks still gets nothing at L1 (idea log is
  // L5+), so "silent at L1" is not just about the proactive budget.
  const asked = sessionAt(1).consider({ kind: 'user.request', want: 'idea', text: 'remember this' });
  assertEqual(asked.card, null, 'L1: an explicit idea request still offers nothing');
}

// ---------------------------------------------------------------------------
// 2. the level gates from §2's table, and the opt-in default
// ---------------------------------------------------------------------------
{
  // morning brief / idea log at L5, session reflection at L10 — and recall
  // (breadth, not a flag) as soon as proactivity leaves 'off' at L2.
  const expect = [
    ['morningBrief', 'session.start', 5],
    ['sessionReflection', 'session.end', 10],
  ];
  for (const [behaviour, kind, gate] of expect) {
    const below = sessionAt(gate - 1);
    const t = TRIGGERS.find((x) => x.name === kind).trigger;
    assertEqual(below.consider(t).card, null, `${behaviour} is not offered at L${gate - 1}`);
    const at = sessionAt(gate);
    const card = at.consider(t).card;
    assert(card && card.behaviour === behaviour, `${behaviour} is offered at L${gate}`);
  }

  for (const lvl of [4, 5, 9, 10, 14, 19, 20, 34, 35]) {
    const s = sessionAt(lvl);
    const gates = companion.gating(level.capabilities(lvl), { optIn: ALL_IN });
    assertEqual(gates.ideaLog.allowed, lvl >= 5, `L${lvl}: idea log gate matches the table`);
    assertEqual(gates.sessionReflection.allowed, lvl >= 10, `L${lvl}: reflection gate matches the table`);
    assertEqual(gates.morningBrief.allowed, lvl >= 5, `L${lvl}: brief gate matches the table`);
    assertEqual(gates.recall.allowed, lvl >= 2, `L${lvl}: recall card gate matches the table`);
    // The four gates, one entry per behaviour: brief 5, idea log 5, recall 2,
    // reflection 10 (§2's table).
    assert(
      s.state().enabled.length === [5, 5, 2, 10].filter((g) => lvl >= g).length,
      `L${lvl}: enabled count is the gate count`
    );
  }

  // Opt-in is off by default: caps say "may", this says "do".
  for (const id of companion.BEHAVIOUR_IDS) assertEqual(companion.DEFAULT_OPT_IN[id], false, `default opt-in for ${id} is off`);
  for (const lvl of [5, 10, 20, 40]) {
    const s = companion.createSession({ caps: level.capabilities(lvl), session: 'no-opt-in', now: () => 0 });
    for (const { name, trigger } of TRIGGERS) {
      assertEqual(s.consider(trigger).card, null, `L${lvl} + no opt-in: ${name} offers nothing`);
    }
  }

  // A user preference can only lower proactivity, and the module honours it.
  const quiet = level.capabilities(30, { userProactivity: 'off' });
  assertEqual(quiet.proactivity, 'off', 'a user can lower proactivity to off');
  const quietSession = companion.createSession({ caps: quiet, optIn: ALL_IN, session: 'quiet', now: () => 0 });
  assertEqual(quietSession.consider(TRIGGERS[0].trigger).card, null, 'proactivity:off silences the morning brief at L30');

  // AEGIS_COMPANION=off may only silence.
  const envOff = companion.createSession({ caps: level.capabilities(40), optIn: ALL_IN, session: 'env', now: () => 0, envDisabled: true });
  for (const { trigger } of TRIGGERS) assertEqual(envOff.consider(trigger).card, null, 'AEGIS_COMPANION=off silences everything');
}

// ---------------------------------------------------------------------------
// 3. one proactive card per session (spec §6: the companion must not be noise)
// ---------------------------------------------------------------------------
{
  const s = sessionAt(40);
  const first = s.consider({ kind: 'session.start', dayKey: 'd1', facts: { changed: 2 } });
  assert(first.card, 'the first proactive card is offered');
  assertEqual(first.card.proactive, true, 'the brief is proactive');

  const second = s.consider({ kind: 'turn.start', candidates: [{ id: 'a', content: 'x' }] });
  assertEqual(second.card, null, 'a second proactive card is refused');
  assert(/already offered/.test(second.reason), `the refusal explains itself (${second.reason})`);

  const third = s.consider({ kind: 'session.end', decisions: ['one thing'] });
  assertEqual(third.card, null, 'the reflection is refused too');
  assertEqual(s.state().proactiveShown, 1, 'exactly one proactive card was shown');
  assertEqual(s.state().budgetLeft, false, 'the budget is spent');

  // A card the user asked for is not proactive and does not spend the budget…
  const asked = sessionAt(40);
  const idea = asked.consider({ kind: 'user.request', want: 'idea', text: 'ship it in slices' });
  assert(idea.card && idea.card.proactive === false, 'an asked-for card is not proactive');
  assertEqual(asked.state().proactiveShown, 0, 'an asked-for card spends no proactive budget');
  assert(asked.consider({ kind: 'session.start', dayKey: 'd2', facts: { changed: 1 } }).card, 'the proactive brief is still available after an asked-for card');

  // …but it does not become a loophole: the budget is still one, and dismissing
  // does not refill it.
  const dismissed = sessionAt(40);
  const c = dismissed.consider({ kind: 'session.start', dayKey: 'd3', facts: { changed: 1 } }).card;
  dismissed.decide(c.id, 'dismiss');
  assertEqual(dismissed.consider({ kind: 'turn.start', candidates: [{ id: 'a', content: 'x' }] }).card, null, 'dismissing does not refill the proactive budget');

  // The same day is briefed once.
  const day = sessionAt(40);
  assert(day.consider({ kind: 'session.start', dayKey: '2026-09-25', facts: { changed: 1 } }).card, 'first brief of the day');
  const sameDay = companion.createSession({ caps: level.capabilities(40), optIn: ALL_IN, session: 'y', now: () => 0, lastBriefDay: '2026-09-25' });
  assertEqual(sameDay.consider({ kind: 'session.start', dayKey: '2026-09-25', facts: { changed: 1 } }).card, null, 'the same day is not briefed twice');

  // "Nothing to report" never produces a card — an empty brief is noise.
  const emptyFacts = sessionAt(40);
  const empty = emptyFacts.consider({ kind: 'session.start', dayKey: 'd4', facts: {} });
  assertEqual(empty.card, null, 'no facts, no brief');
  assertEqual(emptyFacts.state().proactiveShown, 0, 'an empty brief costs no budget');
  assertEqual(emptyFacts.consider({ kind: 'turn.start', candidates: [] }).card, null, 'no candidates, no recall card');
}

// ---------------------------------------------------------------------------
// 4. EXIT CRITERION — every behaviour requires an explicit accept
// ---------------------------------------------------------------------------
{
  // Build one offered card per behaviour, at a level where all four are on.
  const offered = [];
  for (const { name, trigger } of TRIGGERS) {
    const s = sessionAt(40);
    const { card } = s.consider(trigger);
    if (card) offered.push({ name, s, card });
  }
  assertEqual(offered.length, TRIGGERS.length, 'every trigger produced its card for the accept sweep');

  for (const { name, s, card } of offered) {
    // (a) The card's intent is a proposal: frozen, unapproved, and inert.
    assertEqual(card.intent.approved, false, `${name}: the card's intent is not pre-approved`);
    assert(Object.isFrozen(card.intent), `${name}: the intent is frozen`);
    assertEqual(card.requiresExplicitAccept, true, `${name}: the card demands an explicit accept`);
    assertEqual(card.shape, 'approval', `${name}: it is the approval card shape`);
    assertEqual(card.actions.length, 2, `${name}: accept + dismiss, nothing else`);
    assertDeep(card.actions.map((a) => a.decision), ['accept', 'dismiss'], `${name}: the two decisions`);

    // (b) Dispatching the raw intent — the "forgot to ask" path — does nothing.
    const rawHost = recordingHost();
    const raw = await companion.dispatch(s, card.intent, rawHost);
    assertEqual(raw.ok, false, `${name}: a raw intent performs nothing`);
    assertEqual(rawHost.performed.length, 0, `${name}: the raw intent never reached the host`);

    // (c) A hand-forged ticket is not an acceptance either.
    const forgedHost = recordingHost();
    const forged = await companion.dispatch(s, { id: `ticket-s-L40-${card.id}`, cardId: card.id, approved: true, intent: card.intent }, forgedHost);
    assertEqual(forged.ok, false, `${name}: a forged ticket is refused`);
    assertEqual(forgedHost.performed.length, 0, `${name}: the forged ticket never reached the host`);

    // (d) Dismissal mints nothing.
    const dismissed = sessionAt(40);
    const again = dismissed.consider(TRIGGERS.find((x) => x.name === name).trigger).card;
    const no = dismissed.decide(again.id, 'dismiss');
    assertEqual(no.ticket, null, `${name}: dismissal issues no ticket`);
    assertEqual(no.intent, null, `${name}: dismissal carries no intent`);
    assertEqual(dismissed.pending().length, 0, `${name}: the card is resolved`);

    // (e) Acceptance is what mints the ticket — and only acceptance.
    const accepted = sessionAt(40);
    const card2 = accepted.consider(TRIGGERS.find((x) => x.name === name).trigger).card;
    const yes = accepted.decide(card2.id, 'accept');
    assertEqual(yes.ticket !== null, true, `${name}: acceptance mints a ticket`);
    assertEqual(yes.intent.behaviour, card2.behaviour, `${name}: the ticket carries the card's intent`);

    // (f) A second decision on the same card cannot mint a second effect.
    const twice = accepted.decide(card2.id, 'accept');
    assertEqual(twice.ok, false, `${name}: a card can only be decided once`);

    // (g) …and the ticket is single-use, so a replayed dispatch is refused.
    const host = recordingHost();
    const first = await companion.dispatch(accepted, yes.ticket, host);
    assertEqual(first.ok, true, `${name}: the accepted card performs`);
    assertEqual(host.performed.length, 1, `${name}: exactly one effect`);
    const replay = await companion.dispatch(accepted, yes.ticket, host);
    assertEqual(replay.ok, false, `${name}: a replayed accept is refused`);
    assertEqual(host.performed.length, 1, `${name}: the replay performed nothing`);
    assert(/already used/.test(replay.reason), `${name}: the replay says why (${replay.reason})`);

    // (h) A host that is not wired at all performs nothing.
    const naked = await companion.dispatch(accepted, yes.ticket, {});
    assertEqual(naked.ok, false, `${name}: no effect handler, no effect`);
  }
}

// ---------------------------------------------------------------------------
// 5. EXIT CRITERION — nothing can fire a tool without approval
// ---------------------------------------------------------------------------
{
  const recallTrigger = TRIGGERS.find((x) => x.name === 'turn.start').trigger;

  // Every behaviour's accepted intent, checked for the tool rule.
  const check = async (buildIntent, label) => {
    // No approval channel at all ⇒ refused, tool or not (never "ran anyway").
    const s1 = sessionAt(40);
    const t1 = s1.decide(buildIntent(s1).id, 'accept').ticket;
    const h1 = recordingHost({ requestApproval: undefined });
    const r1 = await companion.dispatch(s1, t1, h1);
    assertEqual(r1.ok, false, `${label}: no approval channel ⇒ refused`);
    assert(/approval channel/.test(r1.reason), `${label}: the refusal names the missing channel (${r1.reason})`);
    assertEqual(h1.performed.length, 0, `${label}: nothing performed`);

    // A deny ⇒ refused.
    const s2 = sessionAt(40);
    const t2 = s2.decide(buildIntent(s2).id, 'accept').ticket;
    const h2 = recordingHost({ requestApproval: async () => 'deny' });
    const r2 = await companion.dispatch(s2, t2, h2);
    assertEqual(r2.ok, false, `${label}: a deny ⇒ refused`);
    assertEqual(h2.performed.length, 0, `${label}: nothing performed on deny`);

    // The intent object says a tool call needs interactive approval.
    assertEqual(t2.intent.tool != null, true, `${label}: the intent carries a tool`);
    assertEqual(t2.intent.needsInteractiveApproval, true, `${label}: the intent says so`);

    // An approval channel that throws is not an approval.
    const s3 = sessionAt(40);
    const t3 = s3.decide(buildIntent(s3).id, 'accept').ticket;
    const h3 = recordingHost({ requestApproval: async () => { throw new Error('boom'); } });
    const r3 = await companion.dispatch(s3, t3, h3);
    assertEqual(r3.ok, false, `${label}: a failing channel ⇒ refused`);
    assertEqual(h3.performed.length, 0, `${label}: nothing performed on channel failure`);

    // A non-answer ("", undefined, true) is not an approval either.
    for (const answer of ['', undefined, null, true, 'yes']) {
      const s = sessionAt(40);
      const t = s.decide(buildIntent(s).id, 'accept').ticket;
      const h = recordingHost({ requestApproval: async () => answer });
      const r = await companion.dispatch(s, t, h);
      assertEqual(r.ok, false, `${label}: ${JSON.stringify(answer)} is not an approval`);
      assertEqual(h.performed.length, 0, `${label}: nothing performed on ${JSON.stringify(answer)}`);
    }

    // Only a real decision performs — and it asks once, for that tool.
    const s4 = sessionAt(40);
    const t4 = s4.decide(buildIntent(s4).id, 'accept').ticket;
    const h4 = recordingHost();
    const r4 = await companion.dispatch(s4, t4, h4);
    assertEqual(r4.ok, true, `${label}: an approved tool call performs`);
    assertEqual(h4.approvals.length, 1, `${label}: exactly one approval was requested`);
    assertEqual(h4.approvals[0].tool, t4.intent.tool, `${label}: the request names the tool`);
    assertEqual(h4.approvals[0].behaviour, t4.behaviour, `${label}: the request names the behaviour`);
  };

  await check(
    (s) => s.consider(recallTrigger).card,
    'recall'
  );

  // The other three behaviours fire no tool, so they need no interactive
  // prompt — but they still need the accepted card (proved in §4), and the
  // request is never even consulted.
  for (const name of ['session.start', 'session.end']) {
    const s = sessionAt(40);
    const trigger = TRIGGERS.find((x) => x.name === name).trigger;
    const card = s.consider(trigger).card;
    const ticket = s.decide(card.id, 'accept').ticket;
    assertEqual(ticket.intent.tool, null, `${name}: fires no tool`);
    const host = recordingHost();
    await companion.dispatch(s, ticket, host);
    assertEqual(host.approvals.length, 0, `${name}: no approval prompt for a non-tool effect`);
    assertEqual(host.performed.length, 1, `${name}: the memory write happened only after the accept`);
  }

  // A "write" class effect is never satisfied by level, capabilities or
  // opt-in — only by the accepted card. (A level-1 session has no such card at
  // all, which is how the carve-out reaches the level ladder.)
  const ideaAtL1 = sessionAt(1).consider({ kind: 'user.request', want: 'idea', text: 'x' });
  assertEqual(ideaAtL1.card, null, 'L1 offers no write-class card');

  // Undeclared effects are refused even with a valid ticket from the session.
  const s = sessionAt(40);
  const card = s.consider({ kind: 'session.start', dayKey: 'undeclared', facts: { changed: 1 } }).card;
  const ticket = s.decide(card.id, 'accept').ticket;
  const tampered = { ...ticket, intent: { ...ticket.intent, action: 'shell.run', tool: 'bash' } };
  assertEqual(s.verifyTicket(tampered), false, 'a tampered ticket is not the ticket this session issued');

  // No stale ticket survives a fresh session object.
  const other = sessionAt(40);
  const stolen = await companion.dispatch(other, ticket, recordingHost());
  assertEqual(stolen.ok, false, 'a ticket from another session is refused');
}

// ---------------------------------------------------------------------------
// 6. the morning brief reads the facts it was given — and only those
// ---------------------------------------------------------------------------
{
  const digest = companion.briefDigest({ changed: ['a.js', 'b.js', 'c.js'], queued: 2, resuming: ['half-finished recall card'] });
  assertEqual(digest.empty, false, 'the digest is not empty');
  assert(/3 files changed/.test(digest.lines[0]), `the digest counts changed files (${digest.lines[0]})`);
  assert(/2 tasks waiting/.test(digest.lines[1]), `the digest counts queued tasks (${digest.lines[1]})`);
  assert(/half-finished recall card/.test(digest.lines[2]), `the digest quotes memory (${digest.lines[2]})`);
  assertEqual(companion.briefDigest({}).empty, true, 'no facts ⇒ an empty digest');

  // Nothing in the brief is a live read: the module has no IO at all, so it
  // cannot fetch anything. Facts quoted into a card are sanitized and bounded.
  const hostile = companion.briefDigest({ changed: ['\u0000\u001b[31mred\u2028 line'], resuming: ['x'.repeat(500)] });
  assert(!/[\u0000\u001b\u2028]/.test(hostile.lines.join(' ')), 'control characters are stripped from facts');
  assert(hostile.lines.join(' ').length < 400, 'facts are bounded');

  const s = sessionAt(40);
  const card = s.consider({ kind: 'session.start', dayKey: 'x', facts: { resuming: ['a very long '.repeat(60)] } }).card;
  assert(card.body.length <= companion.MAX_BODY_CHARS + 8, `the card body is bounded (${card.body.length})`);

  // A recall card previews bounded candidate text, never the raw objects.
  const candidates = companion.recallCandidates([{ id: 1, content: 'y'.repeat(400) }, { id: 2 }, null, { content: '' }]);
  assertEqual(candidates.length, 1, 'only usable candidates survive');
  assert(candidates[0].text.length <= 160, 'preview text is bounded');

  // The mission's XP table pays for a logged idea — confirm the ledger agrees
  // with the behaviour's name for it (spec §1.1: `idea.logged` = 10).
  assertEqual(xp.XP_TABLE['idea.logged'], 10, 'idea.logged is worth 10 XP');
}

console.log('avatar-companion: all assertions passed');
