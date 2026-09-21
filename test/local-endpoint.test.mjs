#!/usr/bin/env node
/**
 * The fail-closed loopback gate for the `local` model class.
 *
 * `local` is the one class that bills nothing, because the compute is already
 * bought and sitting on hardware the user owns. That is exactly why its base
 * URL has to be fenced: a URL that reaches somebody else's GPU is an unpaid
 * turn, and there is no flag in this codebase to re-open remote dialing (see
 * desktop/lib/local/local.js for the fee argument in full).
 *
 * The fence only works if it fails CLOSED, and the two ways to get it wrong are
 * not symmetric:
 *
 *   - a false "local" (a public host passing) is an unpaid turn taken silently,
 *     billed to nobody — the failure this file exists to prevent;
 *   - a false "remote" (a LAN box being refused) is a refusal the user fixes by
 *     pointing at another address.
 *
 * So the table below is written as pairs: every string that must be ALLOWED is
 * asserted to be allowed, and every string that must be REFUSED is asserted to
 * be refused, with the "almost local" spellings — `example.local.evil.com`,
 * `172.32.x.x`, `127.0.0.1.aegiscloud.org`, octets over 255 — in the refused
 * column on purpose. Those are the ones a suffix match or a prefix match would
 * wave through, and a bare `hostname.endsWith('.local')` check would.
 *
 * `isLocalEndpoint` is the policy; `remoteRefusal` and the two seams that call
 * it (the transport's own `chat()` before the first byte, and the desktop
 * settings store's `set()` before the row is written) are asserted here too, so
 * the policy cannot be correct in isolation and bypassed in practice.
 */
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const local = require('../desktop/lib/local/local.js');
const { createSettingsStore } = require('../desktop/lib/settings.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ------------------------------------------------------ 1. allowed: this box
//
// Everything a model daemon on the user's own machine actually answers to: the
// two loopback names, the whole 127/8 block (not just 127.0.0.1 — a daemon
// bound to 127.0.0.53 is still this machine), IPv6 loopback in both spellings,
// and a bare hostname, which can only resolve through this machine's own
// resolver / hosts file.
const ALLOWED = [
  'http://localhost',
  'http://localhost:11434',
  'http://LOCALHOST:11434',
  'https://localhost:11434',
  'http://127.0.0.1:11434',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://127.1.2.3', // still 127.0.0.0/8
  'http://127.0.0.1:11434/v1', // a path on a loopback base is still loopback
  'http://[::1]:11434',
  'http://[::1]',
  'http://[0:0:0:0:0:0:0:1]:11434',

  // Private LAN: hardware the user already owns, so the "no vendor to pay"
  // argument holds there too (local.js header, and the reason these ranges are
  // in the allow column rather than the deny column).
  'http://10.0.0.5:11434',
  'http://10.255.255.254',
  'http://172.16.4.4',
  'http://172.31.255.1',
  'http://192.168.1.20',
  'http://192.168.0.1:8080',
  'http://169.254.1.1', // link-local
  'http://[fd00::1]:11434', // IPv6 unique-local fc00::/7
  'http://[fe80::1]', // IPv6 link-local fe80::/10

  // Split-DNS / mDNS names, and a dotless host.
  'http://ollama.local',
  'http://gpu-box.local:11434',
  'http://box.internal',
  'http://my-box.lan',
  'http://ollama',
  'http://gpu-box:11434',
];
for (const url of ALLOWED) {
  assert(local.isLocalEndpoint(url), `must ALLOW (local): ${JSON.stringify(url)}`);
}

// --------------------------------------------------- 2. refused: everything else
const REFUSED = [
  // Real, routable third parties — the unpaid-turn failure mode.
  'https://api.openai.com',
  'https://api.openai.com/v1',
  'http://8.8.8.8',
  'http://1.1.1.1',
  'http://evil.com:11434',
  'https://api.anthropic.com',
  'http://[2001:4860:4860::8888]',
  'http://example.com/local',

  // Unparseable. A string the URL parser cannot read is not evidence of a local
  // box, so it fails closed rather than being waved through as "probably fine".
  'not a url',
  '',
  '   ',
  'http://',
  'localhost', // no scheme — a bare word is not a dialable base URL
  '8.8.8.8', // idem: parses as neither absolute nor relative
  'http://localhost:not-a-port',
  null,
  undefined,

  // Host-less or non-dialable scheme. `file:` is the one that matters: it is
  // local in the filesystem sense and would pass a naive "is it local?" test
  // while being un-dialable as a model endpoint.
  'file:///etc/hosts',
  'file://localhost/etc/hosts',
  'ftp://box.local',
  'data:text/plain,hi',

  // "Almost local" — the spellings a suffix/prefix match lets through.
  'http://example.local.evil.com', // `.local` must END the name
  'http://localhost.localdomain', // ...and `.localhost` must too: this is a
  // plain DNS name whose resolution is not guaranteed to be this machine, and
  // the RFC 6761 form (`*.localhost`, and `localhost` itself) is the one that
  // is. Failing closed here is deliberate: a false "local" is an unpaid turn,
  // a false "remote" is a message the user fixes by typing another address.
  'http://127.0.0.1.aegiscloud.org',
  'https://10.0.0.1.aegiscloud.org',
  'http://172.32.0.1', // one past the private block
  'http://172.15.255.255', // one before it
  'http://11.0.0.1',
  'http://192.169.1.1',
  'http://9.255.255.255',
  'http://999.999.999.999', // not an address, and not local
  'http://256.0.0.1',
];
for (const url of REFUSED) {
  assert(!local.isLocalEndpoint(url), `must REFUSE (not local): ${JSON.stringify(String(url))}`);
}

// -------------------------------------------------------------- 3. the refusal
//
// `remoteRefusal` is what every seam calls, so its CONTRACT is asserted, not
// just its verdict: null when usable, and an Error carrying status 400 when not
// (the CLI's error painter and the desktop turn guard both key off that status,
// and a bare Error would surface as a crash instead of a fixable config
// problem).
assert(local.remoteRefusal('http://127.0.0.1:11434') === null, 'remoteRefusal: loopback is usable');
assert(local.remoteRefusal('http://192.168.1.20') === null, 'remoteRefusal: LAN is usable');

for (const url of ['https://api.openai.com', 'http://8.8.8.8', 'not a url', '']) {
  const err = local.remoteRefusal(url);
  assert(err instanceof Error, `remoteRefusal returns an Error for ${JSON.stringify(url)}`);
  assert(err.status === 400, `remoteRefusal status is 400 for ${JSON.stringify(url)}`);
  assert(
    err.message.includes(JSON.stringify(String(url))),
    `refusal names the address it refused: ${JSON.stringify(url)}`
  );
  assert(/aegis or byok/.test(err.message), 'refusal names the classes that DO dial remote models');
}
// The refusal must survive being serialized into an IPC error envelope — the
// desktop's models.settings.set crosses that boundary, and a status that does
// not survive it turns the gate back into a crash.
const ipcShape = JSON.parse(JSON.stringify({
  message: local.remoteRefusal('https://api.openai.com').message,
  status: local.remoteRefusal('https://api.openai.com').status,
}));
assert(ipcShape.status === 400 && /api\.openai\.com/.test(ipcShape.message), 'refusal survives IPC');

// ------------------------------------------------- 4. seam one: the transport
//
// The gate has to sit BEFORE the request, not after: local.js `chat()` refuses
// a remote base URL itself, so no caller can reach the network by skipping the
// settings store (a hand-edited settings.json, a future caller, a direct
// require). `fetch` is stubbed to count calls — the assertion is that a refused
// URL produces a 400 and ZERO fetches, i.e. the byte never goes out.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = async () => {
  fetches += 1;
  throw new Error('the gate let a request reach the network');
};
try {
  let refused = null;
  try {
    await local.chat({ baseURL: 'https://api.openai.com', model: 'gpt-4o', prompt: 'hi' });
  } catch (err) {
    refused = err;
  }
  assert(refused && refused.status === 400, 'chat() refuses a remote base URL with 400');
  assert(fetches === 0, 'chat() refused BEFORE dialing — no request was made');

  // A local URL with no model is still a 400 (and still no request), which is
  // the other half of "never dial something the user did not choose".
  let noModel = null;
  try {
    await local.chat({ baseURL: 'http://127.0.0.1:11434', prompt: 'hi' });
  } catch (err) {
    noModel = err;
  }
  assert(noModel && noModel.status === 400, 'chat() refuses an empty model with 400');
  assert(fetches === 0, 'the empty-model refusal happens before any request too');
} finally {
  globalThis.fetch = realFetch;
}

// --------------------------------------------- 5. seam two: the settings store
//
// The desktop writes the row through desktop/lib/settings.js, which refuses a
// remote URL at set(): a configuration that could never legally be dialed must
// not be persistable, because it would sit on disk looking like a working
// setup. Also asserted here: the refusal leaves NOTHING behind (a half-written
// row is the same trap), and a legal URL round-trips through a reopened store.
const dir = mkdtempSync(join(tmpdir(), 'aegis-local-endpoint-'));
const store = createSettingsStore({ dir });

let storeRefused = null;
try {
  store.set('local', { baseURL: 'https://api.openai.com' });
} catch (err) {
  storeRefused = err;
}
assert(storeRefused instanceof Error, 'settings.set("local", remote) is refused');
assert(storeRefused.status === 400, 'settings.set refusal carries status 400');
assert(store.get('local').baseURL === '', 'a refused base URL leaves no row on disk');

// The unparseable case, which is the one a `startsWith('http://localhost')`
// shortcut would happily write.
let junkRefused = null;
try {
  store.set('local', { baseURL: 'not a url' });
} catch (err) {
  junkRefused = err;
}
assert(junkRefused && junkRefused.status === 400, 'settings.set("local", junk) is refused');
assert(store.get('local').baseURL === '', 'and nothing was written for it either');

const written = store.set('local', { baseURL: 'http://192.168.1.20:11434' });
assert(written.baseURL === 'http://192.168.1.20:11434', 'a LAN base URL is accepted and returned');
assert(
  createSettingsStore({ dir }).get('local').baseURL === 'http://192.168.1.20:11434',
  'the accepted base URL persists'
);
// A key in the local row is not a policy question (there is no credential to
// send), but the row must not start claiming to be "configured" — `configured`
// means "has a key", and a local server has none.
assert(store.get('local').configured === false, 'the local row is never "configured" (no key)');

// ------------------------------------------------------------ 6. the default
assert(
  local.isLocalEndpoint(local.DEFAULT_BASE),
  `the shipped default base URL is itself local: ${local.DEFAULT_BASE}`
);
assert(local.baseOf('http://localhost:11434/') === 'http://localhost:11434', 'baseOf trims a slash');
assert(
  local.baseOf('') === local.DEFAULT_BASE,
  'an empty base falls back to the default rather than to no address'
);

console.log('local endpoint (loopback gate) tests passed');
