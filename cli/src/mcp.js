'use strict';

/**
 * `aegiscode mcp …` — the host that puts AEGIS inside every coding program.
 *
 * The other three hosts answer "talk to AEGIS from here". This one answers
 * "make AEGIS appear in the editor I already use", and it does that in the two
 * ways an editor can accept it:
 *
 *   - MCP. `install` writes the editor's own config so its agent mode gains the
 *     tools in `mcp/tools.js`. The server is `mcp/server.js`, spawned over
 *     stdio by the editor itself — never by us.
 *   - An OpenAI-compatible endpoint. `shim` runs `hosts/openai-shim.js`, for
 *     clients that let you type a base URL but speak no MCP.
 *
 * Everything mechanical lives in `hosts/`: the host registry (paths, dialects),
 * the canonical server spec, and the merge-only installer. Those are shared
 * with any other host that wants them and are staged into `cli/vendor/hosts/`
 * at publish time, exactly like `client/` and `mcp/` — so this file is argv →
 * those calls, and the honest report of what came back.
 *
 * Two properties this surface must not lose, because losing either one damages
 * a file the user did not ask us to touch:
 *
 *   1. NO SECRET IS WRITTEN BY DEFAULT. These config files are plain, often
 *      world-readable, and frequently inside a committed project directory. The
 *      server already resolves a key from the environment, then the 0600 store,
 *      then `~/.aegiscode/.env`. `--with-key` is the escape hatch and
 *      `--prompt-key` is the one host (VS Code) that can hold no value at all.
 *   2. AN UNPARSEABLE CONFIG IS REFUSED, NOT OVERWRITTEN. The installer returns
 *      an error and the file is left exactly as it was; a JSON syntax error we
 *      "fixed" would silently discard whatever the user had in there.
 *
 * Exit codes, same contract as the autonomous surface:
 *   0  everything asked for happened
 *   1  a config could not be read/parsed, or a write failed
 *   2  usage error
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

// Paths only, no eager requires: `sharedpaths.js` is what the rest of the CLI
// uses to find the shared modules in both layouts (a source checkout and an
// installed package), and `hosts/` is staged into the same vendor tree.
const { resolveShared } = require('./sharedpaths.js');

const install = require(resolveShared(path.join('hosts', 'install.js')));
const targets = require(resolveShared(path.join('hosts', 'targets.js')));
const spec = require(resolveShared(path.join('hosts', 'spec.js')));

const SUBCOMMANDS = new Set([
  'install', 'remove', 'status', 'list', 'print', 'serve', 'shim', 'help',
]);

const USAGE = `aegiscode mcp — put AEGIS inside your editor.

Usage:
  aegiscode mcp install [options]     write the editor config (merges, never replaces)
  aegiscode mcp status [options]      which hosts are configured, and do they still work
  aegiscode mcp list                  every supported host, its config file and its docs
  aegiscode mcp print <host>          show the entry that would be written, touch nothing
  aegiscode mcp remove [options]      take our entry out again
  aegiscode mcp serve                 run the stdio MCP server (editors spawn this themselves)
  aegiscode mcp shim [options]        run the OpenAI-compatible endpoint on loopback

Targets:
  --target <id>     one host, repeatable and comma-separated (see \`aegiscode mcp list\`)
  --all             every supported host, not just the ones detected
  --scope <s>       user (default) or workspace — workspace writes into the
                    current directory, which is committed in many projects

Install options:
  --dry-run         print what would change, write nothing
  --with-key        embed the resolved API key in the config file. Off by
                    default: these files are plain and often world-readable, and
                    the server already finds a key from the environment, the
                    0600 store, or ~/.aegiscode/.env
  --prompt-key      VS Code only: reference its own secret prompt instead of
                    storing a value anywhere
  --base <url>      API base to record (default $AEGIS_API_BASE or aegiscloud.org)

Shim options:
  --port <n>        default 8787
  --host <addr>     default 127.0.0.1; any non-loopback address also requires
  --allow-remote    ... this flag, because the endpoint spends your tokens

Options:
  --json            machine-readable output
  -h, --help        this text
`;

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set([
  'json', 'all', 'dry-run', 'with-key', 'prompt-key', 'yes', 'allow-remote', 'help',
]);
const VALUE_FLAGS = new Set(['target', 'scope', 'base', 'port', 'host']);

/**
 * Parse the subcommand's own argv.
 *
 * Its own parser rather than bin/aegiscode.js's, for the reason the autonomous
 * surface has one: the top-level parser owns the session flags, and everything
 * after `mcp <sub>` belongs to the subcommand.
 */
function parseFlags(argv) {
  const opts = { terms: [], json: false, flags: {}, targetList: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      opts.json = true;
      continue;
    }
    if (a === '-h') {
      opts.flags.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      opts.terms.push(a);
      continue;
    }
    const [rawName, inline] = a.slice(2).split('=');
    const name = rawName.trim();
    if (BOOL_FLAGS.has(name)) {
      opts.flags[name] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`unknown option: --${name}`);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    if (name === 'target') {
      // `--target cursor --target zed` and `--target cursor,zed` are the same
      // request; both spellings are common enough to be worth accepting.
      for (const id of String(value).split(',')) {
        const trimmed = id.trim();
        if (trimmed) opts.targetList.push(trimmed);
      }
      continue;
    }
    opts.flags[name] = value;
  }
  return opts;
}

/**
 * Resolve `--target` / `--all` / detection into a concrete list of targets.
 *
 * The default matters: with no flag, only hosts that are actually INSTALLED on
 * this machine are touched. Writing a Cursor config for somebody who has never
 * installed Cursor is not helpful, it is a file appearing out of nowhere.
 *
 * @returns {{targets: object[], ids: string[], source: string, unknown: string[]}}
 */
function selectTargets(opts, ctx, io) {
  const unknown = [];
  let ids = [];
  let source;

  if (opts.targetList.length) {
    source = 'named';
    for (const id of opts.targetList) {
      const target = targets.getTarget(id);
      if (target) ids.push(target.id);
      else unknown.push(id);
    }
    ids = [...new Set(ids)];
  } else if (opts.flags.all) {
    source = 'all';
    ids = targets.targetIds();
  } else {
    source = 'detected';
    ids = [...install.detected({ ctx })];
    // Detection works by finding a config file or an app-support directory, so
    // an editor that is installed but has never written a config is invisible
    // here. That is the honest reading of "detected", and the report says so.
  }

  return { targets: ids.map((id) => targets.getTarget(id)).filter(Boolean), ids, source, unknown };
}

/** The spec opts the flags imply. Nothing secret is included unless asked. */
function specOptsFor(opts, io) {
  const specOpts = {};
  if (opts.flags.base) specOpts.apiBase = String(opts.flags.base);
  if (opts.flags['prompt-key']) specOpts.promptKey = true;
  if (opts.flags['with-key']) {
    const credentials = require('./credentials.js');
    const st = credentials.keyStatus();
    if (!st.configured) {
      io.stderr.write(
        'aegiscode mcp: --with-key was given but no key is configured. ' +
          'Run `aegiscode login` first, or export AEGIS_API_KEY.\n'
      );
      return null;
    }
    specOpts.apiKey = st.key;
  }
  return specOpts;
}

/** `--scope`, validated against what the target actually supports. */
function scopeFor(target, opts, io) {
  const scope = String(opts.flags.scope || 'user').toLowerCase();
  if (scope !== 'user' && scope !== 'workspace' && scope !== 'project') return null;
  const normalized = scope === 'project' ? 'workspace' : scope;
  if (!(target.scopes || ['user']).includes(normalized)) {
    io.stderr.write(
      `aegiscode mcp: ${target.label} has no ${normalized} config — ` +
        `it supports: ${(target.scopes || ['user']).join(', ')}\n`
    );
    return null;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function homeShort(p, ctx) {
  const home = ctx.home || ctx.env.HOME || ctx.env.USERPROFILE;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function statusWord(row) {
  if (row.error) return 'unreadable';
  if (!row.installed) return row.exists ? 'not installed' : 'no config';
  if (row.serverExists === false) return 'BROKEN';
  return 'installed';
}

function statusText(rows, ctx, io) {
  const w = Math.max(9, ...rows.map((r) => statusWord(r).length));
  const lines = [];
  for (const row of rows) {
    lines.push(
      `  ${statusWord(row).padEnd(w)}  ${row.id.padEnd(14)} ` +
        `${homeShort(row.file, ctx)}${row.scope === 'workspace' ? ' (workspace)' : ''}`
    );
    if (row.error) lines.push(`  ${' '.repeat(w)}  ${row.error}`);
    if (row.serverExists === false) {
      lines.push(
        `  ${' '.repeat(w)}  the server this names is gone: ${row.serverPath}` +
          '\n' + `  ${' '.repeat(w)}  re-run `aegiscode mcp install --target ${row.id}``
      );
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

function runList(opts, ctx, io) {
  const detected = install.detected({ ctx });
  const rows = targets.TARGETS.map((target) => ({
    id: target.id,
    label: target.label,
    kind: target.kind,
    scopes: target.scopes || ['user'],
    docs: target.docs,
    verified: Boolean(target.verified),
    detected: detected.has(target.id),
    files: (target.scopes || ['user']).map((scope) => target.path(scope, ctx)),
    note: target.note || null,
  }));

  if (opts.json) {
    io.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(`${rows.length} hosts AEGIS can appear in:\n\n`);
  for (const row of rows) {
    io.stdout.write(
      `  ${row.id.padEnd(16)} ${row.label}${row.detected ? '  [present on this machine]' : ''}\n`
    );
    io.stdout.write(`  ${' '.repeat(16)} ${homeShort(row.files[0], ctx)}  (${row.scopes.join(', ')})\n`);
    if (row.note) io.stdout.write(`  ${' '.repeat(16)} ${row.note}\n`);
    if (!row.verified) {
      io.stdout.write(
        `  ${' '.repeat(16)} ✗ NOT VERIFIED against this host's own docs — check ${row.docs} ` +
          'before relying on it\n'
      );
    }
  }
  io.stdout.write(
    '\n  `aegiscode mcp install` with no --target configures every host detected above.\n' +
      '  API keys are NOT written unless you pass --with-key.\n'
  );
  return 0;
}

function runStatus(opts, ctx, io) {
  const sel = selectTargets(opts, ctx, io);
  if (sel.unknown.length) {
    io.stderr.write(
      `aegiscode mcp: unknown host${sel.unknown.length > 1 ? 's' : ''}: ${sel.unknown.join(', ')}` +
        ' — run `aegiscode mcp list`\n'
    );
    return 2;
  }
  // Bare `status` reports on the whole registry: "is AEGIS in my editors" is a
  // question you ask before choosing a target, so restricting it to detected
  // hosts would hide the answer. `--target` narrows it.
  const scope = opts.flags.scope ? scopeFor(sel.targets[0], opts, io) : null;
  if (opts.flags.scope && !scope) return 2;

  const ids = opts.targetList.length ? sel.ids : [];
  let rows = install.status(ids, { ctx });

  if (!opts.flags.all && !opts.targetList.length) {
    // Default view: rows that exist, plus anything of ours we can see. An entry
    // in a config for an editor that is no longer installed still matters —
    // that is exactly the stale config worth being told about.
    rows = rows.filter((r) => r.exists || r.installed || r.error);
  }

  if (opts.json) {
    io.stdout.write(
      `${JSON.stringify(
        rows.map((r) => ({
          id: r.id,
          label: r.label,
          scope: r.scope,
          file: r.file,
          exists: r.exists,
          installed: r.installed,
          state: statusWord(r),
          server_path: r.serverPath || null,
          server_exists: r.serverExists === undefined ? null : r.serverExists,
          entry: r.entry,
          error: r.error,
          docs: r.docs,
          verified: r.verified,
        })),
        null,
        2
      )}\n`
    );
    return 0;
  }

  if (!rows.length) {
    io.stdout.write(
      'aegiscode mcp: no editor configs found on this machine.\n' +
        '  `aegiscode mcp list` shows every host AEGIS supports,\n' +
        '  `aegiscode mcp install --target <id>` configures one.\n'
    );
    return 0;
  }

  io.stdout.write(statusText(rows, ctx, io));
  const bad = rows.filter((r) => r.serverExists === false).length;
  const held = rows.filter((r) => r.installed).length;
  io.stdout.write(
    `\n  ${held} configured${bad ? `, ${bad} pointing at a missing server — re-run install` : ''}.\n`
  );
  return 0;
}

function runInstall(opts, ctx, io) {
  const sel = selectTargets(opts, ctx, io);
  if (sel.unknown.length) {
    io.stderr.write(
      `aegiscode mcp: unknown host${sel.unknown.length > 1 ? 's' : ''}: ${sel.unknown.join(', ')}` +
        ' — run `aegiscode mcp list`\n'
    );
    return 2;
  }
  if (!sel.targets.length) {
    io.stderr.write(
      'aegiscode mcp: no editor detected, so there is nothing to configure automatically.\n' +
        '  `aegiscode mcp list` shows the hosts AEGIS supports;\n' +
        '  `aegiscode mcp install --target <id>` names one explicitly.\n'
    );
    return 2;
  }

  const specOpts = specOptsFor(opts, io);
  if (!specOpts) return 2;
  if (opts.flags['prompt-key'] && sel.targets.some((t) => !t.supportsKeyPrompt)) {
    io.stderr.write(
      'aegiscode mcp: --prompt-key only works for VS Code, which is the only host ' +
        'with a secret-prompt mechanism. Drop it for the rest.\n'
    );
    return 2;
  }

  const resolved = spec.resolveServer();
  const results = [];
  let failed = 0;

  for (const target of sel.targets) {
    const scope = scopeFor(target, opts, io);
    if (!scope) {
      failed++;
      continue;
    }
    const plan = install.planTarget(target, scope, { ctx, specOpts });
    if (plan.error) {
      io.stderr.write(`aegiscode mcp: ${target.label} — ${plan.error.message}\n`);
      results.push({ id: target.id, file: plan.file, error: plan.error.message, applied: false });
      failed++;
      continue;
    }
    if (!plan.changed) {
      io.stdout.write(
        `aegiscode mcp: ${target.label} — already configured (${homeShort(plan.file, ctx)})\n`
      );
      results.push({ id: target.id, file: plan.file, applied: false, changed: false });
      continue;
    }
    if (opts.flags['dry-run']) {
      results.push({ id: target.id, file: plan.file, applied: false, changed: true, dryRun: true });
      io.stdout.write(
        `aegiscode mcp: ${target.label} — would write ${homeShort(plan.file, ctx)}\n` +
          `${indent(plan.after)}\n`
      );
      continue;
    }
    const done = install.apply(plan, { withKey: Boolean(opts.flags['with-key']) });
    results.push({
      id: target.id,
      file: plan.file,
      applied: done.applied,
      changed: plan.changed,
      backup: done.backupOf || null,
    });
    io.stdout.write(
      `aegiscode mcp: ${target.label} — wrote ${homeShort(plan.file, ctx)}` +
        `${done.backupOf ? ` (backup: ${homeShort(done.backupOf, ctx)})` : ''}\n`
    );
  }

  if (!opts.flags['dry-run'] && !failed && results.some((r) => r.applied)) {
    if (!resolved.exists) {
      // Should be impossible: a plan that names a missing server is refused
      // above. Reported anyway, because the failure mode (an editor that shows
      // nothing and explains nothing) is expensive enough to guard twice.
      io.stderr.write(
        'aegiscode mcp: WARNING — the server file does not exist at ' +
          `${resolved.path}, so the editors just configured will not start it.\n`
      );
      failed++;
    } else {
      io.stdout.write(
        '\n  Restart the editor (or its MCP host) to pick this up. Configured hosts\n' +
          '  spawn the AEGIS server themselves — nothing needs to keep running in a terminal.\n'
      );
    }
  }
  if (opts.flags['dry-run']) {
    io.stdout.write('\naegiscode mcp: dry run — nothing was written.\n');
  }

  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ changed: results, server: resolved.path, exists: resolved.exists }, null, 2)}\n`);
  }
  return failed ? 1 : 0;
}

function indent(text) {
  return String(text || '')
    .split('\n')
    .filter((l, i, a) => !(i === a.length - 1 && l === ''))
    .map((l) => `    ${l}`)
    .join('\n');
}

function runRemove(opts, ctx, io) {
  const sel = selectTargets(opts, ctx, io);
  if (sel.unknown.length) {
    io.stderr.write(
      `aegiscode mcp: unknown host${sel.unknown.length > 1 ? 's' : ''}: ${sel.unknown.join(', ')}\n`
    );
    return 2;
  }
  // Removal defaults to "anywhere we can see ourselves", not "detected hosts":
  // an editor that has since been uninstalled still has a config on disk, and
  // that is the one most worth cleaning up.
  const ids = opts.targetList.length || opts.flags.all ? sel.ids : [];
  const specOpts = {};
  if (opts.flags.base) specOpts.apiBase = String(opts.flags.base);
  const rows = install.status(ids, { ctx, specOpts }).filter((r) => r.installed);
  let failed = 0;

  if (!rows.length) {
    io.stdout.write('aegiscode mcp: nothing to remove — no config names an AEGIS server.\n');
    if (opts.json) io.stdout.write(`${JSON.stringify({ removed: [], changed: [] }, null, 2)}\n`);
    return 0;
  }

  const changed = [];
  for (const row of rows) {
    const target = targets.getTarget(row.id);
    const plan = install.planRemove(target, row.scope, { ctx, specOpts });
    if (plan.error) {
      io.stderr.write(`aegiscode mcp: ${row.label} — ${plan.error.message}\n`);
      failed++;
      continue;
    }
    if (!plan.changed) {
      io.stdout.write(`aegiscode mcp: ${row.label} — nothing of ours in ${homeShort(plan.file, ctx)}\n`);
      continue;
    }
    if (opts.flags['dry-run']) {
      changed.push({ id: row.id, file: plan.file, dryRun: true });
      io.stdout.write(`aegiscode mcp: ${row.label} — would update ${homeShort(plan.file, ctx)}\n`);
      continue;
    }
    const done = install.apply(plan);
    changed.push({ id: row.id, file: plan.file, backup: done.backupOf || null });
    io.stdout.write(
      `aegiscode mcp: ${row.label} — removed from ${homeShort(plan.file, ctx)}` +
        `${done.backupOf ? ` (backup: ${homeShort(done.backupOf, ctx)})` : ''}\n`
    );
  }

  if (opts.flags['dry-run']) io.stdout.write('\naegiscode mcp: dry run — nothing was written.\n');
  if (opts.json) io.stdout.write(`${JSON.stringify({ changed }, null, 2)}\n`);
  return failed ? 1 : 0;
}

function runPrint(opts, ctx, io) {
  const id = opts.terms[0] || opts.targetList[0];
  if (!id) {
    io.stderr.write('aegiscode mcp print: name a host — `aegiscode mcp print vscode`\n');
    return 2;
  }
  const target = targets.getTarget(id);
  if (!target) {
    io.stderr.write(`aegiscode mcp print: unknown host "${id}" — run \`aegiscode mcp list\`\n`);
    return 2;
  }
  const specOpts = {};
  if (opts.flags.base) specOpts.apiBase = String(opts.flags.base);
  if (opts.flags['prompt-key']) specOpts.promptKey = true;
  const built = spec.buildSpec(specOpts);
  const entry = install.renderEntry(target, built);
  const file = target.path(target.scopes ? target.scopes[0] : 'user', ctx);

  if (target.kind === 'mcp-toml') {
    io.stdout.write(`# ${file}\n[${target.container}.${entry.name || 'aegis'}]\n${entry.join('\n')}\n`);
    return 0;
  }
  if (opts.json) {
    io.stdout.write(`${JSON.stringify({ file, container: target.container, entry }, null, 2)}\n`);
    return 0;
  }
  io.stdout.write(`# ${file}\n${JSON.stringify({ [target.container]: { aegis: entry } }, null, 2)}\n`);
  if (opts.flags['prompt-key']) {
    io.stdout.write(
      `\n# VS Code also needs this in the same file so the prompt can resolve:\n` +
        `${JSON.stringify({ inputs: [spec.vscodeKeyInput()] }, null, 2)}\n`
    );
  }
  return 0;
}

/**
 * Run a staged script as a child with our own stdio attached.
 *
 * Both long-running surfaces are launched as CHILDREN rather than required into
 * this process, and that is not a stylistic choice: `mcp/server.js` registers
 * its stdin handlers at load time and exports nothing, and the shim owns its own
 * listener and shutdown path. Spawning them means the two behave identically to
 * the way an editor starts them, and this host keeps its "main() returns an exit
 * code" lifecycle instead of having to hold the process open by hand.
 */
function runChild(script, args, io) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      io.stderr.write(`aegiscode mcp: could not start ${script}: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) resolve(0); // ctrl+c: the user asked for it, not a failure
      else resolve(code === null ? 1 : code);
    });
  });
}

function runServe(opts, ctx, io) {
  const resolved = spec.resolveServer();
  if (!resolved.exists) {
    io.stderr.write(
      `aegiscode mcp serve: no server found at ${resolved.path}.\n` +
        `  Looked in:\n    ${resolved.candidates.join('\n    ')}\n`
    );
    return 2;
  }
  io.stderr.write(
    `aegiscode mcp: serving ${resolved.path} on stdio.\n` +
      '  Editors start this themselves — you only need it to test one by hand.\n'
  );
  return runChild(resolved.path, [], io);
}

function runShim(opts, ctx, io) {
  const shim = resolveShared(path.join('hosts', 'openai-shim.js'));
  const args = [];
  if (opts.flags.port) args.push('--port', String(opts.flags.port));
  if (opts.flags.host) args.push('--host', String(opts.flags.host));
  if (opts.flags['allow-remote']) args.push('--allow-remote');
  return runChild(shim, args, io);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runMcpCommand(command, argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const out = { stdout, stderr };

  let opts;
  try {
    opts = parseFlags(argv || []);
  } catch (e) {
    stderr.write(`aegiscode mcp: ${e.message}\n`);
    return 2;
  }
  opts.json = Boolean(io.json || opts.json);
  out.json = opts.json;

  if (command === 'help' || !SUBCOMMANDS.has(command) || opts.flags.help) {
    stdout.write(USAGE);
    return command === 'help' || opts.flags.help ? 0 : 2;
  }
  if (command === 'serve' || command === 'shim') {
    const ctx = install.hostCtx({ cwd: io.cwd || process.cwd(), home: io.home || null });
    return command === 'serve' ? runServe(opts, ctx, out) : runShim(opts, ctx, out);
  }
  if (command === 'list') {
    return runList(opts, install.hostCtx({ cwd: io.cwd || process.cwd(), home: io.home || null }), out);
  }
  if (command === 'print') {
    return runPrint(opts, install.hostCtx({ cwd: io.cwd || process.cwd(), home: io.home || null }), out);
  }

  const ctx = install.hostCtx({ cwd: io.cwd || process.cwd(), home: io.home || null });
  if (command === 'install') return runInstall(opts, ctx, out);
  if (command === 'remove') return runRemove(opts, ctx, out);
  if (command === 'status') return runStatus(opts, ctx, out);
  return 2;
}

module.exports = { runMcpCommand, parseFlags, selectTargets, USAGE, SUBCOMMANDS };
