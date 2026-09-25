#!/usr/bin/env node
/**
 * The editor-host installer, exercised against real files in a temp directory.
 *
 * Every claim `hosts/install.js` makes about itself is a claim about someone
 * else's config file, so the tests below are written as the failure modes that
 * losing that file would cause:
 *
 *   - a user's own MCP servers, keys and comments survive the write
 *     (MERGE, not overwrite — the reason this module exists at all)
 *   - running install twice is a no-op the second time (IDEMPOTENT), because
 *     a command re-run in CI or from a Makefile must not rewrite bytes
 *   - the old file is backed up before it is touched, and its mode is kept
 *     (BACKUP / MODE)
 *   - a config this module cannot parse is left completely alone rather than
 *     replaced with something we invented (REFUSE)
 *   - the one TOML host round-trips through our own reader (TOML)
 *   - an entry whose script has moved is REPORTED, not silently fine (DRIFT)
 *
 * Nothing here touches the developer's real ~/.config: every plan is given an
 * explicit `ctx` with `home` pointed at a temp directory.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

const hosts = require(join(root, 'hosts', 'install.js'));
const spec = require(join(root, 'hosts', 'spec.js'));
const { TARGETS, getTarget } = require(join(root, 'hosts', 'targets.js'));

let failures = 0;
let passes = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function test(name, fn) {
  const tmp = fs.mkdtempSync(join(os.tmpdir(), 'aegis-hosts-'));
  try {
    fn(tmp);
    passes++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A ctx whose home is a temp dir, so no target can reach the real one. */
function ctxFor(tmp, extra = {}) {
  return hosts.hostCtx({
    home: tmp,
    cwd: join(tmp, 'workspace'),
    env: { HOME: tmp, XDG_CONFIG_HOME: join(tmp, '.config'), ...(extra.env || {}) },
    platform: extra.platform || 'linux',
  });
}

/** The file a target will write, for a ctx. */
function fileFor(id, scope, ctx) {
  return getTarget(id).path(scope, ctx);
}

function writeAt(file, text, mode) {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
  return file;
}

function readAt(file) {
  return fs.readFileSync(file, 'utf8');
}

const SPEC = () => spec.buildSpec({ serverPath: '/opt/aegis/mcp/server.js', apiBase: 'https://aegiscloud.org' });

// ---------------------------------------------------------------------------
// Spec resolution
// ---------------------------------------------------------------------------

test('spec: the real repo checkout resolves to an existing mcp/server.js', () => {
  const found = spec.resolveServer({});
  assert(found.exists, `expected an existing server, looked in ${found.candidates.join(', ')}`);
  assert(/mcp[/\\]server\.js$/.test(found.path), `unexpected path ${found.path}`);
});

test('spec: no key is written unless one was asked for', () => {
  const bare = spec.buildSpec({ serverPath: '/x/mcp/server.js' });
  assert(!('AEGIS_API_KEY' in bare.env), 'a default spec must not carry a key');
  assert(bare.env.AEGIS_API_BASE, 'the API base is not a secret and must always be recorded');
  const withKey = spec.buildSpec({ serverPath: '/x/mcp/server.js', apiKey: 'sk-test' });
  assert(withKey.env.AEGIS_API_KEY === 'sk-test', 'an explicit key must be written when asked');
});

test('spec: --prompt-key emits a reference, never the value', () => {
  const s = spec.buildSpec({ serverPath: '/x/mcp/server.js', promptKey: true });
  assert(s.env.AEGIS_API_KEY === '${input:aegis-api-key}', `got ${s.env.AEGIS_API_KEY}`);
  const input = spec.vscodeKeyInput();
  assert(input.id === 'aegis-api-key' && input.password === true, 'the codex input must be a password prompt');
});

// ---------------------------------------------------------------------------
// Merge preservation — the core guarantee
// ---------------------------------------------------------------------------

test('merge: a user config with other keys and other servers survives intact', (tmp) => {
  const ctx = ctxFor(tmp);
  const file = fileFor('cursor', 'user', ctx);
  const original = {
    // A key we know nothing about. Losing it would be the bug this test exists
    // for: the installer is a guest in someone else's file.
    'editor.fontSize': 14,
    mcpServers: {
      'someone-elses': { command: 'python', args: ['-m', 'their_server'], env: { TOKEN: 'keep-me' } },
    },
  };
  writeAt(file, JSON.stringify(original, null, 2) + '\n');

  const plan = hosts.planTarget(getTarget('cursor'), 'user', { ctx, spec: SPEC() });
  assert(!plan.error, `plan errored: ${plan.error && plan.error.message}`);
  assert(plan.changed, 'adding a new server must count as a change');
  const applied = hosts.apply(plan);
  assert(applied.applied, 'apply must report it wrote');

  const after = JSON.parse(readAt(file));
  assert(after['editor.fontSize'] === 14, 'an unrelated top-level key was dropped');
  assert(after.mcpServers['someone-elses'], 'a pre-existing MCP server was dropped');
  assert(after.mcpServers['someone-elses'].env.TOKEN === 'keep-me', 'a foreign server env was dropped');
  assert(after.mcpServers.aegis, 'our server was not added');
  assert(after.mcpServers.aegis.args[0] === '/opt/aegis/mcp/server.js', 'wrong server path written');
});

test('merge: every target writes its OWN container key', (tmp) => {
  const ctx = ctxFor(tmp);
  // VS Code is `servers`, Zed is `context_servers`, Codex is TOML. Writing the
  // wrong container does not error anywhere — the editor just never starts the
  // server — so this asserts the container actually lands where the row says.
  for (const target of TARGETS) {
    const file = target.path('user', ctx);
    const plan = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
    assert(!plan.error, `${target.id}: ${plan.error && plan.error.message}`);
    hosts.apply(plan);
    const text = readAt(file);
    const leaf = target.container.split('.').pop();
    assert(text.includes(leaf), `${target.id}: container "${leaf}" missing from the written file`);
    assert(text.includes('aegis'), `${target.id}: no aegis entry written`);
  }
});

// ---------------------------------------------------------------------------
// Idempotency — a second run must not rewrite bytes
// ---------------------------------------------------------------------------

test('idempotent: the second plan is a no-op and the bytes are unchanged', (tmp) => {
  const ctx = ctxFor(tmp);
  for (const target of TARGETS) {
    const file = target.path('user', ctx);
    const one = hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
    assert(one.applied, `${target.id}: first install did not write`);
    const bytes = readAt(file);

    const two = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
    assert(!two.changed, `${target.id}: second plan claimed a change — not idempotent`);
    const twoApplied = hosts.apply(two);
    assert(!twoApplied.applied, `${target.id}: second apply wrote despite no change`);
    assert(readAt(file) === bytes, `${target.id}: file bytes changed on a no-op run`);
  }
});

test('idempotent: no backup is made when nothing changes', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  const before = fs.readdirSync(dirname(file)).filter((f) => f.includes('aegis-backup'));
  assert(before.length === 0, 'a fresh file must not be backed up (there was nothing to lose)');

  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  const after = fs.readdirSync(dirname(file)).filter((f) => f.includes('aegis-backup'));
  assert(after.length === 0, 'a no-op run created a backup');
});

// ---------------------------------------------------------------------------
// Backup and mode
// ---------------------------------------------------------------------------

test('backup: the previous contents are preserved verbatim before the write', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  const original = JSON.stringify({ mcpServers: { keepme: { command: 'x' } } }, null, 2) + '\n';
  writeAt(file, original);

  const applied = hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  assert(applied.backupOf, 'no backup was recorded for a pre-existing file');
  assert(fs.existsSync(applied.backupOf), 'the recorded backup does not exist on disk');
  assert(readAt(applied.backupOf) === original, 'the backup is not byte-identical to the original');
  const mode = fs.statSync(applied.backupOf).mode & 0o777;
  assert(mode === 0o600, `backup mode is ${mode.toString(8)}, expected 600 (it may hold a key)`);
});

test('mode: an existing file keeps its permissions', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, '{}\n', 0o640);
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  const mode = fs.statSync(file).mode & 0o777;
  assert(mode === 0o640, `mode changed from 640 to ${mode.toString(8)}`);
});

test('mode: writing a key tightens the file to 0600', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  const s = spec.buildSpec({ serverPath: '/opt/aegis/mcp/server.js', apiKey: 'sk-secret' });
  const plan = hosts.planTarget(target, 'user', { ctx, spec: s });
  hosts.apply(plan, { withKey: true });
  const mode = fs.statSync(file).mode & 0o777;
  assert(mode === 0o600, `a key was written but the file is ${mode.toString(8)}, expected 600`);
});

// ---------------------------------------------------------------------------
// Refusal — never destroy a file we cannot understand
// ---------------------------------------------------------------------------

test('refuse: unparseable JSON is reported and left untouched', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  // A trailing comma: the exact kind of file VS Code itself tolerates.
  const broken = '{\n  "mcpServers": {\n    "a": { "command": "x" },\n  }\n}\n';
  writeAt(file, broken);

  const plan = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
  assert(plan.error, 'a broken config must produce an error, not a plan');
  assert(!plan.after, 'no replacement document may be produced for a broken file');
  const applied = hosts.apply(plan);
  assert(!applied.applied, 'apply wrote into a file it could not parse');
  assert(readAt(file) === broken, 'the broken file was modified');
});

test('refuse: a JSON document that is not an object is left untouched', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, '["not", "an", "object"]\n');
  const plan = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
  assert(plan.error, 'an array must be refused');
  assert(!hosts.apply(plan).applied, 'apply wrote over an array');
  assert(readAt(file) === '["not", "an", "object"]\n', 'the array file was modified');
});

test('dry run: nothing is written', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  const plan = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
  const applied = hosts.apply(plan, { dryRun: true });
  assert(applied.dryRun && !applied.applied, 'a dry run must not claim to have applied');
  assert(!fs.existsSync(file), 'a dry run created the file');
});

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

test('remove: our entry goes, everyone else stays', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, JSON.stringify({ mcpServers: { theirs: { command: 'p' } } }, null, 2) + '\n');
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));

  const plan = hosts.planRemove(target, 'user', { ctx, spec: SPEC() });
  assert(plan.changed, 'removing a present entry must count as a change');
  hosts.apply(plan);
  const after = JSON.parse(readAt(file));
  assert(!after.mcpServers.aegis, 'our entry survived removal');
  assert(after.mcpServers.theirs, 'removal took someone else with it');
});

test('remove: removing what is not there is a no-op, not an error', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, JSON.stringify({ mcpServers: {} }, null, 2) + '\n');
  const plan = hosts.planRemove(target, 'user', { ctx, spec: SPEC() });
  assert(!plan.error, `unexpected error: ${plan.error && plan.error.message}`);
  assert(!plan.changed, 'nothing to remove must not report a change');
  assert(!hosts.apply(plan).applied, 'apply wrote for a no-op removal');
});

// ---------------------------------------------------------------------------
// TOML — the one non-JSON host
// ---------------------------------------------------------------------------

test('toml: the codex section upserts, is idempotent, and parses back', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('codex');
  assert(target.kind === 'mcp-toml', 'codex must be the TOML target');
  const file = target.path('user', ctx);
  const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "python"\nargs = ["-m", "thing"]\n';
  writeAt(file, original);

  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  const text = readAt(file);
  assert(text.includes('model = "gpt-5"'), 'unrelated TOML was dropped');
  assert(text.includes('[mcp_servers.other]'), 'a foreign TOML section was dropped');
  assert(text.includes('[mcp_servers.aegis]'), 'our TOML section was not written');

  const twice = hosts.planTarget(target, 'user', { ctx, spec: SPEC() });
  assert(!twice.changed, 'the TOML upsert is not idempotent');

  const entry = hosts.parseTomlEntry(readAt(file), 'mcp_servers.aegis');
  assert(entry, 'our own TOML section did not parse back');
  assert(entry.command === 'node', `command parsed as ${entry.command}`);
  assert(entry.args[0] === '/opt/aegis/mcp/server.js', `args parsed as ${JSON.stringify(entry.args)}`);
  assert(entry.env.AEGIS_API_BASE === 'https://aegiscloud.org', 'env did not parse back');
  assert(hosts.entryServerPath(entry) === '/opt/aegis/mcp/server.js', 'entryServerPath found the wrong arg');
});

test('toml: removal drops only our section', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('codex');
  const file = target.path('user', ctx);
  writeAt(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "python"\n');
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  hosts.apply(hosts.planRemove(target, 'user', { ctx, spec: SPEC() }));
  const text = readAt(file);
  assert(!text.includes('[mcp_servers.aegis]'), 'our section survived removal');
  assert(text.includes('[mcp_servers.other]'), 'removal took the foreign section');
  assert(text.includes('model = "gpt-5"'), 'removal took the model line');
});

test('toml: a section header with a dot is matched literally, not as a regex', (tmp) => {
  const entry = hosts.parseTomlEntry('[mcp_servers.aegis]\ncommand = "node"\n', 'mcp_servers.aegis');
  assert(entry && entry.command === 'node', 'a literal dotted header must match itself');
  const none = hosts.parseTomlEntry('[mcp_serversXaegis]\ncommand = "node"\n', 'mcp_servers.aegis');
  assert(none === null, 'the dot in the section name was treated as a wildcard');
});

// ---------------------------------------------------------------------------
// Status — the moved-checkout report
// ---------------------------------------------------------------------------

test('status: a fresh install reports installed with a server that exists', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: SPEC() }));
  // Point the written entry at the real server so the existence check passes.
  const real = spec.resolveServer({}).path;
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: spec.buildSpec({ serverPath: real }) }));

  const rows = hosts.status(['cursor'], { ctx, spec: SPEC() });
  const row = rows.find((r) => r.scope === 'user');
  assert(row.exists, 'the config we just wrote does not exist');
  assert(row.installed, 'our entry was not detected');
  assert(row.serverPath === real, `serverPath is ${row.serverPath}, expected ${real}`);
  assert(row.serverExists === true, 'an existing server was reported missing');
});

test('status: a config pointing at a moved checkout is reported, not silently fine', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, JSON.stringify({
    mcpServers: { aegis: { command: 'node', args: [join(tmp, 'gone', 'mcp', 'server.js')], env: {} } },
  }, null, 2) + '\n');

  const row = hosts.status(['cursor'], { ctx, spec: SPEC() }).find((r) => r.scope === 'user');
  assert(row.installed, 'the entry should still count as installed');
  assert(row.serverExists === false, 'a path that does not exist must report serverExists === false');
});

test('status: a hand-written npx entry reports "cannot tell", not "broken"', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  const file = target.path('user', ctx);
  writeAt(file, JSON.stringify({
    mcpServers: { aegis: { command: 'npx', args: ['aegiscode-mcp'] } },
  }, null, 2) + '\n');
  const row = hosts.status(['cursor'], { ctx, spec: SPEC() }).find((r) => r.scope === 'user');
  assert(row.serverPath === null, `expected null, got ${row.serverPath}`);
  assert(row.serverExists === null, 'an unknown script must be null, not false');
});

test('status: a broken config is reported with an error and no entry', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('cursor');
  writeAt(target.path('user', ctx), '{ not json\n');
  const row = hosts.status(['cursor'], { ctx, spec: SPEC() }).find((r) => r.scope === 'user');
  assert(row.error, 'a broken config must surface an error');
  assert(!row.installed, 'a broken config must not report installed');
});

test('status: a host with no config at all reports exists=false and no error', (tmp) => {
  const ctx = ctxFor(tmp);
  const row = hosts.status(['zed'], { ctx, spec: SPEC() }).find((r) => r.scope === 'user');
  assert(!row.exists, 'nothing was written, so the file must not exist');
  assert(!row.installed && !row.error, 'an absent config is not an error');
});

test('status: every row carries docs and a verified flag', (tmp) => {
  const ctx = ctxFor(tmp);
  for (const row of hosts.status(null, { ctx, spec: SPEC() })) {
    assert(typeof row.id === 'string' && row.id, 'a row with no id');
    assert(row.docs, `${row.id} has no docs link — the claim cannot be checked`);
    assert(typeof row.verified === 'boolean', `${row.id} has no verified flag`);
  }
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detected: an editor is found by its config directory, not only its file', (tmp) => {
  const ctx = ctxFor(tmp);
  fs.mkdirSync(join(tmp, '.codex'), { recursive: true });
  fs.mkdirSync(join(tmp, '.config', 'Code'), { recursive: true });
  const found = hosts.detected({ ctx });
  assert(found.has('codex'), 'a host with only a config directory was not detected');
  assert(found.has('vscode'), 'VS Code was not detected from its config directory');
  assert(!found.has('zed'), 'a host that is not installed was reported present');
});

test('detected: an empty home finds nothing', (tmp) => {
  const found = hosts.detected({ ctx: ctxFor(tmp) });
  assert(found.size === 0, `expected nothing, found ${[...found].join(', ')}`);
});

// ---------------------------------------------------------------------------
// Workspace scope
// ---------------------------------------------------------------------------

test('workspace: the file lands in the project, and no key is written by default', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('vscode');
  const plan = hosts.planTarget(target, 'workspace', { ctx, spec: SPEC() });
  assert(!plan.error, `plan errored: ${plan.error && plan.error.message}`);
  assert(plan.file.startsWith(ctx.cwd), `workspace file ${plan.file} is outside ${ctx.cwd}`);
  hosts.apply(plan);
  const text = readAt(plan.file);
  assert(!text.includes('sk-'), 'a secret leaked into a workspace config that gets committed');
  assert(text.includes('"servers"'), 'VS Code workspace config must use the `servers` container');
});

test('vscode: --prompt-key adds the inputs block exactly once', (tmp) => {
  const ctx = ctxFor(tmp);
  const target = getTarget('vscode');
  const file = target.path('user', ctx);
  const s = spec.buildSpec({ serverPath: '/opt/aegis/mcp/server.js', promptKey: true });
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: s }));
  hosts.apply(hosts.planTarget(target, 'user', { ctx, spec: s }));
  const doc = JSON.parse(readAt(file));
  const inputs = (doc.inputs || []).filter((i) => i.id === 'aegis-api-key');
  assert(inputs.length === 1, `expected exactly one inputs entry, found ${inputs.length}`);
  assert(doc.servers.aegis.env.AEGIS_API_KEY === '${input:aegis-api-key}', 'the reference was not written');
});

// ---------------------------------------------------------------------------
// The registry itself
// ---------------------------------------------------------------------------

test('registry: ids are unique, paths resolve, containers are dotted identifiers', () => {
  const seen = new Set();
  for (const t of TARGETS) {
    assert(!seen.has(t.id), `duplicate target id ${t.id}`);
    seen.add(t.id);
    assert(typeof t.label === 'string' && t.label, `${t.id} has no label`);
    assert(/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(t.container), `${t.id}: bad container ${t.container}`);
    assert(typeof t.path === 'function', `${t.id} has no path()`);
    assert(typeof t.entry === 'function' || t.kind === 'mcp-toml', `${t.id} has neither entry() nor a TOML kind`);
    assert(Array.isArray(t.scopes) && t.scopes.length, `${t.id} declares no scopes`);
    for (const s of t.scopes) assert(['user', 'workspace'].includes(s), `${t.id}: unknown scope ${s}`);
  }
});

test('registry: getTarget returns null for an unknown id rather than throwing', () => {
  assert(getTarget('nope-not-real') === null, 'an unknown id must return null');
});

// ---------------------------------------------------------------------------
// openai-shim — the base-URL half of "available to other programs"
// ---------------------------------------------------------------------------

test('shim: binds loopback by default and refuses remote without --allow-remote', () => {
  const shim = require(join(root, 'hosts', 'openai-shim.js'));
  assert(typeof shim.createShimServer === 'function', 'createShimServer is not exported');
  let threw = null;
  try {
    shim.createShimServer({ host: '0.0.0.0' });
  } catch (err) {
    threw = err;
  }
  assert(threw, 'binding a public interface must be refused without an explicit opt-in');
  assert(/allow-remote/i.test(threw.message), `the refusal must name the flag; got: ${threw.message}`);
});

test('shim: the OpenAI request shape maps to what the transport expects', () => {
  const shim = require(join(root, 'hosts', 'openai-shim.js'));
  const extra = shim.extraFromBody({
    model: 'aegis-fast',
    reasoning_effort: 'high',
    tools: [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: {} } }],
  });
  // `effort`, not `reasoningEffort`: the shared client's field is `effort` (see
  // the budget-ladder comment on createClient), so a shim that forwarded
  // OpenAI's spelling verbatim would accept `reasoning_effort` and silently do
  // nothing with it — the exact no-op this mapping exists to prevent.
  assert(extra.effort === 'high', `reasoning_effort was dropped: ${JSON.stringify(extra)}`);
  assert(extra.reasoningEffort === undefined, 'the OpenAI spelling must not leak onto the wire');
  assert(Array.isArray(extra.tools) && extra.tools[0].function.name === 'read_file',
    'tools must pass through in the OpenAI shape the client already accepts');
});

test('shim: a junk effort value is ignored rather than forwarded', () => {
  const shim = require(join(root, 'hosts', 'openai-shim.js'));
  assert(shim.extraFromBody({ reasoning_effort: 'ludicrous' }).effort === undefined,
    'an unknown rung must not reach the budget ladder');
  assert(shim.extraFromBody({ effort: 'MEDIUM' }).effort === 'medium',
    'the OpenAI-cased value must normalise');
  assert(shim.extraFromBody({ workers: 4 }).workers === 4, 'workers must pass through');
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
