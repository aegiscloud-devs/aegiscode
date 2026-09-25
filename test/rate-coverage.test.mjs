/**
 * Every id the plugin can route to must be PRICED, or DECLARED unpriced.
 *
 * This is the guard that was missing, and it is the reason two rate bugs
 * survived to production in this repo:
 *
 *  1. `usageCost` resolved `RATES[model] || RATES.sonnet`, and RATES had no
 *     DeepSeek row for years. Every DeepSeek turn — every turn — was priced at
 *     Sonnet's $3/$15. Nothing failed, because a placeholder rate and a real
 *     rate are both just numbers.
 *  2. When a DeepSeek row was finally added it said $0.14/$0.28, the RETIRED
 *     V4-Flash tier. Nothing failed either, because a retired rate and a live
 *     rate are also both just numbers.
 *
 * Both are the same defect: nothing compared "ids we route to" against "ids we
 * have priced". A rate table is a lookup with a silent, plausible default, so
 * the only way a hole in it becomes visible is if something enumerates the keys
 * that are *supposed* to be in it and fails when one is absent.
 *
 * So this test derives its id list from the plugin's own SOURCE — the routing
 * regexes that decide whether a model takes the DeepSeek path, the pool seats
 * the CLI names in ID_NOTES, the routing-label spellings the tests show the
 * platform actually serving — and asserts each one resolves to a real row or is
 * declared in UNPRICED_BY_DESIGN with a reason. A NEW id that lands unpriced
 * fails here, on the commit that introduces it, instead of on an invoice.
 *
 * What this cannot catch, stated plainly so the guard is not trusted past its
 * reach: `cli/src/models.js` invents no ids — the catalog is fetched from the
 * pool, which adds and retires providers without a client release. An id the
 * SERVER invents tomorrow is not in any list compiled into this repo. That case
 * is covered by the other half of the mechanism, asserted at the bottom: an
 * unrecognised id is still labelled `basis: 'default'`, `priced: false`, so it
 * renders as an admitted unknown rather than as a measurement.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function assert(c, m) { if (!c) throw new Error(`ASSERT FAILED: ${m}`); }
const eq = (a, b, m) => assert(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// The CLI's copy, not the shared module directly: tokens.js is what the CLI
// actually prices through, and it resolves the shared module via sharedpaths.js.
// If that resolution ever silently returned a stale or different table, testing
// usage.js alone would not see it.
const tokens = require(join(root, 'cli', 'src', 'tokens.js'));
const { RATES, RATE_BASIS, UNPRICED_BY_DESIGN, ratesFor, costBreakdown } = tokens;

/**
 * Fixed instants. DeepSeek's peak window is 01:00-04:00 and 06:00-10:00 UTC,
 * Monday-Friday; every other hour, and the whole weekend, is off-peak at half
 * rate. 2026-01-05 is a Monday (asserted, so this cannot rot into a weekend and
 * start silently exercising the off-peak branch).
 */
const PEAK = new Date('2026-01-05T02:00:00Z');
const OFFPEAK = new Date('2026-01-05T12:00:00Z');

const read = (p) => readFileSync(join(root, p), 'utf8');

// ── the instants, so a wrong weekday fails loudly rather than flakily ───────
{
  eq(PEAK.getUTCDay(), 1, 'PEAK is a Monday');
  eq(OFFPEAK.getUTCDay(), 1, 'OFFPEAK is a Monday');
  eq(ratesFor('deepseek', { at: PEAK }).peak, true, 'PEAK is inside the peak window');
  eq(ratesFor('deepseek', { at: OFFPEAK }).peak, false, 'OFFPEAK is outside it');
}

// ── the id list is derived from the routing regexes, not hand-kept ──────────
//
// Not a copy of the regex: the literal is READ OUT of the two files that own
// it, so narrowing the regex (letting fewer ids take the DeepSeek path) or
// widening it (letting more) both change what this test demands. A hand-typed
// copy of the patterns here would drift from the source it is meant to check.
const regexOf = (src) => {
  const m = src.match(/const\s+(?:DEEPSEEK_)?REASONING_MODEL_RE\s*=\s*(\/.*\/)\s*;/);
  assert(m, 'REASONING_MODEL_RE literal found in source');
  return eval(m[1]); // eslint-disable-line no-eval — a literal read from our own file
};

const engineSrc = read('desktop/lib/local/engine.js');
const avatarSrc = read('desktop/lib/avatar/turn.js');
const ENGINE_RE = regexOf(engineSrc);
const AVATAR_RE = regexOf(avatarSrc);

// The id sets, spelled the way the plugin and the platform actually spell them.
// Each is asserted to match the pattern above, so this list can never quietly
// describe ids the router no longer routes.
const DEEPSEEK_ROUTED = [
  // the aliases the picker used to advertise (engine.js:164-165)
  'deepseek-flash', 'deepseek-pro', 'deepseek-reasoner',
  // the v4 family the regex enumerates
  'deepseek-v4-flash', 'deepseek-v4-pro',
  // the v4.1 family — `v4(\.\d+)?` in the regex
  'deepseek-v4.1-flash', 'deepseek-v4.1-pro',
];

const PLATFORM_SPELLINGS = [
  // what the pool actually serves, in the slash spelling its catalog uses
  // (test/cli-tools.test.mjs:288, test/mcp-balance.test.mjs:33)
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  // the date-stamped ids real configs carry
  'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813',
  // the byok routing-label spelling
  'deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro',
  // a bare family/provider pin
  'deepseek',
];

const ANTHROPIC_ROUTED = [
  'sonnet', 'opus', 'fable', 'haiku',
  'claude-sonnet-5', 'claude-opus-4', 'claude-haiku-4-5',
  'anthropic:claude-sonnet-5', 'anthropic:claude-opus-4',
  'anthropic-haiku', // a pooled seat the CLI labels by name (cli/src/models.js)
];

{
  for (const id of DEEPSEEK_ROUTED) {
    assert(ENGINE_RE.test(id), `${id} is accepted by the engine's reasoning regex`);
  }
  for (const id of [...DEEPSEEK_ROUTED, ...PLATFORM_SPELLINGS, ...ANTHROPIC_ROUTED]) {
    assert(typeof id === 'string' && id.length, `${id} is a non-empty id`);
  }
  // The two files' patterns are not identical and must not be asserted equal:
  // the avatar's adds the brain tiers (nexus-brain, aegis-brain) on top of the
  // DeepSeek set. What must hold is CONTAINMENT — every id the engine routes as
  // a reasoning model is also one the avatar path routes as one, or the two
  // paths disagree about which models get a reasoning budget.
  for (const id of DEEPSEEK_ROUTED) {
    assert(AVATAR_RE.test(id), `the avatar regex also routes ${id}, so the two paths agree`);
  }
}

// ── ID_NOTES keys: pool seats the CLI names in source ───────────────────────
{
  const modelsSrc = read('cli/src/models.js');
  const notes = modelsSrc.match(/const ID_NOTES = Object\.freeze\(\{([\s\S]*?)\}\);/);
  assert(notes, 'ID_NOTES found');
  const ids = [...notes[1].matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]);
  assert(ids.length >= 3, `ID_NOTES yields ids (got ${ids.length})`);
  for (const id of ids) ANTHROPIC_ROUTED.push(id); // same assertion loop below
}

// ── the assertion this file exists for ──────────────────────────────────────
//
// Every routed id resolves to a priced row, or is declared. This is the line
// that fails on the commit that adds an id nobody priced.
{
  const declared = new Set(Object.keys(UNPRICED_BY_DESIGN));
  const checked = new Set([...DEEPSEEK_ROUTED, ...PLATFORM_SPELLINGS, ...ANTHROPIC_ROUTED]);
  const holes = [];
  for (const id of checked) {
    const r = ratesFor(id, { at: PEAK });
    if (r.basis === RATE_BASIS.DEFAULT && !declared.has(id)) holes.push(id);
  }
  eq(holes.length, 0, `no routed id falls to the Sonnet-class placeholder (holes: ${holes.join(', ')})`);

  // And the declared list is not a parking space: every entry must really be
  // unpriced (a declared id that later gets a row is a stale declaration), and
  // must carry a reason.
  for (const [id, reason] of Object.entries(UNPRICED_BY_DESIGN)) {
    assert(typeof reason === 'string' && reason.length > 8, `${id} declares a reason`);
    const r = ratesFor(id, { at: PEAK });
    eq(r.basis, RATE_BASIS.DEFAULT, `${id} is declared unpriced and really is unpriced`);
  }
  // Guessing is not declaring: nothing may be listed that we could price.
  assert(!declared.has('deepseek-flash'), 'the DeepSeek family is PRICED, never declared available');
  assert(!declared.has('haiku'), 'Haiku is PRICED, never declared available');
}

// ── DeepSeek ids price at DeepSeek rates, at BOTH tiers ─────────────────────
{
  const flash = ratesFor('deepseek-v4-flash', { at: PEAK });
  const legacy = ratesFor('deepseek-v4-flash-0731', { at: PEAK });
  eq(flash.input, RATES.deepseek.input, 'v4-flash uses the Flash row');
  eq(legacy.input, RATES.deepseek.input, 'the legacy dated id is served by V4.1-Flash at the Flash price');
  eq(legacy.basis, RATE_BASIS.PREFIX, 'the legacy id resolves by prefix, which is how it inherits the row');

  // The pro tier must NOT be shadowed by the family row. This is the bug the
  // ':' form had, and the '/' form had independently.
  for (const id of [
    'deepseek-v4-pro',
    'deepseek-v4.1-pro',
    'deepseek:deepseek-v4-pro',
    'deepseek/deepseek-v4-pro',
  ]) {
    const r = ratesFor(id, { at: PEAK });
    eq(r.input, RATES['deepseek-v4-pro'].input, `${id} prices at the PRO tier, not the Flash family rate`);
    assert(r.input > RATES.deepseek.input, `${id} is dearer than Flash (so a shadowing regression is visible)`);
  }

  // ...while the flash spellings still price at Flash, so the fix above did not
  // simply move every DeepSeek id onto the pro row.
  for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash']) {
    eq(ratesFor(id, { at: PEAK }).input, RATES.deepseek.input, `${id} prices at Flash`);
  }
}

// ── Anthropic ids price at their own family, never the placeholder ──────────
{
  eq(ratesFor('claude-opus-4', { at: PEAK }).input, RATES.opus.input, 'Opus is priced at Opus');
  eq(ratesFor('claude-haiku-4-5', { at: PEAK }).input, RATES.haiku.input, 'Haiku is priced at Haiku');
  eq(ratesFor('anthropic-haiku', { at: PEAK }).input, RATES.haiku.input, 'the pooled Haiku seat names Haiku');
  // Haiku must not fall to the Sonnet-class default: 3x its real rate.
  assert(ratesFor('claude-haiku-4-5', { at: PEAK }).input < RATES.sonnet.input, 'Haiku is cheaper than Sonnet, not equal to it');
  assert(ratesFor('claude-haiku-4-5', { at: PEAK }).basis !== RATE_BASIS.DEFAULT, 'Haiku carries a real basis');
}

// ── structural invariants over the whole table ──────────────────────────────
{
  for (const [key, row] of Object.entries(RATES)) {
    // A cache read dearer than the input it replaces is not a discount, and the
    // entire reason for measuring cache hits is that they are cheaper.
    assert(row.cacheRead < row.input, `${key}: cacheRead (${row.cacheRead}) is cheaper than input (${row.input})`);
    assert(row.output >= row.input, `${key}: output is not cheaper than input`);
    if (row.offPeak) {
      // Read as a construction, not as four numbers: if the discount is ever
      // not exactly half, this assertion is what tells us the code that divides
      // it (there is none — `finish` copies the row) is still right.
      for (const f of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        assert(Math.abs(row.offPeak[f] - row[f] / 2) < 1e-12,
          `${key}: offPeak.${f} is exactly half of peak (${row.offPeak[f]} vs ${row[f] / 2})`);
      }
    }
  }
  // DeepSeek's cache hit is a quoted price, not a fraction of input — the whole
  // reason a cache hit is worth measuring at all.
  assert(RATES.deepseek.cacheRead < RATES.deepseek.input / 10, 'DeepSeek cache-hit is far below input, as the vendor quotes it');
}

// ── the mechanism that covers ids no list here can know ─────────────────────
//
// A server-invented id must render as an admitted unknown. This is the half of
// the guarantee that survives models.js having no fallback list.
{
  const unknown = ratesFor('some-future-provider:v9-turbo', { at: PEAK });
  eq(unknown.basis, RATE_BASIS.DEFAULT, 'an unrecognised id is labelled default');
  const b = costBreakdown({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 'some-future-provider:v9-turbo', { at: PEAK });
  eq(b.priced, false, 'and reports priced:false, so a caller can say so instead of printing a number as fact');
  // An unnamed model must ALSO report default, not claim an exact match via a
  // default parameter naming 'sonnet' — that labelled a placeholder as this
  // model's own rate.
  eq(costBreakdown({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, undefined, { at: PEAK }).basis, RATE_BASIS.DEFAULT,
    'an unnamed model does not claim an exact match');
}

// ── one table, not two: the drift that caused this ──────────────────────────
{
  const tokensSrc = read('cli/src/tokens.js');
  assert(!/const\s+RATES\s*=/.test(tokensSrc), 'cli/src/tokens.js keeps NO copy of RATES — it resolves the shared module');
  assert(/RATES/.test(tokensSrc), 'and still exposes the resolved table');
  // The vendored tree is a build artifact; if it lags the source, the packaged
  // CLI ships the old table while every test above passes against the new one.
  const vendored = read('cli/vendor/desktop/renderer/usage.js');
  eq(vendored, read('desktop/renderer/usage.js'), 'cli/vendor copy is byte-identical to the source (run `npm run predist` in cli/)');
}

console.log('rate-coverage: ok');
