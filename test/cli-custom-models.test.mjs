#!/usr/bin/env node
/**
 * The named custom-model catalog — the `custom` class the CLI grew next to
 * BYOK, i.e. the aegiscodex-dev `/model add <id> <name> <model> <baseURL>
 * [apiKey]` concept ported into this host.
 *
 * What this file exists to pin, in order of how expensive each one is to get
 * wrong:
 *
 *  1. The lane is CLOSED to remote endpoints. Every other class bills (`aegis`
 *     is the pooled route, `byok` the relay that charges the AEGIS handling
 *     fee); this one calls a provider DIRECTLY through the desktop transport
 *     and bills nothing, so the only usage it may carry is a LOCAL endpoint,
 *     where no vendor is involved. A remote base URL is refused TWICE — at the
 *     add/validation seam, and again in the dispatch gate before any network
 *     call — and the refusal names the billed lane (/class byok) it must use
 *     instead. Both refusals below are asserted with a stubbed transport that
 *     must never be invoked.
 *  2. A LOCAL entry still works, and still bills nothing. The negative
 *     assertions are what carry the policy: the pooled/byok client is never
 *     touched (no margin, no relay), the URL is the entry's own (never
 *     aegiscloud.org => no handling fee), and the turn makes zero billing
 *     calls. The engine assertion drives a real turn and asserts on the wire
 *     request, so it fails on the throwing stub the CLI used to inject rather
 *     than on a shape.
 *  3. The key is stored where secrets belong. `config.json` is not 0600 and
 *     participates in cloud sync, so `customModels` must carry metadata only —
 *     the key goes to the settings store under `custom:<id>`. Asserted by
 *     reading the config file off disk after an add, the same way the
 *     shared-key tests do.
 *  4. The classifier fails CLOSED. isLocalEndpoint's boundary table is pinned
 *     here: loopback, private ranges, `.local` and a dotless host name are
 *     local; a public host, a public IP and a malformed URL are not. A false
 *     "local" would be an unpaid remote turn.
 *
 * NOTE ON HISTORY: this file used to drive its "custom turn" through
 * `https://api.z.ai/v1` and its wire check through `https://api.anthropic.com` —
 * i.e. it asserted the OLD policy, that a remote custom base URL was a free
 * direct passthrough. Those expectations are gone by design (not weakened):
 * remote URLs are now refused, and the equivalent end-to-end coverage runs
 * against a local base URL instead.
 *
 * Style matches the other CLI tests: createRequire, a local assert() that
 * throws `ASSERT FAILED: ...`, no test framework. The only network is stubbed
 * global fetch (there is none), and the real ~/.aegiscode is never touched.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

// ── this file must not touch the developer's real ~/.aegiscode ───────────────
// The catalog reads/writes config.json and the 0600 key store, and the engine
// assertion below runs a real turn (which appends session state), so redirect
// the data dir before anything is required.
const __testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-custom-'));
process.env.AEGISCODE_HOME = __testHome;
process.on('exit', () => { try { fs.rmSync(__testHome, { recursive: true, force: true }); } catch {} });

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const custom = require(join(root, 'cli', 'src', 'custommodels.js'));
const { loadConfig, updateConfig } = require(join(root, 'cli', 'src', 'config.js'));
const deps = require(join(root, 'cli', 'src', 'deps.js'));
const { createSettingsStore } = deps;
const { createEngine, HOST_CLASSES } = require(join(root, 'cli', 'src', 'engine.js'));

const settings = createSettingsStore({ dir: __testHome });

// Runtime-built key so the CI secret scanner stays quiet — never a literal.
const KEY = `sk-${'y'.repeat(24)}`;

// ---- the class is offered, so /class custom cannot be refused --------------
assert(HOST_CLASSES.includes('custom'), 'custom is a host class (a class the CLI can actually run)');

// ---- the local/remote classifier: the gate the whole policy rests on -------
{
  const local = [
    ['http://localhost:11434/v1', 'localhost'],
    ['http://LOCALHOST:11434', 'localhost is matched case-insensitively'],
    ['http://srv.localhost:8080/v1', 'a *.localhost name'],
    ['http://127.0.0.1:8080/v1', '127.0.0.0/8 loopback'],
    ['http://127.9.9.9/v1', 'the whole /8, not just .0.1'],
    ['http://[::1]:8080/v1', 'the IPv6 loopback literal'],
    ['http://[0:0:0:0:0:0:0:1]:8080/v1', 'and the same address in its long form'],
    ['http://10.0.0.7:8080/v1', '10/8'],
    ['http://172.16.4.4:8080', 'the bottom of 172.16/12'],
    ['http://172.31.255.1:8080', 'and the top of it'],
    ['http://192.168.1.40:8080/v1', '192.168/16'],
    ['http://169.254.10.1/v1', 'link-local IPv4'],
    ['http://[fd00::1]:8080/v1', 'fc00::/7 unique-local'],
    ['http://[fe80::1]:8080/v1', 'fe80::/10 link-local'],
    ['http://gpu-box.local:8080/v1', 'a .local (mDNS) name'],
    ['http://llm.internal/v1', 'a .internal (split-DNS) name'],
    ['http://nas.lan/v1', 'a .lan name'],
    ['http://ollama:11434/v1', 'a bare dotless host name — it can only resolve locally'],
    ['http://llama-box/v1', 'ditto for any dotless name'],
  ];
  for (const [url, why] of local) {
    eq(custom.isLocalEndpoint(url), true, `${why} is local (${url})`);
  }

  const remote = [
    ['https://api.z.ai/v1', 'a public host is remote'],
    ['https://api.anthropic.com', 'including the one whose wire we infer'],
    ['https://api.openai.com/v1', 'and theirs'],
    ['https://gw.corp/v1', 'a corporate gateway'],
    ['http://example.local.evil.com/v1', 'a "local" suffix in a subdomain is still a public name'],
    ['http://8.8.8.8/v1', 'a public IPv4 address'],
    ['http://172.32.0.1/v1', 'just outside 172.16/12'],
    ['http://192.169.1.1/v1', 'just outside 192.168/16'],
    ['http://11.0.0.1/v1', 'just outside 10/8'],
    ['http://[2606:4700::1111]/v1', 'a public IPv6 address'],
    ['http://999.1.1.1/v1', 'a non-address that is not local either'],
    ['http://0.0.0.0:8080/v1', 'ambiguous (a bind, not a destination) — fail closed'],
    ['', 'empty'],
    ['not a url', 'unparseable'],
    ['http://', 'no host'],
    ['x.test', 'not http(s), so not a URL we accept'],
    [null, 'null'],
    [undefined, 'undefined'],
  ];
  for (const [url, why] of remote) {
    eq(custom.isLocalEndpoint(url), false, `${why} is NOT local (${JSON.stringify(url)})`);
  }
}

// ---- wire inference: the one thing that cannot be guessed at call time -----
{
  // Anthropic's Messages API is a different wire (x-api-key, /v1/messages, a
  // top-level system field), so it is recognised from the host; everything else
  // — a local llama.cpp, vLLM, Ollama, LM Studio — speaks the OpenAI shape.
  eq(custom.inferWire('https://api.anthropic.com'), 'anthropic', 'anthropic.com infers the Messages API');
  eq(custom.inferWire('https://api.anthropic.com/v1'), 'anthropic', 'a path does not change the inference');
  eq(custom.inferWire('https://API.ANTHROPIC.COM'), 'anthropic', 'and the host match is case-insensitive');
  eq(custom.inferWire('https://api.openai.com/v1'), 'openai', 'OpenAI infers the OpenAI-compatible wire');
  eq(custom.inferWire('https://notanthropic.com'), 'openai', 'a look-alike domain is NOT anthropic');
  eq(custom.inferWire('http://127.0.0.1:8080/v1'), 'openai', 'a local endpoint infers OpenAI-compatible');
  eq(custom.inferWire(''), 'openai', 'and an unparseable URL never infers anthropic');
}

// ---- validation: every refusal is a one-line reason, never a throw ---------
{
  const bad = [
    [{}, /id is required/],
    [{ id: 'a b', model: 'm', baseURL: 'http://127.0.0.1:8080' }, /no spaces/],
    [{ id: 'a:b', model: 'm', baseURL: 'http://127.0.0.1:8080' }, /":" is the byok separator/],
    [{ id: 'ok', baseURL: 'http://127.0.0.1:8080' }, /model string is required/],
    [{ id: 'ok', model: 'm' }, /must start with http/],
    [{ id: 'ok', model: 'm', baseURL: 'x.test' }, /must start with http/],
    [{ id: 'ok', model: 'm', baseURL: 'https://x.test', wire: 'grpc' }, /wire must be one of/],
  ];
  for (const [fields, re] of bad) {
    const res = custom.normalizeEntry(fields);
    assert(res.error && re.test(res.error), `refused: ${JSON.stringify(fields)} (got ${JSON.stringify(res)})`);
    assert(!res.entry, 'a refused entry is never also returned');
  }

  // The id rule is load-bearing rather than cosmetic: a ":" id would collide
  // with the `provider:model` shape byok parses, and a whitespace id could not
  // be typed back into `/model <id>`.
  const ok = custom.normalizeEntry({ id: 'local', model: 'qwen3:32b', baseURL: 'http://127.0.0.1:8080/v1' });
  eq(ok.entry.id, 'local', 'a clean id is kept');
  eq(ok.entry.name, 'local', 'and the name falls back to the id');
  eq(ok.entry.wire, 'openai', 'with the wire inferred');
  const named = custom.normalizeEntry({ id: 'z', name: ' Z.ai ', model: ' glm-4 ', baseURL: ' http://192.168.1.40:8080/v1 ' });
  eq(named.entry.name, 'Z.ai', 'a given name is trimmed and kept');
  eq(named.entry.model, 'glm-4', 'the model string is trimmed');
  eq(named.entry.baseURL, 'http://192.168.1.40:8080/v1', 'and so is the base URL');
  eq(custom.normalizeEntry({ id: 'a', model: 'claude-sonnet-5', baseURL: 'http://127.0.0.1:8081', wire: 'ANTHROPIC' }).entry.wire,
    'anthropic', 'a stated wire wins over inference, and is lower-cased');
}

// ---- validation seam: a REMOTE base URL is refused, with the fix named -----
{
  const remote = [
    'https://api.z.ai/v1',
    'https://gw.corp/v1',
    'https://api.openai.com/v1',
    'http://8.8.8.8/v1',
  ];
  for (const baseURL of remote) {
    const res = custom.normalizeEntry({ id: 'r', model: 'm', baseURL });
    assert(res.error, `a remote base URL is refused (${baseURL})`);
    assert(!res.entry, 'and no entry is handed back to add');
    assert(/must be LOCAL/.test(res.error), `the refusal says LOCAL (got ${res.error})`);
    assert(/\/class byok/.test(res.error), `and points at the billed lane, /class byok (got ${res.error})`);
    assert(/byok-key/.test(res.error), 'naming the command that saves the provider key there');
  }

  // The same refusal through the real add path, and nothing is written: a
  // refused entry must not appear in config.json, or the dispatch gate would
  // have to be the only thing standing between it and the transport.
  const before = custom.listCustomModels(settings).length;
  const added = custom.addCustom({ id: 'remote-one', name: 'Remote', model: 'gpt-4o', baseURL: 'https://gw.corp/v1', key: KEY }, settings);
  assert(added.error, `addCustom refuses a remote base URL (got ${JSON.stringify(added)})`);
  assert(!added.entry, 'and reports no entry');
  eq(custom.listCustomModels(settings).length, before, 'the catalog is unchanged');
  eq(custom.getCustom('remote-one'), null, 'and no row was stored under the refused id');
  eq(settings.rawKey(custom.customNamespace('remote-one')), null, 'nor a key for it');
}

// ---- add / replace / remove, and the split storage --------------------------
{
  const added = custom.addCustom({ id: 'zai', name: 'Z.ai', model: 'glm-4', baseURL: 'http://127.0.0.1:8080/v1', key: KEY }, settings);
  assert(added.entry, `the entry is added (got ${JSON.stringify(added)})`);

  const rows = custom.listCustomModels(settings);
  eq(rows.length, 1, 'the catalog lists one row');
  eq(rows[0].id, 'zai', 'under the id given');
  eq(rows[0].label, 'Z.ai', 'labelled with the name');
  eq(rows[0].configured, true, 'and marked configured once a key is stored');
  eq(rows[0].local, true, 'and marked local — the field the picker and the engine read');
  assert(/glm-4/.test(rows[0].note) && /127\.0\.0\.1/.test(rows[0].note), `the note names the model and host (got ${rows[0].note})`);

  // config.json is NOT 0600 and participates in cloud sync, so the key must not
  // be in it. Read the file the store actually wrote, not the in-memory copy.
  const raw = JSON.parse(fs.readFileSync(path.join(__testHome, 'config.json'), 'utf8'));
  eq(raw.customModels.length, 1, 'config.json carries the catalog metadata');
  const serialised = JSON.stringify(raw);
  assert(!serialised.includes(KEY), 'and NEVER the API key');
  eq(raw.customModels[0].key, undefined, 'the entry has no key field at all');
  eq(settings.rawKey(custom.customNamespace('zai')), KEY, 'the key lives in the settings store under custom:<id>');

  // Re-adding an id REPLACES rather than appending: /model add doubles as the
  // edit path, so fixing a typo'd base URL must not leave a dead second row.
  custom.addCustom({ id: 'zai', name: 'Z.ai', model: 'glm-4.6', baseURL: 'http://127.0.0.1:8080/v1' }, settings);
  const replaced = custom.listCustomModels(settings);
  eq(replaced.length, 1, 're-adding the same id does not duplicate it');
  eq(custom.getCustom('zai').model, 'glm-4.6', 'and the metadata is the new one');
  eq(settings.rawKey(custom.customNamespace('zai')), KEY, 'a re-add with no key given leaves the stored key alone');

  // A second entry, so removal has to be selective.
  custom.addCustom({ id: 'local', model: 'qwen3:32b', baseURL: 'http://localhost:8080/v1' }, settings);
  eq(custom.listCustomModels(settings).length, 2, 'two entries coexist');
  eq(custom.hasKey(settings, 'local'), false, 'a keyless entry reports itself unconfigured');
  eq(custom.listCustomModels(settings).find((r) => r.id === 'local').local, true, 'a dotless/localhost entry is local too');

  eq(custom.removeCustom('zai', settings).removed, true, 'remove reports what it did');
  eq(custom.listCustomModels(settings).map((r) => r.id).join(','), 'local', 'and drops exactly that entry');
  eq(settings.rawKey(custom.customNamespace('zai')), null, 'forgetting the entry forgets its key too');
  eq(custom.removeCustom('nope', settings).removed, false, 'removing an unknown id reports nothing removed');

  // /model key can set and clear a key without touching the metadata.
  custom.setCustomKey('local', KEY, settings);
  eq(custom.hasKey(settings, 'local'), true, 'a key can be added after the fact');
  custom.setCustomKey('local', null, settings);
  eq(custom.hasKey(settings, 'local'), false, 'and cleared again');
}

// ---- resolveCustom: the catalog entry becomes a dispatch -------------------
{
  custom.addCustom({ id: 'claude-local', model: 'claude-sonnet-5', baseURL: 'http://127.0.0.1:8081', wire: 'anthropic', key: KEY }, settings);
  const a = custom.resolveCustom('claude-local', settings);
  eq(a.wireClass, 'anthropic', 'an anthropic-wire entry maps to the anthropic transport class');
  eq(a.baseURL, 'http://127.0.0.1:8081', 'the base URL is the entry\'s');
  eq(a.model, 'claude-sonnet-5', 'and so is the model string');
  eq(a.key, KEY, 'with the key read live from the store');
  eq(a.local, true, 'and the entry resolves as local');
  eq(custom.resolveCustom('does-not-exist', settings), null, 'an unknown id resolves to null (the caller refuses loudly)');

  custom.addCustom({ id: 'zai', model: 'glm-4', baseURL: 'http://10.0.0.7:8080/v1' }, settings);
  eq(custom.resolveCustom('zai', settings).wireClass, 'openai-compat', 'an openai-wire entry maps to the openai-compat class');
  eq(custom.resolveCustom('zai', settings).key, null, 'and a keyless entry resolves with no key');

  // A row written by an older build (when this lane was open to remote URLs)
  // must classify as remote on READ — `local` is recomputed from the base URL,
  // never taken from the stored row — or the dispatch gate could be bypassed by
  // a config.json that predates the policy.
  const withLegacy = loadConfig().customModels.concat([
    { id: 'legacy-remote', name: 'Legacy', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', wire: 'openai' },
  ]);
  updateConfig({ customModels: withLegacy });
  eq(custom.resolveCustom('legacy-remote', settings).local, false, 'a legacy remote row resolves as NOT local');
  const legacyRow = custom.listCustomModels(settings).find((r) => r.id === 'legacy-remote');
  eq(legacyRow.local, false, 'and lists as not local, so the picker can say so');
  assert(/REMOTE/.test(legacyRow.note), `the row says why it cannot run (got ${legacyRow.note})`);
}

// ---- the end-to-end claim: a LOCAL custom turn is DIRECT and free ----------
//
// The two things this lane exists for are negatives — no pooled route (no
// margin) and no aegiscloud.org (no handling fee) — so both are asserted as
// such: the client's pooled/billed entry points must not be touched, and the
// URL must be the entry's own. Zero billing calls is the policy statement: a
// local endpoint costs nobody anything because no vendor is involved.
{
  const originalFetch = globalThis.fetch;
  const seen = [];
  let providerCalls = 0;
  const originalOpenai = deps.providers.openaiCompatible;
  const originalAnthropic = deps.providers.anthropicMessages;
  deps.providers.openaiCompatible = (...args) => { providerCalls += 1; return originalOpenai(...args); };
  deps.providers.anthropicMessages = (...args) => { providerCalls += 1; return originalAnthropic(...args); };
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: (opts && opts.headers) || {}, body: opts && opts.body ? String(opts.body) : '' });
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello from your own machine' } }] })}\n\n`));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    // Every billed entry point on the client, counted: the pooled route and the
    // BYOK relay (whose handling fee is what makes that lane billable).
    const billing = { pooled: 0, relay: 0, balance: 0 };
    const client = {
      apiKey: 'aegis_test_key',
      async chatCompletion() { billing.pooled += 1; throw new Error('the pooled route must not be used on the custom class'); },
      async byokChatCompletion() { billing.relay += 1; throw new Error('the relay must not be used on the custom class'); },
      async listModels() { billing.pooled += 1; return []; },
      async tokenBankBalance() { billing.balance += 1; return null; },
    };

    custom.addCustom({ id: 'mine', name: 'Mine', model: 'glm-4.6', baseURL: 'http://127.0.0.1:11434/v1', key: KEY }, settings);
    const engine = createEngine({ client, getClass: () => 'custom', settings });

    const classes = await engine.listClasses();
    const customClass = classes.find((c) => c.class === 'custom');
    assert(customClass, 'listClasses offers the custom class');
    eq(customClass.configured, true, 'and reports it configured when the catalog is not empty');
    assert(/local/i.test(customClass.label), `and the class label says the lane is local-only (got ${customClass.label})`);

    const listed = engine.listModels('custom');
    const rows = listed && listed.models ? listed.models : listed;
    eq(rows.length >= 1, true, 'listModels(custom) enumerates the catalog so the picker can show it');
    assert(rows.some((r) => r.id === 'mine'), 'including the entry just added');

    await engine.chat({ model: 'mine', prompt: 'hi' }, () => {});

    eq(seen.length, 1, 'the turn made exactly one provider request');
    eq(providerCalls, 1, 'through the direct provider transport, and only once');
    // The entry's base URL was stored versioned ("…/v1") and the transport
    // normalises to exactly one version segment — so a user who types the base
    // URL with or without /v1 gets the same, working request rather than the
    // `/v1/v1/chat/completions` a naive join would build.
    eq(seen[0].url, 'http://127.0.0.1:11434/v1/chat/completions', 'it went to the entry\'s own local base URL');
    assert(!/aegiscloud\.org/.test(seen[0].url), 'and never to ours — no handling fee on this lane');
    eq(seen[0].headers.Authorization, `Bearer ${KEY}`, 'authenticated with the stored key');
    eq(seen[0].headers['x-api-key'], undefined, 'on the OpenAI wire, not the Anthropic one');
    assert(seen[0].body.includes('glm-4.6'), `the entry's model string is what goes on the wire (got ${seen[0].body})`);
    assert(!seen[0].body.includes('mine'), 'the catalog id is a local alias and is not sent upstream');
    eq(billing.pooled, 0, 'the pooled route was never touched — so there is no margin on this lane');
    eq(billing.relay, 0, 'the BYOK relay was never touched — so no handling fee is billed');
    eq(billing.balance, 0, 'and no billing/balance surface was asked for either');
    eq(seen.filter((r) => !r.url.startsWith('http://127.0.0.1:11434')).length, 0, 'this turn made ZERO billing calls');

    // A pin that is not in the catalog is refused in-process with a reason,
    // rather than shipping `model: undefined` to the endpoint.
    let refused = null;
    try { await engine.chat({ model: 'ghost', prompt: 'hi' }, () => {}); } catch (e) { refused = e; }
    assert(refused, 'a turn pinned to an unknown custom id is refused');
    assert(/\/model add/.test(refused.message), `and the message says how to fix it (got ${refused.message})`);
    eq(seen.length, 1, 'nothing reached the wire');
    eq(providerCalls, 1, 'and the transport was not invoked again');
  } finally {
    globalThis.fetch = originalFetch;
    deps.providers.openaiCompatible = originalOpenai;
    deps.providers.anthropicMessages = originalAnthropic;
  }
}

// ---- the dispatch gate: a REMOTE row is refused with ZERO network calls ----
//
// The add path refuses remote URLs, but a config.json written before the lane
// closed can still hold one (the legacy row added a block above). The gate has
// to stop it before the transport: same refusal text, no fetch, no provider
// call, no billing call. This is the assertion the old version of this file got
// backwards — it used a remote entry AS the end-to-end case.
{
  const originalFetch = globalThis.fetch;
  const seen = [];
  let providerCalls = 0;
  const originalOpenai = deps.providers.openaiCompatible;
  const originalAnthropic = deps.providers.anthropicMessages;
  deps.providers.openaiCompatible = (...args) => { providerCalls += 1; return originalOpenai(...args); };
  deps.providers.anthropicMessages = (...args) => { providerCalls += 1; return originalAnthropic(...args); };
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    throw new Error(`the transport must not be reached for a remote custom entry (saw ${url})`);
  };

  try {
    let billing = 0;
    const client = {
      apiKey: 'aegis_test_key',
      async chatCompletion() { billing += 1; return null; },
      async byokChatCompletion() { billing += 1; return null; },
      async listModels() { billing += 1; return []; },
    };
    eq(custom.getCustom('legacy-remote').baseURL, 'https://api.openai.com/v1', 'the remote row is in the catalog (added above)');
    const engine = createEngine({ client, getClass: () => 'custom', settings });

    let refused = null;
    try { await engine.chat({ model: 'legacy-remote', prompt: 'hi' }, () => {}); } catch (e) { refused = e; }
    assert(refused, 'a remote custom entry is refused at the dispatch gate');
    assert(/must be LOCAL/.test(refused.message), `with the local-only refusal (got ${refused.message})`);
    assert(/\/class byok/.test(refused.message), `naming the billed lane to use instead (got ${refused.message})`);
    assert(/byok-key/.test(refused.message), 'and the command that saves a provider key there');
    eq(refused.status, 400, 'as a client error, not a crash');
    eq(seen.length, 0, 'and the refusal happened with ZERO network calls');
    eq(providerCalls, 0, 'the provider transport was never invoked');
    eq(billing, 0, 'and nothing billable was touched');

    // A refusal must not leave the endpoint wired up for the next turn either:
    // the just-in-time settings row the desktop engine reads stays untouched.
    const row = settings.get('openai-compat') || {};
    assert(String(row.baseURL || '') !== 'https://api.openai.com/v1', 'the remote base URL was not written into the wire-class settings row');
  } finally {
    globalThis.fetch = originalFetch;
    deps.providers.openaiCompatible = originalOpenai;
    deps.providers.anthropicMessages = originalAnthropic;
  }

  // Drop the legacy row again so the persisted-catalog assertion below counts
  // only entries this build accepted.
  eq(custom.removeCustom('legacy-remote', settings).removed, true, 'the legacy remote row can still be removed');
}

// ---- an anthropic-wire entry needs a key, and says so ----------------------
// The Messages API rejects a keyless request, so the failure is stated here in
// the host's words instead of surfacing as a 401 from the provider.
{
  custom.addCustom({ id: 'no-key-claude', model: 'claude-sonnet-5', baseURL: 'http://127.0.0.1:8081', wire: 'anthropic' }, settings);
  const client = { apiKey: 'aegis_test_key', async chatCompletion() { throw new Error('unused'); } };
  const engine = createEngine({ client, getClass: () => 'custom', settings });
  let refused = null;
  try { await engine.chat({ model: 'no-key-claude', prompt: 'hi' }, () => {}); } catch (e) { refused = e; }
  assert(refused, 'a keyless anthropic-wire custom model is refused');
  assert(/\/model key no-key-claude/.test(refused.message), `and the message names the exact fix (got ${refused.message})`);
}

// The catalog survives a reload (it is config.json, not session state).
assert(loadConfig().customModels.length >= 3, 'every entry added above is persisted to config.json');

console.log('cli custom-models: all assertions passed');
