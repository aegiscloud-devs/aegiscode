/**
 * Shared marketing-capture harness — the hermetic stub, the virtual display
 * and the Electron resolution helpers used by BOTH asset generators:
 *
 *   scripts/capture-marketing-shots.mjs   §3 stills  (npm run shots)
 *   scripts/record-demo-gif.mjs           §6 demo GIF (npm run demo)
 *
 * Extracted verbatim from `capture-marketing-shots.mjs` so the recording and
 * the stills are driven by the *same* loopback stub that speaks the real wire
 * formats, the same 127.0.0.1-only gate and the same nested-X display. Keeping
 * one copy means a change to the wire shape cannot drift between the two
 * assets — there is no second, parallel stub to go stale.
 *
 * Nothing in here boots or draws on import: every entry point is a function, so
 * the module is inert until a caller uses it.
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');

// The virtual screen the window has to fit inside (see startVirtualDisplay).
export const SCREEN_W = 1920;
export const SCREEN_H = 1080;

// A key shaped nothing like a real one — it only has to be truthy so the
// renderer's Aegis Cloud class reads as "configured". The stub ignores it.
export const FAKE_KEY = 'aegis-shots-test-only';

// ---------------------------------------------------------------------------
// The stub's scripted model output. Both generators drive the SAME three beats
// (a streamed answer, an edit proposal, a post-denial unwind), so the text
// lives here rather than being duplicated per script.
// ---------------------------------------------------------------------------
export const ANSWER_TEXT = `The short version: an edit is proposed, previewed, and only then applied.

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

export const FINAL_TEXT = `Denied — the call was refused, and that refusal was handed back to the model as a normal tool error rather than a crash. No file was written.`;

export const TOOL_CONTENT = `'use strict';

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

export function sse(res, frames, { intervalMs = 30 } = {}) {
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

/**
 * Split a body into realistic streaming fragments (word-ish boundaries).
 * `chunkChars` is the fragment width; the still generator uses 48 (a fast
 * burst), the demo recorder a smaller width so the answer visibly streams for
 * the length of the clip rather than arriving in one blink.
 */
export function contentFrames(text, chunkChars = 48) {
  const chunks = [];
  const lines = text.split('\n');
  for (const line of lines) {
    for (let i = 0; i < line.length; i += chunkChars) chunks.push(line.slice(i, i + chunkChars));
  }
  return chunks.map((content) => ({
    model: 'stub-coder-7b',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }));
}

/** A streamed OpenAI tool call for `writeFile`, in two argument fragments. */
export function toolCallFrames(filePath, content) {
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

// ---------------------------------------------------------------------------
// The stubbed transport. All on one loopback origin:
//   /api/tags                   Ollama's native model list. Required: the
//                               driven class is `local`, and both probe() and
//                               listTags() (lib/local/local.js) read this path
//                               to fill the model picker.
//   /v1/chat/completions        OpenAI-compatible SSE — the wire the `local`
//                               class speaks, and it is the in-process tool
//                               loop that owns the approval gate
//   /v1/models                  OpenAI-shaped list; served so a boot-time
//                               model-list call cannot error out
//   /api/v1/chat/completions    the pooled AEGIS SSE shape (unused by the
//                               driven turns, same reason)
// ---------------------------------------------------------------------------
export function startStubServer({ answerIntervalMs = 30, answerChunkChars = 48 } = {}) {
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
    sse(res, contentFrames(text, answerChunkChars), { intervalMs: answerIntervalMs });
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

      // The `local` class's native model list (Ollama shape). The driven lane
      // is `local`, and its picker is filled from listTags() — without this
      // route the renderer correctly reports "no models on this server yet"
      // and the driven turn never sends a model at all. Both `probe()` and
      // `listTags()` in lib/local/local.js hit exactly this path.
      if (url.pathname === '/api/tags') {
        json(res, {
          models: [
            {
              name: 'stub-coder-7b',
              model: 'stub-coder-7b',
              size: 4_700_000_000,
              details: { family: 'stub', parameter_size: '7B', quantization_level: 'Q4_K_M' },
            },
            {
              name: 'stub-coder-1.5b',
              model: 'stub-coder-1.5b',
              size: 1_000_000_000,
              details: { family: 'stub', parameter_size: '1.5B', quantization_level: 'Q4_K_M' },
            },
          ],
        });
        return;
      }
      // OpenAI-compatible lane (`/v1/models`; kept because the same stub has
      // to answer a boot-time model-list call without erroring).
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

export function payloadToolNames(parsed) {
  const tools = parsed && Array.isArray(parsed.tools) ? parsed.tools : [];
  return tools
    .map((t) => (t && t.function && t.function.name) || (t && t.name) || null)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Launching the real host.
// ---------------------------------------------------------------------------
export function resolveElectronBin() {
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

export function hasXvfb() {
  return spawnSync('sh', ['-c', 'command -v xvfb-run'], { encoding: 'utf8' }).status === 0;
}

export function hasXephyr() {
  return spawnSync('sh', ['-c', 'command -v Xephyr'], { encoding: 'utf8' }).status === 0;
}

/** Screen dimensions of a display, or null when it does not answer. */
export function displaySize(display) {
  const r = spawnSync('xdpyinfo', ['-display', display], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(String(r.stdout || ''));
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function freeDisplayNumber() {
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
export async function startVirtualDisplay() {
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
