#!/usr/bin/env node
/**
 * Marketing screenshot asset generator — docs/marketing-plan-social.md §3.
 *
 *   npm run shots            # from desktop/
 *   node desktop/scripts/capture-marketing-shots.mjs
 *
 * §3 wants 1440p stills of the real UI for thumbnails, carousels and README
 * images. This drives the REAL app (`desktop/main.js` + preload + renderer)
 * under Electron and writes PNGs at 1440x900 into `docs/marketing-assets/`:
 *
 *   01-model-class-picker.png   the provider-class picker
 *   02-answer-complete.png      a completed answer in the transcript
 *   03-tool-approval-diff.png   the tool-call approval card, proposed edit visible
 *
 * Hermetic by construction, and gated exactly like `test/electron-smoke.mjs`:
 * this file owns a loopback HTTP server that speaks the real wire formats and
 * points the app at it, and the driver refuses to boot unless AEGIS_SMOKE=1
 * and every configured base is a 127.0.0.1 origin. A stray invocation
 * therefore cannot reach a provider or spend money, and the app's own
 * settings/sessions store is redirected to a temp profile.
 *
 * No image is hand-crafted, retouched or synthesised: every PNG is
 * `webContents.capturePage()` of the live window (see
 * desktop/test/marketing-shots-main.js). §8's "no fabricated evidence" rule is
 * why this script fails loudly instead: if a file is missing, stale, not a
 * PNG, or not 1440x900, the run exits non-zero.
 *
 * 1440x900 needs a display that is at least that big — Chromium clamps a
 * window to the screen it is on, so on a 1280x800 desktop the capture comes
 * back 1280x702 no matter what size is requested. The script therefore brings
 * its own virtual screen: xvfb-run when installed, otherwise Xephyr (a nested
 * X server) at 1920x1080, otherwise whatever DISPLAY already exists — and in
 * that last case it says so and fails the size assertion rather than shipping
 * a cropped still. AEGIS_SHOTS_DISPLAY=:0 forces a specific display.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The hermetic stub, the nested-X display and the Electron lookup are shared
// with scripts/record-demo-gif.mjs — one stub, one wire shape, one gate.
import { startStubServer, startVirtualDisplay, resolveElectronBin, displaySize, FAKE_KEY } from './marketing-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const DRIVER = path.join(DESKTOP, 'test', 'marketing-shots-main.js');
const OUT_DIR = path.join(REPO, 'docs', 'marketing-assets');

const WIDTH = 1440;
const HEIGHT = 900;

const EXPECTED_SHOTS = [
  { name: '01-model-class-picker.png', state: 'the model-class picker' },
  { name: '02-answer-complete.png', state: 'a completed answer in the transcript' },
  { name: '03-tool-approval-diff.png', state: 'the tool-call approval card with a proposed edit' },
];

const failures = [];
const passes = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  return Boolean(ok);
}

/** IHDR dimensions straight out of the PNG header — not from any metadata. */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

async function main() {
  const electronBin = resolveElectronBin();
  check(
    'electron-present',
    Boolean(electronBin),
    electronBin || 'no Electron binary — run `npm ci` in desktop/ first'
  );
  if (!electronBin) {
    report(null);
    return;
  }

  // The tool loop's cwd for the driven turn. Running Electron with this as cwd
  // means a proposed write can only ever land here — and shot 03 denies the
  // call anyway — while keeping the diff header a clean relative path.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-shots-ws-'));
  fs.mkdirSync(path.join(workspace, 'lib'), { recursive: true });
  const stub = await startStubServer();
  const apiBase = `http://127.0.0.1:${stub.port}`;
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-shots-profile-'));

  // Refuse to reuse a previous run's images: a stale file must never be
  // reported as a fresh capture.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const startedAt = Date.now();
  for (const shot of EXPECTED_SHOTS) {
    const target = path.join(OUT_DIR, shot.name);
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }

  const switches = [
    '--no-sandbox',
    '--disable-gpu',
    '--in-process-gpu',
    '--force-device-scale-factor=1',
    DRIVER,
  ];

  let virtual = null;
  let command = electronBin;
  let args = switches;
  const forcedDisplay = process.env.AEGIS_SHOTS_DISPLAY || '';
  if (forcedDisplay) {
    check('headless-display', true, `AEGIS_SHOTS_DISPLAY=${forcedDisplay}`);
  } else {
    virtual = await startVirtualDisplay();
    if (virtual && virtual.prefix.length) {
      command = virtual.prefix[0];
      args = [...virtual.prefix.slice(1), electronBin, ...switches];
      check('headless-display', true, virtual.kind);
    } else if (virtual) {
      check('headless-display', true, virtual.kind);
    } else if (process.env.DISPLAY) {
      const size = displaySize(process.env.DISPLAY);
      check(
        'headless-display',
        Boolean(size) && size.width >= WIDTH && size.height >= HEIGHT,
        `DISPLAY=${process.env.DISPLAY} is ${size ? `${size.width}x${size.height}` : 'unreadable'} — ` +
          `Chromium clamps a window to its screen, so ${WIDTH}x${HEIGHT} cannot be captured here ` +
          `(install xvfb, or run where Xephyr/xvfb-run exists)`
      );
    } else {
      check(
        'headless-display',
        false,
        'no xvfb-run, no Xephyr and no DISPLAY — install xvfb (apt-get install -y xvfb) or run with a display'
      );
    }
  }

  const env = {
    ...process.env,
    AEGIS_SMOKE: '1',
    AEGIS_API_BASE: apiBase,
    AEGIS_API_KEY: FAKE_KEY,
    AEGIS_SHOTS_STUB: apiBase,
    AEGIS_SHOTS_DIR: OUT_DIR,
    AEGIS_SHOTS_WORKSPACE: workspace,
    AEGIS_SHOTS_W: String(WIDTH),
    AEGIS_SHOTS_H: String(HEIGHT),
    // The app must never touch the developer's real settings/sessions store.
    XDG_CONFIG_HOME: userData,
    HOME: process.env.HOME || userData,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  };
  delete env.AEGIS_MEMORY_TOKEN;
  delete env.AEGIS_TOKEN;

  // The whole point of the gate: nothing but the stub's origin is reachable.
  check(
    'all-bases-are-loopback',
    /^http:\/\/127\.0\.0\.1:\d+$/.test(env.AEGIS_API_BASE) && /^http:\/\/127\.0\.0\.1:\d+$/.test(env.AEGIS_SHOTS_STUB),
    `api=${env.AEGIS_API_BASE} stub=${env.AEGIS_SHOTS_STUB}`
  );

  if (virtual && virtual.display) env.DISPLAY = virtual.display;
  if (forcedDisplay) env.DISPLAY = forcedDisplay;

  const child = spawn(command, args, {
    // cwd = the throwaway workspace (see above). main.js resolves the renderer
    // through __dirname, so this only moves the tool loop's root.
    cwd: workspace,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const timeoutMs = Number(process.env.AEGIS_SHOTS_TIMEOUT_MS || 240000);
  const exitCode = await new Promise((resolve) => {
    const killer = setTimeout(() => {
      failures.push(`electron run timed out after ${timeoutMs}ms`);
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve(signal ? `signal:${signal}` : code);
    });
  });

  await stub.close();
  if (virtual && virtual.proc) {
    try {
      virtual.proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }

  const evidenceLine = stdout.split('\n').find((l) => l.startsWith('SHOTS_EVIDENCE '));
  let payload = null;
  if (evidenceLine) {
    try {
      payload = JSON.parse(evidenceLine.slice('SHOTS_EVIDENCE '.length));
    } catch (err) {
      failures.push(`could not parse SHOTS_EVIDENCE: ${err.message}`);
    }
  }
  if (process.env.AEGIS_SHOTS_DEBUG === '1' || !payload) {
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-40).join('\n'));
    if (!payload && stdout.trim()) console.error(stdout.trim().split('\n').slice(-40).join('\n'));
  }

  check('electron-exit-0', exitCode === 0, `exit=${exitCode}`);
  check(
    'driver-evidence',
    Boolean(payload),
    evidenceLine ? '' : 'no SHOTS_EVIDENCE line on stdout (run with AEGIS_SHOTS_DEBUG=1 to see the tail)'
  );
  if (payload) {
    check('driver-ok', payload.ok === true, payload.fatal ? `fatal: ${payload.fatal}` : '');
    for (const c of payload.checks || []) {
      check(`driver:${c.name}`, Boolean(c.ok), c && !c.ok ? String(c.detail) : '');
    }
    const reported = new Map((payload.shots || []).map((s) => [s.name, s]));
    check(
      'driver-wrote-every-shot',
      EXPECTED_SHOTS.every((s) => reported.has(s.name)),
      `reported ${JSON.stringify([...reported.keys()])}`
    );
  }

  // ── the stub saw a real tool-call turn ───────────────────────────────────
  check(
    'stub-served-a-tool-call-turn',
    stub.state.toolCallServed === true,
    `the stub never sent a tool_calls frame, so shot 03 cannot be the approval card: ` +
      `${JSON.stringify(stub.state.chatStreams)}`
  );
  check(
    'stub-served-at-least-two-answers',
    stub.state.answersServed >= 2,
    `${stub.state.answersServed} answer stream(s) — expected the completed answer plus the ` +
      `post-denial unwind`
  );

  // ── the files themselves ────────────────────────────────────────────────
  const digests = [];
  for (const shot of EXPECTED_SHOTS) {
    const target = path.join(OUT_DIR, shot.name);
    let buf = null;
    try {
      buf = fs.readFileSync(target);
    } catch {
      failures.push(`missing-file:${shot.name} — ${shot.state} was not captured`);
      continue;
    }
    const dims = pngSize(buf);
    const stat = fs.statSync(target);
    const driverShot = payload && (payload.shots || []).find((s) => s.name === shot.name);
    check(
      `file:${shot.name}`,
      Boolean(dims) && dims.width === WIDTH && dims.height === HEIGHT && buf.length > 0,
      dims
        ? `PNG header says ${dims.width}x${dims.height}, expected ${WIDTH}x${HEIGHT}`
        : `not a PNG (${buf.length} bytes)`
    );
    // A blank/empty frame compresses to a few KB; a real UI still does not.
    // This is a floor against "the window never painted", not a quality bar.
    check(
      `painted:${shot.name}`,
      buf.length > 20000,
      `${buf.length} bytes — too small to be a painted 1440x900 frame`
    );
    check(
      `fresh:${shot.name}`,
      stat.mtimeMs >= startedAt,
      `mtime ${new Date(stat.mtimeMs).toISOString()} predates this run (${new Date(startedAt).toISOString()})`
    );
    if (driverShot) {
      check(
        `driver-dims-match:${shot.name}`,
        driverShot.width === dims.width && driverShot.height === dims.height,
        `driver reported ${driverShot.width}x${driverShot.height}, file is ${dims.width}x${dims.height}`
      );
    }
    digests.push({ name: shot.name, sha: sha(buf), bytes: buf.length, dims });
  }
  const unique = new Set(digests.map((d) => d.sha));
  check(
    'shots-are-distinct-frames',
    digests.length === EXPECTED_SHOTS.length && unique.size === digests.length,
    `${digests.length} file(s), ${unique.size} distinct frame(s) — identical PNGs mean one state ` +
      `was captured and copied, not captured`
  );

  report({ dims: digests, state: stub.state, payload, display: (virtual && virtual.kind) || forcedDisplay || process.env.DISPLAY });
}

function report({ dims, state, payload, display } = {}) {
  console.log('\n── marketing screenshot assets (plan §3) ───────────────────────');
  for (const p of passes) console.log(`  PASS  ${p}`);
  for (const f of failures) console.log(`  FAIL  ${f}`);
  if (dims) {
    console.log('\n  assets written to docs/marketing-assets/');
    for (const d of dims) {
      console.log(`    ${d.name.padEnd(28)} ${String(d.bytes).padStart(8)} bytes  ${d.dims.width}x${d.dims.height}  sha256:${d.sha}`);
    }
  }
  if (payload && payload.windowState) {
    console.log(`\n  window: content ${payload.windowState.contentWidth}x${payload.windowState.contentHeight}, ` +
      `outer ${JSON.stringify(payload.windowState.outer)}, dpr ${payload.windowState.devicePixelRatio}`);
  }
  if (payload && payload.shots) {
    const picker = (payload.shots[0] || {}).picker;
    if (picker) console.log(`\n  picker options: ${JSON.stringify(picker.classOptions)}`);
    const answer = (payload.shots[1] || {}).answer;
    if (answer) console.log(`  answer: ${answer.answerChars} chars in ${answer.rows} transcript row(s)`);
    const approval = (payload.shots[2] || {}).approval;
    if (approval) {
      console.log(
        `  approval card: "${approval.title}" — ${approval.addedLines} added line(s), ` +
          `buttons ${JSON.stringify(approval.buttons)}, denied="${(payload.shots[2] || {}).denied}"`
      );
    }
  }
  if (display) console.log(`  display: ${display}`);
  if (state) console.log(`  stub saw: ${JSON.stringify(state.chatStreams.map((s) => s.kind))}`);
  for (const n of notes) console.log(`  NOTE  ${n}`);
  console.log(`\n  ${failures.length === 0 ? 'OK' : 'FAILED'} — ${passes.length} passed, ${failures.length} failed\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((err) => {
  failures.push(`unhandled: ${(err && err.stack) || err}`);
  report(null);
});
