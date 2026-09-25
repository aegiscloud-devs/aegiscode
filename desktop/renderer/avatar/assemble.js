'use strict';

/**
 * assemble.js — persona JSON in, layered SVG out (PLAN Phase 22).
 *
 * A pure string builder. It takes a validated persona record plus one
 * expression id and returns the markup, the layer list it walked, and — the
 * part that matters — a `warnings`/`missing` pair. Three rules:
 *
 *  1. **Never blank, never throw.** An id the manifest does not know (a persona
 *     hand-edited, or written by a newer release) renders the default part and
 *     is REPORTED. `persona.js` made the same choice at the storage boundary
 *     for the same reason: the user's own file must not be able to take the
 *     companion's face away.
 *
 *  2. **No interpolation of user text.** Nothing the user typed is placed in
 *     the markup, so there is no escaping question and no injection surface:
 *     the only persona-supplied value that reaches the SVG is `hairColor`, and
 *     it is re-checked against `#rrggbb` here even though `persona.js` already
 *     checked it. Geometry comes from the manifest, which is code.
 *
 *  3. **No styles, no scripts, no references.** The output carries no `<style>`,
 *     no `on*` attribute and no `href`/`url(...)`: motion lives in avatar.css,
 *     keyed off the `data-motion` attribute this file sets. That keeps the
 *     renderer's CSP (`script-src 'self'; style-src 'self'`) satisfied by
 *     construction, and `desktop/test/avatar-render.test.mjs` asserts all four
 *     absences rather than trusting this paragraph.
 *
 * Pure: no DOM, no Electron. It runs identically under `node --test` and in the
 * renderer, which is what makes the whole phase testable.
 */

'use strict';

const pkg = typeof window !== 'undefined' && window.AegisAvatarParts
  ? window.AegisAvatarParts
  : typeof module !== 'undefined' && module.exports
    ? require('./parts.js')
    : null;

if (!pkg) throw new Error('avatar/assemble.js: avatar/parts.js must be loaded first');

const HEX = /^#[0-9a-f]{6}$/i;

/** Lighten (`amount > 0`) or darken (`amount < 0`) a `#rrggbb` colour. */
function shade(hex, amount) {
  const m = HEX.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[0].slice(1), 16);
  const target = amount < 0 ? 0 : 255;
  const k = Math.min(1, Math.abs(amount));
  const mix = (c) => Math.round(c * (1 - k) + target * k);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Walk a flat list of shape specs, keeping only the ones with geometry. */
function shapesOf(list) {
  return Array.isArray(list) ? list.filter((s) => s && typeof s === 'object') : [];
}

/** A path string from an expression is geometry — normalise it to a shape. */
function asStrokes(value) {
  if (typeof value === 'string' && value.trim()) return [{ kind: 'path', d: value, stroke: true }];
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? { kind: 'path', d: v, stroke: true } : v))
    .filter((s) => s && typeof s === 'object');
}

function call(fn, ...args) {
  return typeof fn === 'function' ? fn(...args) : undefined;
}

/**
 * Resolve a custom expression from `persona.expressions.custom`.
 *
 * A custom expression is DATA too: `{ mouth, brows, eyes }` where `mouth` is an
 * SVG path, `brows` is a path or a list of paths, and `eyes` names one of the
 * manifest's eye overrides. Anything unrecognised is dropped with a warning, so
 * a half-written custom expression renders the core face rather than nothing.
 */
function customExpression(persona, id, warnings) {
  const custom = persona && persona.expressions && persona.expressions.custom;
  const record = custom && typeof custom === 'object' ? custom[id] : null;
  if (!record || typeof record !== 'object') return null;
  const out = { label: id, custom: true };
  if (typeof record.mouth === 'string' && record.mouth.trim()) out.mouth = record.mouth.trim();
  if (record.brows !== undefined) out.brows = asStrokes(record.brows).map((s) => s.d);
  if (record.eyes !== undefined) {
    if (typeof record.eyes === 'string' && pkg.EYE_OVERRIDES[record.eyes]) out.eyes = record.eyes;
    else warnings.push(`custom expression ${id}: unknown eye override ${JSON.stringify(record.eyes)} — ignored`);
  }
  if (out.mouth === undefined && out.brows === undefined && out.eyes === undefined) {
    warnings.push(`custom expression ${id} carries no drawable geometry — ignored`);
    return null;
  }
  return out;
}

/**
 * Assemble the avatar.
 *
 * @param {object} persona a persona record (validated or raw — both survive)
 * @param {object} [opts]
 * @param {string} [opts.expression] an `events.js` expression id
 * @param {boolean} [opts.reducedMotion] the OS preference; forces `minimal`
 * @param {string} [opts.motion] explicit override, mostly for tests
 * @returns {{ svg: string, layers: object[], warnings: string[], missing: string[],
 *             expression: string, palette: string, frame: string, motion: string }}
 */
function assemble(persona, opts = {}) {
  const warnings = [];
  const missing = [];
  const p = persona && typeof persona === 'object' ? persona : pkg.defaultPersona();
  const presentation = p.presentation && typeof p.presentation === 'object' ? p.presentation : {};
  const appearance = p.appearance && typeof p.appearance === 'object' ? p.appearance : {};

  // ---- palette / skin / hair colour --------------------------------------
  const paletteId = pkg.PALETTES[presentation.palette] ? presentation.palette : 'amber';
  if (presentation.palette !== undefined && paletteId !== presentation.palette) {
    warnings.push(`unknown palette ${JSON.stringify(presentation.palette)} — using ${paletteId}`);
  }
  const palette = pkg.PALETTES[paletteId];
  const skin = Number.isInteger(presentation.skin) && presentation.skin >= 0 && presentation.skin < pkg.SKIN_TONES.length
    ? presentation.skin
    : 2;
  const skinTone = pkg.SKIN_TONES[skin];
  const hairColor = HEX.test(String(presentation.hairColor || '')) ? String(presentation.hairColor) : '#3b2a20';

  function colorFor(role) {
    switch (role) {
      case 'skin': return skinTone;
      case 'skinShade': return shade(skinTone, -0.18);
      case 'hair': return hairColor;
      case 'hairShade': return shade(hairColor, -0.25);
      case 'cloth': return palette.cloth;
      case 'clothShade': return palette.clothShade;
      case 'accent': return palette.accent;
      case 'metal': return palette.metal;
      case 'bg': return palette.bg;
      case 'ink': return palette.ink;
      case 'sclera': return '#fdfbf7';
      case 'highlight': return '#ffffff';
      default: return palette.ink;
    }
  }

  // ---- parts -------------------------------------------------------------
  function part(table, kind, id, fallback) {
    const got = table[id];
    if (got) return got;
    if (id !== undefined && id !== null && id !== '') {
      missing.push(`${kind}:${id}`);
      warnings.push(`unknown ${kind} ${JSON.stringify(id)} — using ${fallback}`);
    }
    return table[fallback];
  }

  const frameId = pkg.FRAMES[presentation.frame] ? presentation.frame : 'A';
  const frame = pkg.FRAMES[frameId];
  const hair = part(pkg.HAIR, 'hair', presentation.hair, 'bob-2');
  const eyes = part(pkg.EYES, 'eyes', presentation.eyes, 'soft');

  const outfitIds = [];
  for (const item of Array.isArray(presentation.outfit) ? presentation.outfit : []) {
    if (pkg.OUTFITS[item]) outfitIds.push(item);
    else missing.push(`outfit:${item}`);
  }
  if (!outfitIds.length && Array.isArray(presentation.outfit) && presentation.outfit.length) {
    warnings.push('no known outfit layer — wearing the plain tee');
  }
  const outfits = outfitIds.slice(0, 3).map((id) => pkg.OUTFITS[id]);

  // ---- expression --------------------------------------------------------
  const requested = typeof opts.expression === 'string' && opts.expression ? opts.expression : 'neutral';
  let expression = pkg.EXPRESSIONS[requested];
  let expressionId = requested;
  if (!expression) {
    const custom = customExpression(p, requested, warnings);
    if (custom) {
      expression = custom;
    } else {
      if (requested !== 'neutral') {
        missing.push(`expression:${requested}`);
        warnings.push(`unknown expression ${JSON.stringify(requested)} — using neutral`);
      }
      expression = pkg.EXPRESSIONS.neutral;
      expressionId = 'neutral';
    }
  }

  const eyeOverride = expression.eyes && pkg.EYE_OVERRIDES[expression.eyes] ? pkg.EYE_OVERRIDES[expression.eyes] : null;
  const browShapes = Array.isArray(expression.brows)
    ? asStrokes(expression.brows)
    : asStrokes(expression.brows);
  const mouthShapes = asStrokes(expression.mouth);

  const sheet = {
    shadow: [{ kind: 'ellipse', cx: 100, cy: 254, rx: 62, ry: 10, role: 'clothShade', opacity: 0.5 }],
    hairBack: shapesOf(hair.back),
    body: [
      { kind: 'path', d: pkg.BODY.neck, role: 'skinShade' },
      { kind: 'path', d: pkg.BODY.shirt, role: 'cloth' },
      { kind: 'path', d: pkg.BODY.sleeveL, role: 'cloth' },
      { kind: 'path', d: pkg.BODY.sleeveR, role: 'cloth' },
    ],
    outfitUnder: [],
    head: [
      { kind: 'path', d: frame.head, role: 'skin' },
      ...frame.ear.map((e) => ({ kind: 'circle', cx: e.cx, cy: e.cy, r: e.r, role: 'skin' })),
    ],
    face: [
      ...(eyeOverride
        ? eyeOverride.map((s) => ({ ...s, stroke: true }))
        : [...eyes.left, ...eyes.right]),
      ...browShapes,
      ...shapesOf(pkg.FACE.nose),
      ...mouthShapes,
    ],
    hairFront: [...shapesOf(hair.front), ...shapesOf(hair.detail)],
    outfitOver: [],
    accessory: [],
    effect: [],
  };

  // Outfit layers draw in the order the persona listed them: the last one is
  // the outermost. Items flagged `accessory` (headphones, glasses) go on top of
  // the hair instead of into the clothes pile.
  const under = sheet.outfitUnder;
  for (const item of outfits) {
    under.push(...shapesOf(item.under).map((s) => ({ ...s, defaultRole: 'cloth' })));
    const overShapes = shapesOf(item.over).map((s) => ({ ...s, defaultRole: 'cloth' }));
    if (item.accessory) sheet.accessory.push(...overShapes);
    else sheet.outfitOver.push(...overShapes);
  }

  // A celebrating face gets a few sparks — motion-gated in CSS, and the only
  // thing on the `effect` layer.
  if (expressionId === 'happy' || expressionId === 'playful' || expressionId === 'delighted') {
    sheet.effect.push(
      { kind: 'path', d: 'M28 66 l4 10 l10 4 l-10 4 l-4 10 l-4 -10 l-10 -4 l10 -4 Z', role: 'accent', opacity: 0.9 },
      { kind: 'path', d: 'M172 88 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 l8 -3 Z', role: 'accent', opacity: 0.7 }
    );
  }

  // ---- markup ------------------------------------------------------------
  /** Per-layer default fill role, so a manifest entry rarely repeats itself. */
  const layerDefaultRole = {
    shadow: 'clothShade',
    hairBack: 'hair',
    body: 'cloth',
    outfitUnder: 'cloth',
    head: 'skin',
    face: 'ink',
    hairFront: 'hair',
    outfitOver: 'cloth',
    accessory: 'metal',
    effect: 'accent',
  };

  function renderShape(shape, layer) {
    const role = shape.role || shape.defaultRole || layerDefaultRole[layer] || 'ink';
    const fill = colorFor(role);
    const common = [];
    if (shape.stroke) {
      common.push('fill="none"', `stroke="${fill}"`, 'stroke-width="3.5"', 'stroke-linecap="round"', 'stroke-linejoin="round"');
    } else {
      common.push(`fill="${fill}"`);
    }
    if (typeof shape.opacity === 'number') common.push(`opacity="${shape.opacity}"`);

    switch (shape.kind) {
      case 'circle':
        return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" ${common.join(' ')}/>`;
      case 'ellipse':
        return `<ellipse cx="${shape.cx}" cy="${shape.cy}" rx="${shape.rx}" ry="${shape.ry}" ${common.join(' ')}/>`;
      case 'rect': {
        const rx = shape.rx === undefined ? 0 : shape.rx;
        return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${rx}" ${common.join(' ')}/>`;
      }
      case 'path':
      default:
        return `<path d="${shape.d}" ${common.join(' ')}/>`;
    }
  }

  const motion = opts.motion
    ? String(opts.motion)
    : pkg.motionFor(p, Boolean(opts.reducedMotion));
  const size = ['small', 'medium', 'large'].includes(appearance.size) ? appearance.size : 'medium';

  const layers = [];
  const groups = [];
  for (const name of pkg.LAYERS) {
    const shapes = sheet[name] || [];
    layers.push({ name, shapes: shapes.length });
    if (!shapes.length) continue;
    const body = shapes.map((s) => renderShape(s, name)).join('');
    groups.push(`<g class="avatar-layer avatar-${name}" data-layer="${name}">${body}</g>`);
  }

  const svg =
    `<svg class="avatar-svg" viewBox="0 0 200 268" xmlns="http://www.w3.org/2000/svg" ` +
    `aria-hidden="true" focusable="false" role="presentation" ` +
    `data-motion="${motion}" data-size="${size}" data-frame="${frameId}" ` +
    `data-palette="${paletteId}" data-expression="${expressionId}">` +
    `<rect class="avatar-bg" x="0" y="0" width="200" height="268" rx="24" fill="${colorFor('bg')}"/>` +
    groups.join('') +
    '</svg>';

  return {
    svg,
    layers,
    warnings,
    missing,
    expression: expressionId,
    expressionLabel: expression.label || expressionId,
    palette: paletteId,
    frame: frameId,
    hair: hair === pkg.HAIR[presentation.hair] ? presentation.hair : 'bob-2',
    motion,
    size,
  };
}

const API = Object.freeze({ assemble, shade });

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatarAssemble = API;
