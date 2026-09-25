'use strict';

/**
 * turn.js — the ONE seam where a level reaches turn assembly (Phase 20) and
 * where the persona's register fragment is attached to the engine's system
 * prompt (Phase 21).
 *
 * `level.js` says what a level buys and `register.js` says what the persona's
 * tone is; neither of them knows what a turn is. This file is the only place
 * that combines the two — deliberately small, pure and dependency-light, so
 * the claim "a level changes behaviour, and only in the knobs the engine
 * already takes" is a thing a test can hold.
 *
 * The shape of the claim:
 *
 *  - `recallPolicy(caps)` turns a capabilities object into the recall budget
 *    for one turn: how many memory entries may be injected and how many tokens
 *    they may take. Both GROW with level, both are clamped, and neither can
 *    ever exceed its hard ceiling no matter what a capabilities object says —
 *    so a hand-edited ledger cannot buy an unbounded context.
 *  - The DEEP recall tier (`aegis_recall_deep`) is a paid server-side embedding.
 *    Level never buys it: it stays an explicit per-session opt-in, because a
 *    level that silently starts spending per turn is a billing surprise.
 *  - No approval, grant or tool field is produced here. Turn assembly reads a
 *    recall policy; it is structurally incapable of reading a widened
 *    permission out of it, which is what makes the Phase 20 carve-out test a
 *    statement about the code rather than a promise about the developers.
 *  - `composeSystemPrompt(base, ctx)` appends the register fragment AFTER
 *    `base` (the engine's own safety/tool rules), via `register.append`, and
 *    returns the fragment so a caller can log exactly what was added.
 *
 * Pure Node: no Electron, no fs, no clock.
 */

const register = require('./register.js');

/** Hard ceilings regardless of what a capabilities object claims. */
const MAX_RECALL_ENTRIES = 40;
const MAX_RECALL_TOKENS = 12000;

/** The floor: what an unreadable/absent capabilities object still reads. */
const MIN_RECALL_ENTRIES = 4;
const MIN_RECALL_TOKENS = 1500;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Recall breadth for one turn.
 *
 * @param {object} caps   `level.capabilities(n)` (or anything shaped like it).
 * @param {object} [opts]
 * @param {boolean} [opts.deep]  the session's explicit deep-recall opt-in.
 * @returns {Readonly<{entries:number, tokens:number, deep:boolean,
 *          modelFloor:(string|null), flags:object, approvalFields:number}>}
 */
function recallPolicy(caps, opts = {}) {
  const c = caps && typeof caps === 'object' ? caps : {};
  const entries = clampInt(c.recallEntries, MIN_RECALL_ENTRIES, MAX_RECALL_ENTRIES, MIN_RECALL_ENTRIES);
  const tokens = clampInt(c.recallTokens, MIN_RECALL_TOKENS, MAX_RECALL_TOKENS, MIN_RECALL_TOKENS);
  const deep = opts.deep === true;
  return Object.freeze({
    entries,
    tokens,
    // Never bought by level — see the header.
    deep,
    modelFloor: typeof c.modelFloor === 'string' && c.modelFloor ? c.modelFloor : null,
    // Exactly the flags `lib/local/engine.js` already sends; nothing new is
    // invented here, which is `level.js`'s rule zero.
    flags: Object.freeze({
      aegis_recall: true,
      ...(deep ? { aegis_recall_deep: true } : {}),
    }),
    // Kept at zero on purpose: turn assembly reads no approval class from a
    // capabilities object, so levelling can never widen blast radius.
    approvalFields: 0,
  });
}

/**
 * Compose the system prompt for one turn: the engine's own prompt, unchanged,
 * with the persona's bounded register fragment appended below it.
 *
 * @param {string} base  the engine's system prompt (safety + tool rules).
 * @param {object} [ctx] `{ capabilities, persona, maxTokens }`.
 * @returns {{system:string, fragment:string, fragmentTokens:number,
 *            dropped:string[], neutralizations:number, policy:object}}
 */
function composeSystemPrompt(base, ctx = {}) {
  const policy = recallPolicy(ctx.capabilities, { deep: ctx.deep });
  const frag = register.fragment({
    persona: ctx.persona,
    capabilities: ctx.capabilities,
    maxTokens: ctx.maxTokens,
  });
  return {
    system: register.append(base, frag.text),
    fragment: frag.text,
    fragmentTokens: frag.tokens,
    dropped: frag.dropped,
    neutralizations: frag.neutralizations,
    policy,
  };
}

module.exports = {
  MAX_RECALL_ENTRIES,
  MAX_RECALL_TOKENS,
  MIN_RECALL_ENTRIES,
  MIN_RECALL_TOKENS,
  recallPolicy,
  composeSystemPrompt,
};
