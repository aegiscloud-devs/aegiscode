#!/usr/bin/env node
'use strict';

/**
 * The OpenAI-compatible shim — AEGIS as a *model provider* for every coding
 * program that already lets you type a base URL.
 *
 * There are two different questions a coding tool can ask an account, and AEGIS
 * answers them through two different doors:
 *
 *   - "what can this assistant DO?" → MCP. `./install.js` writes the config and
 *     the tools in `mcp/tools.js` show up in the tool picker. That covers
 *     Copilot agent mode, Cursor, Windsurf, Cline, Roo, Zed, Continue, Junie.
 *
 *   - "which MODEL writes the code?" → an OpenAI-compatible endpoint. Most
 *     editors, and nearly every other client, let you point at a custom
 *     `base_url` for chat. aegis1 speaks a *different* path
 *     (`/api/v1/chat/completions`, AEGIS key auth, AEGIS body extensions), so
 *     no client can point at it directly. This file is the translation:
 *     loopback-only, `/v1/chat/completions` + `/v1/models`, OpenAI SSE out.
 *
 * It is a thin proxy on purpose. All transport, SSE reassembly, the stalled
 * stream watchdog and the reasoning/tool-call accumulation live in
 * `client/aegis.js`, which every other host uses — so a provider that works in
 * the desktop app cannot behave differently here. This file owns one thing:
 * the OpenAI wire format.
 *
 * Security posture:
 *   - binds `127.0.0.1` only, and refuses a non-loopback `--host` unless
 *     `--allow-remote` is passed explicitly (the endpoint spends the account's
 *     tokens, so exposing it is a decision, not a default);
 *   - never logs or echoes the AEGIS key;
 *   - the key is resolved by the ordinary path (env → 0600 store → .env), so
 *     the shim holds no credential of its own.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const { createClient } = require('../client/aegis.js');
const credentials = require('../client/credentials.js');

/**
 * The pure model-catalog module, which lives with the CLI (`cli/src/models.js`)
 * rather than in `client/`. Two layouts have to work, exactly as `deps.js`
 * documents, because this file is staged into `cli/vendor/hosts/` at publish
 * time and the CLI's own `src/` moves with it:
 *
 *   in-repo   <repo>/hosts/openai-shim.js          -> <repo>/cli/src/models.js
 *   npm       <pkg>/vendor/hosts/openai-shim.js    -> <pkg>/src/models.js
 *
 * A single hard-coded `../cli/src/models.js` resolves in the repo and to
 * `<pkg>/vendor/cli/src/models.js` once installed — a file no layout ever
 * creates, so the shim would die at load with MODULE_NOT_FOUND in exactly the
 * configuration it exists to serve. Resolution is by existence, so a source
 * checkout and an installed package run the same code.
 */
function resolveModelsModule() {
  const candidates = [
    path.join(__dirname, '..', 'cli', 'src', 'models.js'),
    path.join(__dirname, '..', '..', 'src', 'models.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    'aegis-shim: cannot find models.js. Expected cli/src/models.js beside hosts/ ' +
      `(source checkout) or src/models.js in the package root (installed). Looked in: ${candidates.join(', ')}`
  );
}

const { normalizeModelCatalog, pickerEntries } = require(resolveModelsModule());

const DEFAULT_PORT = 8787;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** OpenAI's schema wants `owned_by` and a created timestamp; neither means
 *  anything for a pooled provider, so both are stable constants. */
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z

function logLine(stream, msg) {
  stream.write(`aegis-shim: ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Body translation
// ---------------------------------------------------------------------------

/**
 * Fields the pooled endpoint understands and a caller may legitimately send.
 * Anything else is dropped rather than forwarded: aegis1 validates its body,
 * and passing an unknown key through turns a working client into a 400.
 */
function extraFromBody(body) {
  const extra = {};
  for (const key of ['tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'presence_penalty', 'frequency_penalty']) {
    if (body[key] !== undefined) extra[key] = body[key];
  }
  // `reasoning_effort` is OpenAI's spelling of the AEGIS effort rung; a client
  // that offers the knob should get the behaviour it names, not a silent no-op.
  const eff = body.reasoning_effort || body.effort;
  if (typeof eff === 'string' && ['low', 'medium', 'high'].includes(eff.toLowerCase())) {
    extra.effort = eff.toLowerCase();
  }
  if (body.workers !== undefined) extra.workers = body.workers;
  return extra;
}

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}

function sseSend(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function chunkFrame(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: model || 'aegis',
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object} [opts.client]   Injected transport (tests pass a stub).
 * @param {number} [opts.port]
 * @param {string} [opts.host]
 * @param {boolean} [opts.allowRemote]
 * @param {boolean} [opts.requireKey] Reject callers that send no bearer token.
 * @param {NodeJS.WriteStream} [opts.log]
 * @param {Function} [opts.fetchModels] Override catalog fetch (tests).
 */
function createShimServer(opts = {}) {
  const client = opts.client || createClient(credentials.clientOptions());
  const host = opts.host || '127.0.0.1';
  const port = opts.port === undefined ? DEFAULT_PORT : opts.port;
  const out = opts.log || process.stderr;
  const requireKey = opts.requireKey !== false;
  const fetchModels = opts.fetchModels || (() => client.listModels());

  if (!LOOPBACK.has(host) && !opts.allowRemote) {
    throw new Error(
      `refusing to bind ${host}: the shim spends your account's tokens, so it is loopback-only ` +
        'unless you pass --allow-remote'
    );
  }

  // The catalog is cached for a minute: a model picker calls /v1/models on
  // every focus, and hitting aegiscloud.org each time is a visible stall in the
  // one UI where latency is most obvious.
  let catalog = { at: 0, models: [] };
  const CATALOG_MS = 60_000;

  async function models() {
    if (Date.now() - catalog.at < CATALOG_MS && catalog.models.length) return catalog.models;
    const raw = await fetchModels();
    catalog = { at: Date.now(), models: pickerEntries(normalizeModelCatalog(raw && raw.models ? raw.models : raw)) };
    return catalog.models;
  }

  function sendJson(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function oaiError(res, status, message, type) {
    sendJson(res, status, { error: { message, type: type || 'aegis_error', code: status } });
  }

  function authorized(req) {
    if (!requireKey) return true;
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    return Boolean(m && m[1].trim());
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 8 * 1024 * 1024) throw new Error('request body too large');
      chunks.push(c);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    return JSON.parse(text);
  }

  async function handleModels(res) {
    const list = await models();
    sendJson(res, 200, {
      object: 'list',
      data: list.map((m) => ({
        id: m.id,
        object: 'model',
        created: EPOCH,
        owned_by: 'aegis',
        // Non-standard, harmless, and the reason the picker in Cline/Continue
        // does not show five identical rows.
        ...(m.label && m.label !== m.id ? { name: m.label } : {}),
      })),
    });
  }

  async function handleChat(req, res) {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return oaiError(res, 400, `invalid JSON body: ${err.message}`, 'invalid_request_error');
    }

    const messages = Array.isArray(body.messages) ? body.messages : null;
    if (!messages || !messages.length) {
      return oaiError(res, 400, '`messages` is required', 'invalid_request_error');
    }

    const stream = body.stream === true;
    const id = `chatcmpl-aegis-${Date.now().toString(36)}`;
    const model = body.model && body.model !== 'aegis-default' ? String(body.model) : undefined;

    const args = {
      messages,
      model,
      maxTokens: body.max_tokens || body.max_completion_tokens,
      extra: extraFromBody(body),
      includeUsage: stream,
    };

    if (!stream) {
      try {
        const r = await client.chatCompletion({ ...args, stream: false });
        const msg = (r.choices && r.choices[0] && r.choices[0].message) || { content: '' };
        return sendJson(res, 200, {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: r.model || model || 'aegis',
          choices: [{ index: 0, message: { role: 'assistant', ...msg }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }],
          usage: r.usage || undefined,
        });
      } catch (err) {
        return oaiError(res, err.status && err.status >= 400 && err.status < 600 ? err.status : 502, err.message);
      }
    }

    sseHead(res);
    let closed = false;
    req.on('close', () => { closed = true; });
    const write = (payload) => { if (!closed) sseSend(res, payload); };

    // First frame carries the role, exactly as OpenAI does — some clients
    // (Continue among them) key their stream parser off it.
    write(chunkFrame(id, model, { role: 'assistant', content: '' }));

    try {
      const r = await client.chatCompletion({
        ...args,
        stream: true,
        onStream: (ev) => {
          if (ev.delta) write(chunkFrame(id, model, { content: ev.delta }));
          else if (ev.reasoning) write(chunkFrame(id, model, { reasoning_content: ev.reasoning }));
        },
        onReasoning: (chunk) => write(chunkFrame(id, model, { reasoning_content: chunk })),
      });

      const msg = (r.choices && r.choices[0] && r.choices[0].message) || {};
      // Tool calls are accumulated inside the transport, not streamed
      // fragment-by-fragment, so they arrive as one final frame. That is a
      // legal OpenAI chunk (id + index + name + full arguments), and it is the
      // only shape the shared transport can prove is complete.
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        write(chunkFrame(id, model, {
          tool_calls: msg.tool_calls.map((tc, i) => ({
            index: i,
            id: tc.id,
            type: 'function',
            function: { name: tc.function && tc.function.name, arguments: (tc.function && tc.function.arguments) || '' },
          })),
        }));
      }
      write(chunkFrame(id, model, {}, msg.tool_calls && msg.tool_calls.length ? 'tool_calls' : 'stop'));
      if (r.usage) {
        write({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: r.model || model || 'aegis', choices: [], usage: r.usage });
      }
      if (!closed) { res.write('data: [DONE]\n\n'); res.end(); }
    } catch (err) {
      // Headers are already sent, so the error travels as a terminal SSE frame
      // plus a marker the client can surface — an editor that shows a bare
      // stalled stream teaches the user nothing.
      write({ error: { message: err.message, type: 'aegis_error' } });
      if (!closed) { res.write('data: [DONE]\n\n'); res.end(); }
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return sendJson(res, 200, { ok: true, service: 'aegis-openai-shim', endpoint: `http://${host}:${port}/v1` });
    }
    // `/v1` is the OpenAI convention; Cursor and a few others probe `/models`
    // without the prefix, and refusing that reads as "the endpoint is wrong".
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      if (!authorized(req)) return oaiError(res, 401, 'missing API key — any non-empty value works locally', 'invalid_request_error');
      return handleModels(res).catch((err) => oaiError(res, 502, err.message));
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      if (!authorized(req)) return oaiError(res, 401, 'missing API key — any non-empty value works locally', 'invalid_request_error');
      return handleChat(req, res);
    }
    // Anthropic-shaped probes from editors that auto-detect the provider.
    if (req.method === 'POST' && path === '/v1/messages') {
      return oaiError(res, 404, 'this endpoint speaks the OpenAI schema; point the client at /v1 with the OpenAI provider', 'invalid_request_error');
    }
    return oaiError(res, 404, `no such route: ${req.method} ${path}`, 'invalid_request_error');
  });

  server.listen = ((orig) => function listen(...a) {
    return orig.apply(server, a);
  })(server.listen);

  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/v1`,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const actual = server.address();
          logLine(out, `OpenAI-compatible endpoint on http://${host}:${actual.port}/v1`);
          logLine(out, `point any OpenAI-compatible client at that base URL (any API key value)`);
          resolve(actual);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const opts = { log: process.stderr };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--allow-remote') opts.allowRemote = true;
    else if (a === '--no-auth') opts.requireKey = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgv(argv);
  if (opts.help) {
    process.stdout.write([
      'aegis openai shim — serve AEGIS as an OpenAI-compatible endpoint',
      '',
      '  node hosts/openai-shim.js [--port 8787] [--host 127.0.0.1] [--allow-remote] [--no-auth]',
      '',
      'Then point a coding tool at it:',
      '  base URL   http://127.0.0.1:8787/v1',
      '  API key    anything non-empty (the AEGIS key is read from ~/.aegiscode/.env)',
      '',
    ].join('\n'));
    return 0;
  }
  let shim;
  try {
    shim = createShimServer(opts);
    await shim.listen();
  } catch (err) {
    logLine(process.stderr, err.message);
    return 1;
  }
  const stop = async () => { await shim.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null; // runs until signalled
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === 'number') process.exit(code);
    })
    .catch((err) => {
      logLine(process.stderr, err && err.message ? err.message : err);
      process.exit(1);
    });
}

module.exports = { createShimServer, extraFromBody, DEFAULT_PORT };
