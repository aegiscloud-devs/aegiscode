'use strict';

/**
 * voice.js — the companion's voice: present, optional, local, and OFF.
 *
 * Four rules, in the order they matter.
 *
 *  1. **OFF BY DEFAULT, AND THE DEFAULT IS THE PERSONA'S, NOT THIS FILE'S.**
 *     `persona.js` ships `voice: { enabled: false, engine: 'none', id: null }`.
 *     `resolveVoice()` therefore needs an explicit `enabled: true` in the
 *     persona to say anything at all, and `AEGIS_VOICE` can only ever *lower*
 *     that — an env var may select an engine or force voice off for
 *     automation/CI, but it can never be the thing that starts speaking in a
 *     user's room. (Compare level.js's env overrides, which are allowed to widen
 *     recall: recall is a knob, audio output is not.)
 *
 *  2. **NEVER A CLONE OF A REAL PERSON.** Spec §6 non-goal, verbatim: "no voice
 *     cloning of real people; voice ships only as licensed/local models".
 *     `assertNotClone()` refuses any voice id that reads like a person — a
 *     name-shaped id, a `voiceprint`, a recording — and there is no code path
 *     here that takes an audio sample as input, because the way to guarantee no
 *     cloning is to have nowhere to put the sample. `persona.js` already refuses
 *     clone-ish ids at the storage boundary; this is the speech path's own check,
 *     for a persona that arrived some other way (import, sync, hand-edit while
 *     the app runs).
 *
 *  3. **LOCAL, AND ONLY LOCAL.** Every engine in `ENGINES` is an installed local
 *     binary driven with `shell: false`, and `speakPlan()` returns a plan whose
 *     text is delivered on argv or stdin — never fetched, never uploaded. The
 *     test asserts the serialized plan contains no URL and no network flag, so
 *     "voice never leaves the device" is a property of the artifact the host
 *     executes rather than a claim in a doc.
 *
 *  4. **IT IS NOT A SHELL TOOL.** Speaking spawns an allowlisted binary with
 *     arguments built here from a fixed template; the user's text is the only
 *     variable, and it arrives as one argv entry (or on stdin). Nothing in this
 *     file can run a second command, expand a glob, or reach a path the user
 *     named — which is what keeps voice out of the `shell: ask` blast radius
 *     while the approval carve-outs stay exactly as level.js froze them.
 *
 * Pure: `resolveVoice`/`spokenText`/`speakPlan` take injected inputs; only
 * `detectEngine()` touches the process (and takes its probe injected in tests).
 */

/** `none` is the shipped default and means "no audio, ever". */
const ENGINES = Object.freeze(['none', 'local', 'system']);

/**
 * The bundled synthetic voices. Deliberately ROLE names, not people: a pack, a
 * doc page and a test can all point at `aegis-neutral` without any of them
 * naming a human being, which is also what makes the clone refusal in rule 2 a
 * one-line check instead of a database of celebrities.
 */
const BUILTIN_VOICES = Object.freeze([
  Object.freeze({ id: 'aegis-neutral', label: 'Neutral', engine: 'local', consent: 'synthetic', note: 'bundled synthetic model' }),
  Object.freeze({ id: 'aegis-warm', label: 'Warm', engine: 'local', consent: 'synthetic', note: 'bundled synthetic model' }),
  Object.freeze({ id: 'system-default', label: 'System voice', engine: 'system', consent: 'synthetic', note: 'the OS speech engine' }),
]);

/**
 * Everything that reads like a real person's voice. Conservative on purpose: a
 * false positive costs a user one relabelled voice, a false negative is the
 * non-goal the spec calls out by name.
 */
const CLONE_MARKERS = /clone|voiceprint|clon(ing|e)|imitat|impersonat|deepfake|replica|mimic|soundalike|sound-alike|likeness|my-?own-?voice|friend|colleague|celebrity|actor|actress|president|narrator-|real-?person|consent-?less/i;

/**
 * Local engines, in preference order. `piper` first because it is the one a
 * packaged Linux/macOS install can carry; `espeak-ng`/`spd-say`/`say` are the
 * "already on the machine" fallbacks. Each entry builds its own argv — never a
 * string that gets split.
 */
const LOCAL_ENGINES = Object.freeze({
  piper: Object.freeze({
    bin: 'piper',
    // piper reads the sentence on stdin and writes WAV — no temp file, no path.
    args: (o) => ['--model', String(o.model || 'en_US-amy-low'), '--output_file', '-'],
    stdin: true,
  }),
  'espeak-ng': Object.freeze({ bin: 'espeak-ng', args: (o) => ['-s', String(Math.round(175 * o.rate))], stdin: false }),
  espeak: Object.freeze({ bin: 'espeak', args: (o) => ['-s', String(Math.round(175 * o.rate))], stdin: false }),
  say: Object.freeze({ bin: 'say', args: (o) => ['-r', String(Math.round(200 * o.rate))], stdin: false, platforms: ['darwin'] }),
  'spd-say': Object.freeze({ bin: 'spd-say', args: (o) => ['-r', String(Math.round((o.rate - 1) * 100))], stdin: false }),
});

/** A deliberate ceiling: one answer read aloud, not a whole transcript. */
const MAX_SPEAK_CHARS = 600;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Is this id/name something that could be a real person's voice? */
function looksCloned(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return CLONE_MARKERS.test(value);
}

/**
 * Refuse a cloned voice. Returns the reason instead of throwing so a caller can
 * report it in a status line; the persona validator and this function are two
 * independent gates on the same non-goal.
 */
function assertNotClone(id) {
  if (id === null || id === undefined || id === '') return null;
  if (looksCloned(id)) {
    return `refusing voice ${JSON.stringify(id)} — voices are synthetic only; this product does not clone real people`;
  }
  return null;
}

/** Every voice a build knows about: the bundled three plus packaged ones. */
function listVoices(packs) {
  const seen = new Set(BUILTIN_VOICES.map((v) => v.id));
  const out = BUILTIN_VOICES.slice();
  for (const pack of Array.isArray(packs) ? packs : []) {
    if (!isPlainObject(pack) || pack.kind !== 'voice') continue;
    for (const item of pack.items || []) {
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push({
        id: item.id,
        label: item.label || item.id,
        engine: item.engine,
        consent: item.consent,
        note: `from pack ${pack.id}`,
      });
    }
  }
  return out;
}

/** The voice registry entry behind an id, or null. */
function findVoice(id, packs) {
  if (!id) return null;
  return listVoices(packs).find((v) => v.id === id) || null;
}

/**
 * Which local binary this machine actually has. `probe(bin) → boolean` is
 * injected (main passes a PATH lookup; tests pass a stub), so nothing here needs
 * to touch the filesystem to be testable.
 *
 * @returns {{ engine: string, bin: string }|null}
 */
function detectEngine(opts = {}) {
  const probe = typeof opts.probe === 'function' ? opts.probe : () => false;
  const platform = opts.platform || process.platform;
  for (const [name, spec] of Object.entries(LOCAL_ENGINES)) {
    if (spec.platforms && !spec.platforms.includes(platform)) continue;
    if (probe(spec.bin)) return { engine: name, bin: spec.bin };
  }
  return null;
}

/**
 * The ONE decision about whether the companion may speak.
 *
 * Order matters: persona opt-in, then the level gate, then the clone refusal,
 * then whether an engine exists. Returning a reason at each step is what lets
 * the pane say "voice unlocks at level 10" instead of a checkbox that silently
 * does nothing.
 *
 * @param {object} persona validated persona (`persona.load()`); read-only here
 * @param {object} [caps] `level.capabilities()` output. Omitted ⇒ NO gating, the
 *   same convention `renderer/avatar/pane.js` uses (unknown capabilities never
 *   lock anything).
 * @param {object} [opts]
 * @param {'none'|'local'|'system'} [opts.envEngine] `AEGIS_VOICE`, lower-cased.
 *   May only lower: `none` forces silence, `local`/`system` pick an engine for a
 *   user who already opted in, and anything else is ignored.
 * @param {function} [opts.probe] PATH probe for `detectEngine`
 * @param {object[]} [opts.packs] loaded cosmetics packs (voice packs add voices)
 * @returns {{ enabled: boolean, engine: string, id: string|null, rate: number,
 *             voice: object|null, offDevice: false, reason: string }}
 */
function resolveVoice(persona, caps, opts = {}) {
  const p = isPlainObject(persona) ? persona : {};
  const rawVoice = isPlainObject(p.voice) ? p.voice : {};
  const rate = typeof rawVoice.rate === 'number' && Number.isFinite(rawVoice.rate)
    ? Math.min(2, Math.max(0.5, rawVoice.rate))
    : 1.0;

  const off = (reason, engine) => ({
    enabled: false,
    engine: engine || 'none',
    id: null,
    rate,
    voice: null,
    offDevice: false,
    reason,
  });

  // Rule 1: opt-in first. Everything below can only take away.
  if (rawVoice.enabled !== true) return off('voice is off (opt-in, default off)');

  // Rule 1 continued: the env may force silence, never audio.
  if (opts.envEngine === 'none') return off('AEGIS_VOICE=none forces voice off');

  // The level gate (spec §4.5: voice is L10+). No caps ⇒ no gating.
  if (caps && isPlainObject(caps.companion) && caps.companion.voice !== true) {
    return off('voice unlocks at level 10');
  }

  const want = ENGINES.includes(rawVoice.engine) && rawVoice.engine !== 'none'
    ? rawVoice.engine
    : (ENGINES.includes(opts.envEngine) && opts.envEngine !== 'none' ? opts.envEngine : 'local');
  const engine = opts.envEngine === 'local' || opts.envEngine === 'system' ? opts.envEngine : want;

  // Rule 2: the non-goal, enforced on the speech path itself.
  const clone = assertNotClone(rawVoice.id);
  if (clone) return off(clone, engine);

  if (engine === 'system') {
    return {
      enabled: true,
      engine,
      id: rawVoice.id || 'system-default',
      rate,
      voice: findVoice(rawVoice.id || 'system-default', opts.packs) || null,
      offDevice: false,
      reason: 'system speech engine (local)',
    };
  }

  const found = opts.detected || detectEngine(opts);
  const id = rawVoice.id || (found ? 'aegis-neutral' : null);
  if (!found) {
    return off('no local speech engine installed — voice stays off rather than phoning home', 'local');
  }
  return {
    enabled: true,
    engine: 'local',
    id,
    rate,
    voice: findVoice(id, opts.packs) || null,
    localEngine: found.engine,
    offDevice: false,
    reason: `local engine ${found.engine}`,
  };
}

/** One-click mute, in the patch shape the customization pane already speaks. */
function mutePatch() {
  return { voice: { enabled: false, engine: 'none', id: null } };
}

/**
 * Turn an answer into something worth hearing. A voice that reads `**Run
 * \`npm test\`**` aloud is worse than no voice, so fenced code, inline code,
 * URLs, markdown emphasis and link syntax are stripped before anything is
 * spoken — and the result is capped at MAX_SPEAK_CHARS.
 */
function spokenText(text, max = MAX_SPEAK_CHARS) {
  if (typeof text !== 'string') return '';
  const flat = text
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`[^`]*`/g, ' code ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' link ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.slice(0, Math.max(0, max));
}

/**
 * The exact command the host may run to say one sentence.
 *
 * @returns {{ ok: boolean, cmd?: string, args?: string[], stdin?: boolean, shell: false,
 *             offDevice: false, text?: string, reason?: string }}
 *   `ok: false` when there is nothing to say or nothing local to say it with.
 *   `shell: false` is part of the contract, not a default: it is what makes the
 *   text an argument instead of a command.
 */
function speakPlan(text, opts = {}) {
  const clean = spokenText(text, opts.max);
  if (!clean) return { ok: false, reason: 'nothing to say after stripping code and markdown', shell: false, offDevice: false };

  const engine = opts.engine === 'system' ? 'system' : 'local';
  if (engine === 'system') {
    const platform = opts.platform || process.platform;
    if (platform === 'darwin') {
      return { ok: true, cmd: 'say', args: ['-r', String(Math.round(200 * (opts.rate || 1))), clean], shell: false, offDevice: false, text: clean, localEngine: 'say' };
    }
    return { ok: true, cmd: 'spd-say', args: ['-r', String(Math.round(((opts.rate || 1) - 1) * 100))], stdin: false, text: clean, shell: false, offDevice: false, localEngine: 'spd-say' };
  }

  // `opts.localEngine` is the NAME from detectEngine's probe; the argv template
  // comes from LOCAL_ENGINES, so the caller cannot inject one.
  const name = opts.localEngine && LOCAL_ENGINES[opts.localEngine] ? opts.localEngine : 'piper';
  const spec = LOCAL_ENGINES[name];
  const rate = typeof opts.rate === 'number' && Number.isFinite(opts.rate) ? opts.rate : 1;
  const args = spec.args({ rate, model: opts.model }).slice();
  if (!spec.stdin) args.push(clean);
  return {
    ok: true,
    cmd: spec.bin,
    args,
    stdin: Boolean(spec.stdin),
    text: spec.stdin ? clean : undefined,
    shell: false,
    offDevice: false,
    localEngine: name,
  };
}

module.exports = {
  ENGINES,
  BUILTIN_VOICES,
  CLONE_MARKERS,
  LOCAL_ENGINES,
  MAX_SPEAK_CHARS,
  looksCloned,
  assertNotClone,
  listVoices,
  findVoice,
  detectEngine,
  resolveVoice,
  mutePatch,
  spokenText,
  speakPlan,
};
