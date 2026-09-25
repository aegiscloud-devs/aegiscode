#!/usr/bin/env node
/**
 * The desktop must account for a turn the way the CLI does.
 *
 * The gap this locks down: `usageTokens` printed a token count and nothing
 * else, so the desktop could not be compared to `aegiscodex` on the same
 * engine and the same prompt — the very comparison that motivated the work.
 * The CLI's rule (cli/src/tokens.js) has three parts and this asserts all
 * three, because dropping any one of them reintroduces a specific, previously
 * observed lie:
 *
 *   1. A pooled turn's charge is settled SERVER-side, with a margin and a
 *      prompt-cache discount the client cannot see. A stated `costUsd` must win
 *      verbatim and be labeled real — not re-priced locally.
 *   2. Without a settled charge, the rate table's figure is an ESTIMATE and
 *      must be marked as one, so a guess is never read as a bill.
 *   3. The rate table resolves by exact id, then longest prefix, and it must
 *      contain the DeepSeek row. Without it every direct DeepSeek turn fell
 *      through to Sonnet's $3.00/$15.00 per M against a real $0.30/$1.20 —
 *      which made the *meter* the largest single contributor to the apparent
 *      cost gap between two surfaces running identical code.
 *
 *      The figure this section used to pin, $0.14/$0.28, was wrong too, and
 *      wrong in the same direction as the bug it was written to catch: it is
 *      DeepSeek's RETIRED V4-Flash tier, which their pricing page retires in a
 *      footnote (legacy ids are served by V4.1-Flash and billed at Flash
 *      prices). A row copied from a mirror of our own table cannot detect that
 *      the mirror is stale, so these assertions cite the vendor's published
 *      table. The rates are also TIME-DEPENDENT (peak/off-peak), so every
 *      figure below is pinned to an explicit instant — an unpinned rate is a
 *      test that passes in the morning and fails at noon, which is how a suite
 *      teaches people to ignore it.
 *
 * Plus the contract the renderer has always held and that now extends to
 * money: an unknown count is `null`, never a fabricated `0`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const usage = require(join(root, 'desktop', 'renderer', 'usage.js'));
const { usageTokens, ratesFor, usageCost, turnAccounting, fmtCost } = usage;

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures += 1;
    console.error(`ASSERT FAILED: ${msg}`);
  }
}
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const close = (a, b, m) => assert(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`);

// DeepSeek's peak window is 01:00-04:00 and 06:00-10:00 UTC Monday-Friday;
// everything else, weekends included, is off-peak at half rate. Every rate
// figure below is pinned to this instant so the suite cannot be time-flaky.
// 2026-01-05 is a Monday, asserted below so it cannot rot into a weekend.
const PEAK = new Date('2026-01-05T02:00:00Z');

// ── 1. the settled charge wins, verbatim ────────────────────────────────────
{
  const t = turnAccounting({ input_tokens: 116011, output_tokens: 532 }, 'nexus-brain', {
    costUsd: 0.0047,
  });
  eq(t.cost, 0.0047, 'the server-settled charge is reported as-is');
  eq(t.real, true, 'a settled charge is marked real');
  eq(t.estimated, false, 'a settled charge is not an estimate');
  eq(t.tokens, 116543, 'tokens still come from the wire usage');

  // A zero-cost settled turn is a real zero — the pool decided it was free
  // (cached, or a plan quota), and inventing a local price over that would be
  // the same class of error as the Sonnet fallthrough below.
  const free = turnAccounting({ input_tokens: 10, output_tokens: 10 }, 'sonnet', { costUsd: 0 });
  eq(free.cost, 0, 'a settled zero is real and stays zero');
  eq(free.real, true, 'a settled zero is still real');

  // The CLI folds the settled charge into the usage object before accounting
  // (aegiscodex-dev/src/main.js: `{ ...result.usage, costUsd: result.costUsd }`),
  // so the same figure must be found there too. The desktop's response shape
  // has not settled on one of the two yet.
  const folded = turnAccounting({ input_tokens: 5, output_tokens: 5, costUsd: 0.002 }, 'sonnet');
  eq(folded.cost, 0.002, 'a costUsd folded into usage is the settled charge');
  eq(folded.real, true, 'a costUsd folded into usage is real');
}

// ── 2. without a settled charge the table's figure is an ESTIMATE ───────────
{
  const t = turnAccounting({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'sonnet');
  eq(t.real, false, 'a table-priced turn is not real');
  eq(t.estimated, true, 'a table-priced turn is marked an estimate');
  close(t.cost, 18, 'Sonnet: $3/M in + $15/M out on 1M + 1M');
  eq(fmtCost(t.cost, t.real), '~$18.0000', 'an estimate is displayed with a ~ marker');
  eq(fmtCost(0.0047, true), '$0.0047', 'a settled charge is displayed without one');
}

// ── 3. the DeepSeek row — the meter bug ─────────────────────────────────────
{
  eq(PEAK.getUTCDay(), 1, 'the pinned instant is a Monday, so it is inside the peak window');
  // The vendor's published peak figures (api-docs.deepseek.com/quick_start/pricing).
  close(ratesFor('deepseek', { at: PEAK }).input, 0.30, 'DeepSeek input rate is the provider\'s $0.30/M at peak');
  close(ratesFor('deepseek-v4-flash-0731', { at: PEAK }).output, 1.20, 'a dated DeepSeek id resolves by prefix');
  close(usageCost({ input: 1_000_000, output: 1_000_000 }, 'deepseek', { at: PEAK }), 1.50,
    'DeepSeek: $0.30/M + $1.20/M, not Sonnet\'s $18');
  const sonnet = usageCost({ input: 1_000_000, output: 1_000_000 }, 'sonnet', { at: PEAK });
  const deepseek = usageCost({ input: 1_000_000, output: 1_000_000 }, 'deepseek', { at: PEAK });
  const ratio = sonnet / deepseek;
  assert(ratio > 10,
    `pricing DeepSeek at Sonnet rates overstates a turn ${ratio.toFixed(1)}x — the Sonnet fall-through is back`);
  // Off-peak is half, and it is the table that states it rather than the call
  // site dividing it out.
  close(usageCost({ input: 1_000_000, output: 1_000_000 }, 'deepseek', {
    at: new Date('2026-01-05T12:00:00Z'),
  }), 0.75, 'and off-peak is half price');

  // Exact id beats prefix, longest prefix beats shorter, alias beats default.
  close(ratesFor('opus').input, 5, 'the exact id wins');
  close(ratesFor('sonnet-4-5-20250929').input, 3, 'a dated Anthropic id resolves by prefix');
  // A longer prefix (or a routing label) must not be shadowed by the family
  // row: `deepseek-v4-pro` is a pricier model than the flash family.
  close(ratesFor('deepseek-v4-pro', { at: PEAK }).input, 1.32, 'a longer prefix beats the family row');
  close(ratesFor('').input, 3, 'no model named falls to the default row');
  close(ratesFor('who-knows').input, 3, 'an unplaceable model falls to the default row');
  // …and falling to the default row must be LABELED, because a placeholder
  // figure that renders exactly like a measurement is the bug this whole
  // section exists to prevent.
  eq(ratesFor('who-knows').basis, 'default', 'an unplaceable model reports the default basis');
  eq(ratesFor('deepseek-v4-flash-0731', { at: PEAK }).basis, 'prefix', 'a dated id reports its prefix basis');

  // Only a NAMED model is priced from the table; an unnamed one is unknown.
  const named = turnAccounting({ input_tokens: 1000, output_tokens: 100 }, 'deepseek', { at: PEAK });
  eq(named.real, false, 'a named, unpriced turn is still an estimate');
  eq(named.estimated, true, 'a named, unpriced turn is marked an estimate');
  eq(named.priced, true, 'a placed model is priced from its own row');
  const unplaced = turnAccounting({ input_tokens: 1000, output_tokens: 100 }, 'who-knows');
  eq(unplaced.priced, false, 'an unplaced model is flagged as not really priced');
}

// ── an unknown count is null, never a fabricated figure ─────────────────────
{
  for (const empty of [null, undefined, {}, 0, 'nope', [], NaN]) {
    eq(usageTokens(empty), null, `unknown usage ${JSON.stringify(empty)} is null`);
    const t = turnAccounting(empty, 'sonnet');
    eq(t.tokens, null, `unknown usage ${JSON.stringify(empty)} has no token count`);
    eq(t.cost, null, `unknown usage ${JSON.stringify(empty)} has no cost — never $0.0000`);
    eq(t.real, false, `unknown usage ${JSON.stringify(empty)} is not real`);
  }
  eq(fmtCost(null, false), '', 'a null cost renders as nothing, not as $0.0000');
  eq(fmtCost(NaN, true), '', 'a NaN cost renders as nothing');
  eq(turnAccounting({ total_tokens: 0 }, 'sonnet').tokens, 0, 'an explicit zero total is a reported zero');
}

// ── the buckets, both wire spellings ────────────────────────────────────────
{
  const oa = usage.usageBuckets({ prompt_tokens: 1000, completion_tokens: 200 });
  eq(oa.input, 1000, 'OpenAI prompt_tokens is the input bucket');
  eq(oa.output, 200, 'OpenAI completion_tokens is the output bucket');
  const an = usage.usageBuckets({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 });
  eq(an.input, 1000, 'Anthropic input_tokens is the input bucket');
  eq(an.cacheRead, 50, 'a cache read is its own bucket at its own rate');
  // A total larger than the named split must not vanish: the remainder is real
  // billed input the provider counted but the split does not name.
  const gapped = usage.usageBuckets({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1500 });
  eq(gapped.input + gapped.output, 1500, 'a stated total is fully accounted, not truncated to the split');
  const t = turnAccounting({ input_tokens: 0, output_tokens: 0, total_tokens: 500 }, 'sonnet');
  eq(t.cost != null && t.cost > 0, true, 'a turn with a total but zero halves is still priced, not written off as free');
}

// ── the renderer must actually use the meter ────────────────────────────────
// A meter that exists but is never called is the exact state this change came
// from: the CLI-side accounting was there, the desktop's was not wired.
{
  const APP = readFileSync(join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
  const HTML = readFileSync(join(root, 'desktop', 'renderer', 'index.html'), 'utf8');
  assert(HTML.includes('src="usage.js"'),
    'index.html loads usage.js before app.js');
  const callSites = APP.split('turnAccounting(').length - 1;
  assert(callSites >= 2,
    `both the turn and the discovery-lane card must be accounted (found ${callSites} call sites)`);
  assert(APP.includes('fmtCost(turn.cost, turn.real)'),
    'the settled/estimated distinction must reach the rendered line, not be dropped in the renderer');
  assert(APP.includes('fmtCost(flow.cost, flow.real)'),
    'a lane card is a dispatch and must show what it cost too');
  // The lane card must be priced on its OWN model. `spec.model` is the model
  // the card was dispatched with; the parent turn's `model` is a different
  // model whenever the user has switched, and pricing on it would attribute
  // the charge to the wrong rate row.
  assert(APP.includes('turnAccounting(data && data.usage, spec.model'),
    'the lane card must be priced on spec.model, not the parent turn\'s model');
}

if (failures) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('turn-accounting tests passed');
