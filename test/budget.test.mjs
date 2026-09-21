#!/usr/bin/env node
/**
 * One budget rule, two copies — and the ceiling that is only a label.
 *
 * Half of this file is the old max-tokens ceiling test, kept because
 * `maxTokensCeiling()` still exists: it answers "what does this model say its
 * own output limit is?" and is printed in the Model hint. It sizes nothing.
 *
 * The other half is the rule that replaced the Max tokens dropdown, which asked
 * the user to state an answer's length before the answer existed. Output length
 * cannot be predicted from a prompt, and the guess failed in both directions:
 * aegis1 sizes the pooled class from `effort` itself and reads a body
 * max_tokens as a ceiling *over* its ladder, while a DeepSeek reasoning model
 * bills hidden chain-of-thought against the same budget, so the dropdown's 4k
 * default was spent before the first visible token and the turn came back empty
 * with no error.
 *
 * That rule now lives in two places — desktop/renderer/budget.js (what the
 * renderer sends) and desktop/lib/local/engine.js `reasoningBudget()` (what the
 * main process sends, and the last word) — so the two are compared HERE, case
 * by case and literal by literal. A copy that drifts is exactly how aegis1's
 * ladder came to disagree with this side once before (974adc5).
 *
 * Neither takes a model CLASS any more: with the direct-dial classes gone, the
 * class no longer selects anything, and a parameter that selects nothing is how
 * the next class-dependent rule gets added to one copy and not the other.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const renderer = require('../desktop/renderer/budget.js');
const engine = require('../desktop/lib/local/engine.js');
const {
  budgetFor,
  effortRung,
  maxTokensCeiling,
  FLAT_CEILING,
  EFFORT_TOKEN_BUDGET,
  DEEPSEEK_REASONING_MODEL_RE,
} = renderer;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ── 1. The ceiling is display-only ─────────────────────────────────────────
assert(FLAT_CEILING === 300000, `expected flat ceiling 300000, got ${FLAT_CEILING}`);

// No metadata at all -> flat fallback.
assert(maxTokensCeiling(null) === FLAT_CEILING, 'null meta falls back to flat ceiling');
assert(maxTokensCeiling(undefined) === FLAT_CEILING, 'undefined meta falls back to flat ceiling');
assert(maxTokensCeiling({}) === FLAT_CEILING, 'meta without max_output falls back to flat ceiling');

// Model ceiling below the flat cap wins.
assert(maxTokensCeiling({ max_output: 8192 }) === 8192, 'lower per-model ceiling is honored');

// Model ceiling above the flat cap is still clamped to the flat cap.
assert(
  maxTokensCeiling({ max_output: 1000000 }) === FLAT_CEILING,
  'per-model ceiling never exceeds the flat cap'
);

// Non-numeric / non-positive metadata is ignored, not propagated as NaN/0.
assert(maxTokensCeiling({ max_output: 'not-a-number' }) === FLAT_CEILING, 'non-numeric max_output falls back');
assert(maxTokensCeiling({ max_output: 0 }) === FLAT_CEILING, 'zero max_output falls back');
assert(maxTokensCeiling({ max_output: -5 }) === FLAT_CEILING, 'negative max_output falls back');

// ── 2. The rung ────────────────────────────────────────────────────────────
assert(effortRung('low') === 'low' && effortRung('medium') === 'medium', 'a real rung passes through');
assert(effortRung('high') === 'high', "'high' is 'high'");
// "auto" (and anything unrecognised) must not silently mean the SMALLEST
// budget: it falls to the top rung, the same default aegiscodex-dev applies.
for (const v of ['auto', undefined, null, '', 'AUTO', 'turbo']) {
  assert(effortRung(v) === 'high', `unknown effort ${JSON.stringify(v)} falls to high, not low`);
}
assert(
  EFFORT_TOKEN_BUDGET.low < EFFORT_TOKEN_BUDGET.medium &&
    EFFORT_TOKEN_BUDGET.medium < EFFORT_TOKEN_BUDGET.high,
  'the rung ladder is ordered'
);

// ── 3. budgetFor: exactly one authority per call ───────────────────────────
// A number the caller STATED is the budget, verbatim: a deliberate cap is a
// liability ceiling and no rung may raise it.
assert(budgetFor('claude-sonnet-5', 4096, 'high') === 4096, 'a stated cap is returned verbatim');
assert(budgetFor('pooled-x', 1, 'high') === 1, 'even a tiny stated cap is honoured, never raised');
assert(budgetFor('deepseek-flash', '2048', 'low') === 2048, 'a numeric string counts as stated');

// Nonsense is "nothing stated", never a 0/NaN-token ceiling.
assert(budgetFor('gpt-4o-mini', 0, 'high') === undefined, '0 means unstated');
assert(budgetFor('gpt-4o-mini', -1, 'high') === undefined, 'a negative means unstated');
assert(budgetFor('gpt-4o-mini', NaN, 'high') === undefined, 'NaN means unstated');

// A model that reasons against its own output budget gets the rung — on every
// class, because the rule is a property of the MODEL, not of the transport.
for (const id of ['deepseek-flash', 'deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-pro', 'deepseek-reasoner']) {
  assert(
    budgetFor(id, undefined, 'low') === EFFORT_TOKEN_BUDGET.low,
    `${id} is sized by the rung, not by the transport's default`
  );
}

// Everything else states NOTHING. This is the fix, not a shortcut: the
// transport used to fill this gap with an invented 4096, which a reasoning
// model spent entirely on hidden chain-of-thought.
assert(budgetFor('gpt-4o-mini', undefined, 'high') === undefined, 'a plain OpenAI-compatible id sends no cap');
assert(budgetFor('claude-haiku-4-5', undefined, 'medium') === undefined, 'a Claude id sends no cap — the direct-dial class that required the field is gone');
assert(budgetFor('pooled-x', undefined, 'high') === undefined, 'the pooled class sends no cap — aegis1 sizes it');
assert(budgetFor('deepseek-chat', undefined, 'high') === undefined, 'a non-reasoning DeepSeek id sends no cap');

// ── 4. The two copies answer identically ───────────────────────────────────
const CASES = [
  ['gpt-4o-mini', undefined, undefined],
  ['gpt-4o-mini', 4096, 'low'],
  ['deepseek-chat', undefined, 'high'],
  ['deepseek-flash', undefined, 'low'],
  ['deepseek-flash', undefined, 'medium'],
  ['deepseek-flash', undefined, 'auto'],
  ['deepseek-reasoner', undefined, 'high'],
  ['deepseek-v4.1-flash', '8192', 'low'],
  ['claude-sonnet-5', undefined, 'auto'],
  ['deepseek-flash', undefined, 'medium'],
  ['deepseek-v4-pro', 1024, 'high'],
  ['llama3', undefined, 'high'],
  ['pooled-model', undefined, 'high'],
  ['pooled-model', 65536, 'low'],
];
for (const [model, stated, effort] of CASES) {
  const a = budgetFor(model, stated, effort);
  const b = engine.reasoningBudget(model, stated, effort);
  assert(
    a === b,
    `renderer/engine disagree on ${model} stated=${stated} effort=${effort}: ${a} vs ${b}`
  );
}

// …and the literals themselves agree, so a one-sided edit is caught even if the
// case table above never happens to cover the changed branch.
const budgetSrc = readFileSync(join(root, 'desktop', 'renderer', 'budget.js'), 'utf8');
const engineSrc = readFileSync(join(root, 'desktop', 'lib', 'local', 'engine.js'), 'utf8');
const regexOf = (src) => (src.match(/\/\^deepseek-[\s\S]*?\$\//) || [null])[0];
assert(regexOf(budgetSrc) && regexOf(budgetSrc) === regexOf(engineSrc), 'DEEPSEEK_REASONING_MODEL_RE is one literal in both files');
assert(
  String(DEEPSEEK_REASONING_MODEL_RE) === regexOf(engineSrc),
  'the exported regex is the literal the tests just compared'
);
const tableOf = (src) => {
  const m = /EFFORT_TOKEN_BUDGET\s*=\s*\{([^}]*)\}/.exec(src);
  return m ? m[1].replace(/\s+/g, '') : null;
};
assert(tableOf(budgetSrc) && tableOf(budgetSrc) === tableOf(engineSrc), 'EFFORT_TOKEN_BUDGET is one table in both files');

// ── 5. No transport invents a cap ──────────────────────────────────────────
// This half used to read desktop/lib/local/providers.js and ollama.js — the two
// direct-dial transports, both deleted with the classes they served. The rule
// they had to obey is not lost, it moved with the surviving transport: the Aegis
// client is the only one left that can put a max_tokens on the wire, so it is
// the only file that can still invent one.
const aegisSrc = readFileSync(join(root, 'client', 'aegis.js'), 'utf8');
assert(
  !/maxTokens\s*=\s*4096/.test(aegisSrc),
  'the surviving transport does not default maxTokens to an invented 4096'
);
assert(
  !/^\s*maxTokens\s*=\s*\d+,/m.test(aegisSrc),
  'no transport has a defaulted maxTokens parameter'
);
// And the renderer's own call site still states nothing it did not derive.
assert(
  /budgetFor\(model, undefined, effort\)/.test(readFileSync(join(root, 'desktop', 'renderer', 'app.js'), 'utf8')),
  'send() states the rung through budgetFor() and no cap of its own'
);

console.log(
  'Budget tests passed: the ceiling is a label, effort sizes the call, and both copies of the rule agree.'
);
