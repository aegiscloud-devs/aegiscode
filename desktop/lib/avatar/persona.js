'use strict';

/**
 * persona.js — the avatar is DATA, not art.
 *
 * The user asked to "customize her or him as you want". The cheap way to build
 * that is a settings pane with hand-written branches for every option, which
 * makes a new outfit a code change and a commissioned art pack a fork. The way
 * this module does it: a persona is one JSON record, validated and coerced
 * here, and Phase 22's renderer assembles layered SVG from a part manifest. A
 * theme is then a file. Zero code changes.
 *
 * Validation is REPAIR-ORIENTED, not reject-oriented, with exactly two hard
 * errors:
 *
 *   - the input is not an object at all, or
 *   - its `schema` is newer than this build understands.
 *
 * Everything else is coerced to a legal value and reported in `warnings`. That
 * ordering matters for a file the user can hand-edit: an unknown `hair` id from
 * a newer release should render the default hair and tell the user, not blank
 * the avatar or refuse to start the app. A persona is not a security boundary;
 * it is the user's own file.
 *
 * The one place that IS adversarial is the `register` block and the identity
 * strings, because they end up in the system prompt (Phase 21). Those are
 * sanitized here at the storage boundary — control characters and newlines are
 * stripped so a name cannot break out of its line — and the *prompt* fragment
 * is additionally bounded and neutralized in `register.js`. Two layers, because
 * a name is user-authored text going into a prompt.
 *
 * Pure: no fs, no Electron. Phase 21's main process reads/writes the file.
 */

/** Bump when the record shape changes; `migrate` walks old records forward. */
const SCHEMA_VERSION = 1;

/**
 * The part manifest. Ids only — geometry lives in `renderer/avatar/` (Phase 22),
 * which reads these same ids. Validation is against THIS list so a typo in a
 * hand-edited persona is caught at load rather than rendering an empty head.
 */
const PARTS = Object.freeze({
  frame: Object.freeze(['A', 'B', 'C']),
  skin: Object.freeze([0, 1, 2, 3, 4, 5]),
  hair: Object.freeze([
    'short-1', 'bob-2', 'long-3', 'curly-4', 'buzz-5',
    'ponytail-6', 'braids-7', 'wavy-8',
  ]),
  eyes: Object.freeze(['soft', 'sharp', 'sleepy', 'bright']),
  outfit: Object.freeze([
    'hoodie', 'tshirt', 'flannel', 'jacket', 'headphones',
    'glasses', 'scarf', 'apron', 'seasonal-winter', 'archive-coat',
  ]),
  palette: Object.freeze(['amber', 'slate', 'moss', 'plum', 'mono', 'sunset']),
  motion: Object.freeze(['full', 'reduced', 'minimal']),
  size: Object.freeze(['small', 'medium', 'large']),
  expressionPack: Object.freeze(['core', 'trusted', 'companion', 'confidant', 'archivist']),
  proactivity: Object.freeze(['off', 'hints', 'brief']),
  voiceEngine: Object.freeze(['none', 'local', 'system']),
});

/** How many outfit layers may be worn at once (spec §2: 3 layers at L5). */
const MAX_OUTFIT_LAYERS = 3;

const LIMITS = Object.freeze({
  name: 40,
  pronouns: 24,
  selfDesc: 120,
  address: 32,
  voiceId: 64,
  customExpressions: 24,
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Anything a prompt could use to start a new directive line or smuggle a role. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f\u2028\u2029]+/g;

function has(list, value) {
  return list.some((v) => v === value);
}

/**
 * Collapse whitespace and strip control characters. A name is a single line of
 * text in a UI, and (Phase 21) a single line in a prompt — so newlines, tabs and
 * the unicode line separators are removed rather than escaped.
 */
function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(UNSAFE_TEXT, ' ').replace(/\s+/g, ' ').trim();
  return flat.slice(0, max);
}

function clamp01(value, fallback) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, n));
}

function pick(list, value, fallback) {
  return has(list, value) ? value : fallback;
}

function nonEmptyId(value, fallback, fallbackOn) {
  if (typeof value !== 'string') return fallback;
  const id = value.trim();
  if (has(fallbackOn, id)) return id;
  return fallback;
}

/** The persona a fresh install gets. Everything here is replaceable by the user. */
const DEFAULT_PERSONA = Object.freeze({
  schema: SCHEMA_VERSION,
  identity: Object.freeze({
    name: 'Aegis',
    pronouns: 'they/them',
    selfDesc: 'your build partner',
  }),
  presentation: Object.freeze({
    frame: 'A',
    skin: 2,
    hair: 'bob-2',
    hairColor: '#3b2a20',
    eyes: 'soft',
    outfit: Object.freeze(['hoodie']),
    palette: 'amber',
  }),
  expressions: Object.freeze({ pack: 'core', custom: Object.freeze({}) }),
  voice: Object.freeze({ enabled: false, engine: 'none', id: null, rate: 1 }),
  register: Object.freeze({
    formality: 0.3,
    humor: 0.4,
    verbosity: 0.5,
    proactivity: 'hints',
    address: 'you',
    emojis: false,
  }),
  appearance: Object.freeze({ motion: 'full', size: 'medium', docked: true }),
});

/** A deep, mutable copy of the defaults — safe for the settings pane to edit. */
function defaultPersona() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSONA));
}

/**
 * Walk an old record forward. With one schema version this is trivial, but the
 * mechanism exists now so that adding v2 is a table entry rather than a
 * discovery that shipped personas cannot be read.
 */
const MIGRATIONS = Object.freeze({
  // 0 → 1: pre-schema personas are just partial records; normalisation fills them.
  0: (raw) => Object.assign({}, raw),
});

function migrate(raw) {
  if (!raw || typeof raw !== 'object') return { persona: defaultPersona(), migrated: false };
  let current = raw;
  let version = Number.isInteger(current.schema) ? current.schema : 0;
  // A record from the future is not migrated — the validator reports it.
  let migrated = false;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    current = step ? step(current) : current;
    version += 1;
    migrated = true;
  }
  return { persona: current, migrated, fromSchema: Number.isInteger(raw.schema) ? raw.schema : 0 };
}

/**
 * Validate and repair a persona record.
 *
 * @returns {{ ok: boolean, persona: object, errors: string[], warnings: string[], migrated: boolean }}
 *   `ok` is false only for a non-object input or a schema from the future. In
 *   that case `persona` is the default, so the caller always has something
 *   renderable.
 */
function validate(raw) {
  const errors = [];
  const warnings = [];

  if (raw === undefined || raw === null) {
    return { ok: true, persona: defaultPersona(), errors, warnings: ['no persona stored yet — using defaults'], migrated: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      persona: defaultPersona(),
      errors: ['persona must be a JSON object'],
      warnings,
      migrated: false,
    };
  }
  if (Number.isInteger(raw.schema) && raw.schema > SCHEMA_VERSION) {
    return {
      ok: false,
      persona: defaultPersona(),
      errors: [`persona schema ${raw.schema} is newer than this build supports (${SCHEMA_VERSION})`],
      warnings,
      migrated: false,
    };
  }

  const { persona: migratedPersona, migrated } = migrate(raw);
  const src = migratedPersona;
  const d = DEFAULT_PERSONA;

  // --- identity -----------------------------------------------------------
  const rawIdentity = src.identity && typeof src.identity === 'object' ? src.identity : {};
  const name = cleanText(rawIdentity.name, LIMITS.name) || d.identity.name;
  if (rawIdentity.name !== undefined && name !== rawIdentity.name) {
    warnings.push('identity.name was trimmed to a single line and length-capped');
  }
  const identity = {
    name,
    pronouns: cleanText(rawIdentity.pronouns, LIMITS.pronouns) || d.identity.pronouns,
    selfDesc: cleanText(rawIdentity.selfDesc, LIMITS.selfDesc),
  };

  // --- presentation -------------------------------------------------------
  const rawPresentation = src.presentation && typeof src.presentation === 'object' ? src.presentation : {};
  const skin = has(PARTS.skin, rawPresentation.skin)
    ? rawPresentation.skin
    : (Number.isInteger(rawPresentation.skin) ? d.presentation.skin : d.presentation.skin);
  if (rawPresentation.skin !== undefined && !has(PARTS.skin, rawPresentation.skin)) {
    warnings.push(`unknown skin index ${JSON.stringify(rawPresentation.skin)} — using ${skin}`);
  }
  for (const key of ['frame', 'hair', 'eyes', 'palette']) {
    const got = rawPresentation[key];
    if (got !== undefined && !has(PARTS[key], got)) {
      warnings.push(`unknown ${key} ${JSON.stringify(got)} — using ${d.presentation[key]}`);
    }
  }
  const hairColor = HEX_COLOR.test(String(rawPresentation.hairColor || ''))
    ? String(rawPresentation.hairColor).toLowerCase()
    : d.presentation.hairColor;
  if (rawPresentation.hairColor !== undefined && hairColor !== rawPresentation.hairColor) {
    warnings.push(`hairColor must be a #rrggbb hex — using ${hairColor}`);
  }

  let outfit = Array.isArray(rawPresentation.outfit) ? rawPresentation.outfit : d.presentation.outfit;
  const knownOutfit = [];
  for (const item of outfit) {
    if (!has(PARTS.outfit, item)) {
      warnings.push(`unknown outfit item ${JSON.stringify(item)} — dropped`);
      continue;
    }
    if (!knownOutfit.includes(item)) knownOutfit.push(item);
  }
  if (knownOutfit.length > MAX_OUTFIT_LAYERS) {
    warnings.push(`at most ${MAX_OUTFIT_LAYERS} outfit layers — extra layers dropped`);
    knownOutfit.length = MAX_OUTFIT_LAYERS;
  }
  outfit = knownOutfit;

  const presentation = {
    frame: pick(PARTS.frame, rawPresentation.frame, d.presentation.frame),
    skin,
    hair: pick(PARTS.hair, rawPresentation.hair, d.presentation.hair),
    hairColor,
    eyes: pick(PARTS.eyes, rawPresentation.eyes, d.presentation.eyes),
    outfit,
    palette: pick(PARTS.palette, rawPresentation.palette, d.presentation.palette),
  };

  // --- expressions --------------------------------------------------------
  const rawExpressions = src.expressions && typeof src.expressions === 'object' ? src.expressions : {};
  const custom = {};
  if (rawExpressions.custom && typeof rawExpressions.custom === 'object' && !Array.isArray(rawExpressions.custom)) {
    let count = 0;
    for (const [key, value] of Object.entries(rawExpressions.custom)) {
      if (count >= LIMITS.customExpressions) {
        warnings.push(`at most ${LIMITS.customExpressions} custom expressions — extras dropped`);
        break;
      }
      const id = cleanText(key, 40);
      if (!id || typeof value !== 'object' || value === null) continue;
      custom[id] = JSON.parse(JSON.stringify(value));
      count += 1;
    }
  }
  const expressions = {
    pack: pick(PARTS.expressionPack, rawExpressions.pack, d.expressions.pack),
    custom,
  };

  // --- voice --------------------------------------------------------------
  const rawVoice = src.voice && typeof src.voice === 'object' ? src.voice : {};
  const engine = pick(PARTS.voiceEngine, rawVoice.engine, d.voice.engine);
  const rateNum = typeof rawVoice.rate === 'number' && Number.isFinite(rawVoice.rate)
    ? Math.min(2, Math.max(0.5, rawVoice.rate))
    : d.voice.rate;
  const voice = {
    enabled: rawVoice.enabled === true,
    engine,
    id: engine === 'none' ? null : cleanText(rawVoice.id, LIMITS.voiceId) || null,
    rate: rateNum,
  };
  if (voice.id && /clone|voiceprint|imitat/i.test(voice.id)) {
    // Non-goal from the spec: no cloning of real people. Refuse, don't warn.
    warnings.push('voice.id looks like a cloned voice — refused (no cloning of real people)');
    voice.id = null;
    voice.enabled = false;
  }

  // --- register (feeds the prompt, so it is the sanitized one) ------------
  const rawRegister = src.register && typeof src.register === 'object' ? src.register : {};
  const register = {
    formality: clamp01(rawRegister.formality, d.register.formality),
    humor: clamp01(rawRegister.humor, d.register.humor),
    verbosity: clamp01(rawRegister.verbosity, d.register.verbosity),
    proactivity: pick(PARTS.proactivity, rawRegister.proactivity, d.register.proactivity),
    address: cleanText(rawRegister.address, LIMITS.address) || d.register.address,
    emojis: rawRegister.emojis === true,
  };

  // --- appearance ---------------------------------------------------------
  const rawAppearance = src.appearance && typeof src.appearance === 'object' ? src.appearance : {};
  const appearance = {
    motion: pick(PARTS.motion, rawAppearance.motion, d.appearance.motion),
    size: pick(PARTS.size, rawAppearance.size, d.appearance.size),
    docked: rawAppearance.docked !== false,
  };

  // Unknown top-level keys are dropped, not carried: a persona that silently
  // accumulates junk is a persona that grows forever in the user's profile.
  const known = ['schema', 'identity', 'presentation', 'expressions', 'voice', 'register', 'appearance'];
  for (const key of Object.keys(src)) {
    if (!known.includes(key)) warnings.push(`unknown persona key ${JSON.stringify(key)} — ignored`);
  }

  return {
    ok: true,
    errors,
    warnings,
    migrated,
    persona: { schema: SCHEMA_VERSION, identity, presentation, expressions, voice, register, appearance },
  };
}

/** Convenience: validate and hand back just the record. */
function load(raw) {
  return validate(raw).persona;
}

/** Deep-merge a partial update onto a valid persona, then re-validate. */
function update(current, patch) {
  const base = validate(current).persona;
  if (!patch || typeof patch !== 'object') return validate(base);
  const merged = {
    schema: SCHEMA_VERSION,
    identity: { ...base.identity, ...(patch.identity || {}) },
    presentation: { ...base.presentation, ...(patch.presentation || {}) },
    expressions: { ...base.expressions, ...(patch.expressions || {}) },
    voice: { ...base.voice, ...(patch.voice || {}) },
    register: { ...base.register, ...(patch.register || {}) },
    appearance: { ...base.appearance, ...(patch.appearance || {}) },
  };
  return validate(merged);
}

/**
 * Apply an accessibility preference. `prefers-reduced-motion` is not advisory:
 * it forces the least motion the renderer has, regardless of what the persona
 * stored.
 */
function appliesMotion(persona, prefersReducedMotion) {
  const motion = prefersReducedMotion ? 'minimal' : persona.appearance.motion;
  return motion === 'minimal' ? 'minimal' : motion;
}

module.exports = {
  SCHEMA_VERSION,
  PARTS,
  LIMITS,
  MAX_OUTFIT_LAYERS,
  DEFAULT_PERSONA,
  defaultPersona,
  migrate,
  validate,
  load,
  update,
  appliesMotion,
  cleanText,
};
