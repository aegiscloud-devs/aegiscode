#!/usr/bin/env node
/**
 * Behavioural tests for `renderer/avatar/cards.js` — the companion card's DOM
 * half (PLAN Phase 23).
 *
 * What this file exists to pin down:
 *
 *   1. **It is the approval card.** Same class names (`.approval-card`,
 *      `.approval-title`, `.approval-summary`, `.approval-actions`,
 *      `.approval-btn`), same slot (`.approval-slot`), same
 *      disable-everything-on-first-click behaviour — so a companion proposal
 *      cannot drift into a lookalike that reads differently from the gate the
 *      user already trusts.
 *   2. **Rendering is inert.** Building a card, mounting it, and reading it back
 *      sends no decision and touches nothing: only a click resolves it, and a
 *      second click cannot resolve it again.
 *   3. **No HTML is ever constructed from card text.** Facts come from memory
 *      and from git, so they go in as `textContent` — the same rule the diff
 *      block is tested for.
 *
 * No jsdom, no third-party dependency: cards.js takes an injectable `document`,
 * so the ~50-line fake below is all it needs (the same approach as
 * test/renderer-diff.test.mjs).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cardsModule = require('../renderer/avatar/cards.js');
const companion = require('../lib/avatar/companion.js');
const level = require('../lib/avatar/level.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// ------------------------------------------------------------------ fake DOM

function createDom() {
  const created = [];

  class FakeElement {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.className = '';
      this.dataset = {};
      this.children = [];
      this.listeners = new Map();
      this.disabled = false;
      this.type = '';
      this._text = '';
      // `classList` is the one other DOM surface cards.js touches (the
      // approval card marks itself resolved the same way); backed by className.
      this.classList = {
        add: (name) => {
          const parts = String(this.className).split(/\s+/).filter(Boolean);
          if (!parts.includes(name)) parts.push(name);
          this.className = parts.join(' ');
        },
        contains: (name) => String(this.className).split(/\s+/).includes(name),
      };
      created.push(this);
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatch(type, event) {
      for (const fn of this.listeners.get(type) || []) fn(event || { type, preventDefault() {} });
    }
    get textContent() {
      if (this.children.length) return this.children.map((c) => (c == null ? '' : c.textContent)).join('');
      return this._text;
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v);
    }
    /** Depth-first collection of every descendant (and self) with a class. */
    find(className) {
      const out = [];
      const walk = (el) => {
        if (String(el.className || '').split(/\s+/).includes(className)) out.push(el);
        for (const child of el.children || []) walk(child);
      };
      walk(this);
      return out;
    }
  }

  const document = {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  };
  return { document, created };
}

const ALL_IN = Object.freeze(
  companion.BEHAVIOUR_IDS.reduce((acc, id) => Object.assign(acc, { [id]: true }), {})
);

/** Offer one real card from the real core, so a card-type change fails here. */
function offerCard(trigger) {
  const session = companion.createSession({
    caps: level.capabilities(40),
    optIn: ALL_IN,
    session: 'cards-test',
    now: () => 0,
  });
  const { card } = session.consider(trigger);
  assert(card, 'the core offered a card for the renderer to draw');
  return { session, card };
}

// ---------------------------------------------------------------------------
// 1. shape: the approval card, exactly
// ---------------------------------------------------------------------------
{
  const { document } = createDom();
  const { card } = offerCard({ kind: 'session.start', dayKey: 'd1', facts: { changed: 2, queued: 1 } });

  const el = cardsModule.buildCompanionCard(document, card, () => {});
  assert(el, 'the card element is built');

  const classes = String(el.className).split(/\s+/);
  assert(classes.includes(cardsModule.APPROVAL_CARD_CLASS), 'it carries the approval-card class');
  assert(classes.includes(cardsModule.COMPANION_CARD_CLASS), 'it carries the companion-card class');
  assertEqual(el.dataset.companionId, card.id, 'the card is identified by its id');
  assertEqual(el.dataset.companionBehaviour, 'morningBrief', 'the card is identified by its behaviour');
  assertEqual(el.dataset.proactive, 'true', 'a proactive card says so');

  assertEqual(el.find('approval-title').length, 1, 'one title row, the approval card\'s own class');
  assertEqual(el.find('approval-summary').length, 1, 'one summary row');
  assert(el.find('approval-summary')[0].textContent.length > 0, 'the summary carries the brief');

  const facts = el.find('companion-facts');
  assertEqual(facts.length, 1, 'the facts are listed separately');
  assertEqual(facts[0].children.length, 2, 'one list item per fact');

  const actionRows = el.find('approval-actions');
  assertEqual(actionRows.length, 1, 'one action row');
  assertEqual(actionRows[0].children.length, 2, 'accept + dismiss, nothing else');

  const buttons = el.find('approval-btn');
  assertEqual(buttons.length, 2, 'two buttons');
  assertEqual(buttons.map((b) => b.dataset.decision).join(','), 'accept,dismiss', 'in accept-then-dismiss order');
  assertEqual(buttons[0].textContent, card.actions[0].label, 'the accept button uses the core\'s label');
  assertEqual(buttons[0].type, 'button', 'buttons are type=button (never a form submit)');

  // A malformed card is refused rather than rendered as a dead end.
  assertEqual(cardsModule.buildCompanionCard(document, null, () => {}), null, 'no card, no element');
  assertEqual(cardsModule.buildCompanionCard(document, { id: 'x' }, () => {}), null, 'a card with no actions is not drawn');
}

// ---------------------------------------------------------------------------
// 2. inertness: rendering decides nothing, one click decides once
// ---------------------------------------------------------------------------
{
  const { document } = createDom();
  const { session, card } = offerCard({ kind: 'user.request', want: 'idea', text: 'render cards inertly' });
  const decisions = [];

  const el = cardsModule.buildCompanionCard(document, card, (id, decision) => decisions.push([id, decision]));

  // Rendering, reading the text back and even dispatching an unrelated event
  // must not resolve the card.
  assertEqual(String(el.textContent).includes('Idea log'), true, 'the title renders');
  el.dispatch('mouseenter', { type: 'mouseenter' });
  assertEqual(decisions.length, 0, 'rendering decides nothing');
  assertEqual(session.pending().length, 1, 'the core still has the card pending');

  const buttons = el.find('approval-btn');
  buttons[0].dispatch('click');
  assertEqual(decisions.length, 1, 'the accept click sends exactly one decision');
  assertEqual(decisions[0][0], card.id, 'the decision names the card');
  assertEqual(decisions[0][1], 'accept', 'the decision is "accept"');

  assert(buttons[0].disabled && buttons[1].disabled, 'both buttons are disabled after a decision');
  assert(el.className.split(/\s+/).includes('resolved'), 'the card is marked resolved');
  assertEqual(el.find('approval-decision').length, 1, 'the card records what happened');

  // A second click on either button cannot send a second decision — the same
  // double-click guard the approval card has.
  buttons[1].dispatch('click');
  assertEqual(decisions.length, 1, 'a second click sends nothing');

  // Dismissal resolves the card with the other decision, and the core's own
  // decision path is what the renderer's id refers to.
  const { document: doc2 } = createDom();
  const second = offerCard({ kind: 'user.request', want: 'reflection', decisions: ['keep it inert'] });
  const seen = [];
  const el2 = cardsModule.buildCompanionCard(doc2, second.card, (id, decision) => {
    seen.push([id, decision]);
    second.session.decide(id, decision);
  });
  el2.find('approval-btn')[1].dispatch('click');
  assertEqual(seen[0][1], 'dismiss', 'the dismiss button sends "dismiss"');
  const dismissed = second.session.decide(second.card.id, 'dismiss');
  assertEqual(dismissed.ok, false, 'the core refuses a decision the card already made');
}

// ---------------------------------------------------------------------------
// 3. mounting reuses the approval slot, and text stays text
// ---------------------------------------------------------------------------
{
  const { document } = createDom();
  const { card } = offerCard({
    kind: 'turn.start',
    candidates: [{ id: 'm1', content: '<img src=x onerror=alert(1)> remembered' }],
  });

  const container = document.createElement('div');
  const el = cardsModule.mountCompanionCard(document, container, card, () => {});
  assert(el, 'the card mounts');
  assertEqual(container.find('approval-slot').length, 1, 'it mounts into the approval card\'s own slot');
  assertEqual(container.find('approval-slot')[0].children.length, 1, 'exactly one card in the slot');

  // The hostile memory text is text, not markup: no element was created from it.
  const texts = String(el.textContent);
  assert(texts.includes('<img src=x onerror=alert(1)>'), 'the note is rendered verbatim as text');
  assertEqual(el.find('img').length, 0, 'no element was built from memory content');

  // A second card joins the same slot rather than nesting a new one.
  const { card: another } = offerCard({ kind: 'user.request', want: 'idea', text: 'second card' });
  cardsModule.mountCompanionCard(document, container, another, () => {});
  assertEqual(container.find('approval-slot').length, 1, 'the slot is reused');
  assertEqual(container.find('approval-slot')[0].children.length, 2, 'both cards live in the slot');

  assertEqual(cardsModule.mountCompanionCard(document, null, another, () => {}), null, 'no container, no mount');
}

console.log('avatar-companion-cards: all assertions passed');
