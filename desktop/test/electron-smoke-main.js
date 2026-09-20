'use strict';

/**
 * Headless Electron smoke driver — PLAN Phase 9 (P3.6).
 *
 * This is the *main process* of a throwaway Electron run. It requires the real
 * `desktop/main.js` (so the genuine host boots: real window, real preload, real
 * IPC, real LocalEngine, real renderer app.js) and then drives a streamed turn
 * in the real renderer over a **stubbed transport**: the wrapper that spawns
 * this file (`test/electron-smoke.mjs`) runs a loopback HTTP SSE server and
 * points the shared client at it via `AEGIS_API_BASE`. Nothing here reaches a
 * provider, needs a real key, or opens a socket off 127.0.0.1.
 *
 * Never run this directly — it refuses to start unless AEGIS_SMOKE=1 and
 * AEGIS_API_BASE is a loopback origin, so a stray invocation can never turn
 * into live provider spend.
 *
 * What it proves, in the DOM of the real app (not a mock of it):
 *   1. scrolling up mid-stream holds the reader's position (the follow-the-tail
 *      veto is wired to the real scroll listener);
 *   2. Escape stops a running turn (renderer keydown -> models.cancel -> engine
 *      AbortController -> the in-flight fetch on the stubbed transport);
 *   3. the partial answer is salvaged and labelled `stopped by you` instead of
 *      being destroyed, and no further chunks land after the stop.
 *
 * Evidence leaves on stdout as one `SMOKE_EVIDENCE {json}` line; the wrapper
 * asserts on it (and on what its own stub server saw) and owns the exit code
 * the CI job reads. Any failed check here exits non-zero too.
 */

const { app, BrowserWindow } = require('electron');

// ---------------------------------------------------------------------------
// Safety rails — refuse to boot against anything that is not the local stub.
// ---------------------------------------------------------------------------
const apiBase = process.env.AEGIS_API_BASE || '';
const loopback = /^http:\/\/127\.0\.0\.1:\d+$/.test(apiBase);
if (process.env.AEGIS_SMOKE !== '1' || !loopback) {
  console.error(
    'electron-smoke-main: refusing to run. Needs AEGIS_SMOKE=1 and a loopback ' +
      `AEGIS_API_BASE (got ${JSON.stringify(apiBase)}). Use test/electron-smoke.mjs.`
  );
  process.exit(2);
}

// How many characters the stub would send if its stream ran to completion.
// This is the yardstick for "was the answer cut short". Do NOT substitute what
// the socket had written at abort time — the renderer has usually already
// consumed the last frame it wrote, so the two lengths tie and the comparison
// fails at random. Refuse to guess: a missing value would silently become 0 and
// make `partial-not-whole` unfalsifiable, which is the exact bug class this
// phase exists to stamp out.
const COMPLETE_TEXT_LEN = Number(process.env.AEGIS_SMOKE_COMPLETE_LEN);
if (!Number.isFinite(COMPLETE_TEXT_LEN) || COMPLETE_TEXT_LEN <= 0) {
  console.error(
    'electron-smoke-main: AEGIS_SMOKE_COMPLETE_LEN must be a positive number ' +
      `(got ${JSON.stringify(process.env.AEGIS_SMOKE_COMPLETE_LEN)}). Use test/electron-smoke.mjs.`
  );
  process.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');

// ── cancel instrumentation (main process) ───────────────────────────────
// Counting `models.cancel()` from the page is impossible: preload.js does
// `contextBridge.exposeInMainWorld('models', Object.freeze(models))`, so the
// bridge object and every method on it are non-writable and the context is
// non-extensible. A page-level wrapper silently does not install, and the
// counter then reads 0 forever — an assertion that can never fail. Instrument
// the layer underneath instead: main.js destructures `createLocalEngine` at
// load time and its `cancel` handler does a call-time `engine.cancel(...)`
// lookup, so wrapping the factory BEFORE main.js is required intercepts the
// real abort while leaving the page's frozen surface untouched.
const engineModule = require('../lib/local/engine.js');
const realCreateLocalEngine = engineModule.createLocalEngine;
let engineCancelCount = 0;
engineModule.createLocalEngine = function instrumentedCreateLocalEngine(...args) {
  const engine = realCreateLocalEngine.apply(this, args);
  const realCancel = engine.cancel;
  engine.cancel = function countedCancel(...cancelArgs) {
    engineCancelCount += 1;
    return realCancel.apply(this, cancelArgs);
  };
  return engine;
};

// Boot the REAL host. main.js registers its own app.whenReady() handler and
// creates the window there; ours below runs after it and waits for the window.
require('../main.js');

const checks = [];
const consoleErrors = [];

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) console.error(`SMOKE_FAIL ${name}: ${detail}`);
  return Boolean(ok);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 20000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = await fn();
    } catch (err) {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/** Run a function body inside the REAL renderer's world and return its value. */
function js(win, body) {
  return win.webContents.executeJavaScript(`(function(){${HELPERS}${body}})()`, true);
}

/** Whitespace-insensitive comparison form: markdown rendering rewraps text. */
function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * How the driver finds the turn that is running right now.
 *
 * Not `.pending`: app.js clears that class on the first paint (`paintStream`
 * removes it so the typing dots stop), so mid-stream it is already gone. The
 * cancel button is the real marker — it exists for exactly as long as a
 * cancellable turn is in flight and disappears with the bubble when the turn
 * ends (`setBusy(false)` removes the whole row).
 */
const HELPERS = `
  function liveRow() {
    var rows = document.querySelectorAll('#messages .msg');
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].querySelector('.cancel-btn')) return rows[i];
    }
    return null;
  }
  function liveText() {
    var r = liveRow();
    if (!r) return '';
    var b = r.querySelector('.body');
    return b ? b.textContent : '';
  }
  function liveReasoning() {
    var r = liveRow();
    if (!r) return '';
    var el = r.querySelector('.reasoning');
    return el ? el.textContent : '';
  }
`;

const PREPARE = `
  var out = {};
  var messages = document.getElementById('messages');
  var explore = document.getElementById('explore-toggle');
  // The discovery lane would open its own concurrent streams after the turn;
  // off, so exactly one pending turn exists to interrupt.
  if (explore && explore.checked) {
    explore.checked = false;
    explore.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var sel = document.getElementById('class-select');
  if (sel.value !== 'aegis') {
    sel.value = 'aegis';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  out.cls = sel.value;
  out.explore = explore ? explore.checked : null;
  out.options = Array.prototype.map.call(sel.options, function (o) { return o.value; });
  document.getElementById('prompt').value = 'SMOKE: please stream a long answer.';
  // The real send path: the composer's submit handler, same as clicking Send.
  document.getElementById('composer').requestSubmit();
  out.sendDisabled = document.getElementById('send').disabled;
  return out;
`;

const MEASURE = (label) => `
  var m = document.getElementById('messages');
  var text = liveText();
  var hook = window.__aegisSmoke;
  var t = (hook && typeof hook.isScrolledUp === 'function') ? hook.isScrolledUp() : null;
  var meterEl = document.getElementById('session-meter');
  return {
    label: ${JSON.stringify(label)},
    scrollTop: m.scrollTop,
    scrollHeight: m.scrollHeight,
    clientHeight: m.clientHeight,
    textLen: text.length,
    liveTurn: Boolean(liveRow()),
    scrolledUpFlag: t,
    msgs: document.querySelectorAll('#messages .msg').length,
    // Read live, while this turn is still streaming — the exact moment the
    // meter used to sit frozen on the previous turn's total (or hidden, on a
    // session's first turn) until the reply finished.
    sessionMeter: meterEl ? { text: meterEl.textContent, hidden: Boolean(meterEl.hidden) } : { missing: true }
  };
`;

const SCROLL_UP = `
  var m = document.getElementById('messages');
  // Establish a genuine tail first. Scrolling "up" from an offset that is
  // already 0 is a no-op, and an earlier revision of this driver asserted
  // \`m.scrollTop === 0\` right after setting it — a check that could only ever
  // pass, which is how it reported a hold that never happened.
  m.scrollTop = m.scrollHeight;
  var tailTop = m.scrollTop;
  m.dispatchEvent(new Event('scroll', { bubbles: false }));
  // Exactly what a user reading history produces: a scroll to an earlier
  // offset, announced with a scroll event on the transcript element.
  m.scrollTop = 0;
  m.dispatchEvent(new Event('scroll', { bubbles: false }));
  return {
    moved: tailTop > 0 && m.scrollTop === 0,
    tailTop: tailTop,
    scrollTop: m.scrollTop,
    scrollHeight: m.scrollHeight,
    clientHeight: m.clientHeight
  };
`;

const ESCAPE = `
  var lenBefore = liveText().length;
  var ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(ev);
  return { textAtEscape: lenBefore, defaultPrevented: ev.defaultPrevented };
`;

// Two keydowns in ONE evaluation, with no await between them: a genuine double
// press, not two presses a polling interval apart. The detail returned is the
// `defaultPrevented` of each, which is how "the second press still reached the
// handler and was refused there" is told apart from "the second press never
// got dispatched" — two very different failures.
const DOUBLE_ESCAPE = `
  var a = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  var b = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(a);
  document.dispatchEvent(b);
  return { first: a.defaultPrevented, second: b.defaultPrevented };
`;

// Start a turn through the real composer, like a user pressing Send. The class
// is left alone: these legs run while Aegis Cloud is already selected.
const startTurn = (prompt) => `
  var out = {};
  var explore = document.getElementById('explore-toggle');
  if (explore && explore.checked) {
    explore.checked = false;
    explore.dispatchEvent(new Event('change', { bubbles: true }));
  }
  document.getElementById('prompt').value = ${JSON.stringify(prompt)};
  document.getElementById('composer').requestSubmit();
  out.sendDisabled = document.getElementById('send').disabled;
  return out;
`;

// Every bubble the transcript is carrying, split by what its meta says. Counted
// rather than sampled: the re-entrancy claims are all "exactly one more", and a
// count is the only shape that can fail when a duplicate appears.
const BUBBLE_TALLY = `
  function tally(needle) {
    var n = 0;
    var rows = document.querySelectorAll('#messages .msg');
    Array.prototype.forEach.call(rows, function (r) {
      var m = r.querySelector('.meta');
      if (m && m.textContent.indexOf(needle) !== -1) n += 1;
    });
    return n;
  }
  return {
    stopped: tally('stopped by you'),
    errors: tally('request failed'),
    sendDisabled: document.getElementById('send').disabled
  };
`;

// The stopped-bubble state: how many stopped bubbles exist, and what the last
// one says. Both halves of the honesty claim live here, because a bubble that
// is labelled but empty is the exact defect the reasoning-only leg exists for.
//
// The COUNT is the load-bearing half, and it is why this replaced a bare
// last-stopped lookup read straight into a `waitFor`. Three earlier legs have
// already left stopped bubbles in the transcript, so that lookup was truthy the
// instant it was asked and the wait returned the SUCCESSOR bubble without
// waiting at all. The reasoning-only leg then asserted against a turn it never
// drove, and read as a product failure roughly one run in three. Callers anchor
// on "one more stopped bubble than before", which makes the wait wait for this
// leg own bubble.
//
// The wait deliberately does NOT test the label. Waiting on the assertion would
// make the assertion unfalsifiable, which is the same defect in a new costume.
const STOPPED_STATE = `
  var s = { count: 0, meta: '', body: '' };
  var rows = document.querySelectorAll('#messages .msg');
  Array.prototype.forEach.call(rows, function (r) {
    var m = r.querySelector('.meta');
    if (m && m.textContent.indexOf('stopped by you') !== -1) {
      s.count += 1;
      var b = r.querySelector('.body');
      s.meta = m.textContent;
      s.body = b ? b.textContent : '';
    }
  });
`;

// Poll the stopped-bubble state until it holds at least `minCount` of them, or
// the deadline passes — then return what was actually seen. Returning rather
// than throwing keeps the observed meta and count in the failure detail, so a
// miss reads as "count 3 -> 3, meta=..." instead of a bare timeout.
async function pollStopped(win, minCount, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await js(win, STOPPED_STATE + 'return s;');
    if (seen.count >= minCount || Date.now() > deadline) return seen;
    await sleep(100);
  }
}

// The tally, but only once the turn has finished unwinding: `waitFor` needs a
// falsy value to keep polling, and "Send is disabled" is the honest signal that
// teardown is still in flight. Composed from BUBBLE_TALLY rather than re-stated
// so the two can never drift apart.
const SETTLED_TALLY = `
  if (document.getElementById('send').disabled) return null;
` + BUBBLE_TALLY;

// Counts how many times the renderer actually asked the transport to abort.
//
// This exists because the DOM cannot see the difference the double-press leg
// claims to be about: aborting an already-aborted controller is a no-op, so two
// presses through the guard and two presses around it leave an identical
// transcript. Measured directly instead: `window.models` is the same object
// app.js closes over, and `models.cancel(...)` is a property lookup at call
// time, so replacing it here intercepts the real call. One press that reached
// the body increments once; a refused second press does not.
// Reads the main-process counter installed above. This is a real measurement:
// the wrapper sits on the engine the renderer's stop path actually reaches.
const CANCEL_COUNT = () => engineCancelCount;

const CAPTURE = `
  function bodyOf(row) {
    var b = row.querySelector('.body');
    return b ? b.textContent : '';
  }
  var all = document.querySelectorAll('#messages .msg');
  var rows = Array.prototype.map.call(all, function (r) {
    var meta = r.querySelector('.meta');
    return {
      role: r.className,
      meta: meta ? meta.textContent : '',
      textLength: bodyOf(r).length,
      liveTurn: Boolean(r.querySelector('.cancel-btn'))
    };
  });
  var stopped = null;
  for (var i = 0; i < all.length; i++) {
    var m = all[i].querySelector('.meta');
    if (m && m.textContent.indexOf('stopped by you') !== -1) { stopped = bodyOf(all[i]); break; }
  }
  return {
    rows: rows,
    stoppedText: stopped,
    stoppedLength: stopped ? stopped.length : -1,
    pendingLeft: document.querySelectorAll('#messages .msg .cancel-btn').length,
    errorRows: Array.prototype.filter.call(all, function (r) {
      var m = r.querySelector('.meta');
      return m && /request failed|Error:/i.test(m.textContent + ' ' + bodyOf(r));
    }).length,
    sendDisabled: document.getElementById('send').disabled,
    textLen: liveText().length,
    // The rolling session meter. Read from the real topbar node, not from a
    // re-derivation of the math: the whole failure mode this guards against is
    // a correct counter that never reaches the DOM.
    sessionMeter: (function () {
      var el = document.getElementById('session-meter');
      if (!el) return { missing: true };
      return { text: el.textContent, hidden: Boolean(el.hidden) };
    })()
  };
`;

/** Last-resort DOM snapshot, so a timeout is diagnosable from CI logs alone. */
const DIAGNOSE = `
  var all = document.querySelectorAll('#messages .msg');
  return {
    rows: Array.prototype.map.call(all, function (r) {
      var b = r.querySelector('.body');
      var meta = r.querySelector('.meta');
      return {
        role: r.className,
        len: b ? b.textContent.length : -1,
        meta: meta ? meta.textContent.slice(0, 80) : ''
      };
    }),
    classOptions: (function () {
      var s = document.getElementById('class-select');
      return s ? Array.prototype.map.call(s.options, function (o) { return o.value; }) : null;
    })(),
    classValue: (document.getElementById('class-select') || {}).value,
    modelValue: (document.getElementById('model-select') || {}).value,
    hint: (document.getElementById('model-hint') || {}).textContent,
    promptValue: (document.getElementById('prompt') || {}).value,
    sendDisabled: (document.getElementById('send') || {}).disabled,
    messagesHTML: document.getElementById('messages').innerHTML.slice(0, 500)
  };
`;

/**
 * The third leg of the local-only endpoint policy (lib/local/endpoints.js).
 *
 * The policy refuses a remote base URL at two seams: the settings store (so the
 * unusable row cannot be CREATED) and dispatch (so a row hand-edited onto disk
 * cannot be DIALED). Neither seam can help a user who already has such a row —
 * the class simply stops working, with no way out of the Settings pane, because
 * saving a remote URL is exactly what is refused. That recovery is the
 * renderer's job: clicking a Model-card preset on a BLOCKED class must REPLACE
 * the refused URL. It is the one case applyCustomPreset() may overwrite a
 * configured endpoint (see blockedCustomClasses); every other click must still
 * refuse to clobber, or a stray preset click could silently repoint a working
 * local server.
 *
 * Asserted in the REAL DOM, because the failure mode is a silent no-op:
 * applyCustomPreset() returns early when its `row.querySelector('.setting-base')`
 * lookup comes back empty, so a selector that drifted from buildSettingRow()'s
 * markup would leave the row permanently unrepairable while every unit test
 * stayed green. Only renderSettings()'s actual output can prove the two agree.
 *
 * The refused row is seeded through the settings FILE rather than the Settings
 * pane — deliberately: the storage seam now refuses to write a remote URL, so a
 * hand-edited settings.json IS the state under test. lib/settings.js re-reads
 * the file on every get(), so the STORE sees this write immediately — but the
 * settings PANE rows are only built by loadSettings(), which runs at boot and
 * after a save, so the reload below is what puts the seeded URL into the field.
 */
async function presetRepairPhase(win) {
  const fs = require('fs');
  const path = require('path');

  // A remote URL: refused by the policy. A local URL that no preset names, so
  // the "never clobber" branch has something to preserve.
  const REFUSED = 'https://api.z.ai/v1';
  const REPAIR = 'http://127.0.0.1:11434/v1';
  const KEPT = 'http://127.0.0.1:9999';

  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch {
    /* first boot in this temp profile: nothing stored yet */
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...stored,
        'openai-compat': { ...(stored['openai-compat'] || {}), baseURL: REFUSED },
        anthropic: { ...(stored.anthropic || {}), baseURL: KEPT },
      },
      null,
      2
    ),
    { mode: 0o600 }
  );

  // Reload THROUGH THE REAL BOOT PATH before touching anything.
  //
  // The rows in the Settings pane are rendered by loadSettings(), which runs at
  // renderer boot and after a save — never on a file change. Writing
  // settings.json behind a running app therefore leaves the pane displaying the
  // STARTUP config, and that is not a cosmetic detail here: the branch under
  // test reads the FIELD's value (`current: baseInput.value.trim()` in
  // applyCustomPreset), so a stale row makes both subjects of this leg
  // meaningless — the refused URL was never in the field, and neither was the
  // endpoint the "never clobber" rule is supposed to protect. Reloading re-runs
  // init() → loadSettings() against the seeded file, which IS the state a user
  // who already has such a row boots into.
  win.webContents.reload();
  await waitFor(
    () =>
      js(
        win,
        "var s=document.getElementById('class-select'); return s && s.options.length > 0 ? s.options.length : 0;"
      ),
    'renderer reboot on the seeded settings'
  );

  const selectClass = (cls) =>
    js(
      win,
      `var s = document.getElementById('class-select');
       s.value = ${JSON.stringify(cls)};
       s.dispatchEvent(new Event('change', { bubbles: true }));
       return s.value;`
    );

  const READ = `
    var cls = document.getElementById('class-select').value;
    var row = document.querySelector('#settings-list .setting-row[data-provider="' + cls + '"]');
    var base = row ? row.querySelector('.setting-base') : null;
    var preset = document.getElementById('model-preset');
    return {
      cls: cls,
      rowFound: Boolean(row),
      baseValue: base ? base.value : null,
      hint: document.getElementById('model-hint').textContent,
      modelInput: document.getElementById('model-input').value,
      presetOptions: Array.prototype.map.call(preset.options, function (o) { return o.value; }),
    };
  `;

  // The real click: the preset <select>'s change handler is what calls
  // applyCustomPreset() (app.js: `applyCustomPreset(els.classSelect.value,
  // els.modelPreset.value)`), so setting the value and dispatching the event is
  // the same path a user takes.
  const clickPreset = (modelId) =>
    js(
      win,
      `var p = document.getElementById('model-preset');
       p.value = ${JSON.stringify(modelId)};
       p.dispatchEvent(new Event('change', { bubbles: true }));
       return p.value;`
    );

  // Polling that RETURNS the last state instead of throwing. A `waitFor`
  // timeout here would report only "timed out", which is useless for a failure
  // whose whole subject is WHICH of (row exists / row holds the refused URL /
  // the reason reached the hint) came back wrong — so the checks below quote
  // the observed state.
  const pollUntil = async (pred, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = await js(win, READ);
    while (!pred(last) && Date.now() < deadline) {
      await sleep(100);
      last = await js(win, READ);
    }
    return last;
  };

  // ── blocked class: the refused URL must be replaced ──────────────────────
  const switched = await selectClass('openai-compat');
  const classOptions = await js(
    win,
    `return Array.prototype.map.call(document.getElementById('class-select').options, function (o) { return o.value; });`
  );
  check(
    'blocked-class-selectable',
    switched === 'openai-compat',
    `class picker did not accept openai-compat (options=${JSON.stringify(classOptions)}); ` +
      `settings.json written to ${settingsPath}`
  );

  const blocked = await pollUntil(
    (s) => s.rowFound && s.baseValue === REFUSED && /must be LOCAL/.test(s.hint),
    8000
  );

  // The FIELD is asserted alongside the hint, not just the hint: the repair
  // branch below is chosen from the field's value, so a row that rendered empty
  // (the bug this phase first shipped with — a pane built before the seed) would
  // reach that branch by accident and report a pass for the wrong reason.
  check(
    'blocked-row-is-visible-with-reason',
    blocked.rowFound && blocked.baseValue === REFUSED && /must be LOCAL/.test(blocked.hint),
    `seeded ${REFUSED}; the pane must SHOW it and explain the refusal. Observed ` +
      `${JSON.stringify(blocked)} (settings.json at ${settingsPath}, ` +
      `classes=${JSON.stringify(classOptions)})`
  );
  check(
    'blocked-preset-offered',
    Array.isArray(blocked.presetOptions) && blocked.presetOptions.includes('llama3.2'),
    `a blocked class enumerates no models, so the quick-fill presets must still ` +
      `be offered: options=${JSON.stringify(blocked.presetOptions)}`
  );

  const clicked = await clickPreset('llama3.2');
  const repaired = await js(win, READ);
  check('preset-click-applied', clicked === 'llama3.2', `preset select value=${JSON.stringify(clicked)}`);
  check(
    'preset-click-replaced-refused-url',
    repaired.baseValue === REPAIR,
    `clicking a preset on a blocked row must overwrite the refused URL ` +
      `${REFUSED} with ${REPAIR} (got ${JSON.stringify(repaired.baseValue)}) — ` +
      `otherwise the local-only policy leaves the class unfixable`
  );
  check(
    'preset-click-filled-model-id',
    repaired.modelInput === 'llama3.2',
    `model id field=${JSON.stringify(repaired.modelInput)}`
  );
  check(
    'preset-click-hint-names-the-repair',
    /refused/.test(repaired.hint),
    `the hint must say the refused endpoint was replaced: ${JSON.stringify(repaired.hint.slice(0, 200))}`
  );

  // ── working local row: the click must NOT clobber ────────────────────────
  // The regression this guards: if the blocked exception were ever widened to
  // every class (or every click), a preset click would repoint a working local
  // server without asking. The row above proves the repair works; this proves
  // it stays narrow.
  await selectClass('anthropic');
  // Wait for THIS class's own render, not merely for a state the previous leg
  // happened to leave behind.
  //
  // The first version of this leg polled for `rowFound && baseValue === KEPT &&
  // !/must be LOCAL/.test(hint)` — and every one of those three is satisfied by
  // the state the openai-compat leg ends in, because the settings pane lists
  // every provider regardless of class and the hint test was NEGATIVE (the
  // repair text from the leg above is not "must be LOCAL"). So the poll could
  // return before loadModels('anthropic') had resolved, the click then wrote
  // its mismatch hint, and the late-resolving loadModels overwrote it with
  // `endpoint: … · key: …` a few ms later. That is a real, timing-dependent
  // flake: it failed once and passed on an identical rerun. Anchoring on
  // class-specific text (`endpoint: ${KEPT}`, which only this class's loadModels
  // writes) removes the window by construction rather than by hoping.
  //
  // The blocked leg above never flaked for the same reason: its predicate keys
  // on `must be LOCAL`, which only the blocked loadModels render produces.
  const localRow = await pollUntil(
    (s) => s.rowFound && s.baseValue === KEPT && s.hint.includes(`endpoint: ${KEPT}`),
    5000
  );
  // Precondition, asserted rather than assumed. Every branch of planPresetFill()
  // is chosen from this field, so a row that displayed empty would take the
  // "fill it in" branch and the two checks below would then be reporting on the
  // wrong rule entirely (that is exactly how the first version of this phase
  // passed its blocked leg and failed here). The hint is included for the same
  // reason: it proves the class's own loadModels has landed, so nothing is left
  // in flight that could overwrite what the click writes.
  check(
    'local-row-shows-configured-endpoint',
    localRow.rowFound && localRow.baseValue === KEPT && localRow.hint.includes(`endpoint: ${KEPT}`),
    `the pane must display the configured local endpoint ${KEPT} AND that class's own ` +
      `model hint before the click (a late loadModels render must not still be in ` +
      `flight); observed ${JSON.stringify(localRow)}`
  );

  const localClicked = await clickPreset('local-model');
  const afterLocal = await js(win, READ);
  check(
    'local-preset-click-applied',
    localClicked === 'local-model',
    `preset select value=${JSON.stringify(localClicked)}`
  );
  check(
    'local-row-not-clobbered',
    afterLocal.baseValue === KEPT,
    `a preset click on a NON-blocked row must leave the configured endpoint ` +
      `alone: expected ${KEPT}, got ${JSON.stringify(afterLocal.baseValue)}`
  );
  check(
    'local-mismatch-hint-says-so',
    /needs base URL/.test(afterLocal.hint),
    `when the field disagrees with the preset the hint must say so instead of ` +
      `writing: ${JSON.stringify(afterLocal.hint.slice(0, 200))} ` +
      `(pre-click hint was ${JSON.stringify(String(localRow.hint || '').slice(0, 200))})`
  );

  return { blocked, repaired, localRow, afterLocal, refused: REFUSED, repair: REPAIR, kept: KEPT };
}

/**
 * PLAN Phase 10 (P3.7) — the abort path's edges, driven in the real DOM.
 *
 * The phase above proves that ONE Escape stops ONE turn and salvages it. This
 * phase proves the edges either side of that, which were previously only
 * unit-tested on the pure decision (`stopAppliesTo`) and never observed in the
 * app:
 *
 *   1. a second press while the first abort is still unwinding must be refused
 *      (idempotent — one bubble, not two, and no error);
 *   2. a press arriving after the turn already ended must be inert;
 *   3. the turn after a stopped one must not inherit the abort (this is what
 *      the old global `userStopped` flag broke: it stayed true, so the next
 *      turn's genuine failure was relabelled "stopped by you" and its teardown
 *      disarmed the successor);
 *   4. a turn that streamed deliberation but no answer must still leave the
 *      user with that text, labelled `reasoning only`, instead of an empty
 *      bubble.
 *
 * Runs after the chat phase and before `presetRepairPhase`, which must stay
 * last because it switches the class picker off Aegis Cloud.
 */
async function stopEdgesPhase(win) {
  const out = {};

  // ── 1. a second press during teardown ───────────────────────────────────
  const before = await js(win, BUBBLE_TALLY);
  const started = await js(win, startTurn('SMOKE: second turn, to be interrupted twice.'));
  await waitFor(
    () => js(win, 'var n = liveText().length; return n > 600 ? { len: n } : 0;'),
    'the second turn to stream'
  );
  const cancelsBefore = CANCEL_COUNT();
  const pressed = await js(win, DOUBLE_ESCAPE);
  const settled = await waitFor(
    () => js(win, SETTLED_TALLY),
    'the doubly-pressed turn to settle'
  );
  const cancelsAfter = CANCEL_COUNT();

  check(
    'double-press-both-consumed',
    pressed.first === true && pressed.second === true,
    `defaultPrevented first=${pressed.first} second=${pressed.second} (both presses must reach the ` +
      `interrupt handler — the second one is refused there, not dropped before it)`
  );
  check(
    'double-press-cancelled-once',
    cancelsAfter - cancelsBefore === 1,
    `models.cancel ran ${cancelsAfter - cancelsBefore} time(s) across two Escape presses (expected 1) — ` +
      `the second press re-entered the abort instead of being refused by the turn guard`
  );
  check(
    'double-press-one-bubble',
    settled.stopped === before.stopped + 1,
    `stopped bubbles ${before.stopped} -> ${settled.stopped} after two Escape presses ` +
      `(exactly one turn was interrupted; a second bubble means the abort re-entered)`
  );
  check(
    'double-press-no-error',
    settled.errors === before.errors,
    `${settled.errors} "request failed" row(s) — a repeated stop must never render as an error`
  );
  check(
    'double-press-no-pending',
    (await js(win, BUBBLE_TALLY)).sendDisabled === false,
    'Send is still disabled, so the turn never actually finished unwinding'
  );

  // ── 2. a press after the turn already ended ─────────────────────────────
  await js(win, ESCAPE);
  await sleep(400);
  const stale = await js(win, BUBBLE_TALLY);
  const staleCancels = CANCEL_COUNT();
  check(
    'stale-escape-inert',
    stale.stopped === settled.stopped && stale.errors === settled.errors,
    `a press with no running turn changed the transcript: stopped ${settled.stopped} -> ` +
      `${stale.stopped}, errors ${settled.errors} -> ${stale.errors} (it must do nothing)`
  );
  check(
    'stale-escape-called-no-cancel',
    staleCancels === cancelsAfter,
    `models.cancel ran ${staleCancels - cancelsAfter} time(s) with no running turn (expected 0) — ` +
      `a press on nothing must be refused before it reaches the transport`
  );
  check(
    'stale-escape-keeps-send',
    stale.sendDisabled === false,
    `sendDisabled=${stale.sendDisabled} after a no-op press`
  );

  // ── 3. the successor does not inherit the abort ─────────────────────────
  out.successor = await js(win, startTurn('SMOKE: successor turn, must run clean.'));
  await waitFor(
    () => js(win, 'var n = liveText().length; return n > 1200 ? { len: n } : 0;'),
    'the successor turn to stream'
  );
  // No press has happened on THIS turn. If the previous turn's stop leaked, it
  // is either already labelled stopped, or it will die the moment the renderer
  // unwinds it — so this is checked mid-stream, where "already stopped" is the
  // only way it can show.
  const midSuccessor = await js(win, BUBBLE_TALLY);
  check(
    'successor-runs-unstopped',
    midSuccessor.stopped === settled.stopped,
    `the successor reached 1200 chars but the transcript already shows ${midSuccessor.stopped} ` +
      `stopped bubble(s) (expected ${settled.stopped}) — the stopped state leaked into the next turn`
  );
  check(
    'successor-still-running',
    midSuccessor.sendDisabled === true && midSuccessor.errors === settled.errors,
    `sendDisabled=${midSuccessor.sendDisabled}, errors=${midSuccessor.errors} mid-successor`
  );
  const stoppedSuccessor = await js(win, ESCAPE);
  const afterSuccessor = await waitFor(
    () => js(win, SETTLED_TALLY),
    'the successor to settle after its own single press'
  );
  const successorCancels = CANCEL_COUNT();
  check(
    'successor-cancelled-once',
    successorCancels - staleCancels === 1,
    `models.cancel ran ${successorCancels - staleCancels} time(s) for the successor turn ` +
      `(expected 1) — a live successor must be stoppable, exactly once`
  );
  check(
    'successor-stopped-by-its-own-press',
    afterSuccessor.stopped === settled.stopped + 1,
    `stopped bubbles ${settled.stopped} -> ${afterSuccessor.stopped} (a live successor must be ` +
      `stoppable by exactly one press; stopped=${stoppedSuccessor.defaultPrevented})`
  );
  out.successorStopped = afterSuccessor.stopped;

  // ── 4. reasoning-only salvage ───────────────────────────────────────────
  // The stub keys off this marker in the request body and streams
  // `delta.reasoning_content` with no `delta.content` at all — a turn that
  // deliberates and is interrupted before it ever writes an answer. Before
  // Phase 10 that produced a red "aborted" bubble and threw the deliberation
  // away; `salvageTurn` relabels it `reasoning only` and promotes the text.
  await js(win, startTurn('SMOKE_REASON_ONLY: deliberate at length, answer nothing.'));
  await waitFor(
    () => js(win, 'var n = liveReasoning().length; return n > 600 ? { len: n } : 0;'),
    'the reasoning-only turn to stream deliberation'
  );
  const reasoningAtEscape = await js(win, 'return { len: liveReasoning().length, answer: liveText().length };');
  const reasonedBefore = await js(win, STOPPED_STATE + 'return s;');
  await js(win, ESCAPE);
  const reasoned = await pollStopped(win, reasonedBefore.count + 1);
  check(
    'reasoning-only-added-a-stopped-bubble',
    reasoned.count === reasonedBefore.count + 1,
    `stopped bubbles ${reasonedBefore.count} -> ${reasoned.count} (the press must settle exactly ` +
      `one more stopped turn; meta=${JSON.stringify(reasoned.meta)})`
  );
  check(
    'reasoning-only-streamed-no-answer',
    reasoningAtEscape.len > 600 && reasoningAtEscape.answer === 0,
    `at the keystroke: reasoning=${reasoningAtEscape.len} chars, answer=${reasoningAtEscape.answer} ` +
      `(the answer body must be untouched, or this leg is not testing the reasoning-only path)`
  );
  check(
    'reasoning-only-labelled',
    reasoned.meta.indexOf('reasoning only') !== -1,
    `meta=${JSON.stringify(reasoned.meta)} — a turn stopped with no answer text must say so`
  );
  check(
    'reasoning-only-not-empty',
    norm(reasoned.body).length > 200,
    `salvaged body=${norm(reasoned.body).length} chars — the deliberation must survive ` +
      `the stop instead of leaving an empty bubble`
  );
  out.reasoningOnly = {
    stoppedBubbles: reasoned.count,
    meta: reasoned.meta || null,
    bodyLength: norm(reasoned.body).length,
  };

  return out;
}

const QUEUE_HINT = "var el=document.getElementById('queue-hint'); return el ? el.textContent : '';";

/**
 * Phase 11: the ⊘ mark — a tool line whose result never arrived.
 *
 * Unreachable from the transcript, and that is the finding rather than an
 * inconvenience: `engine.js` emits `phase: 'run'` before the tool executes and
 * `phase: 'done'` (always with an explicit boolean `ok`) after, and BOTH
 * transcript handlers deliberately drop the run frame
 * (`if (chunk.tool.phase === 'run') { captureDiffPreview(...); return; }`) so a
 * tool is never printed twice. No stub payload can therefore make the
 * transcript draw ⊘: the only frame that reaches `toolActivityLabel` there
 * carries a real `ok`, so it can only ever be ✓ or ✗.
 *
 * The queue lane is the surface that renders a raw run frame. The worker emits
 * `{ type: 'tool', taskId, tool: chunk.tool }` with no phase filter
 * (lib/local/autonomous.js), main forwards it verbatim over
 * QUEUE_PROGRESS_CHANNEL, and renderQueueProgress has no phase guard either
 * (renderer/app.js). So a run frame draws the live row as ⊘ — "interrupted",
 * not "succeeded" — which is the whole point of the branch: the old
 * `ok === false ? '✗' : '✓'` drew a tick for a call the turn never finished.
 *
 * One synthetic thing, stated plainly: the event is sent by the driver rather
 * than by a draining worker, because driving a real drain needs a queue file, a
 * cwd, and an agent loop that returns `tool_calls`. The SHAPE is exactly what
 * autonomous.js emits, and everything downstream of the channel is production —
 * main's channel constant, preload's listener, the renderer's handler and label.
 */
async function toolMarkPhase(win) {
  const { QUEUE_PROGRESS_CHANNEL } = require('../main.js');
  const out = {};
  const send = (tool) =>
    win.webContents.send(QUEUE_PROGRESS_CHANNEL, { type: 'tool', taskId: 7, tool });

  /** Read #queue-hint until it shows `needle`, or report what it did show. */
  const hintFor = async (needle, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    let seen = '';
    for (;;) {
      seen = String((await js(win, QUEUE_HINT)) || '');
      if (seen.includes(needle)) return seen;
      if (Date.now() > deadline) return seen;
      await sleep(100);
    }
  };

  const TOOL = { name: 'writeFile', args: { file_path: 'NOTES.md' }, id: 'call_smoke_tool' };

  // 1. The run frame: the call has started and no result has arrived. This is
  //    the state the branch exists for, and the one the old code got wrong.
  send({ ...TOOL, phase: 'run' });
  const running = await hintFor('writeFile');
  check(
    'queue-run-frame-marked-interrupted',
    running.endsWith('⊘'),
    `#queue-hint read ${JSON.stringify(running)} — a tool whose result has not arrived must ` +
      `be ⊘, not ✓`
  );
  check(
    'queue-run-frame-not-marked-ok',
    !running.includes('✓'),
    `#queue-hint read ${JSON.stringify(running)} — the run frame drew a success tick for a call ` +
      `that had not finished`
  );
  check(
    'queue-run-frame-names-the-tool',
    running.includes('NOTES.md'),
    `#queue-hint read ${JSON.stringify(running)} — the live row must say which file, not only ` +
      `which tool`
  );

  // 2. The done frame with ok:true — same row, now genuinely finished.
  send({ ...TOOL, phase: 'done', ok: true });
  const done = await hintFor('✓');
  check(
    'queue-done-frame-marked-ok',
    done.endsWith('✓'),
    `#queue-hint read ${JSON.stringify(done)} — a completed call is a tick`
  );

  // 3. The done frame with ok:false — failed is a cross, distinct from both the
  //    tick and the interruption. Three outcomes, three glyphs, one row.
  send({ ...TOOL, phase: 'done', ok: false });
  const failed = await hintFor('✗');
  check(
    'queue-failed-frame-marked-cross',
    failed.endsWith('✗'),
    `#queue-hint read ${JSON.stringify(failed)} — a failed call is a cross, not an interruption`
  );

  out.marks = { interrupted: running, done, failed };
  return out;
}

async function main() {
  const win = await waitFor(
    () =>
      BrowserWindow.getAllWindows().find((w) =>
        String(w.webContents.getURL() || '').endsWith('renderer/index.html')
      ),
    'the main window'
  );
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(String(message).slice(0, 300));
    if (process.env.AEGIS_SMOKE_DEBUG === '1') console.error(`renderer: ${message}`);
  });

  // Give the renderer its viewport: the transcript must genuinely overflow the
  // window for "holds position" to mean anything.
  try {
    win.setContentSize(1080, 560);
  } catch {
    /* a resized window is not required — the stream below overflows regardless */
  }

  // renderer boot: init() populates the class picker from models.listClasses().
  await waitFor(
    () =>
      js(
        win,
        "var s=document.getElementById('class-select'); return s && s.options.length > 0 ? s.options.length : 0;"
      ),
    'renderer boot (class picker)'
  );

  const prepared = await js(win, PREPARE);
  check('turn-started', prepared.sendDisabled === true, `sendDisabled=${prepared.sendDisabled}`);
  check('class-is-cloud', prepared.cls === 'aegis', `class=${prepared.cls}`);
  check('discovery-lane-off', prepared.explore === false, `explore=${prepared.explore}`);

  // ── 1. stream until the transcript is long enough to scroll ──────────────
  const streamed = await waitFor(
    () =>
      js(win, 'var n = liveText().length; return n > 3000 ? { len: n } : 0;'),
    'streamed text on the live turn'
  );

  // ── 2. scroll up mid-stream, then hold ───────────────────────────────────
  const scrollUp = await js(win, SCROLL_UP);
  const before = await js(win, MEASURE('before'));
  await sleep(900);
  const held = await js(win, MEASURE('after'));

  const overflowBefore = before.scrollHeight - before.clientHeight;
  check(
    'transcript-overflows',
    overflowBefore > 200,
    `scrollHeight-clientHeight=${overflowBefore} (must be >200 or 'held position' is vacuous)`
  );
  check('scrolled-up-moved', scrollUp.moved === true, `scrollTop=${scrollUp.scrollTop}`);
  check(
    'stream-live-during-hold',
    held.textLen > before.textLen,
    `textLen ${before.textLen} -> ${held.textLen} (no new chunks arrived, so the hold was never challenged)`
  );
  // THE regression this phase guards: an unconditional `scrollTop =
  // scrollHeight` on every chunk re-pins the view and this fails.
  check(
    'position-held-while-streaming',
    held.scrollTop <= before.scrollTop + 48,
    `scrollTop ${before.scrollTop} -> ${held.scrollTop} while ${held.textLen - before.textLen} chars streamed in`
  );
  check(
    'veto-engaged',
    held.scrollHeight - held.scrollTop - held.clientHeight > 48,
    `distance-from-tail=${held.scrollHeight - held.scrollTop - held.clientHeight} (must be off the tail)`
  );
  check(
    'scrolled-up-flag-set',
    held.scrolledUpFlag === true,
    `transcript.isScrolledUp()=${held.scrolledUpFlag} (the real scroll listener must have recorded the scroll)`
  );

  // ── the meter must move WHILE the AI is still working, not just after ────
  // Both `before` and `held` are captured mid-stream (the turn is still
  // running: Escape hasn't fired yet). This is this session's first turn, so
  // before this fix the meter stayed hidden the entire time a reply streamed
  // in and only appeared the instant the turn finished.
  const meterBefore = before.sessionMeter || {};
  const meterHeld = held.sessionMeter || {};
  check(
    'meter-visible-mid-stream',
    !meterBefore.missing && meterBefore.hidden === false,
    `meter=${JSON.stringify(meterBefore)} — must be on screen while the reply is still streaming, not just after it finishes`
  );
  check(
    'meter-counted-mid-stream',
    /\d[\d,]* tok/.test(String(meterBefore.text || '')),
    `meter text=${JSON.stringify(meterBefore.text)} — must show a real estimate while streaming, not stay blank`
  );
  check(
    'meter-grows-mid-stream',
    String(meterHeld.text || '') !== String(meterBefore.text || ''),
    `meter text unchanged (${JSON.stringify(meterBefore.text)}) while ${held.textLen - before.textLen} more chars streamed in`
  );

  // ── 3. Escape stops the turn ─────────────────────────────────────────────
  const escaped = await js(win, ESCAPE);
  check(
    'escape-consumed',
    escaped.defaultPrevented === true,
    `defaultPrevented=${escaped.defaultPrevented} (Escape must have reached the interrupt handler)`
  );

  const stopped = await waitFor(
    () =>
      js(
        win,
        "return document.querySelector('#messages .msg .meta') && Array.prototype.some.call(document.querySelectorAll('#messages .msg .meta'), function(m){return m.textContent.indexOf('stopped by you')!==-1;}) ? 1 : 0;"
      ),
    'the salvaged "stopped by you" bubble',
    12000
  );
  check('salvage-bubble-present', stopped === 1, 'no bubble labelled "stopped by you" appeared');

  const settledA = await js(win, CAPTURE);
  // If the transport were still live, the transcript would keep growing.
  await sleep(1200);
  const settledB = await js(win, CAPTURE);

  check(
    'partial-text-salvaged',
    settledB.stoppedLength > 200,
    `salvaged text length=${settledB.stoppedLength} (expected the partial answer, not an empty bubble)`
  );
  check(
    'no-error-bubble',
    settledB.errorRows === 0,
    `${settledB.errorRows} row(s) rendered as a failure — a stop must never be reported as an error`
  );
  check(
    'pending-bubble-cleared',
    settledB.pendingLeft === 0,
    `${settledB.pendingLeft} pending bubble(s) still on screen after the stop`
  );
  check(
    'stream-really-stopped',
    settledA.stoppedText === settledB.stoppedText,
    'the salvaged text kept changing after the stop — the transport was still streaming'
  );
  check(
    'send-re-enabled',
    settledB.sendDisabled === false,
    `sendDisabled=${settledB.sendDisabled}`
  );

  // ── The rolling session meter, in the real DOM ───────────────────────────
  // This turn was stopped mid-stream, so the wire never reported usage — the
  // exact case the counter used to drop on the floor: `rollTurn` added
  // `undefined` to the total and the turn vanished from the session. It must
  // now be counted, estimated from the turn's own text, folded on the interrupt
  // path, and visible in the topbar. Three distinct failures are pinned here:
  // a hidden/absent meter (the counter never reached the DOM), a bare `0 tok`
  // (a zero that was never measured), and no tokens at all (the turn dropped).
  const meter = settledB.sessionMeter || {};
  const meterText = String(meter.text || '');
  check(
    'session-meter-visible',
    !meter.missing && meter.hidden === false,
    `meter=${JSON.stringify(meter)} — the rolling total must be on screen after a stopped turn`
  );
  check(
    'session-meter-counted',
    /\d[\d,]* tok/.test(meterText) && !/^0 tok/.test(meterText.trim()),
    `meter text=${JSON.stringify(meterText)} — a stopped turn must contribute its estimate, never a bare 0`
  );
  // The honest invariant: what survived is a real answer that is *shorter than
  // the stream the stub would have sent*. Comparing against `textAtEscape` (the
  // visible length at the instant Escape was dispatched) encoded a race — the
  // renderer can legitimately flush a queued frame after the keypress, pushing
  // the salvaged length past that snapshot. That flake is why this check must
  // use the complete-stream length instead.
  check(
    'partial-not-whole',
    escaped.textAtEscape > 0 &&
      settledB.stoppedLength > 0 &&
      settledB.stoppedLength < COMPLETE_TEXT_LEN,
    `salvaged ${settledB.stoppedLength} of ${COMPLETE_TEXT_LEN} streamed chars ` +
      `(view showed ${escaped.textAtEscape} at the keystroke)`
  );

  // Phase 10's edges. Must run while Aegis Cloud is still selected, and before
  // the preset phase below, which switches the class picker away from it.
  const stopEdges = await stopEdgesPhase(win);

  // Phase 11's ⊘ leg. Independent of the transcript — it drives the queue
  // progress channel — so it does not care which class is selected, but it
  // stays here so the preset phase below remains the last one.
  const toolMarks = await toolMarkPhase(win);

  // The local-only endpoint policy's recovery leg. Runs LAST on purpose: it
  // switches the class picker off Aegis Cloud, which the chat phase above
  // depends on, and it rewrites settings.json behind the running app.
  const presetRepair = await presetRepairPhase(win);

  return {
    prepared,
    streamedLen: streamed.len,
    stopEdges,
    toolMarks,
    presetRepair,
    scrollUp,
    before,
    held,
    escaped,
    settled: {
      stoppedText: settledB.stoppedText,
      stoppedLength: settledB.stoppedLength,
      rows: settledB.rows,
      errorRows: settledB.errorRows,
      pendingLeft: settledB.pendingLeft,
      sendDisabled: settledB.sendDisabled,
    },
    consoleErrors,
  };
}

let finished = false;

async function run() {
  const watchdog = setTimeout(() => {
    if (finished) return;
    console.error('SMOKE_FAIL watchdog: smoke run exceeded 60s');
    report(false);
  }, 60000);

  let evidence = null;
  let fatal = null;
  try {
    evidence = await main();
  } catch (err) {
    fatal = err && err.message ? err.message : String(err);
    check('driver-completed', false, fatal);
  }
  clearTimeout(watchdog);

  const ok = !fatal && checks.every((c) => c.ok);
  report(ok, evidence, fatal);
}

function report(ok, evidence, fatal) {
  if (finished) return;
  finished = true;
  const payload = {
    ok,
    checks,
    fatal: fatal || null,
    evidence: evidence
      ? {
          ...evidence,
          // The wrapper (which owns the stub server) checks this text against
          // exactly what it streamed: the salvage must be a real prefix.
          settled: {
            ...evidence.settled,
            stoppedText: String(evidence.settled.stoppedText || '').slice(0, 20000),
          },
        }
      : null,
  };
  process.stdout.write(`SMOKE_EVIDENCE ${JSON.stringify(payload)}\n`);
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(run, (err) => {
  check('app-ready', false, err && err.message ? err.message : String(err));
  report(false);
});
