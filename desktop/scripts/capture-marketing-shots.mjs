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

import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');
const DRIVER = path.join(DESKTOP, 'test', 'marketing-shots-main.js');
const OUT_DIR = path.join(REPO, 'docs', 'marketing-assets');

const WIDTH = 1440;
const HEIGHT = 900;
// The virtual screen the window has to fit inside (see startVirtualDisplay).
const SCREEN_W = 1920;
const SCREEN_H = 1080;

// A key shaped nothing like a real one — it only has to be truthy so the
// renderer's Aegis Cloud class reads as "configured". The stub ignores it.
const FAKE_KEY = 'aegis-shots-test-only';

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

// ---------------------------------------------------------------------------
// The stubbed transport. Two real wire formats on one loopback origin:
//   /v1/chat/completions        OpenAI-compatible SSE (the openai-compat class,
//                               which is the lane that runs the in-process tool
//                               loop and therefore the approval gate)
//   /api/v1/chat/completions    the pooled/original SSE shape (unused by the
//                               driven turns, served so a boot-time call cannot
//                               error out)
// ---------------------------------------------------------------------------
const ANSWER_TEXT = `The short version: an edit is proposed, previewed, and only then applied.

1. The model sends a tool call — \`file_path\`, the text it wants replaced, and
   the replacement. It never writes anything itself.
2. The host previews that call without touching disk and renders a diff, so the
   card you approve is generated from the same preview that would be applied.
3. The card is the gate. Approve once and the call runs with a fresh hash check
   on the file; allow it for the session and later calls to that tool skip the
   card; deny, and the refusal is returned to the model as an ordinary tool
   error so it can adapt.

A retry wrapper is a good small example:

\`\`\`js
async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}
\`\`\`

Nothing lands on disk until a decision is made, and a file changed behind the
card is refused rather than overwritten.`;

const FINAL_TEXT = `Denied — the call was refused, and that refusal was handed back to the model as a normal tool error rather than a crash. No file was written.`;

const TOOL_CONTENT = `'use strict';

/**
 * Retry wrapper for the flaky upload test.
 * Keeps the retry policy in one place instead of inlining it per call site.
 */
async function withRetry(fn, attempts = 3, delayMs = 250) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

module.exports = { withRetry };
`;

function sse(res, frames, { intervalMs = 30 } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let i = 0;
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    if (i >= frames.length) {
      clearInterval(timer);
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        /* client left first */
      }
      return;
    }
    const payload = frames[i];
    i += 1;
    try {
      res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);
  res.on('close', () => clearInterval(timer));
}

/** Split a body into realistic streaming fragments (word-ish boundaries). */
function contentFrames(text) {
  const chunks = [];
  const lines = text.split('\n');
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 48) chunks.push(line.slice(i, i + 48));
  }
  return chunks.map((content) => ({
    model: 'stub-coder-7b',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }));
}

/** A streamed OpenAI tool call for `writeFile`, in two argument fragments. */
function toolCallFrames(filePath, content) {
  const args = JSON.stringify({ file_path: filePath, content });
  const half = Math.floor(args.length / 2);
  return [
    {
      model: 'stub-coder-7b',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_shots_write',
                type: 'function',
                function: { name: 'writeFile', arguments: '' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      model: 'stub-coder-7b',
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } },
      ],
    },
    {
      model: 'stub-coder-7b',
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } },
      ],
    },
    { model: 'stub-coder-7b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

function startStubServer() {
  const state = {
    requests: {},
    chatStreams: [],
    toolCallServed: false,
    answersServed: 0,
  };

  function json(res, body, status = 200) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function streamAnswer(res) {
    const text = state.answersServed === 0 ? ANSWER_TEXT : FINAL_TEXT;
    state.answersServed += 1;
    sse(res, contentFrames(text));
  }

  function streamToolCall(res, body) {
    // Relative to the child's cwd, which is the throwaway workspace: the diff
    // header stays a clean path and the write can only land in that temp dir.
    const file = 'lib/retry-policy.js';
    state.toolCallServed = true;
    state.lastToolCallPrompt = String(body || '');
    sse(res, toolCallFrames(file, TOOL_CONTENT));
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      state.requests[url.pathname] = (state.requests[url.pathname] || 0) + 1;

      // OpenAI-compatible lane (the one driven).
      if (url.pathname === '/v1/models') {
        json(res, {
          object: 'list',
          data: [
            { id: 'stub-coder-7b', object: 'model', owned_by: 'aegis-shots-stub' },
            { id: 'stub-coder-1.5b', object: 'model', owned_by: 'aegis-shots-stub' },
          ],
        });
        return;
      }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        const record = {
          index: state.chatStreams.length,
          model: parsed && parsed.model,
          toolsOffered: Boolean(parsed && Array.isArray(parsed.tools) && parsed.tools.length),
          toolNames: payloadToolNames(parsed),
          hasToolResult: /"role"\s*:\s*"tool"/.test(raw) || /\btool:/.test(raw),
          kind: 'answer',
        };
        // The one turn that must propose an edit. Keyed on the prompt text the
        // driver types, so it cannot drift with request ordering.
        const wantsEdit = /Propose the edit/.test(raw) && !record.hasToolResult;
        if (wantsEdit) record.kind = 'tool_call';
        state.chatStreams.push(record);
        if (wantsEdit) streamToolCall(res, raw);
        else streamAnswer(res);
        return;
      }

      // Pooled lane — served so a boot-time call or a class switch cannot error.
      if (url.pathname === '/api/v1/models') {
        json(res, { models: [{ id: 'nexus-brain', label: 'Nexus' }] });
        return;
      }
      if (url.pathname === '/api/v1/chat/completions' && req.method === 'POST') {
        state.chatStreams.push({ index: state.chatStreams.length, kind: 'pooled-answer' });
        streamAnswer(res);
        return;
      }
      json(res, { ok: true, models: [], results: [], sessions: [] });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function payloadToolNames(parsed) {
  const tools = parsed && Array.isArray(parsed.tools) ? parsed.tools : [];
  return tools
    .map((t) => (t && t.function && t.function.name) || (t && t.name) || null)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Launching the real host.
// ---------------------------------------------------------------------------
function resolveElectronBin() {
  const direct = path.join(DESKTOP, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(direct)) return direct;
  try {
    const viaModule = require(path.join(DESKTOP, 'node_modules', 'electron'));
    if (typeof viaModule === 'string' && fs.existsSync(viaModule)) return viaModule;
  } catch {
    /* fall through to the null below */
  }
  return null;
}

function hasXvfb() {
  return spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
}

function hasXephyr() {
  return spawnSync('sh', ['-c', 'command -v Xephyr'], { encoding: 'utf8' }).status === 0;
}

/** Screen dimensions of a display, or null when it does not answer. */
function displaySize(display) {
  const r = spawnSync('xdpyinfo', ['-display', display], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(String(r.stdout || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

function freeDisplayNumber() {
  for (let n = 90; n < 100; n += 1) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  }
  return null;
}

/**
 * A nested X server big enough to hold the asset rectangle.
 *
 * This is the same idea as xvfb-run, using the one X server that is actually
 * present here: Xephyr renders inside a window on the parent display, so the
 * app still runs headlessly as far as it is concerned while its virtual screen
 * is 1920x1080. Returns null when neither is available.
 */
async function startVirtualDisplay() {
  if (hasXvfb()) return { kind: 'xvfb-run', prefix: ['xvfb-run', '-a', `--server-args=-screen 0 ${SCREEN_W}x${SCREEN_H}x24`] };
  if (!hasXephyr()) return null;
  const parent = process.env.DISPLAY || ':0';
  const n = freeDisplayNumber();
  if (n === null) return null;
  const display = `:${n}`;
  const proc = spawn('Xephyr', [display, '-screen', `${SCREEN_W}x${SCREEN_H}x24`, '-nolisten', 'tcp', '-ac'], {
    stdio: 'ignore',
    env: { ...process.env, DISPLAY: parent },
  });
  const deadline = Date.now() + 20000;
  for (;;) {
    const size = displaySize(display);
    if (size) return { kind: `Xephyr ${display} (nested on ${parent})`, prefix: [], display, proc, size };
    if (Date.now() > deadline || proc.exitCode !== null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      return null;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
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
