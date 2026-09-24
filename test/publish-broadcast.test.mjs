// `publish broadcast` -- fans one piece of text out to every LIVE channel in
// parallel. No test here touches the network; fetchImpl is always injected.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXIT, main } from '../tools/publish/lib/run.mjs';

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

function mkHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broadcast-home-'));
  tmpDirs.push(dir);
  return dir;
}

const X_ENV = { X_BEARER_TOKEN: 'x-bearer-TESTTOKEN0000' };
const MASTODON_ENV = { MASTODON_INSTANCE: 'https://mastodon.social', MASTODON_ACCESS_TOKEN: 'masto-TESTTOKEN0000' };
const BLUESKY_ENV = { BLUESKY_HANDLE: 'aegiscloud.org', BLUESKY_APP_PASSWORD: 'xxxx-xxxx-xxxx-xxxx' };

async function run(argv, opts = {}) {
  const out = [];
  const { code } = await main(argv, { env: {}, home: mkHome(), repoRoot: '.', write: (s) => out.push(s), ...opts });
  return { code, text: out.join('') };
}

test('broadcast requires --text', async () => {
  const { code, text } = await run(['broadcast'], { env: X_ENV });
  assert.equal(code, EXIT.USAGE);
  assert.match(text, /--text/);
});

test('broadcast exits DARK when no channel is live', async () => {
  const { code, text } = await run(['broadcast', '--text', 'hello'], { env: {} });
  assert.equal(code, EXIT.DARK);
  assert.match(text, /DARK/);
});

test('a dry run lists every live channel and makes no network call', async () => {
  const fetchImpl = async (url) => { throw new Error(`no network call was expected: ${url}`); };
  const { code, text } = await run(['broadcast', '--text', 'hello world'], {
    env: { ...X_ENV, ...MASTODON_ENV },
    fetchImpl,
  });
  assert.equal(code, EXIT.OK);
  assert.match(text, /--- x ---/);
  assert.match(text, /--- mastodon ---/);
  assert.doesNotMatch(text, /--- bluesky ---/, 'bluesky has no credentials in this test and must not appear');
});

test('--channels restricts the fan-out to the requested subset', async () => {
  const { text } = await run(['broadcast', '--text', 'hi', '--channels', 'mastodon'], {
    env: { ...X_ENV, ...MASTODON_ENV },
  });
  assert.doesNotMatch(text, /--- x ---/);
  assert.match(text, /--- mastodon ---/);
});

test('over-length text is truncated per channel with a warning, not silently sent whole', async () => {
  const text = 'x'.repeat(400); // fits Mastodon (500) and Bluesky (300 -- no, over), over X (280)
  const { text: out } = await run(['broadcast', '--text', text], { env: { ...X_ENV, ...MASTODON_ENV } });
  const xSection = out.split('--- mastodon ---')[0];
  assert.match(xSection, /WARNING: truncated to fit x-post/);
  const mastodonSection = out.split('--- mastodon ---')[1];
  assert.doesNotMatch(mastodonSection, /WARNING/, '400 chars fits the 500 Mastodon budget untruncated');
});

test('--live sends every live channel in parallel and reports per-channel results', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    if (url.includes('api.x.com')) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: '111' } }) };
    }
    if (url.includes('mastodon.social')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: '222' }) };
    }
    return { ok: false, status: 500, text: async () => '{}' };
  };
  const { code, text } = await run(['broadcast', '--text', 'launch', '--live'], {
    env: { ...X_ENV, ...MASTODON_ENV },
    fetchImpl,
  });
  assert.equal(code, EXIT.OK);
  assert.match(text, /x: sent \(201\)/);
  assert.match(text, /mastodon: sent \(200\)/);
  assert.equal(calls.length, 2, 'both channels were actually called');
});

test('one channel failing does not block or hide the other channel sending', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('api.x.com')) return { ok: false, status: 403, text: async () => '{"detail":"forbidden"}' };
    if (url.includes('mastodon.social')) return { ok: true, status: 200, text: async () => JSON.stringify({ id: '333' }) };
    throw new Error(`unexpected url: ${url}`);
  };
  const { code, text } = await run(['broadcast', '--text', 'launch', '--live'], {
    env: { ...X_ENV, ...MASTODON_ENV },
    fetchImpl,
  });
  assert.equal(code, EXIT.LIVE_FAILED, 'a partial failure is reported as LIVE_FAILED, not silently OK');
  assert.match(text, /x: FAILED/);
  assert.match(text, /mastodon: sent \(200\)/, 'mastodon must still have been sent despite x failing');
});

test('no secret reaches broadcast output, dry run or live', async () => {
  const secret = 'BEARER-CANARY-VALUE-0099';
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '{"id":"1"}' });
  for (const live of [false, true]) {
    const { text } = await run(['broadcast', '--text', 'hi', ...(live ? ['--live'] : [])], {
      env: { X_BEARER_TOKEN: secret },
      fetchImpl,
    });
    assert.ok(!text.includes(secret), `secret leaked with live=${live}`);
  }
});
