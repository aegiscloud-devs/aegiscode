'use strict';

/**
 * Marketing screenshot driver — docs/marketing-plan-social.md §3 ("asset
 * factory": 1440p stills of the REAL UI for thumbnails, carousels, docs).
 *
 * This is the *main process* of a throwaway Electron run, in the same shape as
 * `test/electron-smoke-main.js`: it requires the real `desktop/main.js` (real
 * window, real preload, real IPC, real LocalEngine, real renderer app.js) and
 * drives the real DOM, but every byte the "model" produces comes from a
 * loopback stub the wrapper (`scripts/capture-marketing-shots.mjs`) owns.
 *
 * Never run this directly — it refuses to start unless AEGIS_SMOKE=1 and both
 * AEGIS_API_BASE and AEGIS_SHOTS_STUB are loopback origins, so a stray
 * invocation can never turn into live provider spend. It is the same gate the
 * smoke harness uses, deliberately reused rather than re-invented.
 *
 * What it captures, at @2x-free 1440x900 (webContents.capturePage of the real
 * window, no HTML is synthesised and no image is edited):
 *
 *   01-model-class-picker.png   the provider-class picker, focused, with the
 *                               real option list the renderer built.
 *   02-answer-complete.png      a finished answer in the transcript, streamed
 *                               through the real transport stack.
 *   03-tool-approval-diff.png   the tool-call approval card with a proposed
 *                               edit (a real writeFile preview diff), i.e. the
 *                               card the engine's approval gate renders before
 *                               it touches disk.
 *
 * Honest limits are printed in the evidence, not papered over: a native
 * `<select>` popup is an OS-level widget that capturePage cannot see, so shot
 * 01 is the picker control itself (focused, option list recorded) rather than
 * the open popup — see `pickerPopups` in the report.
 *
 * The class used for the driven turns is `openai-compat` pointed at the stub's
 * loopback origin: that is the one wire class whose tool loop runs in-process
 * (lib/local/engine.js) and therefore the one that can render the approval
 * card at all. The cloud class relays tool_calls but has no approval gate in
 * this build, so the card would be unreachable there.
 *
 * Evidence leaves on stdout as one `SHOTS_EVIDENCE {json}` line; the wrapper
 * verifies the files (PNG signature + IHDR dimensions + freshness) and owns
 * the exit code CI reads.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Safety rails — refuse to boot against anything that is not the local stub.
// ---------------------------------------------------------------------------
const apiBase = process.env.AEGIS_API_BASE || '';
const stubBase = process.env.AEGIS_SHOTS_STUB || apiBase;
const shotsDir = process.env.AEGIS_SHOTS_DIR || '';
const WIDTH = Number(process.env.AEGIS_SHOTS_W || 1440);
const HEIGHT = Number(process.env.AEGIS_SHOTS_H || 900);
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;

if (process.env.AEGIS_SMOKE !== '1' || !LOOPBACK.test(apiBase) || !LOOPBACK.test(stubBase)) {
  console.error(
    'marketing-shots-main: refusing to run. Needs AEGIS_SMOKE=1 and loopback ' +
      `AEGIS_API_BASE / AEGIS_SHOTS_STUB (got ${JSON.stringify({ apiBase, stubBase })}). ` +
      'Use scripts/capture-marketing-shots.mjs.'
  );
  process.exit(2);
}
if (!path.isAbsolute(shotsDir) || !Number.isFinite(WIDTH) || !Number.isFinite(HEIGHT)) {
  console.error(
    'marketing-shots-main: AEGIS_SHOTS_DIR must be an absolute path and ' +
      `AEGIS_SHOTS_W/H numbers (got ${JSON.stringify({ shotsDir, WIDTH, HEIGHT })}).`
  );
  process.exit(2);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');

// ---------------------------------------------------------------------------
// Seed the settings the driven turn needs BEFORE the host boots.
// ---------------------------------------------------------------------------
// The stub's own origin is the `openai-compat` base URL, so the lane under
// test dials 127.0.0.1 and nothing else. Seeding the FILE (rather than the
// Settings pane) is safe here because lib/settings.js re-reads it on every
// get(); the local-only endpoint policy (lib/local/endpoints.js) permits this
// row precisely because the origin is loopback.
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
    JSON.stringify({ ...stored, 'openai-compat': { ...(stored['openai-compat'] || {}), baseURL: `${stubBase}/v1` } }, null, 2),
    { mode: 0o600 }
  );
}

// Boot the REAL host. main.js registers its own app.whenReady() handler and
// creates the window there; ours below runs after it and waits for the window.
require('../main.js');

const checks = [];
const consoleErrors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) });
  if (!ok) console.error(`SHOTS_FAIL ${name}: ${detail}`);
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

/**
 * Give the window exactly the asset rectangle before anything is captured.
 *
 * The frame insets are measured rather than assumed: `setContentSize` is
 * advisory on X11, so the outer bounds are grown by the observed difference
 * and the result is verified by reading the content size back. The window is
 * positioned at 0,0 last — capturePage only sees the on-screen part of the
 * window, so a still that hangs off the edges of the X server would come back
 * cropped without ever saying so.
 */
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

/**
 * Capture the REAL window and write it. `capturePage()` grabs the live
 * renderer surface; when the window could not be given exactly WIDTHxHEIGHT of
 * content area (a frame, a min-size constraint) the explicit-rect form is used
 * so the asset is never silently a different size than its name claims.
 */
async function shoot(win, file, extra) {
  await sleep(500);
  let image = await win.webContents.capturePage();
  let size = image.getSize();
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    const rectImage = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
    const rectSize = rectImage.getSize();
    if (rectSize.width === WIDTH && rectSize.height === HEIGHT) {
      image = rectImage;
      size = rectSize;
    }
  }
  const png = image.toPNG();
  const target = path.join(shotsDir, file);
  fs.writeFileSync(target, png);
  return {
    file: target,
    name: file,
    width: size.width,
    height: size.height,
    bytes: png.length,
    capturedAt: new Date().toISOString(),
    ...(extra || {}),
  };
}

// ---------------------------------------------------------------------------
// The three driven states.
// ---------------------------------------------------------------------------

/**
 * Viewport rect of a selector, in CSS pixels. At device-scale-factor 1 the
 * viewport IS the captured surface, so these coordinates are also pixel
 * coordinates in the PNG — which is what lets the evidence point at WHICH part
 * of the frame holds the state being claimed.
 */
const RECT_OF = (selector) => `
  var el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  var r = el.getBoundingClientRect();
  return { selector: ${JSON.stringify(selector)}, x: Math.round(r.x), y: Math.round(r.y),
           width: Math.round(r.width), height: Math.round(r.height) };
`;

const CLASS_OPTIONS = `
  var state = {
    classOptions: Array.prototype.map.call(document.getElementById('class-select').options, function (o) {
      return o.value + ' :: ' + String(o.textContent || '').trim();
    }),
    classValue: document.getElementById('class-select').value,
    modelOptions: (function () {
      var m = document.getElementById('model-select');
      return m ? Array.prototype.map.call(m.options, function (o) { return o.value; }) : null;
    })(),
    hint: (document.getElementById('model-hint') || {}).textContent || ''
  };
`;

/** 1. The model-class picker. */
async function capturePicker(win) {
  // Read the real option list the renderer built, and put the control in the
  // one in-page state a picker has: focused. `:focus` is drawn by the app's own
  // stylesheet, so the still shows the app's own focused control.
  const focused = await js(
    win,
    `
    var sel = document.getElementById('class-select');
    sel.focus();
    ` + CLASS_OPTIONS + `
    return Object.assign(state, { focused: document.activeElement === sel });
  `
  );
  check(
    'picker-is-a-real-select-with-the-declared-classes',
    Array.isArray(focused.classOptions) && focused.classOptions.length >= 4,
    `the renderer built ${JSON.stringify(focused.classOptions)}`
  );
  check('picker-focused', focused.focused === true, `activeElement is not the class select (${focused.focused})`);
  const shot = await shoot(win, '01-model-class-picker.png', {
    picker: focused,
    regions: { picker: await js(win, RECT_OF('#class-select')) },
    // Stated in the artifact's own evidence so nobody reads this still as the
    // open popup: the option list above is the picker's content, not a popup.
    pickerPopupCaptured: false,
  });
  return shot;
}

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
  var out = { rows: [], errors: 0 };
  Array.prototype.forEach.call(rows, function (r) {
    var b = r.querySelector('.body');
    var m = r.querySelector('.meta');
    var text = b ? String(b.textContent || '') : '';
    out.rows.push({ role: r.className, meta: m ? m.textContent : '', chars: text.length });
  });
  out.errorRows = Array.prototype.filter.call(rows, function (r) {
    var m = r.querySelector('.meta');
    var b = r.querySelector('.body');
    return m && /request failed|Error:/i.test(m.textContent + ' ' + (b ? b.textContent : ''));
  }).length;
  return out;
`;

/**
 * 2. A completed answer in the transcript.
 *
 * The prompt is typed into the real composer and submitted through the real
 * submit handler; the answer is streamed by the stub over the same transport
 * stack a live provider would use (openai-compat SSE -> providers.js ->
 * engine.js -> IPC -> preload -> renderer). Nothing about the render path is
 * stubbed.
 */
async function captureAnswer(win) {
  const selected = await js(
    win,
    `
    var sel = document.getElementById('class-select');
    sel.value = 'openai-compat';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    var mi = document.getElementById('model-input');
    if (mi) {
      mi.value = 'stub-coder-7b';
      mi.dispatchEvent(new Event('input', { bubbles: true }));
      mi.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { cls: sel.value, modelInput: mi ? mi.value : null };
  `
  );
  check('answer-lane-selected', selected.cls === 'openai-compat', `class picker reports ${JSON.stringify(selected)}`);
  await sleep(1200);

  const submitted = await js(
    win,
    `
    document.getElementById('prompt').value = ${JSON.stringify(
      'Explain what happens when the agent proposes a file edit.'
    )};
    document.getElementById('composer').requestSubmit();
    return { sendDisabled: document.getElementById('send').disabled };
  `
  );
  check('answer-turn-submitted', submitted.sendDisabled === true, `send button after submit: ${JSON.stringify(submitted)}`);

  const settled = await waitFor(
    () => js(win, SETTLE_PROBE),
    'the answer to finish streaming',
    90000,
    200,
    () => js(win, TRANSCRIPT_STATE)
  );
  const transcript = await js(win, TRANSCRIPT_STATE);
  check(
    'answer-has-real-text-and-no-error-row',
    settled.answerChars > 200 && transcript.errorRows === 0,
    `answer ${settled.answerChars} chars, error rows ${transcript.errorRows} — transcript ${JSON.stringify(transcript.rows)}`
  );
  const regions = {
    answer: await js(
      win,
      `
      var rows = document.querySelectorAll('#messages .msg');
      var last = rows.length ? rows[rows.length - 1] : null;
      var body = last ? last.querySelector('.body') : null;
      if (!body) return null;
      var r = body.getBoundingClientRect();
      return { selector: '#messages .msg:last .body', x: Math.round(r.x), y: Math.round(r.y),
               width: Math.round(r.width), height: Math.round(r.height) };
    `
    ),
  };
  return shoot(win, '02-answer-complete.png', { answer: settled, transcript, regions });
}

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
    hunkHeaders: lines.filter(function (l) { return l.cls === 'diff-hunk'; }).length,
    firstAdded: (lines.filter(function (l) { return l.cls === 'diff-add'; })[0] || {}).text || ''
  };
`;

/**
 * 3. The tool-call diff/approval card, with a proposed edit on screen.
 *
 * Confirm mode is switched on through the REAL toggle (the same click a user
 * makes), the stub answers the next turn with an OpenAI-compatible
 * `delta.tool_calls` frame for `writeFile`, and the engine's approval gate
 * previews it without touching disk — `lib/local/tools.js::previewWriteFile`
 * builds the diff, `requestApproval` ships it as an `{ approval }` chunk, and
 * the renderer draws the card. The call is then DENIED through the card's own
 * button, so the proposed file is never written anywhere.
 */
async function captureApproval(win) {
  const toggled = await js(
    win,
    `
    var t = document.getElementById('confirm-mode-toggle');
    var before = Boolean(t && t.checked);
    if (t && !t.checked) t.click();
    return { before: before, after: Boolean(t && t.checked) };
  `
  );
  check(
    'confirm-mode-on-through-the-real-toggle',
    toggled.after === true,
    `the approval toggle reads ${JSON.stringify(toggled)} — without it the gate is short-circuited and no card can render`
  );
  await sleep(600);

  await js(
    win,
    `
    document.getElementById('prompt').value = ${JSON.stringify(
      'Add a retry wrapper to the flaky upload test. Propose the edit.'
    )};
    document.getElementById('composer').requestSubmit();
    return true;
  `
  );

  const card = await waitFor(
    () => js(win, APPROVAL_PROBE),
    'the tool-call approval card',
    60000,
    200,
    () => js(win, TRANSCRIPT_STATE)
  );
  check(
    'approval-card-shows-a-proposed-edit',
    card.addedLines > 0 && card.hunkHeaders > 0 && card.diffLineCount > 3,
    `card carries ${card.addedLines} added / ${card.removedLines} removed line(s) and ` +
      `${card.hunkHeaders} hunk header(s) — ${JSON.stringify(card)}`
  );
  check(
    'approval-card-offers-a-decision',
    card.buttons.length >= 2,
    `card buttons: ${JSON.stringify(card.buttons)}`
  );

  const cardRect = await js(win, RECT_OF('#messages .approval-card'));
  const diffRect = await js(win, RECT_OF('#messages .approval-diff'));
  check(
    'approval-card-is-on-screen-at-capture-time',
    cardRect && cardRect.width > 200 && cardRect.height > 80 && cardRect.y >= 0 &&
      cardRect.y + cardRect.height <= HEIGHT && cardRect.x + cardRect.width <= WIDTH,
    `card rect ${JSON.stringify(cardRect)} inside the ${WIDTH}x${HEIGHT} viewport`
  );
  const shot = await shoot(win, '03-tool-approval-diff.png', {
    approval: card,
    regions: { card: cardRect, diff: diffRect },
  });

  // Deny through the card's own control. Nothing is written, and the turn is
  // allowed to unwind so the process exits with no in-flight fetch.
  const denied = await js(
    win,
    `
    var card = document.querySelector('#messages .approval-card');
    var btns = card ? card.querySelectorAll('.approval-btn') : [];
    for (var i = 0; i < btns.length; i++) {
      if (/deny/i.test(btns[i].textContent || '')) { btns[i].click(); return String(btns[i].textContent).trim(); }
    }
    return null;
  `
  );
  check('approval-denied-after-the-capture', Boolean(denied), `no Deny button was reachable (clicked ${JSON.stringify(denied)})`);
  const unwound = await waitFor(() => js(win, SETTLE_PROBE), 'the denied turn to unwind', 45000, 250).catch(() => null);
  return Object.assign(shot, { denied: denied, unwound: Boolean(unwound) });
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
async function main() {
  let fatal = null;
  const shots = [];
  let windowState = null;
  try {
    await app.whenReady();
    const win = await waitForWindow();
    windowState = await prepareWindow(win);
    await waitFor(
      () =>
        js(
          win,
          `
          var s = document.getElementById('class-select');
          return Boolean(s && s.options && s.options.length > 0 && document.getElementById('messages'));
        `
        ),
      'the renderer to finish booting',
      45000
    );

    shots.push(await capturePicker(win));
    shots.push(await captureAnswer(win));
    shots.push(await captureApproval(win));
  } catch (err) {
    fatal = (err && err.message) || String(err);
  }

  const ok = !fatal && checks.every((c) => c.ok) && shots.length === 3;
  const payload = { ok, fatal, windowState, checks, shots, expected: { width: WIDTH, height: HEIGHT } };
  if (consoleErrors.length) payload.consoleErrors = consoleErrors.slice(-20);
  process.stdout.write(`SHOTS_EVIDENCE ${JSON.stringify(payload)}\n`);
  checks
    .filter((c) => !c.ok)
    .forEach((c) => process.stdout.write(`SHOTS_CHECK_FAILED ${c.name}: ${c.detail}\n`));
  // Give the pipe a moment to drain before tearing the process down.
  setTimeout(() => app.exit(ok ? 0 : 1), 250);
}

main();
