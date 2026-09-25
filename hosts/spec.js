'use strict';

/**
 * The canonical AEGIS server spec — one description of "run the AEGIS MCP
 * server", which every host target then re-shapes into its own config dialect.
 *
 * There is exactly one server implementation (`mcp/server.js`, a dependency-free
 * stdio JSON-RPC host) and one tool registry (`mcp/tools.js`) shared with the
 * CLI. Editor integrations are therefore a CONFIGURATION problem, not a code
 * problem: every host that speaks MCP gets the same process, and nothing here
 * re-implements a tool.
 *
 * Two decisions are encoded deliberately:
 *
 *   1. The API key is NOT written into editor config by default. Each editor
 *      keeps its MCP config in a plain, often world-readable file, and several
 *      of them are inside project directories that get committed. The server
 *      already resolves a credential from the environment, then the 0600 store
 *      `aegiscode login` writes, then `~/.aegiscode/.env` (read at startup in
 *      every host). So the correct default is to write NO secret and let the
 *      existing resolution do its job. `--with-key` exists for the user who
 *      insists, and `--prompt-key` emits VS Code's own `inputs` password prompt
 *      for the one host that supports not storing the value at all.
 *
 *   2. `command` is `node` + an absolute path to `mcp/server.js`, because that
 *      is true on every platform and needs no shebang, no chmod, and no PATH
 *      entry. `npx aegiscode-mcp` style launchers are deliberately not used: a
 *      cold `npx` resolution inside an editor's MCP host is a startup failure
 *      the user cannot see.
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_NAME = 'aegis';
const DEFAULT_API_BASE = 'https://aegiscloud.org';

/**
 * Every place `mcp/server.js` legitimately lives, most-specific first.
 *
 * - inside this repo / this checkout: `<root>/mcp/server.js`
 * - installed as the `aegiscode` npm package: `<pkg>/vendor/mcp/server.js`
 *   (the CLI vendors `mcp/` and `client/` at publish time — see
 *   `cli/scripts/predist.mjs`)
 * - an explicit override, for a user who keeps the tree somewhere unusual.
 *
 * A missing target is a real, reportable condition: an editor config that
 * points at a path that does not exist fails silently inside the editor, which
 * is the worst possible failure mode. `resolveServer()` therefore returns the
 * first candidate that exists and `serverCandidates()` exposes all of them so
 * `aegiscode mcp status` can explain what it looked for.
 */
function serverCandidates(env = process.env) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!out.includes(abs)) out.push(abs);
  };

  push(env.AEGIS_MCP_SERVER);
  push(path.resolve(__dirname, '..', 'mcp', 'server.js'));
  push(path.resolve(__dirname, '..', 'cli', 'vendor', 'mcp', 'server.js'));
  push(path.resolve(__dirname, '..', 'vendor', 'mcp', 'server.js'));
  push(path.resolve(__dirname, '..', '..', 'mcp', 'server.js'));

  // A globally installed CLI (`npm i -g aegiscode`) keeps its vendor tree in
  // the global root, which is not on any path relative to this file.
  for (const root of globalRoots(env)) {
    push(path.join(root, 'aegiscode', 'vendor', 'mcp', 'server.js'));
  }
  return out;
}

function globalRoots(env = process.env) {
  const roots = [];
  if (env.npm_config_prefix) roots.push(path.join(env.npm_config_prefix, 'lib', 'node_modules'));
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  const node = process.execPath || '';
  if (node.includes(`${path.sep}bin${path.sep}`)) {
    roots.push(path.resolve(node, '..', '..', 'lib', 'node_modules'));
  }
  return roots;
}

/**
 * @returns {{path: string, exists: boolean, candidates: string[]}}
 */
function resolveServer(env = process.env) {
  const candidates = serverCandidates(env);
  const found = candidates.find((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  return { path: found || candidates[0], exists: Boolean(found), candidates };
}

/**
 * The API base is part of the spec because a self-hosted `aegis1` is a
 * supported configuration (`AEGIS_API_BASE`), and an editor config that
 * silently points at the public cloud when the user meant their own box is a
 * leak, not a bug.
 */
function resolveApiBase(env = process.env, override) {
  return override || env.AEGIS_API_BASE || DEFAULT_API_BASE;
}

/**
 * Build the server spec for one target.
 *
 * @param {object} [opts]
 * @param {string} [opts.apiKey]   Only set when the user asked for it.
 * @param {string} [opts.apiBase]
 * @param {string} [opts.serverPath]
 * @param {boolean} [opts.promptKey] Reference a host-supplied secret instead of
 *   embedding one (VS Code `inputs`).
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {{name: string, command: string, args: string[], env: object,
 *            keyRef: string|null, server: object}}
 */
function buildSpec(opts = {}) {
  const env = opts.env || process.env;
  const server = resolveServer(env);
  const path_ = opts.serverPath || server.path;
  const apiBase = resolveApiBase(env, opts.apiBase);

  const vars = {};
  if (opts.promptKey) {
    vars.AEGIS_API_KEY = '${input:aegis-api-key}';
  } else if (opts.apiKey) {
    vars.AEGIS_API_KEY = opts.apiKey;
  }
  // Always record the base: it is not a secret and a wrong base is the single
  // most confusing misconfiguration to debug from inside an editor.
  vars.AEGIS_API_BASE = apiBase;

  return {
    name: SERVER_NAME,
    command: 'node',
    args: [path_],
    env: vars,
    keyRef: opts.promptKey ? '${input:aegis-api-key}' : (opts.apiKey || null),
    server,
  };
}

/** The VS Code `inputs` block that makes `promptKey` above resolve. */
function vscodeKeyInput() {
  return {
    type: 'promptString',
    id: 'aegis-api-key',
    description: 'AEGIS API key (aegiscloud.org → Account → API keys)',
    password: true,
  };
}

module.exports = {
  SERVER_NAME,
  DEFAULT_API_BASE,
  buildSpec,
  resolveServer,
  serverCandidates,
  resolveApiBase,
  vscodeKeyInput,
};
