// A provider that holds the connection open and emits only SSE keep-alive
// comments must time out, not hang the host forever. Observed live on
// 2026-09-14: api.deepseek.com answered a trivial prompt with ": keep-alive"
// and nothing else — bytes kept arriving, so a watchdog armed per read() was
// reset by every one of them and never fired.
//
// This used to drive desktop/lib/local/providers.js::readSSE. That transport
// was deleted with the direct-dial classes, but the SAME bug class is alive in
// the aegis lane: the vendored client (desktop/vendor/aegis.js) carries its own
// inlined SSE reader. Its watchdog is per-PAYLOAD, not per-read — only a parsed
// `data:` frame moves `lastPayloadAt`, so transport keep-alive comments cannot
// suppress it. This file drives the real client against a local http server
// that emits keep-alive-only frames, exactly as the removed test did.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createClient } = require('../desktop/vendor/aegis.js');

/**
 * A local SSE server that opens a `text/event-stream` and writes `frames` in
 * order, each after its own delay (ms). Unless `end` is set the response is
 * NEVER ended, so the client can only escape via its idle watchdog — the hang
 * this guard exists to prevent.
 */
function startServer(frames, { end = false } = {}) {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      // Headers are buffered until the first body write, so a frame list with
      // no bytes yet (the truly-silent case) would hold the response open
      // before fetch() ever resolves and the client's watchdog could arm.
      res.flushHeaders();
      let at = 0;
      for (const [delay, text] of frames) {
        at += delay;
        setTimeout(() => {
          try {
            if (!res.writableEnded) res.write(text);
          } catch {
            /* the response was torn down by the test's close() */
          }
        }, at);
      }
      if (end) {
        setTimeout(() => {
          try {
            if (!res.writableEnded) res.end();
          } catch {
            /* the response was torn down by the test's close() */
          }
        }, at + 1);
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

test('keep-alive-only stream times out instead of hanging', async () => {
  const srv = await startServer(Array.from({ length: 100 }, () => [20, ': keep-alive\n\n']));
  try {
    const client = createClient({ apiKey: 'test-key', apiBase: srv.url });
    const started = Date.now();
    await assert.rejects(
      () =>
        client.chatCompletion({
          prompt: 'hi',
          model: 'test-model',
          stream: true,
          onStream: () => {},
          idleTimeoutMs: 200,
        }),
      /stalled.*keep-alives/,
      'the error names the provider stall, not a dead network'
    );
    assert.ok(Date.now() - started < 3000, 'settled promptly, not after minutes');
  } finally {
    await srv.close();
  }
});

test('keep-alives interleaved with real frames do not shorten the stream', async () => {
  const frames = [];
  for (let i = 0; i < 4; i++) {
    frames.push([60, ': keep-alive\n\n']);
    frames.push([60, `data: ${JSON.stringify({ choices: [{ delta: { content: `part${i} ` } }] })}\n\n`]);
  }
  frames.push([60, 'data: [DONE]\n\n']);
  const srv = await startServer(frames, { end: true });
  try {
    const client = createClient({ apiKey: 'test-key', apiBase: srv.url });
    const deltas = [];
    // Each gap (120ms between real frames) is under the budget, but the whole
    // stream (>500ms) is well past it — an idle budget measured from the last
    // payload must survive that, and keep-alives must not reset it.
    const out = await client.chatCompletion({
      prompt: 'hi',
      model: 'test-model',
      stream: true,
      onStream: (c) => c.delta && deltas.push(c.delta),
      idleTimeoutMs: 200,
    });
    assert.equal(deltas.join(''), 'part0 part1 part2 part3 ');
    assert.equal(out.choices[0].message.content, 'part0 part1 part2 part3 ');
  } finally {
    await srv.close();
  }
});

test('a stream that goes truly silent still times out', async () => {
  const srv = await startServer([]); // opens the stream, then never speaks
  try {
    const client = createClient({ apiKey: 'test-key', apiBase: srv.url });
    await assert.rejects(
      () =>
        client.chatCompletion({
          prompt: 'hi',
          model: 'test-model',
          stream: true,
          onStream: () => {},
          idleTimeoutMs: 150,
        }),
      /stalled - no data/
    );
  } finally {
    await srv.close();
  }
});

console.log('keep-alive stall tests passed');
