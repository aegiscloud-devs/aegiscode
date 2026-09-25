'use strict';

/**
 * companion.js — the four companion behaviours (PLAN Phase 23, spec §4).
 *
 * The behaviours are the morning brief, the idea log, the session reflection
 * and in-session recall. What they have in common is not their content, it is
 * the rule that makes them shippable at all:
 *
 *   **The companion proposes; the user disposes.** This module cannot perform
 *   anything. It has no fs, no Electron, no network, no timers and no clock of
 *   its own — every fact it talks about is handed to it, every effect it
 *   proposes is executed by a host that main passes in, and that host is only
 *   ever reached through a *ticket* that `decide(cardId, 'accept')` issued for
 *   one specific card. There is deliberately no `autoAccept`, no `level ≥ N`
 *   shortcut and no "trusted behaviour" bypass: a level buys whether a card may
 *   be *offered*, never whether one may be *acted on*.
 *
 * Four properties, each asserted in `test/avatar-companion.test.mjs`:
 *
 *  1. **Silent at level 1.** `level.capabilities(1)` reports
 *     `proactivity: 'off'`, and every behaviour reads that through
 *     `gating()`. With capabilities the module does not understand (a
 *     hand-written caps object, a future schema) it fails *silent*: unknown
 *     capabilities offer nothing rather than everything. That is the opposite
 *     of `voice.js`'s "unknown caps never lock anything" convention, and it is
 *     deliberate — silence is a safe failure for a proactive surface, noise is
 *     not.
 *  2. **Opt-in per behaviour.** `DEFAULT_OPT_IN` is all-false, so a level alone
 *     never turns a behaviour on. `capabilities` says *may*, `optIn` says *do*.
 *  3. **One proactive card per session** (`MAX_PROACTIVE_PER_SESSION`, spec
 *     §6's "companion becomes noise" risk). A card the user asked for
 *     (`user.request`) is not proactive and does not spend the budget.
 *  4. **No effect without an accepted card, and no *tool* without an
 *     interactive approval.** `dispatch()` refuses on a missing, forged,
 *     replayed or already-consumed ticket, and refuses any intent carrying a
 *     `tool` unless the host's approval channel answers `once`/`session`. A
 *     host with no approval channel at all is refused too — "I forgot to wire
 *     the prompt" must not degrade into "it ran anyway".
 *
 * Effects are declared data (`EFFECTS`), not code paths, so the carve-outs are
 * checkable: nothing here may be a shell, a network call or anything that sends
 * data off the device, and `carveOuts()` is the assertion that says so.
 *
 * Pure: no `fs`, no Electron, no globals. See `docs/avatar-plan.md` §2 and §4.
 */

const level = require('./level.js');

/** The gate values from `level.js` — one source of truth for the level ladder. */
const GATES = level.GATES;

/** How many proactive cards one session may ever show (spec §6). */
const MAX_PROACTIVE_PER_SESSION = 1;

/** Hard ceiling on anything this module renders into a card, in characters. */
const MAX_BODY_CHARS = 600;
const MAX_FACT_CHARS = 160;
const MAX_FACTS = 6;
const MAX_CANDIDATES = 8;

/**
 * Everything a behaviour is allowed to ask for. A closed table, because "the
 * companion can only do these three things" is a property worth being able to
 * test: every entry is local, and none of them is a shell, a network call or an
 * off-device send.
 */
const EFFECTS = Object.freeze({
  'brief.show': Object.freeze({ class: null, tool: null, offDevice: false }),
  'memory.save': Object.freeze({ class: 'write', tool: null, offDevice: false }),
  'recall.load': Object.freeze({ class: 'read', tool: 'memory.search', offDevice: false }),
});

/** Approval classes no companion effect may ever carry. */
const FORBIDDEN_CLASSES = Object.freeze(['shell', 'network', 'offDevice']);

/**
 * The behaviour catalogue. `needsProactivity` is the *minimum* proactivity the
 * level must earn before the card may be offered; `proactive` says whether the
 * card is unprompted (and therefore spends the session's one-card budget).
 */
const CATALOG = Object.freeze([
  Object.freeze({
    id: 'morningBrief',
    label: 'Morning brief',
    // L5+ and only at `proactivity: 'brief'` — the point of the bonus tier.
    needsProactivity: 'brief',
    proactive: true,
    action: 'brief.show',
    acceptLabel: 'Show the brief',
    dismissLabel: 'Not now',
    doneLabel: 'Brief opened',
  }),
  Object.freeze({
    id: 'ideaLog',
    label: 'Idea log',
    // L5+. User-initiated ("remember this idea"), so it is not proactive and
    // does not need the proactivity tier — asking out loud is not noise.
    needsProactivity: 'off',
    proactive: false,
    action: 'memory.save',
    acceptLabel: 'Save to memory',
    dismissLabel: 'Discard',
    doneLabel: 'Saved to memory',
  }),
  Object.freeze({
    id: 'sessionReflection',
    label: 'Session reflection',
    // L10+, offered at session end, at most one line, and only with something
    // to say (a decision made or a thread left open).
    needsProactivity: 'hints',
    proactive: true,
    action: 'memory.save',
    acceptLabel: 'Save this line',
    dismissLabel: 'Discard',
    doneLabel: 'Saved to memory',
  }),
  Object.freeze({
    id: 'recall',
    label: 'Context recall',
    // Breadth scales with level (that is `turn.js`'s recallPolicy), but the
    // *card* only exists once the level is off 'off' — silent at L1.
    needsProactivity: 'hints',
    proactive: true,
    action: 'recall.load',
    acceptLabel: 'Load those notes',
    dismissLabel: 'Skip',
    doneLabel: 'Notes loaded',
  }),
]);

const BEHAVIOUR_IDS = Object.freeze(CATALOG.map((b) => b.id));

/** All-false: a level says *may*, this says *do*. */
const DEFAULT_OPT_IN = Object.freeze(
  BEHAVIOUR_IDS.reduce((acc, id) => Object.assign(acc, { [id]: false }), {})
);

const PROACTIVITY_ORDER = Object.freeze(['off', 'hints', 'brief']);

// --------------------------------------------------------------- small utils

function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Strip control characters / line separators and bound the length. */
function clean(text, max) {
  const s = String(text == null ? '' : text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const limit = typeof max === 'number' && max > 0 ? max : MAX_FACT_CHARS;
  return s.length > limit ? `${s.slice(0, limit - 1)}…` : s;
}

function atLeast(proactivity, want) {
  const a = PROACTIVITY_ORDER.indexOf(proactivity);
  const b = PROACTIVITY_ORDER.indexOf(want);
  if (a < 0) return false;
  if (b < 0) return true;
  return a >= b;
}

function behaviourById(id) {
  return CATALOG.find((b) => b.id === id) || null;
}

/** The flags `level.capabilities()` publishes for the gated behaviours. */
function capsFlags(caps) {
  return isPlainObject(caps) && isPlainObject(caps.companion) ? caps.companion : null;
}

// ------------------------------------------------------------------- opt-in

/** Normalize an opt-in map. Anything not explicitly `true` is off. */
function normalizeOptIn(raw) {
  const out = Object.assign({}, DEFAULT_OPT_IN);
  if (!isPlainObject(raw)) return Object.freeze(out);
  for (const id of BEHAVIOUR_IDS) {
    if (raw[id] === true) out[id] = true;
  }
  return Object.freeze(out);
}

// ------------------------------------------------------------------ gating

/**
 * Which behaviours this capabilities object + opt-in allow, and why not when it
 * does not. The reason string is user-facing ("unlocks at level 5"), because a
 * checkbox that silently does nothing is the failure mode this table exists to
 * prevent.
 *
 * @param {object} caps `level.capabilities(n)` output (or anything shaped like it).
 * @param {object} [opts]
 * @param {object} [opts.optIn] per-behaviour opt-in (`normalizeOptIn` shape).
 * @param {boolean} [opts.envDisabled] `AEGIS_COMPANION=off` — may only silence.
 * @returns {Object<string, {id: string, allowed: boolean, reason: string}>}
 */
function gating(caps, opts = {}) {
  const optIn = normalizeOptIn(opts.optIn);
  const flags = capsFlags(caps);
  const proactivity = isPlainObject(caps) && typeof caps.proactivity === 'string' ? caps.proactivity : 'off';
  const out = {};

  for (const spec of CATALOG) {
    const gate = (allowed, reason) => {
      out[spec.id] = Object.freeze({ id: spec.id, allowed, reason });
    };

    if (!isPlainObject(caps) || !flags) {
      // Fail silent: an unreadable capabilities object offers nothing.
      gate(false, 'no capabilities — the companion stays quiet');
      continue;
    }
    if (opts.envDisabled === true) {
      gate(false, 'AEGIS_COMPANION=off');
      continue;
    }
    if (PROACTIVITY_ORDER.indexOf(proactivity) < 0) {
      gate(false, `unknown proactivity ${JSON.stringify(proactivity)} — staying quiet`);
      continue;
    }
    if (!atLeast(proactivity, spec.needsProactivity)) {
      gate(false, `${spec.label} unlocks at level ${gateLevelFor(spec)}, not level ${caps.level}`);
      continue;
    }
    if (!flagAllowed(flags, spec)) {
      gate(false, `${spec.label} unlocks at level ${gateLevelFor(spec)}`);
      continue;
    }
    if (optIn[spec.id] !== true) {
      gate(false, `${spec.label} is off (opt-in, default off)`);
      continue;
    }
    gate(true, 'available');
  }
  return Object.freeze(out);
}

function flagAllowed(flags, spec) {
  if (spec.id === 'recall') return true; // breadth, not a flag: the gate is proactivity
  return flags[spec.id] === true;
}

function gateLevelFor(spec) {
  if (spec.id === 'morningBrief') return GATES.brief;
  if (spec.id === 'ideaLog') return GATES.ideaLog;
  if (spec.id === 'sessionReflection') return GATES.sessionReflection;
  return GATES.hints;
}

// ------------------------------------------------------------------ effects

/**
 * Which carve-outs this module's effect table violates. Empty array = safe.
 * Mirrors `level.js`'s `carveOuts()` shape so main can assert both at boot.
 */
function carveOuts() {
  const violations = [];
  for (const spec of CATALOG) {
    const effect = EFFECTS[spec.action];
    if (!effect) {
      violations.push(`${spec.id} proposes undeclared effect ${spec.action}`);
      continue;
    }
    if (effect.offDevice) violations.push(`${spec.id} (${spec.action}) reaches off-device`);
    if (FORBIDDEN_CLASSES.includes(effect.class)) {
      violations.push(`${spec.id} (${spec.action}) carries ${effect.class} approval class`);
    }
    if (effect.tool && !effect.tool.startsWith('memory.')) {
      violations.push(`${spec.id} (${spec.action}) fires tool ${effect.tool}, which is not a memory read`);
    }
  }
  return violations;
}

function assertCarveOuts() {
  const bad = carveOuts();
  if (bad.length) throw new Error(`companion behaviours violate a carve-out: ${bad.join('; ')}`);
  return true;
}

// -------------------------------------------------------------------- facts

/**
 * Shape a morning-brief digest out of facts the *caller* gathered locally.
 *
 * This module never looks anything up, so this function is pure formatting: the
 * caller (main, which already has `lib/local/git-scope.js` and
 * `lib/local/queue.js` in hand) reads them and passes the results in. That is
 * what keeps an unprompted card from being an unprompted *tool call*.
 *
 * @param {object} [facts]
 * @param {string[]|number} [facts.changed] changed paths (or a count)
 * @param {string[]|number} [facts.queued] queued task summaries (or a count)
 * @param {string[]} [facts.resuming] memory lines the last session was mid-way through
 */
function briefDigest(facts = {}) {
  const lines = [];
  const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(v) ? Number(v) : 0);

  const changed = count(facts.changed);
  if (changed > 0) {
    const sample = Array.isArray(facts.changed) ? facts.changed.slice(0, 2).map((f) => clean(f, 60)) : [];
    lines.push(`${changed} file${changed === 1 ? '' : 's'} changed since you were last here${sample.length ? ` (${sample.join(', ')})` : ''}`);
  }
  const queued = count(facts.queued);
  if (queued > 0) lines.push(`${queued} task${queued === 1 ? '' : 's'} waiting in the queue`);

  const resuming = (Array.isArray(facts.resuming) ? facts.resuming : []).map((r) => clean(r, MAX_FACT_CHARS)).filter(Boolean).slice(0, 3);
  if (resuming.length) lines.push(`memory says you were mid-way through: ${resuming.join(' · ')}`);

  return Object.freeze({
    lines: Object.freeze(lines.slice(0, MAX_FACTS)),
    empty: lines.length === 0,
  });
}

/** Preview lines for a recall card — ids and text only, bounded. */
function recallCandidates(candidates) {
  const list = Array.isArray(candidates) ? candidates : [];
  return list
    .filter((c) => c && (c.content != null || c.text != null))
    .slice(0, MAX_CANDIDATES)
    .map((c) => Object.freeze({
      id: c.id == null ? null : String(c.id),
      text: clean(c.content != null ? c.content : c.text, MAX_FACT_CHARS),
    }))
    .filter((c) => c.text.length > 0);
}

// -------------------------------------------------------------- card builder

function newId(prefix, seq) {
  return `${prefix}-${seq}`;
}

function makeIntent(spec, args) {
  const effect = EFFECTS[spec.action];
  return Object.freeze({
    behaviour: spec.id,
    action: spec.action,
    approvalClass: effect.class,
    tool: effect.tool,
    offDevice: effect.offDevice,
    args: Object.freeze(Object.assign({}, args || {})),
    // A proposal is never pre-approved. Only `decide(id, 'accept')` mints a
    // ticket, and `dispatch()` accepts nothing else.
    approved: false,
    needsInteractiveApproval: effect.tool != null,
  });
}

function makeCard(spec, opts) {
  const actions = Object.freeze([
    Object.freeze({ id: 'accept', decision: 'accept', label: spec.acceptLabel, doneLabel: spec.doneLabel, primary: true }),
    Object.freeze({ id: 'dismiss', decision: 'dismiss', label: spec.dismissLabel, doneLabel: 'Not now', primary: false }),
  ]);
  return Object.freeze({
    id: opts.id,
    // The renderer shapes this exactly like the tool approval card
    // (`renderer/avatar/cards.js`), which is the whole point: it is a UI the
    // user has already learned to read.
    kind: 'companion',
    shape: 'approval',
    behaviour: spec.id,
    label: spec.label,
    proactive: opts.proactive === true,
    title: opts.title,
    body: opts.body,
    facts: Object.freeze((opts.facts || []).slice(0, MAX_FACTS)),
    actions,
    requiresExplicitAccept: true,
    intent: opts.intent,
  });
}

// ------------------------------------------------------------------- session

/**
 * One session's worth of companion state. Everything the behaviours need to
 * stay quiet lives here — the proactive budget, which cards were shown, which
 * were accepted, and every ticket ever issued — so "at most one proactive card"
 * and "no effect without an accepted card" are properties of a single object
 * rather than of a caller's discipline.
 *
 * @param {object} [input]
 * @param {object} input.caps        `level.capabilities(n)` (required to do anything)
 * @param {object} [input.optIn]     per-behaviour opt-in; default all off
 * @param {string} [input.session]   session id (stamped on tickets)
 * @param {function} [input.now]     clock, injected (never `Date.now` inside)
 * @param {boolean} [input.envDisabled] `AEGIS_COMPANION=off`
 */
function createSession(input = {}) {
  const caps = input.caps;
  const optIn = normalizeOptIn(input.optIn);
  const sessionId = input.session == null ? 'session' : String(input.session);
  const now = typeof input.now === 'function' ? input.now : () => 0;
  const gates = gating(caps, { optIn, envDisabled: input.envDisabled === true });

  const cards = new Map();
  const tickets = new Map();
  const decisions = [];
  let seq = 0;
  let proactiveShown = 0;
  let lastBriefDay = input.lastBriefDay == null ? null : String(input.lastBriefDay);

  function gateOf(id) {
    return gates[id] || Object.freeze({ id, allowed: false, reason: 'unknown behaviour' });
  }

  function budgetLeft() {
    return proactiveShown < MAX_PROACTIVE_PER_SESSION;
  }

  /** Common front door for every behaviour: gate, then budget, then nothing. */
  function offer(spec, trigger, builders) {
    const gate = gateOf(spec.id);
    if (!gate.allowed) return { card: null, reason: gate.reason };
    const proactive = trigger.kind !== 'user.request';
    if (proactive && !budgetLeft()) {
      return { card: null, reason: 'already offered a proactive card this session' };
    }
    const built = builders();
    if (!built) return { card: null, reason: 'nothing to report' };
    seq += 1;
    const card = makeCard(spec, Object.assign({ id: newId('companion', seq), proactive }, built));
    cards.set(card.id, { card, decision: null, decidedAt: null });
    if (proactive) proactiveShown += 1;
    return { card, reason: 'offered' };
  }

  function considerMorningBrief(trigger, spec) {
    const day = trigger.dayKey == null ? null : String(trigger.dayKey);
    if (day && day === lastBriefDay) return { card: null, reason: 'already briefed today' };
    const digest = briefDigest(trigger.facts);
    if (digest.empty) return { card: null, reason: 'nothing to report' };
    return offer(spec, trigger, () => {
      if (day) lastBriefDay = day;
      return {
        title: 'Morning brief',
        body: digest.lines.join(' '),
        facts: digest.lines,
        intent: makeIntent(spec, { lines: digest.lines.slice() }),
      };
    });
  }

  function considerRecall(trigger, spec) {
    const candidates = recallCandidates(trigger.candidates);
    if (!candidates.length) return { card: null, reason: 'no remembered context for this turn' };
    const query = clean(trigger.query, 120);
    return offer(spec, trigger, () => ({
      title: 'Context recall',
      body: `${candidates.length} remembered note${candidates.length === 1 ? '' : 's'} may be relevant${query ? ` to “${query}”` : ''}. Load them into this turn?`,
      facts: candidates.map((c) => c.text),
      intent: makeIntent(spec, {
        query,
        ids: candidates.map((c) => c.id),
        limit: candidates.length,
      }),
    }));
  }

  function considerReflection(trigger, spec) {
    const decisions_ = (Array.isArray(trigger.decisions) ? trigger.decisions : []).map((d) => clean(d, MAX_FACT_CHARS)).filter(Boolean);
    const open = (Array.isArray(trigger.open) ? trigger.open : []).map((o) => clean(o, MAX_FACT_CHARS)).filter(Boolean);
    if (!decisions_.length && !open.length) return { card: null, reason: 'nothing to report' };
    const line =
      decisions_.length && open.length
        ? `Decided: ${decisions_[0]} · Still open: ${open[0]}`
        : decisions_.length
          ? `Decided: ${decisions_[0]}`
          : `Still open: ${open[0]}`;
    return offer(spec, trigger, () => ({
      title: 'Session reflection',
      body: `One durable line from this session — save it? ${line}`,
      facts: [line],
      intent: makeIntent(spec, {
        kind: 'reflection',
        content: clean(line, MAX_BODY_CHARS),
        session: sessionId,
        decisions: decisions_.slice(0, MAX_FACTS),
        open: open.slice(0, MAX_FACTS),
      }),
    }));
  }

  function considerIdea(trigger, spec) {
    const text = clean(trigger.text, MAX_BODY_CHARS);
    if (!text) return { card: null, reason: 'no idea text to save' };
    return offer(spec, trigger, () => ({
      title: 'Idea log',
      body: `Save this to memory as an idea? ${text}`,
      facts: [text],
      intent: makeIntent(spec, { kind: 'idea', content: text, session: sessionId }),
    }));
  }

  /**
   * The one entry point: hand the companion a real engine trigger, get either a
   * card or a reason. It never performs anything, and calling it twice with the
   * same trigger cannot double-charge a behaviour (the proactive budget).
   *
   * @param {object} trigger
   * @param {'session.start'|'turn.start'|'session.end'|'user.request'} trigger.kind
   * @returns {{card: object|null, reason: string}}
   */
  function consider(trigger = {}) {
    const t = isPlainObject(trigger) ? trigger : {};
    switch (t.kind) {
      case 'session.start':
        return considerMorningBrief(t, behaviourById('morningBrief'));
      case 'turn.start':
        return considerRecall(t, behaviourById('recall'));
      case 'session.end':
        return considerReflection(t, behaviourById('sessionReflection'));
      case 'user.request':
        if (t.want === 'idea') return considerIdea(t, behaviourById('ideaLog'));
        if (t.want === 'recall') return considerRecall(t, behaviourById('recall'));
        if (t.want === 'brief') return considerMorningBrief(t, behaviourById('morningBrief'));
        if (t.want === 'reflection') return considerReflection(t, behaviourById('sessionReflection'));
        return { card: null, reason: `unsupported request ${JSON.stringify(t.want)}` };
      default:
        return { card: null, reason: `unknown trigger ${JSON.stringify(t.kind)}` };
    }
  }

  /**
   * Resolve one card. `'accept'` mints a single-use ticket; `'dismiss'` mints
   * nothing. A second decision on the same card is refused, so a double click
   * cannot produce two effects.
   */
  function decide(cardId, decision) {
    const rec = cards.get(String(cardId));
    if (!rec) return { ok: false, reason: 'unknown card', decision: null, ticket: null, intent: null };
    if (rec.decision) return { ok: false, reason: `already ${rec.decision}ed`, decision: rec.decision, ticket: null, intent: null };
    if (decision !== 'accept' && decision !== 'dismiss') {
      return { ok: false, reason: 'decision must be "accept" or "dismiss"', decision: null, ticket: null, intent: null };
    }
    rec.decision = decision;
    rec.decidedAt = now();
    decisions.push(Object.freeze({ cardId: rec.card.id, behaviour: rec.card.behaviour, decision, at: rec.decidedAt }));
    if (decision === 'dismiss') return { ok: true, reason: 'dismissed', decision: 'dismiss', ticket: null, intent: null };

    const ticket = Object.freeze({
      id: `ticket-${sessionId}-${rec.card.id}`,
      cardId: rec.card.id,
      behaviour: rec.card.behaviour,
      session: sessionId,
      approved: true,
      approvedAt: rec.decidedAt,
      intent: rec.card.intent,
    });
    tickets.set(ticket.id, { ticket, used: false });
    return { ok: true, reason: 'accepted', decision: 'accept', ticket, intent: rec.card.intent };
  }

  /**
   * Was this ticket issued by *this* session, for a card that was accepted?
   * Identity, not shape: a hand-built `{ approved: true, … }` object has no
   * entry in this session's map, so it verifies false. Spending is a separate
   * step (`consumeTicket`) so a replay is reported as a replay rather than as a
   * missing acceptance.
   */
  function verifyTicket(ticket) {
    if (!isPlainObject(ticket) || typeof ticket.id !== 'string') return false;
    const rec = tickets.get(ticket.id);
    return Boolean(rec) && rec.ticket === ticket;
  }

  function consumeTicket(ticket) {
    const rec = tickets.get(ticket.id);
    if (!rec || rec.ticket !== ticket || rec.used) return false;
    rec.used = true;
    return true;
  }

  return {
    session: sessionId,
    capabilities: caps,
    optIn,
    // The computed permission table for this session (not the module function).
    gates,
    consider,
    decide,
    verifyTicket,
    consumeTicket,
    /** Cards offered so far (resolved or not), in order. */
    cards: () => Array.from(cards.values()).map((r) => r.card),
    pending: () => Array.from(cards.values()).filter((r) => !r.decision).map((r) => r.card),
    decisions: () => decisions.slice(),
    state: () => Object.freeze({
      session: sessionId,
      proactiveShown,
      maxProactive: MAX_PROACTIVE_PER_SESSION,
      budgetLeft: budgetLeft(),
      lastBriefDay,
      cards: cards.size,
      pending: Array.from(cards.values()).filter((r) => !r.decision).length,
      enabled: BEHAVIOUR_IDS.filter((id) => gateOf(id).allowed),
    }),
  };
}

// ------------------------------------------------------------------ dispatch

function refuse(reason) {
  return Object.freeze({ ok: false, performed: false, reason });
}

/**
 * Turn an accepted card into an effect — the ONLY function in this module that
 * can reach a host, and the only place a tool could ever be fired.
 *
 * The gates are ordered so that the cheapest refusal wins, and so that no gate
 * can be satisfied by level, capabilities or opt-in:
 *
 *  1. the ticket must have been issued by this session for this card
 *     (`verifyTicket`), or there is no accepted card and nothing happens;
 *  2. the ticket is single-use (`consumeTicket`) — a replayed accept, a
 *     re-offered card or a double click cannot fire twice;
 *  3. an intent carrying a `tool` needs the host's approval channel to answer
 *     `once` or `session`. No channel, a deny, or a non-answer ⇒ refused;
 *  4. only then is `host.perform(intent)` called.
 *
 * @param {object} ticket from `session.decide(cardId, 'accept')`
 * @param {object} host `{ requestApproval?, perform }` — injected by main
 * @returns {Promise<{ok: boolean, performed: boolean, reason?: string, result?: any}>}
 */
async function dispatch(session, ticket, host = {}) {
  if (!session || typeof session.verifyTicket !== 'function') {
    return refuse('no companion session — refusing to act');
  }
  if (!session.verifyTicket(ticket)) {
    return refuse('an accepted card is required — the companion never acts on its own');
  }
  if (typeof session.consumeTicket !== 'function' || !session.consumeTicket(ticket)) {
    return refuse('this acceptance was already used');
  }

  const intent = ticket.intent;
  if (!isPlainObject(intent) || intent.approved !== false) {
    return refuse('malformed intent — refusing to act');
  }
  const effect = EFFECTS[intent.action];
  if (!effect) return refuse(`undeclared effect ${JSON.stringify(intent.action)}`);

  if (intent.tool) {
    if (typeof host.requestApproval !== 'function') {
      return refuse(`no approval channel for ${intent.tool} — refusing to fire a tool`);
    }
    let decision;
    try {
      decision = await host.requestApproval({
        id: ticket.id,
        behaviour: ticket.behaviour,
        tool: intent.tool,
        args: intent.args,
        approvalClass: intent.approvalClass,
      });
    } catch (err) {
      return refuse(`approval channel failed: ${err && err.message ? err.message : err}`);
    }
    if (decision !== 'once' && decision !== 'session') {
      return refuse(`approval denied for ${intent.tool}`);
    }
  }

  if (typeof host.perform !== 'function') return refuse('no effect handler configured');
  const result = await host.perform(intent, { ticket });
  return Object.freeze({ ok: true, performed: true, behaviour: ticket.behaviour, action: intent.action, result });
}

module.exports = {
  GATES,
  MAX_PROACTIVE_PER_SESSION,
  MAX_BODY_CHARS,
  BEHAVIOUR_IDS,
  DEFAULT_OPT_IN,
  CATALOG,
  EFFECTS,
  briefDigest,
  recallCandidates,
  normalizeOptIn,
  gating,
  carveOuts,
  assertCarveOuts,
  behaviourById,
  createSession,
  dispatch,
  clean,
};
