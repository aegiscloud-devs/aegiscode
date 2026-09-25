#!/usr/bin/env node
/**
 * Cache accounting: the providers DISAGREE about what a cached count means,
 * and reading them as one convention silently double-bills.
 *
 *   Anthropic   input_tokens EXCLUDES cache_read_input_tokens   (disjoint)
 *   OpenAI      prompt_tokens INCLUDES prompt_tokens_details.cached_tokens
 *   DeepSeek    prompt_tokens INCLUDES prompt_cache_hit_tokens  (subset)
 *
 * usageBuckets read only the Anthropic spelling, so a DeepSeek turn — which is
 * every plugin turn — recorded `cacheRead: 0` and priced its entire prompt at
 * the miss rate. Nothing caught it because a wrong number here still looks
 * like a number: the meter simply read high, and the surface running the same
 * model looked expensive for reasons that were never in the model.
 *
 * These assertions pin the convention detection, the clamp that keeps a
 * bad hit count from producing negative input, and the cost consequence —
 * that a cached turn is strictly cheaper than an uncached one.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { usageBuckets, usageCost } = require(join(root, 'desktop', 'renderer', 'usage.js'));

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── DeepSeek: the cached count is a SUBSET of prompt_tokens ────────────────
{
  const b = usageBuckets({
    prompt_tokens: 1200,
    completion_tokens: 300,
    total_tokens: 1500,
    prompt_cache_hit_tokens: 1000,
    prompt_cache_miss_tokens: 200,
  });
  eq(b.cacheRead, 1000, 'DeepSeek prompt_cache_hit_tokens becomes cacheRead');
  eq(b.input, 200, 'and is SUBTRACTED from prompt_tokens, not billed twice');
  eq(b.output, 300, 'completion_tokens is the output bucket');
  eq(b.cacheWrite, 0, 'DeepSeek charges no separate cache-write premium');
}

// ── OpenAI: the same convention, nested ────────────────────────────────────
{
  const b = usageBuckets({
    prompt_tokens: 1200,
    completion_tokens: 300,
    prompt_tokens_details: { cached_tokens: 1000 },
  });
  eq(b.cacheRead, 1000, 'OpenAI prompt_tokens_details.cached_tokens is read');
  eq(b.input, 200, 'and subtracted from the prompt it is nested under');
}

// ── a bare cached_tokens, as some gateways emit ────────────────────────────
{
  const b = usageBuckets({ prompt_tokens: 500, completion_tokens: 10, cached_tokens: 400 });
  eq(b.cacheRead, 400, 'bare cached_tokens is a subset spelling too');
  eq(b.input, 100, 'and subtracts');
}

// ── Anthropic: DISJOINT — subtracting here would understate the bill ───────
{
  const b = usageBuckets({
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 250,
  });
  eq(b.cacheRead, 1000, 'Anthropic cache_read_input_tokens is read');
  eq(b.cacheWrite, 250, 'and cache_creation_input_tokens is the write bucket');
  eq(b.input, 1200, 'input_tokens is NOT reduced — the buckets are disjoint');
}

// ── the already-bucketed ledger shape is untouched ─────────────────────────
{
  const b = usageBuckets({ input: 116011, output: 532, cacheRead: 110000, cacheWrite: 0 });
  eq(b.input, 116011, 'a stored bucket row keeps its input verbatim');
  eq(b.cacheRead, 110000, 'and its cacheRead');
}

// ── a hit count larger than its prompt cannot go negative ──────────────────
{
  const b = usageBuckets({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 999 });
  eq(b.cacheRead, 100, 'cacheRead is clamped to the prompt it belongs to');
  eq(b.input, 0, 'input floors at 0 rather than going negative');
}

// ── a stated total still absorbs tokens the split does not name ────────────
{
  const b = usageBuckets({ input_tokens: 100, output_tokens: 50, total_tokens: 400 });
  eq(b.input, 350, 'an unattributed total remainder lands on input, not dropped');
}

// ── the cost consequence, which is the entire point ────────────────────────
{
  const missAll = usageCost({ prompt_tokens: 100_000, completion_tokens: 1000 }, 'deepseek');
  const cached = usageCost(
    { prompt_tokens: 100_000, completion_tokens: 1000, prompt_cache_hit_tokens: 95_000 },
    'deepseek',
  );
  assert(cached < missAll, `a cached turn must cost LESS than an uncached one (${cached} vs ${missAll})`);
  // 5k miss at the input rate + 95k hit at the cache rate + 1k out.
  const want = (5000 / 1e6) * 0.14 + (95_000 / 1e6) * 0.014 + (1000 / 1e6) * 0.28;
  assert(
    Math.abs(cached - want) < 1e-12,
    `cached cost is the miss rate on the miss alone (got ${cached}, want ${want})`,
  );
  // The regression stated as arithmetic: reading the subset as disjoint charged
  // the 95k hits at the input rate AS WELL, which is strictly more expensive.
  const doubleBilled = (100_000 / 1e6) * 0.14 + (95_000 / 1e6) * 0.014 + (1000 / 1e6) * 0.28;
  assert(doubleBilled > cached, 'and double-billing is the more expensive reading');
}

// ── the CLI vendors this exact file, so the two hosts cannot disagree ──────
{
  const vendored = require(join(root, 'cli', 'vendor', 'desktop', 'renderer', 'usage.js'));
  const shape = { prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 8 };
  eq(vendored.usageBuckets(shape).input, usageBuckets(shape).input, 'the vendored copy answers identically');
  eq(vendored.usageBuckets(shape).cacheRead, 8, 'including the cache slice');
}

console.log('cache-buckets: ok');
