'use strict';

/**
 * avatar.js — the mount: stage, HUD, pane, and the rules that keep the avatar
 * out of everything else's way (PLAN Phase 22).
 *
 * The three modules beside this one are pure or nearly so (`parts.js` is data,
 * `assemble.js` builds a string, `hud.js` builds a view model, `machine.js`
 * owns the face's state). This file is where they meet the document, and that
 * makes it the only place the phase's non-functional promises can be kept or
 * broken:
 *
 *  1. **Never blocks input.** No key listener is registered anywhere in
 *     `renderer/avatar/`, so the avatar cannot consume a keystroke — Escape
 *     still reaches Phase 9's interrupt handler and typing still reaches the
 *     composer, whatever the avatar is doing. Painting is coalesced to at most
 *     one write per animation frame (`schedule()`), so a stream that emits
 *     fifty deltas in a frame still costs one repaint, and every entry point is
 *     wrapped: a throw inside the avatar is swallowed and reported, never
 *     propagated into the chat path. `desktop/test/electron-smoke-main.js`
 *     proves the two behaviours this protects (scroll-hold and interrupt) with
 *     the avatar mounted and streaming.
 *
 *  2. **Never claims a level it was not given.** There is no arithmetic on XP
 *     in this file. It renders whatever projection main hands it, and when main
 *     has nothing to hand it it says `level unknown` (see hud.js).
 *
 *  3. **Accessible by construction.** The SVG is `aria-hidden` +
 *     `focusable="false"` (the assembler sets it), the layer that matters is a
 *     `role="status"` text readout beside it, the XP bar is `aria-hidden` and
 *     its numbers live in that readout, and `prefers-reduced-motion` is read
 *     from the OS and forced through `persona.appliesMotion` — the same
 *     function the storage layer uses, so a persona cannot opt out of the
 *     accessibility preference.
 *
 * Source resolution is deliberately forward-compatible: `window.avatar` (the
 * Phase 21 bridge) is used when it exists, and `preview()` exists so the
 * harnesses (and the customization pane, which previews edits before anything
 * is written) can drive the avatar without it. Both are one code path — the
 * preview state is an override layer over the real one, and it is labelled as
 * such in the readout's own vocabulary (`source`), never presented as truth.
 */

const pkg = typeof window !== 'undefined' && window.AegisAvatarAssemble
  ? {
      parts: window.AegisAvatarParts,
      assemble: window.AegisAvatarAssemble.assemble,
      hud: window.AegisAvatarHud,
      machine: window.AegisAvatarMachine,
      pane: window.AegisAvatarPane,
      persona: window.AegisAvatarPersona,
    }
  : typeof module !== 'undefined' && module.exports
    ? {
        parts: require('./parts.js'),
        assemble: require('./assemble.js').assemble,
        hud: require('./hud.js'),
        machine: require('./machine.js'),
        pane: require('./pane.js'),
        persona: require('../../lib/avatar/persona.js'),
      }
    : null;

if (!pkg) throw new Error('avatar/avatar.js: the avatar modules must be loaded first');

/** How long a quiet `idle` state sits before the face dozes off. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** The clock the idle timeout is evaluated on. Not a frame loop — see §6. */
const TICK_INTERVAL_MS = 30000;

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * The data source. `window.avatar` is the preload bridge Phase 21 will expose
 * (`state()` returning `{ persona, projection, capabilities, warnings }`); when
 * it is missing the avatar renders the honest unknown state rather than
 * inventing numbers.
 */
function resolveSource(win) {
  const bridge = win && win.avatar;
  if (bridge && typeof bridge.state === 'function') {
    return {
      kind: 'main',
      reason: '',
      state: () => Promise.resolve(bridge.state()),
      set: typeof bridge.set === 'function' ? (patch) => Promise.resolve(bridge.set(patch)) : null,
    };
  }
  return {
    kind: 'none',
    reason: 'main has no avatar surface yet',
    state: () => Promise.resolve(null),
    set: null,
  };
}

/**
 * Mount the avatar.
 *
 * @param {object} input
 * @param {object} input.doc
 * @param {object} input.win
 * @param {object} input.els element handles (see ELEMENT_IDS in app.js); any
 *   missing handle is skipped rather than thrown on
 * @param {object} [input.source] override the bridge lookup (tests)
 * @param {object} [input.persona] starting persona
 * @param {object} [input.projection] starting level projection
 * @param {object} [input.capabilities] starting capabilities
 * @param {number} [input.idleTimeoutMs]
 */
function mountAvatar(input = {}) {
  const doc = input.doc;
  const win = input.win || (typeof window !== 'undefined' ? window : null);
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('mountAvatar: a document is required');
  }
  const els = input.els || {};
  const source = input.source || resolveSource(win);

  const signals = pkg.machine.createAvatarSignals({ idleTimeoutMs: input.idleTimeoutMs || IDLE_TIMEOUT_MS });

  let persona = input.persona && typeof input.persona === 'object'
    ? input.persona
    : pkg.persona
      ? pkg.persona.defaultPersona()
      : pkg.parts.defaultPersona();
  let projection = input.projection && typeof input.projection === 'object' ? input.projection : null;
  let capabilities = input.capabilities && typeof input.capabilities === 'object' ? input.capabilities : null;
  let reason = input.reason || source.reason || '';

  const overrides = { persona: null, projection: null, capabilities: null, reason: null, active: false };
  let reducedMotion = false;
  let frame = null;
  let destroyed = false;
  let lastPainting = null;
  let tickTimer = null;

  // ---- OS preference -----------------------------------------------------
  const media = safe(() => (win && typeof win.matchMedia === 'function'
    ? win.matchMedia('(prefers-reduced-motion: reduce)')
    : null), null);
  reducedMotion = Boolean(media && media.matches);
  if (media && typeof media.addEventListener === 'function') {
    safe(() => media.addEventListener('change', (event) => {
      reducedMotion = Boolean(event && 'matches' in event ? event.matches : media.matches);
      schedule();
    }));
  }

  // ---- the customization pane -------------------------------------------
  const pane = safe(() => pkg.pane.buildPane({
    doc,
    persona,
    capabilities,
    onPatch: (patch) => {
      const validated = safe(() => (pkg.persona ? pkg.persona.update(persona, patch).persona : persona), persona);
      applyPersona(validated.persona || validated, { repaint: true });
      return persist(patch);
    },
  }), null);
  if (pane && els.paneHost && typeof els.paneHost.appendChild === 'function') {
    els.paneHost.appendChild(pane.root);
  }

  /**
   * Persist a patch through the bridge. Returns the shape the pane's status
   * line prints, so "saved" is only ever shown for a write that really landed.
   */
  function persist(patch) {
    if (!source.set) return { ok: true, saved: false, reason: source.reason || 'no write surface' };
    return source.set(patch).then(
      (res) => {
        if (res && res.ok === false) return { ok: false, reason: res.reason || 'refused' };
        if (res && res.persona) applyPersona(res.persona, { repaint: false });
        return { ok: true, saved: true };
      },
      (err) => ({ ok: false, reason: (err && err.message) || 'write failed' })
    );
  }

  // ---- painting ----------------------------------------------------------
  function schedule() {
    if (destroyed) return;
    if (frame !== null) return;
    const raf = win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame : null;
    if (raf) {
      frame = safe(() => raf(paint), null);
      if (frame !== null) return;
    }
    // No rAF (a bare test document): coalesce on the microtask queue instead, so
    // the "one repaint per burst" property still holds without a timer.
    frame = 0;
    Promise.resolve().then(() => {
      frame = null;
      paint();
    });
  }

  function effective() {
    return {
      persona: overrides.active && overrides.persona ? overrides.persona : persona,
      projection: overrides.active ? overrides.projection : projection,
      capabilities: overrides.active ? overrides.capabilities : capabilities,
      reason: overrides.active && overrides.reason !== null ? overrides.reason : reason,
    };
  }

  function paint() {
    if (destroyed) return;
    const now = effective();
    const assembled = safe(
      () => pkg.assemble(now.persona, { expression: signals.expression, reducedMotion }),
      null
    );
    if (!assembled) {
      // A manifest that cannot assemble must not leave a stale face claiming to
      // be current: blank the stage and say so in the readout.
      if (els.stage) els.stage.innerHTML = '';
    } else if (els.stage) {
      // Generated markup only: ids, geometry and colour roles from the manifest.
      // No persona text ever reaches this string (see assemble.js rule 2), so
      // there is nothing here for a persona to inject through.
      els.stage.innerHTML = assembled.svg;
    }

    const model = pkg.hud.hudModel({
      persona: now.persona,
      projection: now.projection,
      capabilities: now.capabilities,
      expression: signals.expression,
      expressionLabel: signals.label,
      reason: now.reason,
    });
    safe(() => pkg.hud.renderHud(els, model));
    if (pane && typeof pane.update === 'function') safe(() => pane.update(now.persona));
    lastPainting = {
      expression: assembled ? assembled.expression : null,
      motion: assembled ? assembled.motion : null,
      warnings: assembled ? assembled.warnings.slice() : ['assemble failed'],
      missing: assembled ? assembled.missing.slice() : [],
      hud: model,
      source: overrides.active ? 'preview' : source.kind,
    };
    return lastPainting;
  }

  function applyPersona(next, opts = {}) {
    if (!next || typeof next !== 'object') return persona;
    const validated = safe(() => (pkg.persona ? pkg.persona.validate(next).persona : next), next);
    persona = validated && validated.persona ? validated.persona : validated;
    if (opts.repaint !== false) schedule();
    return persona;
  }

  // ---- reads from main ---------------------------------------------------
  function refresh() {
    if (destroyed) return Promise.resolve(null);
    return Promise.resolve(safe(() => source.state(), null)).then(
      (state) => {
        if (destroyed || !state || typeof state !== 'object') {
          if (!state && !reason) reason = source.reason || 'main has not published a level yet';
          schedule();
          return null;
        }
        if (state.persona) applyPersona(state.persona, { repaint: false });
        if (state.projection && typeof state.projection === 'object') projection = state.projection;
        else if (typeof state.level === 'number') projection = state;
        if (state.capabilities && typeof state.capabilities === 'object') capabilities = state.capabilities;
        reason = '';
        schedule();
        return state;
      },
      (err) => {
        reason = `level unavailable — ${(err && err.message) || 'read failed'}`;
        schedule();
        return null;
      }
    );
  }

  // ---- the face follows the engine ---------------------------------------
  function signal(name, meta) {
    const out = safe(() => signals.signal(name, meta), null);
    if (out) schedule();
    return out;
  }

  const api = {
    get expression() {
      return signals.expression;
    },
    get state() {
      return signals.state;
    },
    get persona() {
      return persona;
    },
    get painting() {
      return lastPainting;
    },
    signal,
    turnStart: (meta) => signal('turn.start', meta),
    stream: () => signal('turn.stream'),
    turnEnd: (meta) => signal('turn.end', meta),
    tool: (tool) => signal(pkg.machine.signalForTool(tool), { tool: pkg.machine.toolName(tool) }),
    approvalCard: () => signal('approval.card'),
    approvalDecided: () => signal('approval.decided'),
    queue: () => signal('queue.progress'),
    syncOk: () => signal('sync.ok'),
    syncError: (meta) => signal('sync.error', meta),
    poke: () => signal('poke'),
    celebrateDone: () => signal('celebrate.done'),
    reset: () => signal('reset'),
    tick: (now) => {
      const out = safe(() => signals.tick(now), null);
      if (out && out.changed) schedule();
      return out;
    },
    on: (fn) => signals.on(fn),
    setPersona: (next) => applyPersona(next),
    /** Ask main for a fresh projection (a turn that saved memory moved XP). */
    refresh,
    /**
     * The preview seam. Harnesses (the Electron smoke leg and the marketing
     * shot driver) and the pane use it to render a persona/level this process
     * was not handed by main, and `painting.source` reports it as `preview` so
     * the evidence can never read as if main had published it.
     */
    preview(next = {}) {
      overrides.active = true;
      if (next.persona) overrides.persona = next.persona;
      if ('projection' in next) overrides.projection = next.projection;
      if ('capabilities' in next) overrides.capabilities = next.capabilities;
      if ('reason' in next) overrides.reason = next.reason === undefined ? null : next.reason;
      schedule();
      return lastPainting;
    },
    clearPreview() {
      overrides.active = false;
      schedule();
      return lastPainting;
    },
    /** The readout text, for harnesses that assert on what a user would read. */
    readout() {
      return els.readout ? String(els.readout.textContent || '') : '';
    },
    destroy() {
      destroyed = true;
      if (tickTimer !== null) safe(() => win.clearInterval(tickTimer));
      tickTimer = null;
      if (pane && typeof pane.destroy === 'function') safe(() => pane.destroy());
      if (els.stage) els.stage.innerHTML = '';
    },
  };

  // ---- the idle clock ----------------------------------------------------
  // One 30s interval for the doze timeout — not a frame loop. §6 of the plan
  // spells out why: "pure SVG, no WebGL, no per-frame work". The interval only
  // evaluates a comparison; it paints only when the machine actually changes.
  if (win && typeof win.setInterval === 'function') {
    tickTimer = safe(() => win.setInterval(() => api.tick(Date.now()), TICK_INTERVAL_MS), null);
  }

  schedule();
  return api;
}

const API = Object.freeze({ mountAvatar, resolveSource, IDLE_TIMEOUT_MS, TICK_INTERVAL_MS });

if (typeof module !== 'undefined' && module.exports) module.exports = API;
else if (typeof globalThis !== 'undefined') globalThis.AegisAvatar = API;
