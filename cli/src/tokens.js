'use strict';

/**
 * Token + cost estimation. Tokens are estimated from text length (~4
 * chars/token, the usual rule of thumb) and priced against the per-model rates
 * in the SHARED table. Everything is labeled approximate in the UI.
 *
 * The rate table itself is not here — see the block below.
 */

// ── The rate table is NOT defined here ─────────────────────────────────────
//
// This file used to carry its own copy of `RATES`, and that copy is how the
// DeepSeek row came to be wrong in one host and right in the other: the table
// existed twice (here and desktop/renderer/usage.js), so a rate read off the
// vendor's pricing page reached whichever copy someone happened to edit. The
// CLI's copy still said $0.14/$0.28 — the retired V4-Flash tier — while the
// desktop's had been corrected, and `/cost` would have disagreed with the GUI
// about the same turn on the same engine.
//
// So the table lives in exactly one place. `desktop/renderer/usage.js` is
// already the declared single source of truth for turning a provider's usage
// object into a display number (cli/src/deps.js resolves it, and
// test/cli-tools.test.mjs asserts the function identity), so the rates belong
// there too rather than in a second table that can only drift.
//
// `sharedpaths.js` is used rather than `deps.js` because deps.js eagerly
// requires the engine, the client and the tool registry — pulling all of that
// in to read a number would be a require cycle for anything in that graph.
const path = require('node:path');

const { resolveShared } = require('./sharedpaths.js');
const shared = require(resolveShared(path.join('desktop', 'renderer', 'usage.js')));

const { RATES, RATE_BASIS, UNPRICED_BY_DESIGN, isPeak, ratesFor, costBreakdown } = shared;

// System prompt + tool definitions overhead, roughly, in tokens.
const SYSTEM_TOKENS = 18000;
const TOOL_TOKENS = 12000;
// Default context window we budget against (Sonnet 5 class).
const CONTEXT_WINDOW = 200000;

// Real per-provider context budgets for the /context meter. The default above
// is the Claude-class window the UI was built around; providers with a
// different window map here so the meter shows the truth instead of a
// Sonnet-flavored estimate.
//
// DeepSeek V4 — verified live 2026-09-11 against api.deepseek.com:
//   - a 942,031-token prompt was ACCEPTED (HTTP 200)
//   - a 1,122,032-token prompt was REJECTED, verbatim: "This model's maximum
//     context length is 1048576 tokens."
// so the window is 1M. The old 256k figure here understated it 4x and made the
// /context meter lie. Max output is 393216 — the API rejects anything larger
// with "the valid range of max_tokens is [1, 393216]".
// Keyed by provider name or model-id prefix (longest prefix wins via the
// iteration order below — exact id matches take priority).
const CONTEXT_WINDOWS = {
  deepseek: 1_048_576,
  openrouter: 256_000,
  together: 256_000,
  xai: 256_000,
  groq: 128_000,
  ollama: 128_000,
  openai: 200_000,
  anthropic: 200_000,
  google: 1_000_000,
  gemini: 1_000_000,
};

/** The context budget to show/guard against for a model id, provider, or raw model string. */
function contextWindowFor(model) {
  const raw = String(model || '').toLowerCase();
  if (!raw) return CONTEXT_WINDOW;
  // Same two-candidate lookup as ratesFor in the shared table, for the same
  // reason: a byok id ("deepseek:deepseek-v4-flash") carries a routing label in
  // front of the model, and matching it as written left the 1M-token DeepSeek
  // window reading as the 200k default — a meter that would have told a user
  // they were at 20% of a context that was 4% full.
  const ids = [raw];
  const tail = raw.slice(raw.lastIndexOf(':') + 1);
  if (tail && tail !== raw) ids.push(tail);
  for (const id of ids) {
    if (CONTEXT_WINDOWS[id]) return CONTEXT_WINDOWS[id];
    for (const [prefix, win] of Object.entries(CONTEXT_WINDOWS)) {
      if (id.startsWith(prefix)) return win;
    }
  }
  return CONTEXT_WINDOW;
}

/** Rough token estimate: ~4 chars per token (heuristic, labeled approximate). */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...String(text)].length / 4));
}

/**
 * Bucket the transcript's token usage.
 *   input   — user prompts + system + tools (per exchange)
 *   output  — assistant replies
 *   cacheRead  — what a resumed session reads back (prior context, approximated
 *                as all prior user+assistant text)
 *   cacheWrite — the newest user+assistant chunk written to cache
 */
function transcriptUsage(transcript, model = 'sonnet') {
  const userMsgs = transcript.filter((m) => m.role === 'user');
  const asstMsgs = transcript.filter((m) => m.role === 'assistant');
  const input = userMsgs.reduce((a, m) => a + estimateTokens(m.text || ''), 0);
  const output = asstMsgs.reduce((a, m) => a + estimateTokens(m.text || ''), 0);
  const cacheRead = Math.max(0, input - (userMsgs.length ? estimateTokens(userMsgs[userMsgs.length - 1].text || '') : 0));
  const cacheWrite = userMsgs.length ? estimateTokens(userMsgs[userMsgs.length - 1].text || '') : 0;
  return { input, output, cacheRead, cacheWrite };
}

/**
 * Dollar cost of a usage record at the given model's rates.
 *
 * Returns a number for backward compatibility, but the basis is not lost: use
 * `costBreakdown` when the caller needs to know whether the figure is real.
 * (`usageCost` in the shared module, which also folds the record through
 * `usageBuckets` first — so a wire usage object is normalized identically in
 * both hosts, where this file's old copy read `usage.input` directly.)
 *
 * `model` has no `= 'sonnet'` default here either, and that matters for more
 * than tidiness: a default parameter in THIS file would re-introduce exactly
 * the split the shared module just removed, and only on the CLI side — so
 * `usageCost(u)` would report `basis: 'exact'` in the terminal and
 * `basis: 'default'` in the GUI for the same turn on the same engine. The
 * whole point of delegating is that both hosts answer identically.
 */
function usageCost(usage, model, opts = {}) {
  return shared.usageCost(usage, model, opts);
}

/** Full session accounting: per-bucket tokens, cost, and context used %. */
function sessionAccounting(transcript, model = 'sonnet') {
  const usage = transcriptUsage(transcript, model);
  const system = SYSTEM_TOKENS;
  const tools = TOOL_TOKENS;
  const history = usage.input + usage.output;
  const used = system + tools + history;
  const contextWindow = contextWindowFor(model);
  // ONE breakdown, not a cost call plus a separate basis call: ratesFor reads
  // the wall clock for peak/off-peak, so two evaluations straddling a peak
  // boundary would report a peak cost with an off-peak basis (or vice versa) —
  // two different claims about the same number, which is the thing this return
  // shape exists to prevent. aegiscodex-dev's sessionAccounting is written the
  // same way; if one host folds this into two calls again the two will disagree
  // about the same turn, which is how the rate table split in the first place.
  const breakdown = costBreakdown(usage, model);
  return {
    usage,
    system,
    tools,
    history,
    used,
    contextWindow,
    pct: Math.min(100, Math.round((used / contextWindow) * 100)),
    cost: breakdown.cost,
    // Which rate row priced this. 'default' means the model is unpriced and
    // `cost` is a Sonnet-class placeholder — surfaced rather than swallowed so
    // /cost can label it instead of printing a fabricated figure.
    costBasis: breakdown.basis,
    costPriced: breakdown.priced,
  };
}

/**
 * Phase 4: build the same accounting shape from summed history.jsonl token
 * records (live usage numbers when `real`, estimated otherwise). Real usage
 * already includes system prompt + tools in cacheRead, so `used` counts
 * input + output + cache instead of re-adding the constants.
 */
function accountingFromUsage(usage, model = 'sonnet', { exchanges = 0, real = false, costUsd, at } = {}) {
  const breakdown = costBreakdown(usage, model, { at });
  const cost = typeof costUsd === 'number' ? costUsd : breakdown.cost;
  const used = real
    ? usage.input + usage.output + usage.cacheRead + usage.cacheWrite
    : SYSTEM_TOKENS + TOOL_TOKENS + usage.input + usage.output;
  const contextWindow = contextWindowFor(model);
  return {
    usage,
    system: SYSTEM_TOKENS,
    tools: TOOL_TOKENS,
    history: usage.input + usage.output,
    used,
    contextWindow,
    pct: Math.min(100, Math.round((used / contextWindow) * 100)),
    cost,
    // A settled charge (costUsd) is the ledger's own truth, so it is 'settled'
    // rather than a table match — the pool's bill carries a margin and a
    // prompt-cache discount the table cannot see, so the two must never be
    // conflated.
    costBasis: typeof costUsd === 'number' ? 'settled' : breakdown.basis,
    costPriced: typeof costUsd === 'number' ? true : breakdown.priced,
    exchanges,
    real,
  };
}

function fmtTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(d) {
  return `$${d.toFixed(4)}`;
}

module.exports = {
  RATES,
  RATE_BASIS,
  UNPRICED_BY_DESIGN,
  isPeak,
  SYSTEM_TOKENS,
  TOOL_TOKENS,
  CONTEXT_WINDOW,
  CONTEXT_WINDOWS,
  contextWindowFor,
  ratesFor,
  costBreakdown,
  estimateTokens,
  transcriptUsage,
  usageCost,
  sessionAccounting,
  accountingFromUsage,
  fmtTokens,
  fmtCost,
};
