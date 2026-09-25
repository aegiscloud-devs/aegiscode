#!/usr/bin/env node
/** Unit tests for desktop/lib/avatar/tiers.js — the shared tier bands. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TIERS, tierFor, tierIndex } = require('../lib/avatar/tiers.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

// The bands from docs/avatar-plan.md §1.2: 1–4 · 5–9 · 10–19 · 20–34 · 35+.
assertEqual(TIERS.length, 5, 'five tier bands');
assertEqual(tierFor(1).name, 'Familiar', 'L1 is Familiar');
assertEqual(tierFor(4).name, 'Familiar', 'L4 is still Familiar');
assertEqual(tierFor(5).name, 'Trusted', 'L5 is Trusted');
assertEqual(tierFor(9).name, 'Trusted', 'L9 is still Trusted');
assertEqual(tierFor(10).name, 'Companion', 'L10 is Companion');
assertEqual(tierFor(19).name, 'Companion', 'L19 is still Companion');
assertEqual(tierFor(20).name, 'Confidant', 'L20 is Confidant');
assertEqual(tierFor(34).name, 'Confidant', 'L34 is still Confidant');
assertEqual(tierFor(35).name, 'Archivist', 'L35 is Archivist');
assertEqual(tierFor(1000).name, 'Archivist', 'no ceiling — a very high level is still Archivist');

// Every band is contiguous and covers a level with no gaps or overlaps.
for (let level = 1; level <= 60; level += 1) {
  const band = tierFor(level);
  assert(level >= band.min && level <= band.max, `L${level} falls inside its own band [${band.min}, ${band.max}]`);
}
for (let i = 1; i < TIERS.length; i += 1) {
  assertEqual(TIERS[i].min, TIERS[i - 1].max + 1, `band ${i} starts exactly where band ${i - 1} ends`);
}

// Clamping and bad input: below 1, non-numbers, NaN — all land in the first band.
assertEqual(tierFor(0).name, 'Familiar', 'L0 clamps to the first band');
assertEqual(tierFor(-5).name, 'Familiar', 'a negative level clamps to the first band');
assertEqual(tierFor(NaN).name, 'Familiar', 'NaN clamps to the first band');
assertEqual(tierFor(undefined).name, 'Familiar', 'undefined clamps to the first band');
assertEqual(tierFor(3.9).name, 'Familiar', 'a fractional level floors before banding');
assertEqual(tierFor(4.9).name, 'Familiar', '4.9 floors to L4, still Familiar');
assertEqual(tierFor(5.1).name, 'Trusted', '5.1 floors to L5, Trusted');

// tierIndex tracks tierFor and is monotonic with level.
assertEqual(tierIndex(1), 0, 'Familiar is index 0');
assertEqual(tierIndex(35), 4, 'Archivist is index 4');
let prevIndex = -1;
for (let level = 1; level <= 60; level += 1) {
  const idx = tierIndex(level);
  assert(idx >= prevIndex, `tierIndex is monotonic non-decreasing at L${level}`);
  assert(TIERS[idx] === tierFor(level), `tierIndex(${level}) points at the same band object tierFor returns`);
  prevIndex = idx;
}

console.log('avatar-tiers.test.mjs ok');
