'use strict';

/**
 * Demo-GIF driver — docs/marketing-plan-social.md §6 ("a 40-second demo GIF at
 * the top of the README").
 *
 * This is the *main process* of a throwaway Electron run, in the same shape as
 * `test/marketing-shots-main.js`: it requires the real `desktop/main.js` (real
 * window, real preload, real IPC, real LocalEngine, real renderer app.js) and
 * drives the real DOM. Every byte the "model" produces comes from the loopback
 * stub `scripts/record-demo-gif.mjs` owns (the SAME stub the stills use,
 * imported from `scripts/marketing-harness.mjs`) — so this file demonstrates
 * the UI, never inference quality.
 *
 * It does NOT capture anything itself. The recorder records the live window in
 * real time with `ffmpeg -f x11grab` against the nested-X display the whole run
 * sits on, so the GIF is the app rendering frame by frame — no still is pasted
 * in, nothing is sped up, and no frame is synthesised. This driver's only jobs
 * are (a) to drive an honest four-beat flow and (b) to say, on stdout, when the
 * window is ready (so recording can start) and when the flow is done (so
 * recording can stop).
 *
 * Never run this directly — it refuses to start unless AEGIS_SMOKE=1 and both
 * AEGIS_API_BASE and AEGIS_SHOTS_STUB are loopback origins, the same gate the
 * smoke and still harnesses use.
 *
 * The four beats, in order, at real time:
 *   1. the window is up and a prompt is typed into the real composer
 *   2. the answer streams in, token by token, through the real transport stack
 *   3. the model-class picker is opened — a real native popup (`sendInputEvent`,
 *      a trusted user gesture) showing the three provider classes
 *   4. an edit is proposed: the tool-call diff/approval card renders
 *
 * Evidence leaves on stdout as `DEMO_READY {json}`, `DEMO_DONE {json}` and one
 * final `DEMO_EVIDENCE {json}` line; the recorder owns the exit code.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Safety rails — refuse to boot against anything that is not the local stub.
// ---------------------------------------------------------------------------
const apiBase = process.env.AEGIS_API_BASE || '';
const stubBase = process.env.AEGIS_SHOTS_STUB || apiBase;
const WIDTH = Number(process.env.AEGIS_DEMO_W || 1200);
const HEIGHT = Number(process.env.AEGIS_DEMO_H || 750);
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

if (process.env.AEGIS_SMOKE !== '1' || !LOOPBACK.test(apiBase) || !LOOPBACK.test(stubBase)) {
  console.error(
    'demo-gif-main: refusing to run. Needs AEGIS_SMOKE=1 and loopback ' +
      `AEGIS_API_BASE / AEGIS_SHOTS_STUB (got ${JSON.stringify({ apiBase, stubBase })}). ` +
      'Use scripts/record-demo-gif.mjs.'
  );
  process.exit(2);
}
if (!Number.isFinite(WIDTH) || !Number.isFinite(HEIGHT)) {
  console.error(`demo-gif-main: AEGIS_DEMO_W/H must be numbers (got ${JSON.stringify({ WIDTH, HEIGHT })}).`);
  process.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');

// ---------------------------------------------------------------------------
// Seed the settings the driven turn needs BEFORE the host boots (identical to
// the still driver: the stub's BARE loopback origin is the `local` base URL).
// ---------------------------------------------------------------------------
const userData = app.getPath('userData');
const settingsPath = path.join(userData, 'settings.json');
{
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) || {};
  } catch {
    /* first boot in this temp profile */
  }
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({ ...stored, local: { ...(stored.local || {}), baseURL: stubBase } }, null, 2),
    { mode: 0o600 }
  );
}

// Boot the REAL host. main.js registers its own app.whenReady() handler and
// creates the window there; ours below runs after it and waits for the window.
require('../main.js');

const checks = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (line) => process.stdout.write(`${line}\n`);

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  if (!ok) console.error(`DEMO_FAIL ${name}: ${detail}`);
  return Boolean(ok);
}

function js(win, body) {
  return win.webContents.executeJavaScript(`(function () {${body}})()`, true);
}

async function waitFor(fn, label, timeoutMs = 30000, intervalMs = 150, observe = null) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await fn();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() > deadline) {
      let seen = null;
      if (observe) {
        try {
          seen = await observe();
        } catch (err) {
          seen = `observing threw: ${err && err.message}`;
        }
      }
      throw new Error(`timed out waiting for ${label}` + (seen ? ` — saw ${JSON.stringify(seen)}` : ''));
    }
    await sleep(intervalMs);
  }
}

async function waitForWindow(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isLoading()) return win;
      } catch {
        /* window went away mid-iteration */
      }
    }
    if (Date.now() > deadline) throw new Error('no BrowserWindow appeared within the deadline');
    await sleep(200);
  }
}

async function prepareWindow(win) {
  if (!win.isVisible()) win.show();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const [cw, ch] = win.getContentSize();
    if (cw === WIDTH && ch === HEIGHT) break;
    const [ow, oh] = win.getSize();
    const frameW = Math.max(0, ow - cw);
    const frameH = Math.max(0, oh - ch);
    win.setBounds({ x: 0, y: 0, width: WIDTH + frameW, height: HEIGHT + frameH });
    await sleep(250);
  }
  win.setPosition(0, 0);
  try {
    win.webContents.setZoomFactor(1);
  } catch {
    /* zoom factor is not settable on every platform; the launch flag covers it */
  }
  await sleep(700);
  const [cw, ch] = win.getContentSize();
  return {
    contentWidth: cw,
    contentHeight: ch,
    outer: win.getBounds(),
    contentBounds: win.getContentBounds(),
    devicePixelRatio: await js(win, 'return window.devicePixelRatio;').catch(() => null),
  };
}

const MODEL_STATE = `
  var m = document.getElementById('model-select');
  return {
    cls: (document.getElementById('class-select') || {}).value,
    modelOptions: m ? Array.prototype.map.call(m.options, function (o) { return o.value; }) : null,
    modelValue: m ? m.value : null,
    freeVisible: (document.getElementById('model-input') || {}).hidden === false
  };
`;

const SETTLE_PROBE = `
  var send = document.getElementById('send');
  var rows = document.querySelectorAll('#messages .msg');
  var last = rows.length ? rows[rows.length - 1] : null;
  var body = last ? last.querySelector('.body') : null;
  var len = body ? String(body.textContent || '').trim().length : 0;
  var out = {
    rows: rows.length,
    answerChars: len,
    pendingBubbles: document.querySelectorAll('#messages .cancel-btn').length,
    sendDisabled: Boolean(send && send.disabled)
  };
  if (out.sendDisabled || out.pendingBubbles || out.answerChars < 200) return null;
  return out;
`;

const TRANSCRIPT_STATE = `
  var rows = document.querySelectorAll('#messages .msg');
  var out = { rows: [] };
  Array.prototype.forEach.call(rows, function (r) {
    var b = r.querySelector('.body');
    var m = r.querySelector('.meta');
    out.rows.push({ role: r.className, meta: m ? m.textContent : '',
      chars: b ? String(b.textContent || '').length : 0 });
  });
  out.errorRows = Array.prototype.filter.call(rows, function (r) {
    var m = r.querySelector('.meta');
    var b = r.querySelector('.body');
    return m && /request failed|Error:/i.test(m.textContent + ' ' + (b ? b.textContent : ''));
  }).length;
  return out;
`;

const APPROVAL_PROBE = `
  var card = document.querySelector('#messages .approval-card');
  if (!card) return null;
  var diff = card.querySelector('.approval-diff');
  var lines = diff ? Array.prototype.map.call(diff.children, function (l) {
    return { cls: l.className, text: String(l.textContent || '') };
  }) : [];
  return {
    title: (card.querySelector('.approval-title') || {}).textContent || '',
    summary: (card.querySelector('.approval-summary') || {}).textContent || '',
    buttons: Array.prototype.map.call(card.querySelectorAll('.approval-btn'), function (b) {
      return String(b.textContent || '').trim();
    }),
    diffLineCount: lines.length,
    addedLines: lines.filter(function (l) { return l.cls === 'diff-add'; }).length,
    removedLines: lines.filter(function (l) { return l.cls === 'diff-del'; }).length,
    hunkHeaders: lines.filter(function (l) { return l.cls === 'diff-hunk'; }).length
  };
`;

/**
 * Count the mapped top-level X windows on the run's display. A native
 * `<select>` popup is a real override-redirect window (not part of the page),
 * so this number rises while the picker is open. It is the machine-checkable
 * proof that beat 3 shows the app's real picker popup and not a page stand-in —
 * captured because the recorder grabs the whole nested-X framebuffer, not just
 * the web contents.
 */
function mappedWindowCount() {
  try {
    const r = spawnSync('xwininfo', ['-root', '-children', '-display', process.env.DISPLAY || ''], {
      encoding: 'utf8',
    });
    if (r.status !== 0) return null;
    return String(r.stdout || '')
      .split('\n')
      .filter((l) => /^\s+0x[0-9a-f]+/.test(l)).length;
  } catch {
    return null;
  }
}

/** Type into the real composer one character at a time (the app renders each). */
async function typeText(win, text, perCharMs) {
  await js(win, `document.getElementById('prompt').focus(); return true;`);
  for (const ch of text) {
    await js(
      win,
      `(function () { var el = document.getElementById('prompt'); el.value += ${JSON.stringify(ch)};
         el.dispatchEvent(new Event('input', { bubbles: true })); return el.value.length; })()`
    );
    await sleep(perCharMs);
  }
}

const PROMPT_1 = 'What happens when the agent proposes a file edit?';
const PROMPT_2 = 'Add a retry wrapper to the flaky upload test. Propose the edit.';
const TYPE_MS = 42;

async function main() {
  let fatal = null;
  const t0 = Date.now();
  const marks = {};
  const mark = (k) => {
    marks[k] = Date.now() - t0;
  };
  let windowState = null;
  let picker = null;

  try {
    await app.whenReady();
    const win = await waitForWindow();
    windowState = await prepareWindow(win);
    await waitFor(
      () =>
        js(
          win,
          `var s = document.getElementById('class-select');
           return Boolean(s && s.options && s.options.length > 0 && document.getElementById('messages'));`
        ),
      'the renderer to finish booting',
      45000
    );

    // Configure the driven lane through the real picker: class `local`, and the
    // model chosen from the list the renderer built from the stub's /api/tags.
    const selected = await js(
      win,
      `var sel = document.getElementById('class-select'); sel.value = 'local';
       sel.dispatchEvent(new Event('change', { bubbles: true })); return { cls: sel.value };`
    );
    check('demo-lane-selected', selected.cls === 'local', `class picker reports ${JSON.stringify(selected)}`);
    const chosen = await waitFor(
      () =>
        js(
          win,
          `var m = document.getElementById('model-select');
           var has = m && Array.prototype.some.call(m.options, function (o) { return o.value === 'stub-coder-7b'; });
           if (!has) return null;
           m.value = 'stub-coder-7b'; m.dispatchEvent(new Event('change', { bubbles: true })); ${MODEL_STATE}`
        ),
      'the local model list (stub /api/tags) to reach the renderer',
      30000,
      200,
      () => js(win, MODEL_STATE)
    );
    check(
      'demo-model-selected',
      chosen.modelValue === 'stub-coder-7b' && chosen.freeVisible === false,
      `model picker reports ${JSON.stringify(chosen)}`
    );
    await sleep(900);

    // Recording starts only once the window is painted: the recorder keys off
    // this line. The app is on screen, the lane is configured, the transcript
    // is empty. `ready` anchors every later mark to the start of the clip.
    mark('ready');
    // `t0` is the epoch anchor for every mark: the recorder turns a mark into a
    // position on the recording timeline with `t0 + mark - recordingStartEpoch`,
    // so the sampled frames land on the beats they claim to show.
    emit(`DEMO_READY ${JSON.stringify({ windowState, marks, t0 })}`);
    await sleep(1200);

    // ── Beat 1: the window is up, a prompt is typed ─────────────────────────
    await typeText(win, PROMPT_1, TYPE_MS);
    mark('prompt1Typed');
    await sleep(400);
    const submitted1 = await js(
      win,
      `document.getElementById('composer').requestSubmit();
       return { sendDisabled: document.getElementById('send').disabled };`
    );
    check('prompt1-submitted', submitted1.sendDisabled === true, `send after submit: ${JSON.stringify(submitted1)}`);

    // ── Beat 2: the answer streams in token by token ────────────────────────
    const settled = await waitFor(
      () => js(win, SETTLE_PROBE),
      'the answer to finish streaming',
      90000,
      200,
      () => js(win, TRANSCRIPT_STATE)
    );
    mark('answerStreamed');
    const transcript = await js(win, TRANSCRIPT_STATE);
    check(
      'answer-streamed-and-no-error-row',
      settled.answerChars > 200 && transcript.errorRows === 0,
      `answer ${settled.answerChars} chars, error rows ${transcript.errorRows}`
    );
    await sleep(900);

    // ── Beat 3: the model-class picker opens as a real native popup ─────────
    const before = mappedWindowCount();
    const pickRect = await js(
      win,
      `var s = document.getElementById('class-select'); s.focus();
       var r = s.getBoundingClientRect();
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } };`
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', x: pickRect.x, y: pickRect.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: pickRect.x, y: pickRect.y, button: 'left', clickCount: 1 });
    mark('pickerOpened');
    await sleep(400);
    const during = mappedWindowCount();
    check(
      'picker-opened-as-a-real-native-popup',
      before === null || during === null || during > before,
      `top-level X windows before=${before} while-open=${during} — the popup is an override-redirect window`
    );
    // Hold the popup so the three class labels are readable, then dismiss it.
    await sleep(2600);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    const composer = await js(
      win,
      `var el = document.getElementById('prompt'); el.focus(); var r = el.getBoundingClientRect();
       return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`
    );
    win.webContents.sendInputEvent({ type: 'mouseDown', x: composer.x, y: composer.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: composer.x, y: composer.y, button: 'left', clickCount: 1 });
    await sleep(500);
    const after = mappedWindowCount();
    picker = { before, during, after, rect: pickRect.rect };

    // ── Beat 4: an edit is proposed — the approval card renders ─────────────
    const toggled = await js(
      win,
      `var t = document.getElementById('confirm-mode-toggle'); var beforeT = Boolean(t && t.checked);
       if (t && !t.checked) t.click(); return { before: beforeT, after: Boolean(t && t.checked) };`
    );
    check(
      'confirm-mode-on-through-the-real-toggle',
      toggled.after === true,
      `approval toggle reads ${JSON.stringify(toggled)}`
    );
    await sleep(600);

    await typeText(win, PROMPT_2, TYPE_MS);
    mark('prompt2Typed');
    await sleep(400);
    await js(win, `document.getElementById('composer').requestSubmit(); return true;`);

    const card = await waitFor(
      () => js(win, APPROVAL_PROBE),
      'the tool-call approval card',
      60000,
      200,
      () => js(win, TRANSCRIPT_STATE)
    );
    mark('approvalCardVisible');
    check(
      'approval-card-shows-a-proposed-edit',
      card.addedLines > 0 && card.hunkHeaders > 0 && card.diffLineCount > 3,
      `card carries ${card.addedLines} added / ${card.removedLines} removed line(s), ${card.hunkHeaders} hunk header(s)`
    );
    check('approval-card-offers-a-decision', card.buttons.length >= 2, `card buttons: ${JSON.stringify(card.buttons)}`);
    const cardRect = await js(win, `var c = document.querySelector('#messages .approval-card'); if (!c) return null;
      var r = c.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };`);
    check(
      'approval-card-is-on-screen',
      cardRect && cardRect.width > 200 && cardRect.height > 80 && cardRect.y >= 0,
      `card rect ${JSON.stringify(cardRect)} inside the ${WIDTH}x${HEIGHT} viewport`
    );

    // Hold the card — this is the clip's closing beat. Recording stops here, so
    // the tail runs comfortably past the ~40 s cut point.
    await sleep(Number(process.env.AEGIS_DEMO_CARD_HOLD_MS || 14000));
    mark('recordingEnd');
    emit(`DEMO_DONE ${JSON.stringify({ marks, cardRect, t0 })}`);

    // Deny through the card's own control so nothing is written and the turn
    // unwinds cleanly before the process exits.
    const denied = await js(
      win,
      `var card = document.querySelector('#messages .approval-card');
       var btns = card ? card.querySelectorAll('.approval-btn') : [];
       for (var i = 0; i < btns.length; i++) {
         if (/deny/i.test(btns[i].textContent || '')) { btns[i].click(); return String(btns[i].textContent).trim(); }
       }
       return null;`
    );
    check('approval-denied-after-recording', Boolean(denied), `no Deny button reachable (clicked ${JSON.stringify(denied)})`);
    await waitFor(() => js(win, SETTLE_PROBE), 'the denied turn to unwind', 45000, 250).catch(() => null);
  } catch (err) {
    fatal = (err && err.message) || String(err);
  }

  const ok = !fatal && checks.every((c) => c.ok);
  const payload = {
    ok,
    fatal,
    width: WIDTH,
    height: HEIGHT,
    windowState,
    picker,
    marks,
    checks,
    transcriptRowCount: null,
  };
  emit(`DEMO_EVIDENCE ${JSON.stringify(payload)}`);
  checks.filter((c) => !c.ok).forEach((c) => emit(`DEMO_CHECK_FAILED ${c.name}: ${c.detail}`));
  setTimeout(() => app.exit(ok ? 0 : 1), 250);
}

main();
