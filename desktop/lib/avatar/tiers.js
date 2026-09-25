'use strict';

/**
 * tiers.js — the tier bands, alone in their own module on purpose.
 *
 * Both `xp.js` (which needs the tier name for a projection) and `level.js`
 * (which needs the band to decide unlocks) depend on this table. Putting it in
 * either one would make the other require it and create a cycle the moment
 * either grew a second import — so the shared vocabulary lives by itself and
 * both read it. Nothing here imports anything.
 */

const TIERS = Object.freeze([
  Object.freeze({ min: 1, max: 4, name: 'Familiar', blink: 'familiar' }),
  Object.freeze({ min: 5, max: 9, name: 'Trusted', blink: 'trusted' }),
  Object.freeze({ min: 10, max: 19, name: 'Companion', blink: 'companion' }),
  Object.freeze({ min: 20, max: 34, name: 'Confidant', blink: 'confidant' }),
  Object.freeze({ min: 35, max: Number.POSITIVE_INFINITY, name: 'Archivist', blink: 'archivist' }),
]);

/** The band a level falls in. Levels below 1 are clamped to the first band. */
function tierFor(level) {
  const n = Math.max(1, Math.floor(typeof level === 'number' && Number.isFinite(level) ? level : 1));
  for (const band of TIERS) {
    if (n >= band.min && n <= band.max) return band;
  }
  return TIERS[TIERS.length - 1];
}

/** Index of the band (0-based) — handy for cosmetics rarity. */
function tierIndex(level) {
  return TIERS.indexOf(tierFor(level));
}

module.exports = { TIERS, tierFor, tierIndex };
