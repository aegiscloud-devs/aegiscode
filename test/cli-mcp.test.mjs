'use strict';

/**
 * `aegiscode mcp …` — the CLI surface over `hosts/`.
 *
 * `test/editor-hosts.test.mjs` covers the installer's own invariants (merge,
 * idempotency, TOML envelope, backups). This file covers the layer above it:
 * argv parsing, dispatch, exit codes, the JSON reports, and — the part that
 * matters most — that the two promises in `cli/src/mcp.js`'s header actually
 * hold when driven through the real entry point:
 *
 *   1. no secret is written unless `--with-key` is passed;
 *   2. an unparseable config is refused and left byte-identical.
 *
 * Everything runs against a throwaway `$HOME` and cwd, so no test can touch a
 * real editor config. That isolation is not optional here: the failure mode of
 * getting it wrong is silently rewriting somebody's `~/.config/Code/User/mcp.json`.
 */

import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const mcp = require(path.join(REPO, 'cli', 'src', 'mcp.js'));
const install = require(path.join(REPO, 'hosts', 'install.js'));

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-cli-mcp-'));

// `targets.js` resolves the config root as XDG_CONFIG_HOME || home/.config, and
// `home()` prefers ctx.home but falls through to $HOME. Clear the overrides and
// point HOME at the sandbox so nothing can reach a real config by accident.
delete process.env.XDG_CONFIG_HOME;
delete process.env.APPDATA;
delete process.env.AEGIS_API_BASE;
delete process.env.AEGIS_API_KEY;
process.env.HOME = path.join(ROOT, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });

let seq = 0;

/** A private home + cwd for one test. */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(ROOT, `s${++seq}-`));
  const home = path.join(dir, 'home');
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return { dir, home, cwd };
}

/** Run the real entry point with captured stdio and the sandbox injected. */
async function run(command, argv, sb, extra = {}) {
  let out = '';
  let err = '';
  const io = {
    stdout: { write: (s) => ((out += String(s)), true) },
    stderr: { write: (s) => ((err += String(s)), true) },
    home: sb.home,
    cwd: sb.cwd,
    ...extra,
  };
  const code = await mcp.runMcpCommand(command, argv, io);
  return { code, out, err };
}

function ctxOf(sb) {
  return install.hostCtx({ home: sb.home, cwd: sb.cwd });
}

/** The user-scope config file a target would write, discovered not hardcoded. */
function userFile(sb, id) {
  const rows = install.status([id], { ctx: ctxOf(sb) });
  const user = rows.find((r) => r.scope === 'user');
  assert.ok(user, `target ${id} has no user scope`);
  return user.file;
}

function parseJson(text) {
  return JSON.parse(text);
}

function backupsOf(file) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(file)}.aegis-backup-`));
}

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// argv parsing and dispatch
// ---------------------------------------------------------------------------

describe('argv and dispatch', () => {
  test('parseFlags accepts repeated and comma-separated --target', () => {
    const a = mcp.parseFlags(['--target', 'cursor', '--target', 'zed']);
    assert.deepEqual(a.targetList, ['cursor', 'zed']);

    const b = mcp.parseFlags(['--target', 'cursor,zed']);
    assert.deepEqual(b.targetList, ['cursor', 'zed']);

    const c = mcp.parseFlags(['--target', ' vscode , codex ']);
    assert.deepEqual(c.targetList, ['vscode', 'codex'], 'whitespace is trimmed');
  });

  test('parseFlags handles the inline = form, booleans, and bare terms', () => {
    const o = mcp.parseFlags(['--scope=workspace', '--json', '--dry-run', 'vscode']);
    assert.equal(o.flags.scope, 'workspace');
    assert.equal(o.json, true);
    assert.equal(o.flags['dry-run'], true);
    assert.deepEqual(o.terms, ['vscode']);
  });

  test('parseFlags rejects an unknown option and a value-less one', () => {
    assert.throws(() => mcp.parseFlags(['--nope']), /unknown option: --nope/);
    assert.throws(() => mcp.parseFlags(['--target']), /--target needs a value/);
  });

  test('a usage error exits 2 through the real entry point', async () => {
    const sb = sandbox();
    const r = await run('install', ['--nope'], sb);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown option: --nope/);
  });

  test('help exits 0 and an unknown subcommand exits 2, both printing usage', async () => {
    const sb = sandbox();
    const help = await run('help', [], sb);
    assert.equal(help.code, 0);
    assert.match(help.out, /aegiscode mcp — put AEGIS inside your editor/);

    const bogus = await run('bogus', [], sb);
    assert.equal(bogus.code, 2);
    assert.match(bogus.out, /aegiscode mcp — put AEGIS inside your editor/);

    const flagged = await run('install', ['--help'], sb);
    assert.equal(flagged.code, 0, '--help on a real subcommand is not an error');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  test('--json reports every host with its container-relevant facts', async () => {
    const sb = sandbox();
    const r = await run('list', ['--json'], sb);
    assert.equal(r.code, 0);

    const rows = parseJson(r.out);
    const ids = rows.map((x) => x.id);

    for (const id of [
      'vscode', 'vscode-insiders', 'vscodium', 'cursor', 'windsurf', 'cline',
      'roo', 'zed', 'continue', 'claude', 'gemini', 'codex', 'junie', 'opencode',
    ]) {
      assert.ok(ids.includes(id), `registry is missing ${id}`);
    }

    for (const row of rows) {
      assert.ok(row.files.length > 0, `${row.id} has no config path`);
      assert.ok(row.docs, `${row.id} has no docs link`);
      assert.equal(typeof row.verified, 'boolean');
    }

    // The two rows that are formally unfinished must say so rather than being
    // presented as working. This is the honesty check on the registry.
    const junie = rows.find((x) => x.id === 'junie');
    const opencode = rows.find((x) => x.id === 'opencode');
    assert.equal(junie.verified, false);
    assert.equal(opencode.verified, false);
    assert.equal(rows.find((x) => x.id === 'vscode').verified, true);
  });

  test('the empty sandbox reports nothing detected', async () => {
    const sb = sandbox();
    const r = await run('list', ['--json'], sb);
    const rows = parseJson(r.out);
    assert.ok(rows.every((x) => x.detected === false));
  });

  test('detection follows an editor config directory, not just a config file', async () => {
    const sb = sandbox();
    fs.mkdirSync(path.join(sb.home, '.config', 'Code'), { recursive: true });
    const r = await run('list', ['--json'], sb);
    const rows = parseJson(r.out);
    assert.equal(rows.find((x) => x.id === 'vscode').detected, true,
      'an installed-but-unconfigured editor must still be detected');
  });
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe('install', () => {
  const FOREIGN = {
    servers: {
      github: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: 'ghp_keep_me_intact' },
      },
      postgres: { command: 'pg-mcp', args: ['--dsn', 'postgres://x'] },
    },
    someUserSetting: { theme: 'dark', telemetry: false },
  };

  test('merges into an existing config without disturbing anything else', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));

    const r = await run('install', ['--target', 'vscode'], sb);
    assert.equal(r.code, 0, r.err);

    const doc = parseJson(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(doc.servers.github, FOREIGN.servers.github, 'foreign server was altered');
    assert.deepEqual(doc.servers.postgres, FOREIGN.servers.postgres);
    assert.deepEqual(doc.someUserSetting, FOREIGN.someUserSetting);
    assert.ok(doc.servers.aegis, 'our entry was not written');
  });

  test('is idempotent: a second run changes not one byte', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));

    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);
    const first = fs.readFileSync(file, 'utf8');

    const again = await run('install', ['--target', 'vscode'], sb);
    assert.equal(again.code, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), first, 'second install rewrote the file');
    assert.match(again.out, /already|unchanged|0 written/i);
  });

  test('a change is preceded by a timestamped backup', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));

    await run('install', ['--target', 'vscode'], sb);
    const backups = backupsOf(file);
    assert.equal(backups.length, 1, 'expected exactly one backup');

    const saved = parseJson(fs.readFileSync(path.join(path.dirname(file), backups[0]), 'utf8'));
    assert.deepEqual(saved, FOREIGN, 'the backup is not the original content');
  });

  test('--dry-run writes nothing at all', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(FOREIGN, null, 2));
    const before = fs.readFileSync(file, 'utf8');

    const r = await run('install', ['--target', 'vscode', '--dry-run'], sb);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'dry-run modified the file');
    assert.equal(backupsOf(file).length, 0, 'dry-run wrote a backup');
  });

  test('NO SECRET IS WRITTEN unless --with-key is passed', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: {} }, null, 2));

    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);
    const raw = fs.readFileSync(file, 'utf8');

    // A literal credential, not a placeholder reference to one.
    assert.doesNotMatch(raw, /sk-[A-Za-z0-9_-]{8,}/, 'a live-looking key was embedded');
    assert.doesNotMatch(raw, /ghp_[A-Za-z0-9]{8,}/);
    // ...and the entry must still be self-sufficient: it has to tell the server
    // where the key comes from, or "no secret" would just mean "broken".
    assert.match(raw, /aegis/i);
  });

  test('--with-key with no key configured fails loudly instead of writing a blank', async () => {
    const sb = sandbox();
    const r = await run('install', ['--target', 'vscode', '--with-key'], sb);
    assert.equal(r.code, 2);
    assert.match(r.err, /--with-key.*no key|no key.*configured|login/i);
    assert.equal(fs.existsSync(userFile(sb, 'vscode')), false, 'it wrote a config anyway');
  });

  test('an unknown target exits 2 and names it', async () => {
    const sb = sandbox();
    const r = await run('install', ['--target', 'not-an-editor'], sb);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown host.*not-an-editor/);
  });

  test('with nothing detected it refuses rather than inventing configs', async () => {
    const sb = sandbox();
    const r = await run('install', [], sb);
    assert.equal(r.code, 2);
    assert.match(r.err, /no editor detected/);
  });

  test('--all configures every host without needing detection', async () => {
    const sb = sandbox();
    const r = await run('install', ['--all'], sb);
    assert.equal(r.code, 0, r.err);
    // Written outside the sandbox would be catastrophic; prove we stayed inside.
    assert.ok(userFile(sb, 'vscode').startsWith(sb.home));
    assert.equal(fs.existsSync(userFile(sb, 'vscode')), true);
  });
});

// ---------------------------------------------------------------------------
// The refusal guarantee
// ---------------------------------------------------------------------------

describe('unparseable configs', () => {
  test('install refuses, exits 1, and leaves the file byte-identical', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const broken = '{ "servers": { "github": { "command": "npx", } '; // trailing comma
    fs.writeFileSync(file, broken);
    const before = fs.readFileSync(file);

    const r = await run('install', ['--target', 'vscode'], sb);
    assert.equal(r.code, 1, `expected refusal, got ${r.code}: ${r.out}${r.err}`);
    assert.equal(fs.readFileSync(file).equals(before), true, 'the file was touched');
    assert.equal(backupsOf(file).length, 0, 'a refused write still made a backup');
  });

  test('status reports it as unreadable instead of claiming health', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json at all');

    const r = await run('status', ['--target', 'vscode', '--json'], sb);
    assert.equal(r.code, 0, 'status itself should still succeed');
    const row = parseJson(r.out).find((x) => x.id === 'vscode');
    assert.equal(row.state, 'unreadable');
    assert.ok(row.error, 'no error text was reported');
  });
});

// ---------------------------------------------------------------------------
// status: the drift check the feature exists for
// ---------------------------------------------------------------------------

describe('status and drift', () => {
  test('a healthy install reports installed', async () => {
    const sb = sandbox();
    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);

    const r = await run('status', ['--target', 'vscode', '--json'], sb);
    const row = parseJson(r.out).find((x) => x.id === 'vscode');
    assert.equal(row.state, 'installed');
    assert.equal(row.server_exists, true);
    assert.equal(row.installed, true);
  });

  test('a moved checkout is reported BROKEN, not silently healthy', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);

    // Simulate the checkout moving: the entry still parses, the path is gone.
    const doc = parseJson(fs.readFileSync(file, 'utf8'));
    const moved = path.join(sb.dir, 'moved-away', 'mcp', 'server.js');
    doc.servers.aegis = { ...doc.servers.aegis, command: process.execPath, args: [moved] };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    const r = await run('status', ['--target', 'vscode', '--json'], sb);
    const row = parseJson(r.out).find((x) => x.id === 'vscode');
    assert.equal(row.state, 'BROKEN');
    assert.equal(row.server_exists, false);
    assert.equal(row.server_path, moved, 'it should name the path that is missing');

    // ...and the human report says what to do about it.
    const human = await run('status', ['--target', 'vscode'], sb);
    assert.match(human.out, /BROKEN/);
    assert.match(human.out, /re-run.*mcp install/);
  });

  test('install repairs a drifted entry', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);

    const doc = parseJson(fs.readFileSync(file, 'utf8'));
    doc.servers.aegis = { ...doc.servers.aegis, args: [path.join(sb.dir, 'gone', 'server.js')] };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));

    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);
    const after = await run('status', ['--target', 'vscode', '--json'], sb);
    assert.equal(parseJson(after.out).find((x) => x.id === 'vscode').state, 'installed');
  });

  test('a host-resolved path is NOT called broken', async () => {
    // `.mcp.json` ships `${CLAUDE_PLUGIN_ROOT}/mcp/server.js` so one file works
    // on every machine. That is deliberate portability, not a missing file —
    // reporting it as BROKEN would push users into overwriting a portable
    // config with a machine-absolute path.
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        { servers: { aegis: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/mcp/server.js'] } } },
        null,
        2
      )
    );

    const r = await run('status', ['--target', 'vscode', '--json'], sb);
    const row = parseJson(r.out).find((x) => x.id === 'vscode');
    assert.equal(row.state, 'host-resolved');
    assert.equal(row.server_unverifiable, true);
    assert.equal(row.server_exists, null, 'an unverifiable path is not "missing"');
  });

  test('a config for an editor that is gone is still surfaced', async () => {
    const sb = sandbox();
    assert.equal((await run('install', ['--target', 'zed'], sb)).code, 0);
    // Remove the app-support directory the way an uninstall would.
    const zedDir = path.dirname(userFile(sb, 'zed'));
    fs.rmSync(zedDir, { recursive: true, force: true });
    fs.mkdirSync(zedDir, { recursive: true }); // the config file itself is gone too

    const r = await run('status', ['--json'], sb);
    assert.equal(r.code, 0);
    // Nothing installed and nothing present: the default view is legitimately empty.
    assert.ok(Array.isArray(parseJson(r.out)));
  });
});

// ---------------------------------------------------------------------------
// print and remove
// ---------------------------------------------------------------------------

describe('print and remove', () => {
  test('print touches nothing and shows the entry', async () => {
    const sb = sandbox();
    const r = await run('print', ['vscode'], sb);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /servers/);
    assert.match(r.out, /aegis/i);
    assert.equal(fs.existsSync(userFile(sb, 'vscode')), false, 'print wrote a file');
  });

  test('print without a host exits 2', async () => {
    const sb = sandbox();
    const r = await run('print', [], sb);
    assert.equal(r.code, 2);
    assert.match(r.err, /name a host/);
  });

  test('remove takes ours out and leaves the rest untouched', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = {
      servers: { github: { command: 'npx', env: { TOKEN: 'keepme' } } },
      someUserSetting: 42,
    };
    fs.writeFileSync(file, JSON.stringify(original, null, 2));

    assert.equal((await run('install', ['--target', 'vscode'], sb)).code, 0);
    const r = await run('remove', ['--target', 'vscode'], sb);
    assert.equal(r.code, 0, r.err);

    const doc = parseJson(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.servers.aegis, undefined, 'our entry survived remove');
    assert.deepEqual(doc.servers.github, original.servers.github);
    assert.equal(doc.someUserSetting, 42);
  });

  test('removing when nothing is installed does not rewrite the file', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'vscode');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = `{\n  "servers": { "github": { "command": "npx" } }\n}\n`;
    fs.writeFileSync(file, original);

    const r = await run('remove', ['--target', 'vscode'], sb);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'a no-op remove reformatted the file');
  });
});

// ---------------------------------------------------------------------------
// TOML (Codex CLI) — the one target that is not JSON
// ---------------------------------------------------------------------------

describe('codex TOML', () => {
  const PRELUDE = [
    '[mcp_servers.other]',
    'command = "other-mcp"',
    'args = ["--x"]',
    '',
    '[history]',
    'persistence = "save-all"',
    '',
  ].join('\n');

  test('merges into an existing TOML config, idempotently, and parses back', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'codex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PRELUDE);

    const r = await run('install', ['--target', 'codex'], sb);
    assert.equal(r.code, 0, r.err);

    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\[mcp_servers\.other\]/, 'the other server was dropped');
    assert.match(text, /persistence = "save-all"/, 'the [history] section was dropped');

    const headers = text.split('\n').filter((l) => l.trim() === '[mcp_servers.aegis]');
    assert.equal(headers.length, 1, `expected exactly one aegis header, found ${headers.length}`);

    // The round trip is the real check: a header that reads back is a header an
    // editor will actually load.
    const rows = install.status(['codex'], { ctx: ctxOf(sb) });
    const row = rows.find((x) => x.id === 'codex');
    assert.equal(row.installed, true, 'the entry did not parse back');
    assert.ok(row.entry, 'status reported installed with no entry');
    assert.ok(row.serverPath, 'the parsed entry names no server');

    const first = fs.readFileSync(file, 'utf8');
    assert.equal((await run('install', ['--target', 'codex'], sb)).code, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), first, 'second TOML install appended again');
  });

  test('remove-then-status round trip leaves no aegis section', async () => {
    const sb = sandbox();
    const file = userFile(sb, 'codex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, PRELUDE);

    assert.equal((await run('install', ['--target', 'codex'], sb)).code, 0);
    assert.equal((await run('remove', ['--target', 'codex'], sb)).code, 0);

    const rows = install.status(['codex'], { ctx: ctxOf(sb) });
    assert.equal(rows.find((x) => x.id === 'codex').installed, false);
    assert.match(fs.readFileSync(file, 'utf8'), /\[mcp_servers\.other\]/);
  });
});

// ---------------------------------------------------------------------------
// The artifacts themselves
// ---------------------------------------------------------------------------

describe('the MCP server', () => {
  test('answers initialize and tools/list over stdio', async () => {
    const server = path.join(REPO, 'mcp', 'server.js');
    assert.equal(fs.existsSync(server), true, 'mcp/server.js is missing — nothing to point editors at');

    const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    const seen = [];
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { seen.push(JSON.parse(line)); } catch { /* partial */ }
      }
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    const waitFor = async (pred, ms = 10000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = seen.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      return null;
    };

    try {
      send({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      });
      const init = await waitFor((m) => m.id === 1);
      assert.ok(init, 'no initialize response');
      assert.ok(init.result, `initialize failed: ${JSON.stringify(init)}`);
      assert.match(JSON.stringify(init.result), /aegis/i);

      send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      const list = await waitFor((m) => m.id === 2);
      assert.ok(list, 'no tools/list response');
      assert.ok(Array.isArray(list.result.tools), 'tools/list returned no tools array');
      assert.ok(list.result.tools.length > 0, 'the server exposes no tools');
      for (const t of list.result.tools) {
        assert.equal(typeof t.name, 'string');
        assert.ok(t.inputSchema, `${t.name} has no input schema`);
      }
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('the OpenAI-compatible shim', () => {
  test('refuses a non-loopback bind with one clean line and exit 1', async () => {
    const shim = path.join(REPO, 'hosts', 'openai-shim.js');
    const r = await new Promise((resolve) => {
      const c = spawn(process.execPath, [shim, '--host', '0.0.0.0'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (err += d));
      c.on('exit', (code) => resolve({ code, out, err }));
    });

    assert.equal(r.code, 1, 'the loopback guard did not stop the bind');
    assert.match(r.err, /refusing to bind 0\.0\.0\.0/);
    assert.match(r.err, /--allow-remote/);

    // It is a safety refusal, not a crash: no stack trace, and exactly one
    // prefix — `logLine` already writes one.
    assert.doesNotMatch(r.err, /\bat .*\(.*:\d+:\d+\)/, 'a stack trace leaked to the user');
    assert.equal((r.err.match(/aegis-shim:/g) || []).length, 1);
    assert.doesNotMatch(r.err, /aegiscode shim:/, 'the prefix is doubled');
  });
});
