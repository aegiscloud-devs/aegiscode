// The direct-dial policy: an endpoint reached by providers.js bills NOTHING, so
// only an address on this machine may use it. Everything remote belongs on a
// lane that bills (the pooled `aegis` class, or `byok` through the relay).
//
// This file covers the classifier and the two seams that enforce it in the
// desktop host (the CLI dropped its own custom-endpoint class and now only
// ever runs 'aegis'/'byok' — see cli/src/engine.js HOST_CLASSES — but the
// desktop app's direct-dial classes still gate on this same policy).

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  hostOf,
  isLocalEndpoint,
  isDirectDialRow,
  allowsDirectDialRow,
  ensureLocalEndpoint,
  remoteRefusal,
} from '../desktop/lib/local/endpoints.js';
import { createSettingsStore } from '../desktop/lib/settings.js';
import { createLocalEngine } from '../desktop/lib/local/engine.js';

const tmp = (n) => mkdtempSync(join(tmpdir(), `endpoints-${n}-`));

// ------------------------------------------------------- the classifier
{
  // Local: loopback by name, by IPv4, by IPv6 in both spellings.
  for (const url of [
    'http://localhost:11434',
    'http://localhost',
    'http://sub.localhost:8080',
    'http://127.0.0.1:11434',
    'http://127.1.2.3:9',
    'http://[::1]:11434',
    'http://[0:0:0:0:0:0:0:1]:11434',
  ]) {
    assert.equal(isLocalEndpoint(url), true, `loopback is local: ${url}`);
  }

  // Local: RFC1918 / link-local / ULA, and the reserved local suffixes.
  for (const url of [
    'http://10.0.0.5:8080',
    'http://172.16.0.1',
    'http://172.31.255.254',
    'http://192.168.1.50:8000',
    'http://169.254.10.10',
    'http://[fd00::1]:8080',
    'http://[fe80::1]:8080',
    'http://ollama:11434',
    'http://box.local',
    'http://llm.internal',
    'http://nas.lan',
  ]) {
    assert.equal(isLocalEndpoint(url), true, `LAN/local name is local: ${url}`);
  }

  // Remote: public names and public addresses — the lane that must not exist.
  for (const url of [
    'https://api.openai.com/v1',
    'https://api.anthropic.com',
    'https://api.deepseek.com/anthropic',
    'https://api.z.ai/api/paas/v4',
    'http://8.8.8.8',
    'http://1.1.1.1:8080',
    'http://172.15.0.1', // one below the 172.16/12 block
    'http://172.32.0.1', // one above it
    'http://192.169.1.1', // not 192.168/16
    'http://11.0.0.1', // not 10/8
    'http://127.0.0.1.evil.com', // the suffix must END the name
    'http://example.local.evil.com',
    'http://[2001:db8::1]',
  ]) {
    assert.equal(isLocalEndpoint(url), false, `remote is not local: ${url}`);
  }

  // FAIL CLOSED: anything unusable or ambiguous is not local.
  for (const url of ['', '   ', null, undefined, 'not a url', 'http://', 'ftp://x', 42, {}]) {
    assert.equal(isLocalEndpoint(url), false, `unparseable/empty fails closed: ${JSON.stringify(url)}`);
  }

  // A non-http scheme is not an endpoint we dial, even on loopback.
  assert.equal(hostOf('http://127.0.0.1:11434/v1'), '127.0.0.1:11434', 'host includes the port');
  assert.equal(hostOf('garbage'), '', 'unparseable host is empty');

  // The refusal names the URL, the allowed shapes, and where to go instead.
  const msg = remoteRefusal('https://api.openai.com/v1', { subject: 'the openai-compat endpoint' });
  assert(msg.includes('api.openai.com'), 'refusal quotes the offending URL');
  assert(msg.includes('LOCAL'), 'refusal states the rule');
  assert(msg.includes('localhost'), 'refusal lists what IS allowed');
  assert.equal(
    remoteRefusal('https://api.openai.com', { hint: 'HOSTHINT' }).includes('HOSTHINT'),
    true,
    'the host-specific hint is carried through'
  );

  // ensureLocalEndpoint throws a 400 the callers already paint, and passes local.
  assert.equal(ensureLocalEndpoint('http://127.0.0.1:11434'), true, 'local passes the gate');
  let threw = null;
  try {
    ensureLocalEndpoint('https://api.openai.com/v1');
  } catch (e) {
    threw = e;
  }
  assert(threw && threw.code === 'CUSTOM_ENDPOINT_NOT_LOCAL', 'remote throws the shared code');
  assert(threw.status === 400, 'the refusal is a 400-class error');

  // The gate is keyed on the ROW, not the value — this is what keeps the billed
  // BYOK rows storable. They save baseURL '' (the relay owns the URL).
  for (const p of ['openai-compat', 'anthropic', 'custom:zai']) {
    assert.equal(isDirectDialRow(p), true, `${p} is a direct-dial row`);
  }
  for (const p of ['byok:deepseek', 'byok:anthropic', 'aegis', 'openai', 'ollama']) {
    assert.equal(isDirectDialRow(p), false, `${p} is not dialled directly`);
    assert.equal(allowsDirectDialRow(p, 'https://api.deepseek.com'), true, `${p} may keep a remote URL`);
  }
  // A direct-dial row may be cleared or left unconfigured, but not pointed away.
  assert.equal(allowsDirectDialRow('openai-compat', ''), true, 'clearing the row is allowed');
  assert.equal(allowsDirectDialRow('openai-compat', '   '), true, 'blank is unconfigured, not remote');
  assert.equal(allowsDirectDialRow('openai-compat', 'http://127.0.0.1:11434'), true, 'local is storable');
  assert.equal(allowsDirectDialRow('openai-compat', 'https://api.openai.com/v1'), false, 'remote is not storable');
  assert.equal(allowsDirectDialRow('custom:zai', 'https://api.z.ai/api/paas/v4'), false, 'custom:* is gated too');
}

// ------------------------------------------- seam 1: the settings store
{
  const store = createSettingsStore({ dir: tmp('store') });

  for (const provider of ['openai-compat', 'anthropic', 'custom:zai']) {
    let threw = null;
    try {
      store.set(provider, { baseURL: 'https://api.openai.com/v1', key: 'sk-x' });
    } catch (e) {
      threw = e;
    }
    assert(threw, `settings.set('${provider}') must refuse a remote base URL`);
    assert(threw.code === 'CUSTOM_ENDPOINT_NOT_LOCAL', `refusal carries the shared code for ${provider}`);
    assert(
      !JSON.stringify(store.list()).includes('api.openai.com'),
      `the refused URL is not persisted for ${provider}`
    );
  }

  // The unusable configuration therefore cannot be created…
  assert.equal(store.list().length, 0, 'no row was written');

  // …while local endpoints and the billed lanes are all still configurable.
  store.set('openai-compat', { baseURL: 'http://127.0.0.1:11434', key: 'sk-x' });
  assert.equal(store.get('openai-compat').baseURL, 'http://127.0.0.1:11434', 'local endpoint stored');
  store.set('openai-compat', { baseURL: '' });
  assert.equal(store.get('openai-compat').baseURL, '', 'the row can be cleared');
  store.set('byok:deepseek', { baseURL: '', key: 'sk-y' });
  assert.equal(store.rawKey('byok:deepseek'), 'sk-y', 'a BYOK row is untouched by the gate');
}

// ------------------------------------------- seam 2: the dispatch gate
{
  const dir = tmp('dispatch');
  const store = createSettingsStore({ dir });

  // Write the pre-policy shape straight into the file: a row that was legal
  // before this rule existed (or was hand-edited) must still be unusable. The
  // file is only created by the first write, so seed it with a local value.
  store.set('openai-compat', { baseURL: 'http://127.0.0.1:11434', key: 'sk-x' });
  const file = store.file;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data['openai-compat'] = { baseURL: 'https://api.openai.com/v1', key: 'sk-x' };
  writeFileSync(file, JSON.stringify(data));

  const reopened = createSettingsStore({ dir });
  assert.equal(reopened.get('openai-compat').baseURL, 'https://api.openai.com/v1', 'the stale row is on disk');

  let dialled = false;
  const engine = createLocalEngine({
    aegis: { apiKey: '', listModels: async () => ({ models: [] }) },
    settings: reopened,
    ollama: { probe: async () => ({ running: false }), listTags: async () => [] },
    providers: {
      async openaiCompatible() {
        dialled = true;
        return { model: 'm', choices: [{ message: { content: 'ok' } }] };
      },
      async anthropicMessages() {
        dialled = true;
        return { model: 'm', choices: [{ message: { content: 'ok' } }] };
      },
    },
  });

  let threw = null;
  try {
    await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'x' }, () => {});
  } catch (e) {
    threw = e;
  }
  assert(threw, 'dispatch refuses a stored remote URL');
  assert(threw.code === 'CUSTOM_ENDPOINT_NOT_LOCAL', 'dispatch refusal carries the shared code');
  assert.equal(dialled, false, 'no transport call is made — the network is never reached');

  // The class reports why, rather than looking ready.
  const classes = {};
  for (const c of await engine.listClasses()) classes[c.class] = c;
  assert(
    classes['openai-compat'].configured !== true || classes['openai-compat'].blocked === true,
    'a blocked class must not report itself as ready'
  );
}

console.log('endpoints tests passed');
