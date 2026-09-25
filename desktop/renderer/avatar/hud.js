'use strict';

/**
 * hud.js — the level HUD: XP bar, next unlock, and the honest held state
 * (PLAN Phase 22, spec §1.4).
 *
 * The HUD is a *renderer*: it draws a projection main handed it and derives
 * nothing. That is not a stylistic preference — §1.5 of the plan says a level is
 * written by main because "a renderer-held counter is a suggestion, not a fact",
 * so `hudModel` has no branch that turns XP into a level. It reads `level`,
 * `progress`, `tier` and `held` off the projection, and when there is no
 * projection it says exactly that:
 *
 *     known: false, percent: null, readout: "level unknown — …"
 *
 * The tempting alternative — treat a missing projection as `level 1, 0 XP` —
 * would be a fabricated number on a screen about the user's own progress, and on
 * a real install (main landed, level 12) it would be a lie, not a default. The
 * unknown state costs a line of text and cannot be wrong.
 *
 * The three honesty rules the tests hold it to:
 *
 *   1. **Unknown is not zero.** No projection ⇒ no percentage, no bar fill, and
 *      a readout that says so.
 *   2. **Held is labelled.** §1.4: a level never silently regresses while the
 *      user watches. When `projection.held` is set the HUD says
 *      `level held · reshuffling` and marks the bar, and the next-unlock line
 *      says it is waiting for the ledger to settle — because unlocks follow the
 *      *settled* level, and claiming a unlock the ledger does not support is the
 *      same class of lie as a level that ticks down unannounced.
 *   3. **Every number has a text twin.** The SVG is `aria-hidden`, so the
 *      readout below it must carry the whole state as a sentence.
 *
 * Pure (a model) plus one small DOM writer. No timers, no storage.
 */

const pkg = typeof window !== 'undefined' && window.AegisAvatarParts
  ? {
      parts: window.AegisAvatarParts,
      level: window.AegisAvatarLevel || null,
    }
  : typeof module !== 'undefined' && module.exports
    ? {
        parts: require('./parts.js'),
        level: require('../../lib/avatar/level.js'),
      }
    : { parts: null, level: null };

if (!pkg.parts) throw new Error('avatar/hud.js: avatar/parts.js must be loaded first');

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** `Headphones`, `Seasonal set · pack` — a paid cosmetic says so on the tin. */
function unlockText(unlock) {
  return unlock.unlocks
    .map((u) => (u.paid ? `${u.label} · pack` : u.label))
    .join(', ');
}

/**
 * Build the view model.
 *
 * @param {object} input
 * @param {object} [input.persona] validated persona (for the name)
 * @param {object} [input.projection] `xp.evaluate()` output, as main reports it
 * @param {object} [input.capabilities] `level.capabilities()` output, for the
 *   cosmetics gate (which packs the pane may offer)
 * @param {string} [input.expression] current expression id
 * @param {string} [input.expressionLabel] its human label
 * @param {string} [input.reason] why there is no projection, shown verbatim
 */
function hudModel(input = {}) {
  const persona = input.persona && typeof input.persona === 'object' ? input.persona : pkg.parts.defaultPersona();
  const name = (persona.identity && persona.identity.name) || 'Aegis';
  const projection = input.projection && typeof input.projection === 'object' ? input.projection : null;
  const levelNo = projection ? num(projection.level, null) : null;
  const known = levelNo !== null;

  const expressionLabel = String(input.expressionLabel || input.expression || 'neutral');
  const expressionNote = `expression: ${expressionLabel}`;

  if (!known) {
    const reason = String(input.reason || 'main has not published a level yet');
    return {
      known: false,
      name,
      level: null,
      tier: null,
      xpIntoLevel: null,
      xpForNext: null,
      percent: null,
      held: false,
      heldNote: '',
      nextUnlock: null,
      nextUnlockText: '',
      unlockNote: '',
      expression: input.expression || 'neutral',
      expressionLabel,
      readout: `${name} · level unknown — ${reason} · ${expressionNote}`,
      ariaLive: 'polite',
    };
  }

  const held = projection.held === true;
  const settled = num(projection.settledLevel, levelNo);
  const tier = projection.tier || call(() => pkg.level.tierFor(levelNo).name, null) || null;
  const xpIntoLevel = num(projection.xpIntoLevel, null);
  const xpForNext = num(projection.xpForNext, null);
  // The bar shows the projection's own progress — never a number this file
  // computed. Clamped only so a malformed projection cannot draw outside the
  // track; the held case is labelled in the readout instead of fudged here.
  const percent = Math.round(Math.min(1, Math.max(0, num(projection.progress, 0))) * 100);

  // Unlocks follow the settled level, never the held one.
  const unlockLevel = held ? settled : levelNo;
  let next = null;
  try {
    next = pkg.level ? pkg.level.nextUnlock(unlockLevel) : null;
  } catch {
    next = null;
  }
  const nextUnlockText = next ? `next at level ${next.level}: ${unlockText(next)}` : 'every unlock is yours';

  const parts = [];
  parts.push(`${name} · level ${levelNo}`);
  if (tier) parts.push(tier);
  if (held) parts.push('level held · reshuffling');
  if (!held && xpForNext !== null && xpIntoLevel !== null) {
    parts.push(`${xpIntoLevel} / ${xpForNext} XP to level ${levelNo + 1}`);
  }
  parts.push(nextUnlockText);
  parts.push(expressionNote);

  return {
    known: true,
    name,
    level: levelNo,
    tier,
    xpIntoLevel,
    xpForNext,
    percent,
    held,
    heldNote: held ? 'level held · reshuffling' : '',
    nextUnlock: next,
    nextUnlockText,
    // The held state makes the unlock line provisional; say so where it is read.
    unlockNote: held ? `held — applies after the ledger settles (level ${settled})` : '',
    expression: input.expression || 'neutral',
    expressionLabel,
    readout: parts.join(' · '),
    ariaLive: 'polite',
    cosmetics: input.capabilities && Array.isArray(input.capabilities.cosmeticsUnlocked)
      ? input.capabilities.cosmeticsUnlocked.slice()
      : null,
  };
}

function call(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Write a model into DOM handles. Missing handles are skipped, never thrown on. */
function renderHud(els, model) {
  const e = els || {};
  const set = (node, value) => {
    if (node && typeof value === 'string') node.textContent = value;
  };
  const width = model.percent === null ? '' : `${model.percent}%`;
  if (e.root) {
    e.root.setAttribute('data-known', model.known ? 'true' : 'false');
    e.root.setAttribute('data-held', model.held ? 'true' : 'false');
  }
  set(e.level, model.known ? `L${model.level}` : 'L—');
  set(e.tier, model.tier || '—');
  set(e.readout, model.readout);
  set(e.nextUnlock, model.nextUnlockText);
  set(e.unlockNote, model.unlockNote);
  set(e.expression, model.expressionLabel);
  if (e.fill) {
    e.fill.style.width = width;
    if (e.fill.setAttribute) e.fill.setAttribute('data-held', model.held ? 'true' : 'false');
  }
  if (e.bar) {
    // The bar is decorative: its text twin is the readout, so it is hidden from
    // assistive tech rather than announced twice with different words.
    e.bar.setAttribute('aria-hidden', 'true');
  }
  if (e.heldBadge) {
    e.heldBadge.textContent = model.heldNote;
    e.heldBadge.hidden = !model.held;
  }
  return model;
}

const API = Object.freeze({ hudModel, renderHud, unlockText });

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatarHud = API;
