'use strict';

/**
 * cards.js — the companion card, rendered in the shape of the tool approval
 * card (PLAN Phase 23, spec §4: "same shape as the approval card the user
 * already trusts").
 *
 * Two things make that more than a styling choice:
 *
 *  1. **It is genuinely the same card.** The class names, the action-row
 *     structure, the disable-on-first-click behaviour and the "what just
 *     happened" line are the approval card's, not a lookalike: a companion
 *     proposal and a tool request read as the same kind of event, because they
 *     are — an offer that does nothing until the user says yes.
 *  2. **It presumes nothing.** The decision is sent to `onDecision(cardId,
 *     'accept'|'dismiss')` and the card is dead afterwards. There is no
 *     "auto-accept after N seconds", no default focus that a stray Enter could
 *     resolve, and no path from rendering to acting: main's `dispatch()`
 *     (`lib/avatar/companion.js`) still refuses anything without the ticket the
 *     accept click produced. Rendering a card cannot cause an effect.
 *
 * Dependency-free and DOM-injectable (`doc`), so a test drives it without
 * jsdom, exactly like `renderer/diffview.js` and `renderer/avatar/assemble.js`.
 */

const COMPANION_CARD_CLASS = 'companion-card';
const APPROVAL_CARD_CLASS = 'approval-card';

function textEl(doc, className, text) {
  const el = doc.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

/**
 * Build one companion card element.
 *
 * @param {Document} doc   the document (injected: this module touches nothing global)
 * @param {object} card    a card from `companion.createSession().consider(...)`
 *                         — `{id, title, body, facts, actions, behaviour}`
 * @param {(cardId: string, decision: 'accept'|'dismiss') => void} onDecision
 * @returns {HTMLElement|null} null for a malformed card (never throws)
 */
function buildCompanionCard(doc, card, onDecision) {
  if (!doc || !card || !card.id) return null;

  const el = doc.createElement('div');
  // Both classes: `.approval-card` for the shared look, `.companion-card` so a
  // theme or a test can tell a proposal from a tool gate.
  el.className = `${APPROVAL_CARD_CLASS} ${COMPANION_CARD_CLASS}`;
  el.dataset.companionId = String(card.id);
  if (card.behaviour) el.dataset.companionBehaviour = String(card.behaviour);
  el.dataset.proactive = card.proactive ? 'true' : 'false';

  el.appendChild(textEl(doc, 'approval-title', String(card.title || card.label || 'Suggestion')));

  if (card.body) el.appendChild(textEl(doc, 'approval-summary', String(card.body)));

  const facts = Array.isArray(card.facts) ? card.facts.filter(Boolean) : [];
  if (facts.length) {
    const list = doc.createElement('ul');
    list.className = 'companion-facts';
    for (const fact of facts.slice(0, 6)) {
      const li = doc.createElement('li');
      li.textContent = String(fact);
      list.appendChild(li);
    }
    el.appendChild(list);
  }

  const actions = doc.createElement('div');
  actions.className = 'approval-actions';

  // Every button this card made, so resolving it can disable exactly those —
  // no `querySelectorAll` on the container (a card is self-contained).
  const buttons = [];
  let resolved = false;

  // No decision is sent until a click. Anything else (Enter on a focused card,
  // a timer, a programmatic "accept") is not a path this card offers.
  //
  // The `resolved` flag is belt-and-braces alongside `disabled`: a browser will
  // not fire a click on a disabled button, but the approval card's promise is
  // that one card produces at most one decision, and that must not depend on
  // the browser's event dispatch. main's `dispatch()` refuses the replayed
  // ticket anyway — three independent layers, none of them trusted alone.
  const decide = (action) => {
    if (resolved) return;
    resolved = true;
    for (const btn of buttons) btn.disabled = true;
    el.classList.add('resolved');
    const tag = textEl(doc, 'approval-decision', String(action.doneLabel || (action.decision === 'accept' ? 'Accepted' : 'Not now')));
    el.appendChild(tag);
    if (typeof onDecision === 'function') onDecision(String(card.id), action.decision);
  };

  for (const action of Array.isArray(card.actions) ? card.actions : []) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `approval-btn ${action.decision === 'accept' ? 'allow' : 'deny'}`;
    btn.textContent = String(action.label || action.decision);
    btn.dataset.decision = String(action.decision);
    btn.addEventListener('click', () => decide(action));
    buttons.push(btn);
    actions.appendChild(btn);
  }

  if (!buttons.length) {
    // A card with no actions is a bug in the caller, not something to render
    // as a dead end.
    return null;
  }

  el.appendChild(actions);
  return el;
}

/**
 * Mount a card into `container`, reusing the approval card's `.approval-slot`
 * so the two can never interleave in the transcript.
 */
function mountCompanionCard(doc, container, card, onDecision) {
  if (!container || typeof container.appendChild !== 'function') return null;
  const el = buildCompanionCard(doc, card, onDecision);
  if (!el) return null;
  let slot = typeof container.querySelector === 'function' ? container.querySelector('.approval-slot') : null;
  if (!slot) {
    slot = doc.createElement('div');
    slot.className = 'approval-slot';
    container.appendChild(slot);
  }
  slot.appendChild(el);
  return el;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildCompanionCard, mountCompanionCard, COMPANION_CARD_CLASS, APPROVAL_CARD_CLASS };
}
