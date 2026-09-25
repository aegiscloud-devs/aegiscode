'use strict';

/**
 * pane.js — the customization pane (PLAN Phase 22, spec §3).
 *
 * The whole pane is BUILT FROM THE MANIFEST. Every select is a list of
 * `persona.PARTS` ids, every label comes from `parts.LABELS` (and falls back to
 * the raw id when a label is missing), every number bound comes from
 * `persona.LIMITS`. There is not one `if (part === 'hoodie')` in this file, and
 * that is the phase's contract: adding a part is adding an entry to the
 * manifest, and `desktop/test/avatar-pane.test.mjs` proves it by handing the
 * pane a manifest with an extra hair id and asserting the control grew a new
 * option with no code change anywhere.
 *
 * Three decisions worth stating, because the alternatives are the usual bugs:
 *
 *  1. **Previewing is not saving.** The pane always edits a live, in-memory
 *     persona and re-renders, so the user can try things on; whether that
 *     reaches disk is a separate answer (`onPatch`'s return) which the pane
 *     shows verbatim in its status line. A control that looks like it saved
 *     when nothing was written is the exact defect this avoids.
 *  2. **Cosmetics follow the level table, not this file.** An outfit or pack is
 *     disabled only when main says the id is not unlocked (`capabilities
 *     .cosmeticsUnlocked`). No capabilities ⇒ NO gating at all, because a pane
 *     that invents a lock is as wrong as one that invents an unlock.
 *  3. **Nothing here touches input routing.** No key handlers, no focus trap, no
 *     `preventDefault`, no modal. The pane is a plain block of form controls in
 *     the sidebar; opening or closing it cannot consume a keystroke meant for
 *     the composer, and the Escape-interrupt path stays exactly where Phase 9
 *     put it.
 */

'use strict';

const pkg = typeof window !== 'undefined' && window.AegisAvatarParts
  ? { parts: window.AegisAvatarParts, persona: window.AegisAvatarPersona || null }
  : typeof module !== 'undefined' && module.exports
    ? { parts: require('./parts.js'), persona: require('../../lib/avatar/persona.js') }
    : { parts: null, persona: null };

if (!pkg.parts) throw new Error('avatar/pane.js: avatar/parts.js must be loaded first');

/**
 * Cosmetic id → unlock id. Persona ids and unlock ids are not the same
 * vocabulary (a seasonal SET is `seasonal-winter` in the persona and
 * `outfit.seasonal` in `level.js`), so the few that differ are named here and
 * everything else follows the obvious `<kind>.<id>` rule. An unlock id that the
 * level table does not list at all is treated as FREE — see rule 2 above.
 */
const UNLOCK_ALIASES = Object.freeze({
  'outfit.seasonal-winter': 'outfit.seasonal',
  'outfit.archive-coat': 'outfit.archive',
});

/**
 * Facial kinds are cosmetics and may be gated by level. Everything else
 * (frame, skin, hair, eyes, motion, size, proactivity, engine) is part of the
 * companion the user already has — the level table sells cosmetics only, and a
 * pane that locks a non-cosmetic would be inventing a paywall (spec §3).
 */
const GATED_KINDS = Object.freeze(new Set(['outfit', 'palette', 'expressions']));

/** Labels for the register/voice controls. The `en` keys are the persona's. */
const FIELD_LABELS = Object.freeze({
  formality: 'Formality',
  humor: 'Humour',
  verbosity: 'Verbosity',
  proactivity: 'Proactivity',
  address: 'Addresses you as',
  emojis: 'Use emojis',
  enabled: 'Voice',
  engine: 'Voice engine',
  voiceId: 'Voice id',
  rate: 'Rate',
  motion: 'Motion',
  size: 'Size',
  docked: 'Dock in the sidebar',
  hairColor: 'Hair colour',
  pack: 'Expression pack',
});

function readPath(source, path) {
  let node = source;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/** Turn a `['presentation','hair']` path + value into a persona-shaped patch. */
function patchFor(path, value) {
  const patch = {};
  let node = patch;
  for (let i = 0; i < path.length; i += 1) {
    if (i === path.length - 1) node[path[i]] = value;
    else {
      node[path[i]] = {};
      node = node[path[i]];
    }
  }
  return patch;
}

/** `<div class="avatar-field" data-path="presentation.hair">` and friends. */
function make(doc, tag, attrs, text) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (node.setAttribute) node.setAttribute(k, String(v));
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/**
 * Build the pane.
 *
 * @param {object} input
 * @param {object} input.doc the document to build into
 * @param {object} input.persona the starting persona (validated or raw)
 * @param {object} [input.manifest] `avatar/parts.js` — injectable so a test can
 *   extend the manifest and watch the pane follow
 * @param {object} [input.capabilities] `level.capabilities()` output, for the
 *   cosmetics gate only
 * @param {function} [input.onPatch] called with a persona-shaped patch for every
 *   change; its return value (or promise) is what the status line reports
 */
function buildPane(input = {}) {
  const doc = input.doc;
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('buildPane: a document is required');
  }
  const manifest = input.manifest || pkg.parts;
  const limits = (pkg.persona && pkg.persona.LIMITS) || { name: 40, address: 32, voiceId: 64 };
  const maxLayers = (pkg.persona && pkg.persona.MAX_OUTFIT_LAYERS) || 3;

  let persona = input.persona && typeof input.persona === 'object'
    ? input.persona
    : pkg.persona
      ? pkg.persona.defaultPersona()
      : manifest.defaultPersona();

  const unlocked = input.capabilities && Array.isArray(input.capabilities.cosmeticsUnlocked)
    ? new Set(input.capabilities.cosmeticsUnlocked)
    : null;

  const controls = [];
  const root = make(doc, 'div', { class: 'avatar-pane', id: 'avatar-pane' });

  /** Is this cosmetic available? Unknown capabilities never gate anything. */
  function cosmeticState(kind, id) {
    if (kind === 'expressionPack' || kind === 'expressions') kind = 'expressions';
    const unlockId = UNLOCK_ALIASES[`${kind}.${id}`] || `${kind}.${id}`;
    if (!GATED_KINDS.has(kind)) return { id: unlockId, known: false, unlocked: true };
    if (!unlocked) return { id: unlockId, known: false, unlocked: true };
    return { id: unlockId, known: true, unlocked: unlocked.has(unlockId) };
  }

  /** The unlock id behind a pack id, for the pack select's label. */
  function packNote(id) {
    const state = cosmeticState('expressions', id);
    return state.known && !state.unlocked ? `locked · needs ${state.id}` : '';
  }

  function label(kind, id) {
    const table = manifest.LABELS && manifest.LABELS[kind];
    return (table && table[id]) || String(id);
  }

  /** One `<select>` whose options ARE a manifest id list. */
  function selectField(group, kindKey, path, kind) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': path.join('.') });
    const labelNode = make(doc, 'label', { class: 'avatar-label' }, FIELD_LABELS[kindKey] || kindKey);
    const control = make(doc, 'select', { id: `avatar-${kind}-${path.join('-')}`, class: 'avatar-select' });
    const ids = manifest.IDS[kind] || [];
    for (const id of ids) {
      const state = cosmeticState(kind, id);
      const option = make(doc, 'option', { value: id }, label(kind, id));
      option.value = id;
      if (!state.unlocked) {
        option.disabled = true;
        option.textContent = `${label(kind, id)} · locked`;
      }
      control.appendChild(option);
    }
    control.value = String(readPath(persona, path));
    const note = make(doc, 'span', { class: 'avatar-field-note' });
    const record = { path, kind, control, tag: 'select', group };
    control.addEventListener('change', () => {
      const state = cosmeticState(kind, control.value);
      if (!state.unlocked) {
        // Refused rather than applied: the option is disabled, but a programmatic
        // change can still set it, and a silent "saved" for a locked cosmetic is
        // the dishonesty this branch exists to prevent.
        note.textContent = `${label(kind, control.value)} is not unlocked yet (${state.id})`;
        emit(record, readPath(persona, path));
        return;
      }
      note.textContent = '';
      emit(record, control.value);
    });
    controls.push(record);
    field.appendChild(labelNode);
    field.appendChild(control);
    field.appendChild(note);
    return { field, control };
  }

  function rangeField(group, key, path, { min, max, step, format }) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': path.join('.') });
    const value = readPath(persona, path);
    const valueNode = make(doc, 'span', { class: 'avatar-value' }, format ? format(value) : String(value));
    const labelNode = make(doc, 'label', { class: 'avatar-label' }, FIELD_LABELS[key] || key);
    const control = make(doc, 'input', {
      type: 'range',
      id: `avatar-${key}`,
      min: String(min),
      max: String(max),
      step: String(step),
    });
    control.value = String(value);
    const record = { path, kind: key, control, tag: 'input', group };
    control.addEventListener('input', () => {
      valueNode.textContent = format ? format(control.value) : String(control.value);
      emit(record, Number(control.value));
    });
    controls.push(record);
    field.appendChild(labelNode);
    field.appendChild(control);
    field.appendChild(valueNode);
    return { field, control };
  }

  function toggleField(group, key, path) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': path.join('.') });
    const control = make(doc, 'input', { type: 'checkbox', id: `avatar-${key}` });
    control.checked = readPath(persona, path) === true;
    const labelNode = make(doc, 'label', { class: 'avatar-label', for: `avatar-${key}` }, FIELD_LABELS[key] || key);
    const record = { path, kind: key, control, tag: 'input', group };
    control.addEventListener('change', () => emit(record, control.checked === true));
    controls.push(record);
    field.appendChild(control);
    field.appendChild(labelNode);
    return { field, control };
  }

  function textField(group, key, path, maxLength) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': path.join('.') });
    const labelNode = make(doc, 'label', { class: 'avatar-label' }, FIELD_LABELS[key] || key);
    const control = make(doc, 'input', { type: 'text', id: `avatar-${key}`, maxlength: maxLength });
    control.value = String(readPath(persona, path) || '');
    const record = { path, kind: key, control, tag: 'input', group };
    control.addEventListener('change', () => emit(record, String(control.value).slice(0, maxLength)));
    controls.push(record);
    field.appendChild(labelNode);
    field.appendChild(control);
    return { field, control };
  }

  function colorField(group, key, path) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': path.join('.') });
    const labelNode = make(doc, 'label', { class: 'avatar-label' }, FIELD_LABELS[key] || key);
    const control = make(doc, 'input', { type: 'color', id: `avatar-${key}` });
    control.value = String(readPath(persona, path) || '#3b2a20');
    const record = { path, kind: key, control, tag: 'input', group };
    control.addEventListener('change', () => emit(record, String(control.value).toLowerCase()));
    controls.push(record);
    field.appendChild(labelNode);
    field.appendChild(control);
    return { field, control };
  }

  /** Outfit multi-select, capped by `persona.MAX_OUTFIT_LAYERS` (spec §2). */
  function outfitField(group) {
    const field = make(doc, 'div', { class: 'avatar-field', 'data-path': 'presentation.outfit' });
    field.appendChild(make(doc, 'div', { class: 'avatar-label' }, 'Outfit (up to ' + maxLayers + ' layers)'));
    const chosen = Array.isArray(readPath(persona, ['presentation', 'outfit']))
      ? readPath(persona, ['presentation', 'outfit']).slice()
      : [];
    const boxes = [];
    const note = make(doc, 'span', { class: 'avatar-field-note' });
    for (const id of manifest.IDS.outfit || []) {
      const state = cosmeticState('outfit', id);
      const row = make(doc, 'div', { class: 'avatar-check' });
      const box = make(doc, 'input', { type: 'checkbox', id: `avatar-outfit-${id}` });
      box.checked = chosen.includes(id);
      box.disabled = !state.unlocked;
      const labelNode = make(doc, 'label', { for: `avatar-outfit-${id}` }, label('outfit', id) + (state.unlocked ? '' : ' · locked'));
      const record = { path: ['presentation', 'outfit'], kind: 'outfitLayer', control: box, tag: 'input', group, id };
      box.addEventListener('change', () => {
        const current = Array.isArray(readPath(persona, ['presentation', 'outfit']))
          ? readPath(persona, ['presentation', 'outfit']).slice()
          : [];
        let next;
        if (box.checked) {
          if (current.length >= maxLayers) {
            // Refuse, uncheck the box, and say why. Silently dropping the oldest
            // layer would look like the click worked.
            box.checked = false;
            note.textContent = `at most ${maxLayers} outfit layers (earned at level 5)`;
            return;
          }
          next = current.concat([id]);
        } else {
          next = current.filter((x) => x !== id);
        }
        note.textContent = '';
        emit(record, next);
      });
      controls.push(record);
      boxes.push(box);
      row.appendChild(box);
      row.appendChild(labelNode);
      field.appendChild(row);
    }
    field.appendChild(note);
    return { field, control: boxes };
  }

  function group(title, key) {
    const node = make(doc, 'div', { class: 'avatar-group', 'data-group': key });
    node.appendChild(make(doc, 'div', { class: 'avatar-group-title' }, title));
    root.appendChild(node);
    return node;
  }

  // ---- presentation ------------------------------------------------------
  const presentation = group('Presentation', 'presentation');
  presentation.appendChild(selectField('presentation', 'frame', ['presentation', 'frame'], 'frame').field);
  presentation.appendChild(selectField('presentation', 'skin', ['presentation', 'skin'], 'skin').field);
  presentation.appendChild(selectField('presentation', 'hair', ['presentation', 'hair'], 'hair').field);
  presentation.appendChild(colorField('presentation', 'hairColor', ['presentation', 'hairColor']).field);
  presentation.appendChild(selectField('presentation', 'eyes', ['presentation', 'eyes'], 'eyes').field);
  presentation.appendChild(selectField('presentation', 'palette', ['presentation', 'palette'], 'palette').field);
  presentation.appendChild(outfitField('presentation').field);

  // ---- expressions -------------------------------------------------------
  const expressions = group('Expressions', 'expressions');
  expressions.appendChild(selectField('expressions', 'pack', ['expressions', 'pack'], 'expressionPack').field);

  // ---- voice -------------------------------------------------------------
  const voice = group('Voice', 'voice');
  voice.appendChild(toggleField('voice', 'enabled', ['voice', 'enabled']).field);
  voice.appendChild(selectField('voice', 'engine', ['voice', 'engine'], 'voiceEngine').field);
  voice.appendChild(textField('voice', 'voiceId', ['voice', 'id'], limits.voiceId || 64).field);
  voice.appendChild(rangeField('voice', 'rate', ['voice', 'rate'], { min: 0.5, max: 2, step: 0.1, format: (v) => `${Number(v).toFixed(1)}×` }).field);

  // ---- register ----------------------------------------------------------
  const register = group('Register', 'register');
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  register.appendChild(rangeField('register', 'formality', ['register', 'formality'], { min: 0, max: 1, step: 0.05, format: pct }).field);
  register.appendChild(rangeField('register', 'humor', ['register', 'humor'], { min: 0, max: 1, step: 0.05, format: pct }).field);
  register.appendChild(rangeField('register', 'verbosity', ['register', 'verbosity'], { min: 0, max: 1, step: 0.05, format: pct }).field);
  register.appendChild(selectField('register', 'proactivity', ['register', 'proactivity'], 'proactivity').field);
  register.appendChild(textField('register', 'address', ['register', 'address'], limits.address || 32).field);
  register.appendChild(toggleField('register', 'emojis', ['register', 'emojis']).field);

  // ---- appearance --------------------------------------------------------
  const appearance = group('Appearance', 'appearance');
  appearance.appendChild(selectField('appearance', 'motion', ['appearance', 'motion'], 'motion').field);
  appearance.appendChild(selectField('appearance', 'size', ['appearance', 'size'], 'size').field);
  appearance.appendChild(toggleField('appearance', 'docked', ['appearance', 'docked']).field);

  // ---- status ------------------------------------------------------------
  const status = make(doc, 'p', { class: 'avatar-pane-status', id: 'avatar-pane-status', role: 'status' });
  root.appendChild(status);

  /** Every control fires through here, so "preview vs saved" has ONE answer. */
  function emit(record, value) {
    persona = pkg.persona ? pkg.persona.validate(merge(persona, patchFor(record.path, value))).persona : persona;
    const patch = patchFor(record.path, value);
    let result;
    try {
      result = typeof input.onPatch === 'function' ? input.onPatch(patch, { persona, record }) : undefined;
    } catch (err) {
      result = { ok: false, reason: (err && err.message) || 'change handler threw' };
    }
    Promise.resolve(result).then(
      (res) => {
        if (res && res.ok) setStatus(res.saved === false ? 'preview only' : 'saved');
        else if (res && res.reason) setStatus(`not saved — ${res.reason}`);
        else if (res === undefined) setStatus('');
        else setStatus('preview only');
      },
      (err) => setStatus(`not saved — ${(err && err.message) || 'error'}`)
    );
    return persona;
  }

  function setStatus(text) {
    status.textContent = String(text || '');
    status.hidden = !text;
  }

  function merge(base, patch) {
    const out = {};
    for (const key of ['identity', 'presentation', 'expressions', 'voice', 'register', 'appearance']) {
      out[key] = Object.assign({}, base[key], patch[key]);
    }
    return out;
  }

  return {
    root,
    controls,
    status,
    get persona() {
      return persona;
    },
    /** Reset every control to a persona (used when main's copy wins). */
    update(next) {
      if (!next || typeof next !== 'object') return persona;
      persona = next;
      for (const record of controls) {
        const value = readPath(persona, record.path);
        if (record.tag === 'select') record.control.value = String(value);
        else if ((record.control.type || '') === 'checkbox') record.control.checked = value === true;
        else if (Array.isArray(value) && record.kind === 'outfitLayer') record.control.checked = value.includes(record.id);
        else record.control.value = String(value);
      }
      return persona;
    },
    setStatus,
    destroy() {
      if (root.parentNode && root.parentNode.removeChild) root.parentNode.removeChild(root);
    },
  };
}

const API = Object.freeze({ buildPane, patchFor, readPath, UNLOCK_ALIASES, FIELD_LABELS });

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatarPane = API;
