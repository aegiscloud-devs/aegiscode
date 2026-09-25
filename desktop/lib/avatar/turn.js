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
 *  - `applyModelFloor(model, policy)` turns the L20 floor into the model this
 *    turn actually travels on. It is a ROUTING constraint and nothing more: it
 *    substitutes the reasoning sibling of the model the user picked where this
 *    build can route one (same provider, same key, an id the engine already
 *    pattern-matches), and where it cannot — a local daemon, a provider with no
 *    reasoning sibling — it leaves the pick alone and says so in `met:false`.
 *    A floor that quietly ran a different provider would be a bonus that
 *    invented a code path, which is exactly what §2's rule zero forbids.
 *  - `composeSystemPrompt(base, ctx)` appends the register fragment AFTER
 *    `base` (the engine's own safety/tool rules), via `register.append`, and
 *    returns the fragment so a caller can log exactly what was added.
 *
 * The app-readable shape of this file: `recallPolicy()` is what turn assembly
 * reads for breadth, and `applyModelFloor()` is what it reads for the floor.
 * Neither returns an approval, and `approvalFields` is kept at zero so "a
 * level cannot widen blast radius" is a property of the value, not a promise.
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

// ---------------------------------------------------------------------------
// the model floor (L20+)
// ---------------------------------------------------------------------------

/**
 * Ids that reason on their own, as this build can tell without a round trip:
 *
 *  - DeepSeek's reasoning family — the same anchored set `engine.js` sizes its
 *    budget from (DEEPSEEK_REASONING_MODEL_RE, mirrored from aegiscodex-dev),
 *    because a model whose hidden chain-of-thought bills against its own output
 *    budget is by definition a model that reasons.
 *  - the pooled brain tier (`nexus-brain` and the `-smart`/`-neo` spellings the
 *    server serves as aliases), which is not one model at all: the server fans
 *    the turn out to reasoning workers plus a synthesis pass. That is the one
 *    id the Aegis Cloud class offers (engine.js filterAegisCatalog), so an
 *    Aegis Cloud turn satisfies the floor by construction.
 */
const REASONING_MODEL_RE = /^(?:deepseek-(?:v4(?:\.\d+)?-(?:flash|pro)|flash|pro|reasoner)|(?:nexus|aegis)-brain(?:-(?:smart|neo))?)$/;

/**
 * The same-provider reasoning sibling a floor may substitute, keyed by the
 * provider half of a `provider:model` id. Deliberately tiny and explicit: a
 * substitution is only honest when the sibling runs on the SAME credential the
 * user already configured, so this table names one vendor's own sibling rather
 * than guessing a mapping for the rest. `deepseek-reasoner` is in the regex
 * above for exactly this reason.
 */
const REASONING_SIBLINGS = Object.freeze({ deepseek: 'deepseek-reasoner' });

/** Split a `<provider>:<model>` id; ids without a colon have no provider. */
function splitModelId(model) {
  const id = String(model == null ? '' : model);
  const at = id.indexOf(':');
  if (at <= 0) return { provider: '', model: id };
  return { provider: id.slice(0, at), model: id.slice(at + 1) };
}

/** True when this model reasons on its own, ignoring any provider prefix. */
function reasoningModel(model) {
  return REASONING_MODEL_RE.test(splitModelId(model).model);
}

/**
 * Apply the level's model floor to the model a turn will actually run on.
 *
 * @param {string} model the caller's pick (`provider:model` for byok)
 * @param {object} policy `recallPolicy()` output — `modelFloor` is the only
 *   field read, and it comes from `level.js`'s GATES.reasoningFloor.
 * @returns {{model:string, floor:{requested:(string|null), met:boolean,
 *            applied:boolean, from:string, to:string, reason:string}}}
 */
function applyModelFloor(model, policy) {
  const from = String(model == null ? '' : model);
  const requested = policy && typeof policy.modelFloor === 'string' ? policy.modelFloor : null;
  if (requested !== 'reasoning') {
    return { model: from, floor: { requested: null, met: true, applied: false, from, to: from, reason: '' } };
  }
  if (reasoningModel(from)) {
    return { model: from, floor: { requested, met: true, applied: false, from, to: from, reason: '' } };
  }
  const { provider } = splitModelId(from);
  const sibling = REASONING_SIBLINGS[provider];
  if (sibling) {
    const to = `${provider}:${sibling}`;
    return { model: to, floor: { requested, met: true, applied: true, from, to, reason: '' } };
  }
  return {
    model: from,
    floor: {
      requested,
      met: false,
      applied: false,
      from,
      to: from,
      reason: `no reasoning model this build can route ${from} to`,
    },
  };
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
  REASONING_MODEL_RE,
  REASONING_SIBLINGS,
  splitModelId,
  reasoningModel,
  applyModelFloor,
  recallPolicy,
  composeSystemPrompt,
};
