'use strict';

/**
 * budget.js — what a request is sized by.
 *
 * Two questions live here, and only one of them is a budget:
 *
 *   1. `maxTokensCeiling(meta)` — how many output tokens the SELECTED MODEL
 *      says it can produce. Display-only: it prints "max output: N" in the
 *      Model hint. It is a property of the model discovered from the catalog,
 *      never a number this app puts on a request. (Kept for that one line;
 *      it decided a request's ceiling until the "Max tokens" dropdown below
 *      was removed.)
 *   2. `budgetFor(model, stated, effort)` — the token budget a request
 *      actually travels with, or `undefined` for "state none".
 *
 * There used to be a third thing: a "Max tokens" dropdown (1k/4k/16k/64k/300k
 * plus an "adaptive" checkbox) that asked the user to state, before sending,
 * how long the answer would be. Output length cannot be predicted from a
 * prompt — it is a guess at text nobody has written yet — and the guess was
 * wrong in both directions:
 *
 *   - it was ignored exactly where it mattered. The pooled Aegis Cloud class
 *     is sized server-side from `effort` (aegis1 services/pool_brain.py
 *     pass_budgets: low/medium/high -> 16384/32768/65536 tokens total across
 *     the worker fan-out), and the server reads a body max_tokens as a ceiling
 *     OVER that ladder — so the number on screen was never the budget the call
 *     ran on;
 *   - it was obeyed exactly where it hurt. A DeepSeek reasoning model bills
 *     hidden chain-of-thought against the SAME budget as its answer, so the
 *     4k default was spent before the first visible token and the turn came
 *     back empty — no error, no tool call, just a turn that "completed" with
 *     nothing.
 *
 * So the number is gone, and what a call is sized by is derived from effort.
 * This file mirrors desktop/lib/local/engine.js (DEEPSEEK_REASONING_MODEL_RE,
 * EFFORT_TOKEN_BUDGET, the stated-cap-wins rule) and keeps it a PURE function
 * for one reason: test/budget.test.mjs requires both copies and asserts they
 * answer identically over a table of cases, so the mirror cannot drift
 * silently — which is how the two copies of aegis1's ladder came to disagree
 * in the first place (974adc5).
 */

/** The flat ceiling, for a model whose catalog entry reports no `max_output`. */
const FLAT_CEILING = 300000;

/**
 * The model's own output limit, for the Model hint ("max output: N").
 *
 * Clamped to FLAT_CEILING because a provider's advertised limit can exceed
 * anything worth displaying, and falls back to the flat ceiling when no
 * per-model metadata is known — the only two states that matter for a line of
 * explanatory text.
 *
 * NOT a request ceiling. Nothing here reads this to size a call.
 */
function maxTokensCeiling(meta) {
  const raw = meta && Number(meta.max_output);
  return Number.isFinite(raw) && raw > 0 ? Math.min(FLAT_CEILING, raw) : FLAT_CEILING;
}

/**
 * DeepSeek's reasoning models, which spend part of the budget on hidden
 * chain-of-thought before emitting a single visible token — DeepSeek counts
 * those tokens against the SAME budget as the answer.
 *
 * Covers the 4.1 family (`deepseek-flash`, i.e. "Flash 4.1", and
 * `deepseek-v4.1-flash`), the ids the picker used to advertise
 * (`deepseek-v4-flash`, `deepseek-v4-pro`) and the deprecated
 * `deepseek-reasoner`. Mirrors DEEPSEEK_REASONING_MODEL_RE in
 * desktop/lib/local/engine.js verbatim — test/budget.test.mjs compares the two.
 */
const DEEPSEEK_REASONING_MODEL_RE = /^deepseek-(v4(\.\d+)?-(flash|pro)|flash|pro|reasoner)$/;

/**
 * Effort rung -> tokens. Mirrors EFFORT_TOKEN_BUDGET in
 * desktop/lib/local/engine.js, which mirrors aegiscodex-dev's src/backend.js.
 *
 * These are the numbers the models whose output length cannot be predicted are
 * sized by, which is why the rung replaced the dropdown: a rung is a
 * decision about how hard to think, and it is the same decision the engine and
 * the server already make.
 */
const EFFORT_TOKEN_BUDGET = { low: 8192, medium: 16384, high: 32768 };

/**
 * There is no longer a "class that requires a stated max_tokens".
 *
 * That set held exactly one entry — `anthropic`, the direct-dial class that
 * spoke the Messages API itself, which rejects a request with no `max_tokens`.
 * That class is gone: the survivors are `aegis`, whose pooled path lets the
 * server size the budget (aegis1's pass_budgets ladder), and `byok`, which
 * reaches its upstream provider through the AEGIS relay — the relay owns the
 * upstream wire format, so the requirement is no longer this client's to
 * satisfy. A stated number is therefore only ever the caller's own.
 */

/** An unknown or "auto" rung falls to the top: the same default the engine
 *  and aegiscodex-dev apply, so "auto" cannot silently mean "smallest". */
function effortRung(effort) {
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}

/**
 * The budget a request travels with.
 *
 * EXACTLY ONE authority per call, in this order:
 *
 *   1. a number the caller STATED (`stated`) is returned verbatim — a
 *      deliberate cap is a liability ceiling and is never raised or lowered by
 *      a rung;
 *   2. otherwise a model that reasons against its own output budget gets the
 *      effort rung;
 *   3. otherwise `undefined`: no `max_tokens` is sent at all and the
 *      provider's own output limit governs. Stating a number here was the
 *      whole defect — `max_tokens: 4096` invented by the transport meant a
 *      DeepSeek model answered nothing, with no error to explain it.
 *
 * No `cls` parameter: it has no bearing on the answer any more. When a class
 * could change the outcome (the removed `anthropic` direct-dial lane) the
 * engine's `reasoningBudget()` took it too, and the two must stay one
 * authority — a parameter that no longer selects anything is how the next
 * class-dependent rule gets added to one copy and not the other.
 */
function budgetFor(model, stated, effort) {
  const n = Number(stated);
  if (Number.isFinite(n) && n > 0) return n;
  if (DEEPSEEK_REASONING_MODEL_RE.test(String(model || ''))) {
    return EFFORT_TOKEN_BUDGET[effortRung(effort)];
  }
  return undefined;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    budgetFor,
    effortRung,
    maxTokensCeiling,
    FLAT_CEILING,
    EFFORT_TOKEN_BUDGET,
    DEEPSEEK_REASONING_MODEL_RE,
  };
}
