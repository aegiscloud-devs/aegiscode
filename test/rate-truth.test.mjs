/**
 * The local rate table must price a model at ITS provider's rate — and must
 * say so when it can't.
 *
 * Two defects lived here, and they were the same defect twice.
 *
 * FIRST: usageCost resolved `RATES[model] || RATES.sonnet`, and RATES had no
 * DeepSeek row — so every direct DeepSeek turn was priced at Sonnet's
 * $3.00/$15.00 per M against the provider's real rate. That is the number that
 * made a local turn look like it cost a fraction of Aegis Cloud's: most of the
 * reported gap was the meter, not the margin.
 *
 * SECOND, and quieter: the row that was eventually added said $0.14/$0.28,
 * sourced from aegis1's catalog.py (cost_per_1k_input=0.00014) and a mirror of
 * our own table rather than the vendor's. That is the RETIRED V4-Flash tier,
 * and DeepSeek's own pricing page retires it in a footnote: "The legacy names
 * deepseek-v4-flash and deepseek-v4-flash-vision-exp are still accepted, but
 * the corresponding models have been retired, their requests are served by the
 * DeepSeek-V4.1-Flash model and billed at the Flash price." Every legacy id —
 * which is what the picker advertises and what a user pins — bills at the V4.1
 * figures this test pins.
 *
 * A rate read from a mirror of our own table cannot detect that the mirror is
 * wrong, which is why these figures are asserted against the vendor's published
 * table (api-docs.deepseek.com/quick_start/pricing) and not against
 * catalog.py. The two disagreed, and the vendor is the one that bills.
 *
 * The figures are also TIME-DEPENDENT (peak/off-peak), so every assertion here
 * passes an explicit `at`. An unpinned rate makes a test that passes at 09:00
 * UTC fail at 12:00 UTC, which is how a suite teaches people to ignore it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const close = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`);

const tokens = require(join(root, 'cli', 'src', 'tokens.js'));
const { usageCost, ratesFor, RATES, RATE_BASIS, isPeak, costBreakdown } = tokens;

const M = 1_000_000;

/**
 * Fixed instants. DeepSeek's peak window is 01:00-04:00 and 06:00-10:00 UTC,
 * Monday-Friday; everything else, weekends included, is off-peak at half rate.
 * 2026-01-05 is a Monday (asserted below, so this cannot rot into a weekend).
 */
const PEAK = new Date('2026-01-05T02:00:00Z');
const OFFPEAK = new Date('2026-01-05T12:00:00Z');
const WEEKEND = new Date('2026-01-03T02:00:00Z');

// ── the instants themselves, so a wrong weekday is a loud failure ──────────
{
  eq(PEAK.getUTCDay(), 1, 'PEAK is a Monday');
  eq(OFFPEAK.getUTCDay(), 1, 'OFFPEAK is a Monday');
  eq(WEEKEND.getUTCDay(), 6, 'WEEKEND is a Saturday');
  eq(isPeak('deepseek', PEAK), true, 'the pinned peak instant is peak');
  eq(isPeak('deepseek', OFFPEAK), false, 'the pinned midday instant is off-peak');
  eq(isPeak('deepseek', WEEKEND), false, 'the weekend is always off-peak');
  // The window is half-open: 04:00 and 10:00 are the first off-peak hour, not
  // the last peak one. Off-by-one here would misprice two hours a day.
  eq(isPeak('deepseek', new Date('2026-01-05T03:59:59Z')), true, '03:59:59 is peak');
  eq(isPeak('deepseek', new Date('2026-01-05T04:00:00Z')), false, '04:00:00 is off-peak');
  eq(isPeak('deepseek', new Date('2026-01-05T05:59:59Z')), false, '05:59:59 is off-peak');
  eq(isPeak('deepseek', new Date('2026-01-05T06:00:00Z')), true, '06:00:00 is peak');
  eq(isPeak('deepseek', new Date('2026-01-05T10:00:00Z')), false, '10:00:00 is off-peak');
  // A non-DeepSeek provider has no peak window to be inside of.
  eq(isPeak('anthropic', PEAK), true, 'only DeepSeek has a peak window');
  eq(isPeak('anthropic', WEEKEND), true, 'and a weekend does not discount it');
}

// ── the provider family row, at the VENDOR's rates ─────────────────────────
{
  // Peak: $0.30/M in, $1.20/M out. Both ~2.1x the retired row this replaced.
  close(RATES.deepseek.input, 0.30, 'DeepSeek input is the published peak per-M rate');
  close(RATES.deepseek.output, 1.20, 'DeepSeek output is the published peak per-M rate');
  // Off-peak is half, and it is stated in the table rather than divided out at
  // the call site, so a future discount that is NOT exactly half has a place to
  // live.
  close(RATES.deepseek.offPeak.input, 0.15, 'DeepSeek off-peak input is half');
  close(RATES.deepseek.offPeak.output, 0.60, 'DeepSeek off-peak output is half');
  // cacheRead is the vendor's CACHE HIT price, quoted directly — not 0.1x
  // input (the convention aegis1/pricing.py used, which overstated it 2.3x).
  close(RATES.deepseek.cacheRead, 0.006, 'the cache hit price is the vendor\'s own $0.006/M');
  close(RATES.deepseek.cacheRead, RATES.deepseek.input / 50, 'a hit is 50x cheaper than a miss');
  close(RATES.deepseek.cacheWrite, RATES.deepseek.input, 'a cache write bills as ordinary input');
  // A separate, pricier model — and longest-prefix order must not let the
  // family row shadow it.
  close(RATES['deepseek-v4-pro'].input, 1.32, 'V4-Pro is priced separately');
  close(RATES['deepseek-v4-pro'].output, 3.96, 'V4-Pro output is priced separately');
}

// ── a DATED id resolves to its family, at the right time of day ────────────
{
  // The configured model is an id, never the bare family name — this is the
  // exact string ~/.aegiscodex/config.json holds.
  const id = 'deepseek-v4-flash-0731';
  eq(ratesFor(id, { at: PEAK }).input, 0.30, 'a dated DeepSeek id resolves to the DeepSeek row');
  eq(ratesFor(id, { at: PEAK }).basis, RATE_BASIS.PREFIX, 'and resolves by prefix');
  eq(ratesFor(id, { at: OFFPEAK }).input, 0.15, 'the same id is half price off-peak');

  const oneM = { input: M, output: M, cacheRead: 0, cacheWrite: 0 };
  close(usageCost(oneM, id, { at: PEAK }), 1.50, '1M in + 1M out costs the peak provider figure');
  close(usageCost(oneM, id, { at: OFFPEAK }), 0.75, 'and half that off-peak');
  assert(usageCost(oneM, id, { at: PEAK }) < usageCost(oneM, 'sonnet', { at: PEAK }) / 10,
    'even at peak the overstatement was more than 10x, so the fall-through cannot come back quietly');
}

// ── the resolution order: exact (all candidates), then prefix, then family ─
{
  eq(ratesFor('sonnet').basis, RATE_BASIS.EXACT, 'an exact alias match wins');
  eq(ratesFor('opus').basis, RATE_BASIS.EXACT, 'and so does the Opus alias');
  eq(ratesFor('deepseek-chat', { at: PEAK }).basis, RATE_BASIS.PREFIX, 'a sibling DeepSeek id resolves by prefix');
  eq(ratesFor('deepseek-v4-pro', { at: PEAK }).input, 1.32, 'exact id for the pro variant');

  // THE ORDERING FIX. Matching candidate-by-candidate let the routing label
  // `deepseek` prefix-match the family row before the tail was ever considered,
  // so a pro turn was priced at Flash rates. Exact must be tried across ALL
  // candidates before any prefix.
  eq(ratesFor('deepseek:deepseek-v4-pro', { at: PEAK }).input, 1.32,
    'the routing label must not beat the model it labels');
  eq(ratesFor('deepseek:deepseek-v4-pro', { at: PEAK }).basis, RATE_BASIS.EXACT,
    'and it resolves exactly, by the tail id');
  eq(ratesFor('deepseek:deepseek-v4-flash', { at: PEAK }).input, 0.30, 'the flash tail still prices as flash');

  // An Anthropic BYOK id: the label is not a rate, and the family is spelled
  // inside the id, so neither exact nor prefix can see it.
  eq(ratesFor('anthropic:claude-opus-4').input, 5, 'an Opus BYOK id is not priced at Sonnet rates');
  eq(ratesFor('anthropic:claude-opus-4').basis, RATE_BASIS.FAMILY, 'it resolves by family');
}

// ── an unpriced model is LABELED, not silently repriced ────────────────────
{
  // The whole point of the return shape. This used to be a bare row, so an id
  // nobody had priced rendered a Sonnet-class figure that looked exactly like a
  // measurement. A wrong number that announces itself is a bug report.
  for (const id of ['some-unknown-model', '', undefined, null, 'mistral-large']) {
    const r = ratesFor(id);
    eq(r.basis, RATE_BASIS.DEFAULT, `${JSON.stringify(id)} is reported as unpriced`);
    close(r.input, 3.00, `${JSON.stringify(id)} keeps the conservative Sonnet-class default`);
    const b = costBreakdown({ input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, id);
    eq(b.priced, false, `${JSON.stringify(id)} reports priced: false`);
    close(b.cost, 3.00, 'an unknown model is not silently repriced');
  }
  // A priced model must say it is priced.
  eq(costBreakdown({ input: M, output: 0 }, 'deepseek', { at: PEAK }).priced, true,
    'a priced model reports priced: true');
  eq(costBreakdown({ input: M, output: 0 }, 'deepseek', { at: PEAK }).basis, RATE_BASIS.EXACT,
    'the bare family name is an exact key');
  eq(costBreakdown({ input: M, output: 0 }, 'deepseek-v4-flash-0731', { at: PEAK }).basis, RATE_BASIS.PREFIX,
    'and carries its basis through to the breakdown');
  // An UNNAMED model must not claim an exact match — see the note on
  // costBreakdown: the old `= 'sonnet'` parameter did exactly that.
  eq(costBreakdown({ input: M, output: 0 }).basis, RATE_BASIS.DEFAULT,
    'an unnamed model is default, not a silent exact Sonnet match');
  eq(costBreakdown({ input: M, output: 0 }).priced, false,
    'and is not presented as priced');
}

// ── the cache slice is billed at the DeepSeek cache rate, not Sonnet's ─────
{
  // A resumed long session: nearly all input served from cache.
  const usage = { input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0 };
  const cost = usageCost(usage, 'deepseek-v4-flash', { at: PEAK });
  // The three buckets are additive by this module's convention (cacheRead is a
  // separate slice, not a subset of input — see transcriptUsage and history's
  // aggregateSessionUsage), so the total is ~$0.0361, NOT sub-cent.
  close(cost, (116011 / M) * 0.30 + (532 / M) * 1.20 + (110000 / M) * 0.006,
    'every bucket priced at the DeepSeek peak row');
  assert(Math.abs(cost - 0.0361) < 0.0005,
    `a 116k-token DeepSeek turn costs about 3.6 cents at peak (got ${cost})`);
  // And the fall-through it replaces was not off by a rounding error.
  const atSonnet = usageCost(usage, 'sonnet', { at: PEAK });
  assert(atSonnet / cost > 10,
    `the Sonnet fall-through overstated this turn ${(atSonnet / cost).toFixed(1)}x`);
}

// ── a certified charge is still preferred over any local rate ─────────────
{
  // accountingFromUsage must not let the repaired table override the ledger:
  // a pooled turn's `costUsd` is the real bill, margin and discount included.
  const usage = { input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0 };
  const agg = tokens.accountingFromUsage(usage, 'deepseek-v4-flash', { real: true, costUsd: 0.0047 });
  close(agg.cost, 0.0047, 'the settled charge wins over the local table');
  // And a settled figure must never be presented as a table match — the pool's
  // bill carries a margin and a cache discount this table cannot see.
  eq(agg.costBasis, 'settled', 'a settled charge is labeled settled, not priced');
  eq(agg.costPriced, true, 'a settled charge is real money, so it is priced');

  const est = tokens.accountingFromUsage(usage, 'deepseek-v4-flash', { real: false });
  eq(est.costBasis, RATE_BASIS.PREFIX, 'an unsettled turn reports the table basis');
  const unknown = tokens.accountingFromUsage(usage, 'who-knows', { real: false });
  eq(unknown.costBasis, RATE_BASIS.DEFAULT, 'an unpriced model reports the default basis');
  eq(unknown.costPriced, false, 'and is flagged as not really priced');
}

console.log('rate-truth tests passed');
