#!/usr/bin/env node
/**
 * Pre-publish staging for the `aegiscode` package.
 *
 * The CLI is a host, not a fork: it consumes the repo's shared modules
 * (`client/aegis.js` transport, `mcp/tools.js` registry, the desktop's pure
 * `usage.js` mapping) rather than copies of them. npm can only publish a
 * package's own directory, so those files are staged into `cli/vendor/` here,
 * at publish time, keeping the repo's relative shape:
 *
 *   cli/                        repo/
 *     vendor/mcp/tools.js   ≡     mcp/tools.js
 *     vendor/client/*.js    ≡     client/*.js
 *     vendor/desktop/...    ≡     desktop/renderer/usage.js,
 *                                 desktop/lib/local/{engine,tools,shell,agents,prompt}.js
 *
 * The shape matters: `mcp/tools.js` requires `../client/foreign-memory.js`, and
 * because the staged tree mirrors the repo, that path resolves *inside* the
 * vendor tree with no rewrite in either file.
 *
 * `src/deps.js` resolves in-repo paths first and falls back to `vendor/`, so a
 * source checkout and an installed package run identical code.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLI_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(CLI_DIR, '..');
const VENDOR = path.join(CLI_DIR, 'vendor');

/** repo-relative -> staged location (same relative shape, under vendor/) */
const FILES = [
  'client/aegis.js',
  'client/update.js',
  'client/foreign-memory.js',
  // The account credential store and the unified session store. Shared with the
  // desktop app and the MCP plugin so all three see one key and one session
  // list; `src/shared.js` resolves them from here in an installed package.
  'client/credentials.js',
  'client/session-store.js',
  // The shared `~/.aegiscode/.env` loader. bin/aegiscode.js resolves it through
  // resolveClientModule in src/shared.js and calls it before any credential is
  // read, so a key lives in ONE file for every host. (No apostrophes in the
  // comments in this array: test/packaging.test.mjs parses it by pairing single
  // quotes, and one stray one silently swallows the next real entry.)
  'client/env-file.js',
  'mcp/tools.js',
  // The stdio MCP server itself — the process every editor config written by
  // `aegiscode mcp install` points at. Staging the registry without it ships a
  // package whose configs name a file that is not in the package, and an editor
  // reports that as a server that simply never starts: no error the user can
  // see. It exports nothing and registers its stdin handlers at load time, so
  // it is verified by COMPILING it (see the probe below) and never required
  // here — requiring it would switch the predist process stdin to flowing mode
  // and it would then never exit.
  'mcp/server.js',
  // The editor-integration layer: the host registry, the canonical server spec,
  // and the merge-only installer behind `aegiscode mcp install|status|remove`.
  // Staged under vendor/hosts/ so the tree keeps the repo shape — these files
  // require ../client/*.js, which resolves INSIDE the vendor tree, and
  // hosts/spec.js finds the server one level up as vendor/mcp/server.js.
  'hosts/spec.js',
  'hosts/targets.js',
  'hosts/install.js',
  // The OpenAI-compatible shim (loopback /v1/chat/completions), for the many
  // coding programs that take a base URL but speak no MCP. It resolves
  // cli/src/models.js from either layout itself; in a checkout that is
  // cli/src/models.js and in the package it is src/models.js, which ships
  // because the CLI own source directory is published as-is.
  'hosts/openai-shim.js',
  'desktop/renderer/usage.js',
  // The agent-loop engine (persistent shell, editFile/grep/exec, Task
  // subagents) the desktop app already ships (desktop/lib/local/). The CLI
  // reuses it as-is, scoped to the 'aegis' class only (see src/engine.js) —
  // one tool loop implementation, not a second one drifting alongside it.
  'desktop/lib/local/engine.js',
  // engine.js and settings.js both require this at load time: it is the local
  // model transport, and the module that owns the fail-closed check deciding
  // whether a base URL is on this machine. Leaving it out stages a vendor tree
  // whose engine throws MODULE_NOT_FOUND before it can answer anything.
  'desktop/lib/local/local.js',
  // engine.js requires this at load time to hold a turn cut off at its tool
  // horizon: the interruption is filed against the session and the next turn
  // resumes it instead of starting cold. Staging engine.js without it ships a
  // CLI that throws `Cannot find module './session-rounds.js'` before it can
  // answer anything — the same failure class as the 6.5.6 tarball below.
  'desktop/lib/local/session-rounds.js',
  'desktop/lib/local/tools.js',
  'desktop/lib/local/shell.js',
  'desktop/lib/local/agents.js',
  'desktop/lib/local/prompt.js',
  // The provider-config store: one row per provider (base URL + key), and the
  // row the 'byok' class reads for a per-provider key. The CLI now selects that
  // class (src/engine.js), so it needs the same store the desktop writes —
  // created without a safeStorage argument, which the store already supports
  // (base64 at rest, file mode 0600). Pure node builtins, so it stages cleanly.
  'desktop/lib/settings.js',
  // engine.js requires all three at load time (turn-guard -> git-scope, and
  // worktree-lock), so leaving them out stages a vendor tree whose engine
  // throws MODULE_NOT_FOUND before it can answer anything — which is what
  // test/cli-package.test.mjs caught in the published 6.5.6 tarball.
  'desktop/lib/local/turn-guard.js',
  'desktop/lib/local/worktree-lock.js',
  'desktop/lib/local/git-scope.js',
  // The autonomous work queue (`queue.js`) and its unattended worker
  // (`autonomous.js`), which `src/deps.js` requires at load time along with
  // everything above — a named interface, not a lazy one, so a vendor tree
  // missing either throws MODULE_NOT_FOUND before the CLI can print its usage.
  // `autonomous.js` requires `./queue.js` and `./git-scope.js` at load time and
  // both sit above; `queue.js` requires only node builtins.
  'desktop/lib/local/queue.js',
  'desktop/lib/local/autonomous.js',
];

function main() {
  fs.rmSync(VENDOR, { recursive: true, force: true });
  const staged = [];

  for (const rel of FILES) {
    const from = path.join(REPO_DIR, rel);
    if (!fs.existsSync(from)) {
      console.error(`predist: missing shared module: ${rel} (expected at ${from})`);
      process.exit(1);
    }
    const to = path.join(VENDOR, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    const same = fs.readFileSync(from).equals(fs.readFileSync(to));
    if (!same) {
      console.error(`predist: staged copy differs from source: ${rel}`);
      process.exit(1);
    }
    staged.push(`${rel} -> vendor/${rel}`);
  }

  // Prove the staged tree stands on its own: the registry must load and
  // resolve its own dependencies from inside vendor/, not from the repo.
  const toolsPath = path.join(VENDOR, 'mcp', 'tools.js');
  delete require.cache[require.resolve(toolsPath)];
  const { createTools } = require(toolsPath);
  const tools = createTools({
    apiBase: 'http://127.0.0.1',
    apiKey: 'predist-probe',
    randomUUID: () => 'id',
  });
  const count = tools.toolList().length;
  if (count === 0) {
    console.error('predist: staged registry exposes no tools');
    process.exit(1);
  }

  console.log(`predist: staged ${staged.length} shared modules into cli/vendor/`);
  for (const s of staged) console.log(`  ${s}`);
  console.log(`predist: staged registry loads standalone (${count} tools)`);

  // -------------------------------------------------------------------------
  // The editor layer, proven from inside the staged tree.
  // -------------------------------------------------------------------------
  //
  // Three things have to be true of the package we are about to publish, and
  // none of them are visible from the repo:
  //
  //   1. the stdio server is present and is valid JavaScript;
  //   2. `hosts/spec.js` resolves THAT copy of it, not a checkout path that
  //      only exists on this machine — an editor config pointing at a missing
  //      file fails silently, which is the worst failure mode there is;
  //   3. `hosts/install.js` loads with its siblings resolved from vendor/.
  //
  // The server is compiled rather than required, deliberately: it registers
  // process.stdin handlers at load time and exports nothing, so requiring it
  // here would take over predist's own stdin and keep it alive forever.
  const vm = require('node:vm');
  const serverJs = path.join(VENDOR, 'mcp', 'server.js');
  try {
    new vm.Script(fs.readFileSync(serverJs, 'utf8'), { filename: serverJs });
  } catch (err) {
    console.error(`predist: staged mcp/server.js does not compile: ${err.message}`);
    process.exit(1);
  }

  const hostsDir = path.join(VENDOR, 'hosts');
  const spec = require(path.join(hostsDir, 'spec.js'));
  const install = require(path.join(hostsDir, 'install.js'));
  const targets = require(path.join(hostsDir, 'targets.js'));

  // An empty AEGIS_MCP_SERVER so a developer's own override cannot mask a
  // broken staged tree — the candidate we are asserting on must be the staged
  // one, and nothing else.
  const resolved = spec.resolveServer({ AEGIS_MCP_SERVER: '' });
  const stagedServer = path.join(VENDOR, 'mcp', 'server.js');
  if (!resolved.exists || resolved.path !== stagedServer) {
    console.error(
      `predist: staged hosts/spec.js resolves the server as ${resolved.path} ` +
        `(exists: ${resolved.exists}), expected ${stagedServer}. An installed ` +
        'aegiscode would write editor configs pointing at a file the package ' +
        `never shipped. Candidates were:\n  ${resolved.candidates.join('\n  ')}`
    );
    process.exit(1);
  }

  // Plan one real install against a throwaway home: this is the exact document
  // `aegiscode mcp install vscode` would write, so it is the cheapest possible
  // proof that the packaged command points at a file that exists.
  const vscode = targets.getTarget('vscode');
  const plan = install.planTarget(vscode, 'user', {
    ctx: install.hostCtx({ home: path.join(VENDOR, '.predist-home'), env: {}, cwd: REPO_DIR }),
    specOpts: { env: { AEGIS_MCP_SERVER: '' } },
  });
  const wrote = JSON.stringify(plan.after || '');
  if (plan.error || !plan.changed || !wrote.includes(JSON.stringify(stagedServer).slice(1, -1))) {
    console.error(
      `predist: a planned vscode install does not name the staged server ` +
        `(error: ${plan.error && plan.error.message}, changed: ${plan.changed})`
    );
    process.exit(1);
  }

  // The shim resolves cli/src/models.js from either layout on its own load; a
  // checkout has it and the package ships it as src/models.js. Loading it here
  // is what catches a repo-shaped require that only works in development.
  const shim = require(path.join(hostsDir, 'openai-shim.js'));
  if (typeof shim.createShimServer !== 'function') {
    console.error('predist: staged hosts/openai-shim.js exposes no createShimServer');
    process.exit(1);
  }

  console.log(
    `predist: editor layer verified (${targets.targetIds().length} host targets, ` +
      `server resolves to vendor/mcp/server.js, shim loads)`
  );
}

main();
