'use strict';

/**
 * Pure token-usage → display-number mapping, and the cost half of it.
 *
 * Standalone from app.js (same reason as budget.js/stream-policy.js): it is
 * requireable from a plain Node test without window.aegis. app.js only calls
 * into it.
 *
 * Why this exists at all: the two wire formats spell the same quantity
 * differently, and the renderer used to read exactly one of the spellings.
 *
 *   OpenAI-compatible       { prompt_tokens, completion_tokens, total_tokens }
 *   Anthropic-compatible    { input_tokens,  output_tokens }        ← no total
 *
 * Reading only `total_tokens` — the field OpenAI happens to provide — meant
 * every Anthropic-compatible model rendered with no token count at all, while
 * the call was silently being billed. Accepting both spellings, and deriving
 * the total when the provider doesn't state one, is what makes the spend
 * visible regardless of which endpoint answered.
 *
 * ── The cost half, on the CLI's principle ──────────────────────────────────
 *
 * The renderer printed a token count and nothing else, so the desktop had no
 * meter to compare against `aegiscodex` on the same engine and the same
 * prompt — the comparison that started this whole line of work. The CLI's
 * rule (cli/src/tokens.js, ported here) has three parts, and all three matter:
 *
 *   1. A pooled turn's bill is settled SERVER-side and carries a margin and a
 *      prompt-cache discount the client cannot see. When the response states
 *      `costUsd`, that figure wins verbatim — it is the truth about the
 *      charge, not an estimate of it.
 *   2. Only in the absence of a settled charge does the local rate table
 *      apply, and the result is labeled an estimate so nobody reads a guess as
 *      a bill.
 *   3. The rate table is resolved by exact id, then longest prefix. The
 *      DeepSeek row is load-bearing: without it every direct DeepSeek turn
 *      fell through to Sonnet's $3.00/$15.00 per M against a real
 *      $0.14/$0.28 — 21x the input rate and 54x the output rate — which made
 *      the *meter* the largest single contributor to the apparent cost gap
 *      between two surfaces running identical code.
 */

/**
 * Number of tokens to show for a completed turn, or `null` when the provider
 * reported none (an unknown count must render as nothing, never as `0`).
 *
 * @param {{total_tokens?: number, prompt_tokens?: number, completion_tokens?: number,
 *          input_tokens?: number, output_tokens?: number,
 *          input?: number, output?: number}|null|undefined} usage
 * @returns {number|null}
 */
function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  // Three spellings of the same quantity: OpenAI's, Anthropic's, and this
  // file's own bucket shape — which is also the shape a LEDGER row carries
  // (cli/src/history.js writes `{input, output, cacheRead, cacheWrite}` into
  // sessions.json, and the CLI's demo path writes `{input, output}`). Reading
  // only the two wire spellings left every stored row uncountable, so a
  // resumed session's rolling total started at zero even though its ledger
  // said otherwise.
  const input = usage.input_tokens ?? usage.prompt_tokens ?? usage.input;
  const output = usage.output_tokens ?? usage.completion_tokens ?? usage.output;
  if (typeof input !== 'number' && typeof output !== 'number') return null;
  return (input || 0) + (output || 0);
}

/**
 * Rough token count for text the wire never measured — a direct port of the
 * CLI's own estimator (`aegiscodex-dev/src/tokens.js estimateTokens`), and the
 * reason its session total is MONOTONIC.
 *
 * This is the whole difference being fixed. The CLI's `appendHistory`
 * (aegiscodex-dev/src/history.js) writes a `tokens` object for EVERY finished
 * exchange: `{input, output, cacheRead, cacheWrite, real: true}` when the wire
 * reported usage, and `{input: estimateTokens(prompt), output:
 * estimateTokens(reply), real: false}` when it did not. `real` is a FLAG, not a
 * gate — `aggregateSessionUsage` adds `t.input || 0` for every row regardless,
 * so a turn without usage still moves the total and only marks it as partly
 * estimated.
 *
 * The desktop rolled only reported usage and dropped everything else, so its
 * total was flat across any turn the pool did not report on — the meter looked
 * dead while the conversation was being billed. ~4 characters per token, the
 * CLI's heuristic, kept identical so the two surfaces estimate the same turn
 * the same way. Empty text is 0, never the `Math.max(1, …)` floor.
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil([...String(text)].length / 4));
}

/**
 * The bucket shape an exchange gets when the wire reported no usage: the CLI's
 * `{input: estimateTokens(prompt), output: estimateTokens(reply)}`.
 *
 * `null` when there is no text at all to estimate from, so a dispatch that
 * genuinely reported nothing (no usage, no prompt, no reply) still lands in
 * `unknown` instead of being handed a fabricated zero.
 *
 * `reasoning` is the extended-thinking trace, and it is OUTPUT: a reasoning
 * model bills its chain of thought as output tokens, which is why the wire's
 * own `output_tokens` already includes it. The desktop renders that trace in
 * its own element (app.js `reasoningText`) rather than in the reply body, so
 * the two streams had to be added back together here — an estimate measured off
 * the visible answer alone sat still for the entire think phase, which on a
 * reasoning model is both the longest and the most expensive part of the turn.
 *
 * @param {string} [prompt]
 * @param {string} [reply]
 * @param {string} [reasoning]
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}|null}
 */
function estimatedBuckets(prompt, reply, reasoning) {
  const hasPrompt = typeof prompt === 'string' && prompt.length > 0;
  const out =
    (typeof reply === 'string' ? reply : '') +
    (typeof reasoning === 'string' ? reasoning : '');
  const hasReply = out.length > 0;
  if (!hasPrompt && !hasReply) return null;
  return {
    input: estimateTokens(prompt),
    output: estimateTokens(out),
    cacheRead: 0,
    cacheWrite: 0,
    real: false,
  };
}

// Per-million-token USD rates. Cache-read/write matter for long sessions.
//
// These are the PROVIDER's rates, for the fallback path where a turn has no
// server-settled charge (a byok relay turn reports the provider rate it
// relays against). A pooled turn reports the ledger figure instead — see
// turnAccounting's `costUsd` — because the pool's bill carries a margin and a
// prompt-cache discount this table cannot see.
//
// Keys are matched by exact id first, then by prefix (ratesFor below), so a
// family row covers every dated variant of it.
const RATES = {
  sonnet:  { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  default: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  fable:   { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  opus:    { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  // Haiku — the same class of hole as the DeepSeek row below, on the provider
  // whose prices we already thought we knew. The three rows above price Sonnet,
  // Opus and Fable; a Haiku turn matched no exact key, no prefix
  // ("claude-haiku-4-5" starts with none of them) and no family name, so it
  // fell to the Sonnet-class default at 3x its real input and output rate.
  //
  // $1.00/$5.00 per M (Anthropic's published rate). cacheRead/cacheWrite
  // follow the convention the three rows above already encode — 0.1x and 1.25x
  // input — rather than being quoted independently, so the Anthropic rows
  // cannot drift apart from each other.
  haiku:   { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  // `claude-haiku-4-5` names its family after the vendor prefix, so the
  // family-scan fallback (raw.includes(key)) would find it — but only after the
  // prefix loop, and the prefix `claude` is not a key. Listed explicitly so the
  // match is EXACT and cannot be reordered away.
  'claude-haiku': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },

  // DeepSeek — read off the vendor's own pricing table
  // (api-docs.deepseek.com/quick_start/pricing), not from a secondary blog and
  // not from a mirror of our own catalog.
  //
  // The row this replaces said $0.14/$0.28, sourced from aegis1's
  // catalog.py (cost_per_1k_input=0.00014) and referenced in pricing.py. That
  // figure is the retired **V4-Flash** tier, and the vendor's own footnote (1)
  // retires it explicitly: "The legacy names deepseek-v4-flash and
  // deepseek-v4-flash-vision-exp are still accepted, but the corresponding
  // models have been retired, their requests are served by the
  // DeepSeek-V4.1-Flash model and billed at the Flash price." So every legacy
  // id — which is what the picker advertises and what a user pins — bills at
  // the V4.1 figures below, ~2.1x the old row.
  //
  // The rate is TIME-DEPENDENT (peak 01:00-04:00 and 06:00-10:00 UTC Mon-Fri),
  // so one flat row cannot state the price — it can only state one of the two.
  // `offPeak` carries the other and ratesFor() picks by the wall clock.
  //
  // cacheRead is the CACHE HIT price the vendor quotes directly ($0.006 peak),
  // not a fraction of input: it is 50x cheaper than input, which is what makes
  // the cache-hit rate worth measuring at all. Deriving it as 0.1x input — the
  // convention aegis1/pricing.py used — overstated it 2.3x.
  // cacheWrite is the input rate: DeepSeek bills a cache write as ordinary
  // input tokens with no write premium, unlike Anthropic's 1.25x.
  deepseek: {
    input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0.30,
    offPeak: { input: 0.15, output: 0.60, cacheRead: 0.003, cacheWrite: 0.15 },
  },
  // DeepSeek-V4-Pro-0813 — a different, pricier model. Longest-prefix matching
  // keeps it from being shadowed by the `deepseek` family row above.
  'deepseek-v4-pro': {
    input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32,
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 },
  },
  // `deepseek-v4.1-pro` is a spelling the plugin's OWN regex accepts
  // (DEEPSEEK_REASONING_MODEL_RE: `v4(\.\d+)?-(flash|pro)`), so a config can
  // carry it and the picker can advertise it. It is listed explicitly because
  // the prefix loop cannot reach the row above — "deepseek-v4.1-pro" does not
  // start with "deepseek-v4-pro" — so it fell to the `deepseek` FAMILY row and
  // a Pro-tier turn was billed at Flash rates.
  //
  // Figures are the Pro tier's ($1.32/$3.96 per M), the same tier the tail of
  // the id names. This is deliberately the DEARER reading: an id that names
  // "pro" and prices at Flash under-reports spend, which is the direction that
  // cannot be recovered after the fact. Sources disagree on V4 Pro's current
  // rate (one registry still carries an August 12 check at $0.435/$0.87), so
  // treat this row as the one figure here most worth confirming against an
  // invoice.
  'deepseek-v4.1-pro': {
    input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 1.32,
    offPeak: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0.66 },
  },
};

/**
 * Is `at` inside DeepSeek's peak window? 01:00-04:00 and 06:00-10:00 UTC,
 * Monday-Friday. Everything else, weekends included, is off-peak at half rate.
 *
 * The vendor also excludes Chinese public holidays, which we do NOT model: the
 * published table lists them by date, so honouring them would mean shipping a
 * calendar that goes stale. The consequence is bounded and one-directional —
 * on a holiday we price at peak (the dearer reading) instead of off-peak — and
 * over-reporting a spend is recoverable where under-reporting is not.
 */
function isPeak(provider, at = new Date()) {
  if (String(provider || '').toLowerCase().indexOf('deepseek') !== 0) return true;
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** How a model id was matched to a rate row — see ratesFor. */
const RATE_BASIS = Object.freeze({
  EXACT: 'exact',
  PREFIX: 'prefix',
  FAMILY: 'family',
  DEFAULT: 'default',
});

/**
 * The rate rows a model id may name as a whole word rather than as a prefix.
 * Anthropic spells its family *inside* the id — "claude-opus-4" matches no
 * prefix — so prefix matching alone cannot see it.
 */
const RATE_FAMILIES = Object.keys(RATES).filter((k) => k !== 'default');

/**
 * Ids this module can be handed that deliberately have NO row, with the reason.
 *
 * `test/rate-coverage.test.mjs` fails the build when an id the plugin's own
 * source routes to resolves to RATE_BASIS.DEFAULT without appearing here. That
 * is the mechanism that was missing on the day the picker started advertising
 * DeepSeek: nothing compared "ids we route to" against "ids we have priced", so
 * the gap had no surface on which to show up as a failure.
 *
 * Two honest reasons to be in this list, and no others:
 *
 *  - POOLED: aegis1 bills the pool call and reports the settled figure, which
 *    `turnAccounting` already prefers over anything computed here (its
 *    `costUsd` branch). A local guess would be a second, worse number printed
 *    beside the real charge — and for the brain tiers it would also miss the
 *    fan-out factor (see ID_NOTES in cli/src/models.js: four billed provider
 *    calls per turn at effort=high, sized by the ask).
 *  - PROVIDER: a bare provider (`anthropic`, `groq`) is a ROUTING choice — "let
 *    the pool pick" — not a model. It names no rate because it names no model.
 *
 * Anything else belongs in RATES. An entry here is a claim that we have no
 * business pricing it, not a parking space for a rate we have not looked up.
 */
const UNPRICED_BY_DESIGN = Object.freeze({
  // Pooled seats — the ledger carries the charge.
  'nexus-brain': 'pooled: multi-call fan-out, aegis1 settles the charge',
  'aegis-brain': 'pooled alias of nexus-brain',
  'nexus-brain-smart': 'pooled alias of nexus-brain',
  'nexus-brain-neo': 'pooled alias of nexus-brain',
  'aegis-brain-smart': 'pooled alias of nexus-brain',
  'aegis-brain-neo': 'pooled alias of nexus-brain',
  'openai-gpt4o-mini': 'pooled seat, aegis1 settles the charge',
  // Bare provider names — a routing choice, not a model.
  anthropic: 'provider name, not a model id',
  openai: 'provider name, not a model id',
  groq: 'provider name, not a model id',
  google: 'provider name, not a model id',
  xai: 'provider name, not a model id',
});

/**
 * The rate row for a model id, plus HOW it was matched.
 *
 * `basis` is the whole point of the return shape. This used to be
 * `return family || RATES.default` — a bare row — so an id nobody had priced
 * (DeepSeek, until this change; Haiku too) was silently priced at Sonnet's
 * $3/$15 and rendered as though it were a measurement. A wrong number that
 * announces itself is a bug report; a wrong number that looks like every other
 * number is a fabrication, and it survived because nothing downstream could
 * tell the two apart.
 *
 * So the fallback still exists — a caller needs *a* number to render — but it
 * is now labeled: `basis: 'default'` means "we do not know this model's price
 * and this figure is a Sonnet-class placeholder". Callers that display money
 * are expected to say so, and test/rate-coverage.test.mjs fails the build when
 * a model the plugin can actually route to lands here.
 *
 * @param {string} model  a model id, provider name, alias, or "provider:model"
 * @param {{at?: Date}} [opts]  the instant to price against, for peak/off-peak
 * @returns {object} the row ({input,output,cacheRead,cacheWrite}) plus `basis`,
 *   `peak`, and the `model` it resolved from.
 */
function ratesFor(model, { at } = {}) {
  const raw = String(model || '').toLowerCase();
  const finish = (row, basis) => {
    const provider = raw.indexOf('deepseek') === 0 || raw.indexOf(':deepseek') > -1
      ? 'deepseek'
      : raw;
    const peak = isPeak(provider, at || new Date());
    // Off-peak rows are half of peak by construction, but read them from the
    // table rather than dividing, so a future discount that is NOT exactly half
    // is expressed where the numbers live instead of in arithmetic here.
    const use = !peak && row.offPeak ? { ...row, ...row.offPeak } : row;
    return { ...use, basis, peak, model: raw };
  };
  if (!raw) return finish(RATES.default, RATE_BASIS.DEFAULT);

  // A byok model id carries its provider as a routing label:
  // "anthropic:claude-opus-4", "deepseek:deepseek-v4-flash". The label is not
  // a rate, and rating it as written fell through every prefix to
  // RATES.default — so an Opus BYOK turn was priced at Sonnet's $3/$15 against
  // the vendor's real $5/$25. 15x, on the one class whose figure can only ever
  // be an estimate, because there the vendor bills the caller and AEGIS only
  // relays.
  //
  // Precedence is by MATCH QUALITY first and candidate second, not
  // candidate-first: matching candidate-by-candidate let the label `deepseek`
  // prefix-match the family row before the tail was ever considered, so a
  // `deepseek:deepseek-v4-pro` turn was priced at Flash rates — the routing
  // label beating the model it labels. So: try every candidate as an exact id,
  // then every candidate as a prefix.
  const ids = [raw];
  // The routing label is separated by ':' in a byok id ("anthropic:claude-opus-4")
  // and by '/' in the ids the PLATFORM advertises ("deepseek/deepseek-v4-flash"
  // — see test/cli-tools.test.mjs, test/mcp-balance.test.mjs). Splitting only on
  // ':' left the slash form resolving its whole string as one id, so
  // "deepseek/deepseek-v4-pro" never reached the tail and prefix-matched the
  // `deepseek` FAMILY row — the pro model priced at Flash rates, the same
  // label-shadowing bug the ':' form had, in the spelling that is actually
  // shipped.
  const sep = Math.max(raw.lastIndexOf(':'), raw.lastIndexOf('/'));
  const tail = raw.slice(sep + 1);
  if (tail && tail !== raw) ids.push(tail);
  for (const id of ids) {
    if (RATES[id]) return finish(RATES[id], RATE_BASIS.EXACT);
  }
  let best = null;
  let bestLen = 0;
  for (const id of ids) {
    for (const [prefix, rates] of Object.entries(RATES)) {
      if (prefix !== 'default' && id.startsWith(prefix) && prefix.length > bestLen) {
        best = rates;
        bestLen = prefix.length;
      }
    }
  }
  if (best) return finish(best, RATE_BASIS.PREFIX);
  // Longest family-key hit wins, so an overlapping pair resolves the same way
  // twice running rather than by object key order.
  let family = null;
  let familyLen = 0;
  for (const key of RATE_FAMILIES) {
    if (raw.includes(key) && key.length > familyLen) {
      family = RATES[key];
      familyLen = key.length;
    }
  }
  return finish(family || RATES.default, family ? RATE_BASIS.FAMILY : RATE_BASIS.DEFAULT);
}

/**
 * The four billable buckets from a wire usage object, accepting every
 * provider's spelling of them.
 *
 * ── The one thing the providers genuinely disagree about ───────────────────
 *
 * Cache fields are not merely spelled differently, they are MEASURED
 * differently, and the difference is silent:
 *
 *   Anthropic   `input_tokens` EXCLUDES `cache_read_input_tokens` and
 *               `cache_creation_input_tokens` — the buckets are DISJOINT.
 *   OpenAI      `prompt_tokens` INCLUDES
 *               `prompt_tokens_details.cached_tokens`.
 *   DeepSeek    `prompt_tokens` INCLUDES `prompt_cache_hit_tokens` — the
 *               cached count is a SUBSET of the prompt count.
 *
 * Reading a subset pair as though it were disjoint double-bills every cached
 * token: once at the input rate and again at the cache rate. That is the exact
 * inverse of the saving caching exists to produce, and it is invisible in the
 * output — the figure simply comes out larger, and never looks wrong. So the
 * convention is detected from which field supplied the prompt count, and only
 * the subset spellings subtract.
 *
 * Earlier revisions deferred this to `desktop/lib/local/providers.js`, a file
 * that does not exist — so nothing normalised these fields and every DeepSeek
 * turn reported `cacheRead: 0`, pricing its whole prompt at the miss rate.
 * That is why the convention is resolved here, in the one module both hosts
 * resolve (cli/src/deps.js), rather than in a transport either could drop.
 *
 * @param {object|null|undefined} usage
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
function usageBuckets(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const num = (...candidates) => {
    for (const c of candidates) if (typeof c === 'number') return c;
    return 0;
  };
  const opt = (v) => (typeof v === 'number' ? v : undefined);

  const anthropicIn = opt(u.input_tokens);
  const openaiIn = opt(u.prompt_tokens);
  const details = u.prompt_tokens_details;
  const nested = details && typeof details === 'object' ? opt(details.cached_tokens) : undefined;
  // DeepSeek's `prompt_cache_hit_tokens`, OpenAI's nested `cached_tokens`, and
  // the bare `cached_tokens` some OpenAI-compatible gateways emit. All three
  // are SUBSETS of the prompt count they arrive beside.
  const subsetHit = num(u.prompt_cache_hit_tokens, nested, u.cached_tokens);

  // Only the OpenAI/DeepSeek spelling names the cache INSIDE the prompt stat.
  // The Anthropic spelling, and this file's own already-bucketed `{input,...}`
  // shape (which a ledger row carries), are disjoint — subtracting there would
  // understate the bill.
  const subset = anthropicIn === undefined && openaiIn !== undefined;
  const promptCount = subset ? openaiIn : num(anthropicIn, openaiIn, u.input);

  const cacheReadRaw = num(u.cache_read_input_tokens, u.cacheRead, subsetHit);
  // Clamp to the prompt it belongs to: a provider over-reporting its hit count
  // must not be able to produce negative input tokens.
  const cacheRead = subset ? Math.min(Math.max(0, promptCount), cacheReadRaw) : cacheReadRaw;
  const cacheWrite = num(u.cache_creation_input_tokens, u.cacheWrite);
  const output = num(u.output_tokens, u.completion_tokens, u.output);
  const input = subset ? Math.max(0, promptCount - cacheRead) : promptCount;

  // A stated total larger than the split means the provider counted tokens the
  // split does not name (thinking, cached reads). Attribute the remainder to
  // input rather than dropping it: dropping it would understate the bill.
  const total = num(u.total_tokens);
  const accounted = input + output + cacheRead + cacheWrite;
  return {
    input: total > accounted ? input + (total - accounted) : input,
    output,
    cacheRead,
    cacheWrite,
  };
}

/**
 * Dollar cost of a usage record at the given model's rates, with the
 * provenance attached.
 *
 * `basis === 'default'` means the model was not priced and `cost` is a
 * Sonnet-class placeholder — the one state the old code could not express.
 *
 * `model` deliberately has NO `= 'sonnet'` default parameter, which is a
 * behaviour change worth stating: the old signature was `model = 'sonnet'`, so
 * `costBreakdown(u, undefined)` substituted the alias and reported
 * `basis: 'exact'` — "this model's real rate" — while `costBreakdown(u, '')`
 * (and `ratesFor(undefined)`) reported `basis: 'default'` — "we do not know
 * this model". The two spellings produced the SAME money, because
 * RATES.default and RATES.sonnet are numerically identical, but two different
 * labels for the same number is the exact ambiguity this return shape exists to
 * remove. So an unspecified model now flows to the default row and says so.
 * The money is unchanged; only the claim about it is.
 *
 * @param {object} usage  a wire usage object or a stored bucket row
 * @param {string} model  the model id that answered
 * @param {{at?: Date}} [opts]  the instant to price against (peak/off-peak)
 * @returns {{cost: number, basis: string, peak: boolean, model: string, priced: boolean}}
 */
function costBreakdown(usage, model, opts = {}) {
  const r = ratesFor(model, opts);
  const u = usageBuckets(usage);
  const toD = (n, rate) => (Math.max(0, Number(n) || 0) / 1_000_000) * rate;
  const cost = toD(u.input, r.input)
    + toD(u.output, r.output)
    + toD(u.cacheRead, r.cacheRead)
    + toD(u.cacheWrite, r.cacheWrite);
  return { cost, basis: r.basis, peak: r.peak, model: r.model, priced: r.basis !== RATE_BASIS.DEFAULT };
}

/**
 * Dollar cost of a usage record at the given model's rates (USD, estimate).
 * See `costBreakdown` for why an unnamed model reports `default` rather than
 * silently claiming Sonnet's row as an exact match.
 */
function usageCost(usage, model, opts = {}) {
  return costBreakdown(usage, model, opts).cost;
}

/**
 * What one turn cost, as the CLI reports it: the server's settled charge when
 * the response carries one, otherwise the rate table's estimate, always with
 * the distinction preserved so it can be labeled.
 *
 * @param {object|null|undefined} usage  the response's `usage` object
 * @param {string} model                 the model id that answered
 * @param {{costUsd?: number}} [opts]    the server-settled charge, if any
 * @returns {{tokens: number|null, cost: number|null, real: boolean, estimated: boolean}}
 *          `real` is true only when `cost` is the settled charge. `cost` is
 *          `null` when nothing was reported and no model was named — an
 *          unpriced turn must render as nothing, never as $0.0000.
 */
function turnAccounting(usage, model, opts = {}) {
  const tokens = usageTokens(usage);
  const u = usage && typeof usage === 'object' ? usage : {};
  // The settled charge can arrive either on the response or folded into the
  // usage object — aegiscodex-dev/src/main.js does the latter
  // (`{ ...result.usage, costUsd: result.costUsd }`), so both are accepted.
  const settled = typeof opts.costUsd === 'number'
    ? opts.costUsd
    : (typeof u.costUsd === 'number' ? u.costUsd : undefined);
  if (typeof settled === 'number') {
    // The ledger's own figure. `basis: 'settled'` rather than a table match,
    // because a settled charge is a fact and a table match is a guess — and the
    // pool's bill carries a margin and a prompt-cache discount this table
    // cannot see, so the two must never be averaged or confused.
    return { tokens, cost: settled, real: true, estimated: false, basis: 'settled', priced: true };
  }
  if (tokens == null) return { tokens, cost: null, real: false, estimated: false, basis: null, priced: false };
  const b = costBreakdown(u, model, opts);
  // A model the table cannot place still yields a number (ratesFor never
  // returns nothing), so this is always an estimate — but `priced: false` says
  // the figure is a placeholder rather than this model's rate, so the caller
  // can label it instead of printing it as though it had been measured.
  return { tokens, cost: b.cost, real: false, estimated: true, basis: b.basis, priced: b.priced };
}

/**
 * ── The rolling session tallies, on the CLI's rule ─────────────────────────
 *
 * The two surfaces did not merely print different numbers — they counted
 * differently. The CLI never shows a turn's tokens in isolation: `recordTurn`
 * (cli/src/app.js) folds each finished turn's usage into one `session` object
 * — `tokens`, `inputTokens`, `outputTokens`, `calls` — and what the user reads
 * back is that RUNNING TOTAL. The status bar prints `state.tokens`
 * (renderStatus), and `ctrl+t` prints the tallies in one line
 * (`tokenSummary`: `12,400 tok (10,100 in / 2,300 out) · 4 calls · €0.03`).
 * The tallies are reproduced; that one abbreviation is not — `fmtRoll` explains
 * why it drops the parenthetical rather than carrying the CLI's line verbatim.
 *
 * The desktop counted per turn only. Every meta row was a fresh count that
 * reset at the next call, so "what has this session spent" was answerable only
 * by adding the rows up by eye across a scrollback — which is most of why the
 * desktop looked like it accounted differently from the CLI on identical
 * engine code and an identical prompt.
 *
 * Three properties of the CLI's fold are load-bearing and are reproduced here
 * exactly, because dropping any one of them reintroduces a specific lie:
 *
 *   1. `turns` and `calls` are incremented BEFORE the "did usage come back?"
 *      gate (recordTurn counts first, then tests `tokens != null`). A turn
 *      that reported nothing still happened; a tally that skipped it would
 *      report the session as shorter and cheaper than it was.
 *   2. `tokens`, `input` and `output` accumulate — never reset. A rolling
 *      total that resets per turn is the per-turn count it replaced.
 *   3. A `null` count contributes nothing and is counted in `unknown`, so
 *      `tokens: 0` is only ever read as a real zero. Nothing is ever added as
 *      a fabricated 0 to make the arithmetic look complete.
 *
 * The money split is the CLI's too: a settled charge (the pool's ledger
 * figure) rolls into `cost`, and a locally priced turn rolls into `estimate`.
 * They are kept apart rather than summed so a `~`-estimate can never be read
 * as part of the bill — the distinction `fmtCost` marks on a single turn, held
 * across the session.
 */

/** A session with nothing accounted for yet. */
function emptyRoll() {
  return {
    turns: 0,
    calls: 0,
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    /** Dispatches that reported no usage at all — the honest gap in `tokens`. */
    unknown: 0,
    /**
     * Exchanges folded from TEXT rather than reported usage, on the CLI's
     * `real: false` rule. They are counted in `tokens` — that is the point —
     * and named here so an estimated figure is never read as a measured one.
     */
    estimated: 0,
    /** Settled charges (server-settled `costUsd`), rolled. */
    cost: 0,
    /** Locally priced turns, rolled. Never mixed into `cost`. */
    estimate: 0,
  };
}

/**
 * Fold one completed dispatch into a session's rolling tallies. Pure: it
 * returns a NEW roll and never mutates the one it was handed, so a half-applied
 * fold cannot exist.
 *
 * @param {object} [roll]      the roll so far (emptyRoll() when omitted)
 * @param {object} [usage]     the response's `usage` object
 * @param {{model?: string, costUsd?: number, calls?: number, turns?: number,
 *          prompt?: string, reply?: string, estimated?: boolean}} [opts]
 *        `calls` defaults to 1; a pooled turn may report how many provider
 *        calls it actually made. `turns: 0` folds a dispatch that is not a
 *        turn of its own — the discovery-lane card, which bills like any other
 *        call but is not something the user asked for. `prompt`/`reply` are the
 *        turn's text, used ONLY when the wire reported no usage, so the turn is
 *        estimated rather than dropped (the CLI's `appendHistory` rule).
 * @returns {object} the new roll
 */
function rollTurn(roll, usage, opts = {}) {
  const next = Object.assign(emptyRoll(), roll || {});
  next.turns += opts.turns === undefined ? 1 : Number(opts.turns) || 0;
  next.calls += opts.calls === undefined ? 1 : Number(opts.calls) || 0;
  const turn = turnAccounting(usage, opts.model, { costUsd: opts.costUsd });
  // A row folded from text rather than from the wire: either this turn's own
  // fallback below, or a stored ledger row carrying `real: false` — the shape
  // the CLI's `appendHistory` writes for an exchange the provider did not
  // report on.
  const estimated = opts.estimated === true || (usage && usage.real === false);
  if (turn.tokens == null) {
    // No reported usage. The CLI does not let such a turn vanish from the
    // total: `appendHistory` estimates it from the text and marks it
    // `real: false` (aegiscodex-dev/src/history.js), and
    // `aggregateSessionUsage` then adds it like any other row. Folding the same
    // estimate here is what makes the live roll and the rebuilt roll the same
    // number, and what stops the total standing still on exactly the turns the
    // pool declined to report on — the symptom this fallback exists to remove.
    const est = estimatedBuckets(opts.prompt, opts.reply, opts.reasoning);
    if (!est) {
      // Nothing reported AND no text to estimate from. The single case that
      // stays uncounted: `unknown` names the gap, where a fabricated zero would
      // read as a measurement.
      next.unknown += 1;
      return next;
    }
    next.tokens += est.input + est.output;
    next.input += est.input;
    next.output += est.output;
    next.estimated += 1;
    return next;
  }
  const b = usageBuckets(usage);
  next.tokens += turn.tokens;
  next.input += b.input;
  next.output += b.output;
  next.cacheRead += b.cacheRead;
  next.cacheWrite += b.cacheWrite;
  if (estimated) {
    // Money stays out of an estimated exchange, deliberately and in both
    // directions: the CLI writes no `costUsd` for one, so pricing it here would
    // make the live roll drift from the rebuilt one — and pricing tokens that
    // were themselves guessed would stack one guess on another.
    next.estimated += 1;
    return next;
  }
  if (turn.real) next.cost += turn.cost;
  else if (turn.cost != null) next.estimate += turn.cost;
  return next;
}

/**
 * Rebuild a session's rolling total from stored exchanges — the desktop's
 * counterpart of the CLI's `aggregateSessionUsage`, which sums history.jsonl so
 * a resumed session (and a compacted one) still reports everything it spent.
 *
 * Reads the shapes the shared store writes: an assistant message carrying
 * `tokens: {input, output, cacheRead, cacheWrite}` and, when the pool settled
 * the turn, `costUsd` (cli/src/history.js → session-store.recordExchange).
 * Messages the desktop itself appended carry no `tokens` and fold as `unknown`
 * — a resumed thread states what is known and does not invent the rest.
 *
 * @param {Array<{role?: string, tokens?: object, costUsd?: number, model?: string}>} [messages]
 * @returns {object} the roll
 */
function rollMessages(messages) {
  let roll = emptyRoll();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== 'assistant') continue;
    roll = rollTurn(roll, m.tokens, {
      model: m.model,
      costUsd: typeof m.costUsd === 'number' ? m.costUsd : undefined,
      calls: m.calls,
    });
  }
  return roll;
}

/**
 * The ledger row one finished dispatch must carry into the shared session
 * store, so the rolling total can be REBUILT when the thread is reopened —
 * the desktop's counterpart of the CLI's `appendHistory`
 * (aegiscodex-dev/src/history.js:36).
 *
 * One authority for the row, on purpose. The CLI writes a `tokens` object for
 * EVERY exchange and skips none:
 *
 *   tokens: usage
 *     ? { input, output, cacheRead, cacheWrite, real: true }
 *     : { input: estimateTokens(prompt), output: estimateTokens(reply), real: false }
 *
 * …and `aggregateSessionUsage` then sums `t.input || 0` over every entry with
 * `real` as a FLAG, not a gate. Mirroring that shape here is what makes the
 * live roll and the rebuilt roll the same number: `rollTurn` is handed this
 * exact object on reopen, so an estimated exchange adds the same buckets it
 * added live and is counted under `estimated` in both.
 *
 * Returns `null` when there is neither reported usage nor text to estimate
 * from — the one case that must stay unrecorded, because a fabricated
 * `{input: 0, output: 0}` row would read as a measured zero forever after.
 *
 * @param {object} [usage]  the response's `usage` object
 * @param {object} [turn]   its accounting (turnAccounting), when already done
 * @param {{model?: string, costUsd?: number, calls?: number, prompt?: string,
 *          reply?: string}} [opts]
 * @returns {object|null} the row's ledger fields
 */
function ledgerRow(usage, turn, opts = {}) {
  const t = turn || turnAccounting(usage, opts.model, { costUsd: opts.costUsd });
  const calls = Number.isFinite(opts.calls) && opts.calls > 0 ? opts.calls : undefined;
  if (t.tokens != null) {
    const row = { tokens: usageBuckets(usage) };
    // Only a SETTLED charge is persisted. The CLI writes `costUsd` for a real
    // charge only, and the rebuild prices an unpriced row from the same rate
    // table this window used — persisting a local guess would let a stale
    // table outlive the change that wrote it.
    if (t.real && t.cost != null) row.costUsd = t.cost;
    if (calls !== undefined) row.calls = calls;
    return row;
  }
  // `reasoning` is part of the billed output, so it is estimated with the
  // reply — a stored row for a thinking-heavy turn must not persist a count
  // that excludes the longest thing the model wrote.
  const est = estimatedBuckets(opts.prompt, opts.reply, opts.reasoning);
  if (!est) return null;
  const row = { tokens: est };
  if (calls !== undefined) row.calls = calls;
  return row;
}

/**
 * The CLI's rendering of a session tally — `cli/src/format.js fmtTokens`, which
 * is the one `tokenSummary` actually imports (`cli/src/app.js:50`). NOT the
 * `1.5k`/`12.3k` form in `cli/src/tokens.js`: that one belongs to the /cost
 * panels, and using it here would print `12.4k` on the very total the CLI
 * prints as `12,400` — a rendering difference stacked on top of the accounting
 * difference this change exists to remove.
 *
 * Comma-grouped integer. Anything not finite and positive renders `0`, which is
 * the CLI's rule and keeps a stray NaN from reaching the topbar.
 */
function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The rolling session total as one line — the desktop's counterpart of the
 * CLI's `tokenSummary`. Empty string when nothing has been accounted for, so
 * an untouched session adds no noise to a turn's meta line.
 *
 * @param {object} [roll]
 * @returns {string} e.g. `12,400 tok · 4 calls · $0.0310` — the CLI's fields in
 *   the CLI's order, minus the input/output parenthetical (see below).
 */
function fmtRoll(roll) {
  const r = roll || emptyRoll();
  if (!r.turns && !r.calls) return '';
  // The fields are `tokenSummary`'s (cli/src/app.js:1413) in its order — tokens,
  // calls, money — with one dropped: the `(10,100 in / 2,300 out)` split. `in`
  // and `out` are a terminal status-line shorthand, legible to someone already
  // reading that status line and to nobody else, which is what an unlabelled
  // abbreviation in a GUI topbar turns into. The total is the figure a reader
  // wants; `r.input`/`r.output` are still folded onto the roll (see `rollTurn`)
  // for any surface that wants to show the split with real labels. The call
  // count stays unconditional, because it is the number that reveals a
  // fan-out, and it is not hidden at 1.
  const bits = [];
  // The token half only when something was actually counted. `rollTurn` counts
  // turns and calls BEFORE it looks at the token count, so a dispatch that
  // reported nothing still reaches here — and printing its empty tally would
  // put `0 tok` on the topbar, a figure the meter never took, which reads as a
  // counter that does not move. The turn count is still stated, because that
  // much is true.
  if (r.tokens > 0) {
    bits.push(`${fmtTokens(r.tokens)} tok`);
  }
  bits.push(`${r.calls} call${r.calls === 1 ? '' : 's'}`);
  // Money is where this line departs from `tokenSummary`, deliberately: that
  // one sums a single `session.cost` in EUR via fmtEur, while this surface keeps
  // a settled charge and a local estimate apart so a `~`-estimate can never be
  // read as part of the bill. Desktop's pre-existing fmtCost renders both, and
  // its `$` convention is left exactly as it was.
  if (r.cost > 0 || r.estimate > 0) {
    const money = [];
    if (r.cost > 0) money.push(fmtCost(r.cost, true));
    if (r.estimate > 0) money.push(fmtCost(r.estimate, false));
    bits.push(money.join(' + '));
  }
  // No counterpart in `tokenSummary`, which folds a usage-less turn silently and
  // so reports a total short of the truth without saying so. Named here instead:
  // the count appears only when something went unreported, and it never changes
  // a number — it only says the number is not the whole story.
  if (r.unknown) bits.push(`${r.unknown} unrpt`);
  // The other half of the same honesty: a total that includes estimated
  // exchanges says so, because the CLI marks the same rows `real: false` and a
  // reader is entitled to know which figure they are looking at. It changes no
  // number — it says the number is partly inferred.
  if (r.estimated) bits.push(`${r.estimated} est`);
  return bits.join(' · ');
}

/**
 * A cost for display. Estimates are marked with `~` so an estimate is never
 * mistaken for a settled charge.
 *
 * @param {number} cost
 * @param {boolean} [real]
 * @returns {string}
 */
function fmtCost(cost, real) {
  if (typeof cost !== 'number' || !isFinite(cost)) return '';
  return `${real ? '' : '~'}$${cost.toFixed(4)}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RATES,
    RATE_BASIS,
    UNPRICED_BY_DESIGN,
    isPeak,
    usageTokens,
    ratesFor,
    usageBuckets,
    usageCost,
    costBreakdown,
    turnAccounting,
    estimateTokens,
    estimatedBuckets,
    emptyRoll,
    rollTurn,
    rollMessages,
    ledgerRow,
    fmtTokens,
    fmtRoll,
    fmtCost,
  };
}
