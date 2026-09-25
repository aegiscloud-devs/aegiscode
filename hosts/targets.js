'use strict';

/**
 * The host registry — every coding program AEGIS can appear in, and the exact
 * dialect each one wants.
 *
 * This file is DATA. It contains no I/O, no prompting and no CLI text: the
 * installer (`./install.js`) walks this table, and `aegiscode mcp print` renders
 * one entry without touching the disk. Adding a host is adding a row.
 *
 * Two things are worth knowing before editing a row:
 *
 *   - `container` is the dotted key path inside the config file that holds the
 *     server map. VS Code uses `servers`, most of the ecosystem uses
 *     `mcpServers`, Zed uses `context_servers`, and OpenCode nests a single
 *     `mcp` object. Getting this wrong does not error — the editor just never
 *     starts the server — so each row carries `docs` and `verified` so a user
 *     can check the claim against the host's own documentation.
 *
 *   - `entry()` returns the host's own object shape, built from the canonical
 *     spec in `./spec.js`. Nothing else in the codebase needs to know that
 *     Windsurf and Cline disagree about `type: "stdio"`.
 *
 * `scopes`: `user` writes to the machine-wide config, `workspace` writes into
 * the current directory (committed to git in many projects — which is exactly
 * why no API key is written unless the user asks).
 */

const os = require('node:os');
const path = require('node:path');

const { SERVER_NAME, vscodeKeyInput } = require('./spec.js');

// ---------------------------------------------------------------------------
// Path helpers — platform-aware, and injectable so tests never touch $HOME.
// ---------------------------------------------------------------------------

function home(ctx) {
  return ctx.home || ctx.env.HOME || ctx.env.USERPROFILE || os.homedir();
}

/** XDG on Linux, Application Support on macOS, APPDATA on Windows. */
function appConfig(ctx) {
  const { env, platform } = ctx;
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  if (platform === 'win32') return env.APPDATA || path.join(home(ctx), 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(home(ctx), 'Library', 'Application Support');
  return path.join(home(ctx), '.config');
}

/** Zed keeps its settings in a plain dotfile even on macOS. */
function zedConfig(ctx) {
  const { env, platform } = ctx;
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home(ctx), 'AppData', 'Roaming'), 'Zed');
  return path.join(env.XDG_CONFIG_HOME || path.join(home(ctx), '.config'), 'zed');
}

function dot(ctx, ...parts) {
  return path.join(home(ctx), ...parts);
}

function vscodeUserFile(ctx, variant) {
  return path.join(appConfig(ctx), variant, 'User', 'mcp.json');
}

/** `env` is omitted entirely when empty: an empty object in these files is
 *  noise, and Cline in particular treats a present-but-empty `env` as a change
 *  worth re-asking the user about. */
function orEnv(spec) {
  const env = spec.env && Object.keys(spec.env).length ? spec.env : null;
  return env;
}

function plainEntry(spec) {
  const env = orEnv(spec);
  const out = { command: spec.command, args: spec.args };
  if (env) out.env = env;
  return out;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const TARGETS = [
  {
    id: 'vscode',
    label: 'VS Code',
    kind: 'mcp-json',
    container: 'servers',
    scopes: ['user', 'workspace'],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    verified: true,
    supportsKeyPrompt: true,
    note: 'Copilot agent mode reads `.vscode/mcp.json` for the workspace, or the user file for every project.',
    path(scope, ctx) {
      return scope === 'workspace' ? path.join(ctx.cwd, '.vscode', 'mcp.json') : vscodeUserFile(ctx, 'Code');
    },
    // VS Code is the one host with a first-class stdio type tag and a secret
    // input mechanism, so it is the only row that gets either.
    entry(spec) {
      const out = { type: 'stdio', command: spec.command, args: spec.args };
      const env = orEnv(spec);
      if (env) out.env = env;
      return out;
    },
    extras(spec) {
      return spec.keyRef && spec.keyRef.startsWith('${input:')
        ? { inputs: [vscodeKeyInput()] }
        : null;
    },
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    kind: 'mcp-json',
    container: 'servers',
    scopes: ['user'],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    verified: true,
    supportsKeyPrompt: true,
    path(scope, ctx) { return vscodeUserFile(ctx, 'Code - Insiders'); },
    entry: (spec) => TARGETS[0].entry(spec),
    extras: (spec) => TARGETS[0].extras(spec),
  },
  {
    id: 'vscodium',
    label: 'VSCodium',
    kind: 'mcp-json',
    container: 'servers',
    scopes: ['user', 'workspace'],
    docs: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    verified: true,
    supportsKeyPrompt: true,
    path(scope, ctx) {
      return scope === 'workspace' ? path.join(ctx.cwd, '.vscode', 'mcp.json') : vscodeUserFile(ctx, 'VSCodium');
    },
    entry: (spec) => TARGETS[0].entry(spec),
    extras: (spec) => TARGETS[0].extras(spec),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user', 'workspace'],
    docs: 'https://cursor.com/docs/context/mcp',
    verified: true,
    path(scope, ctx) {
      return scope === 'workspace'
        ? path.join(ctx.cwd, '.cursor', 'mcp.json')
        : path.join(appConfig(ctx), 'Cursor', 'mcp.json');
    },
    entry: plainEntry,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user'],
    docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    verified: true,
    // Windsurf reads ~/.codeium/windsurf/mcp_config.json on every platform.
    path(scope, ctx) { return dot(ctx, '.codeium', 'windsurf', 'mcp_config.json'); },
    entry: plainEntry,
  },
  {
    id: 'cline',
    label: 'Cline (VS Code extension)',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user'],
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    verified: true,
    path(scope, ctx) {
      return path.join(
        appConfig(ctx), 'Code', 'User', 'globalStorage',
        'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'
      );
    },
    entry(spec) {
      return { ...plainEntry(spec), disabled: false, autoApprove: [], type: 'stdio' };
    },
  },
  {
    id: 'roo',
    label: 'Roo Code (VS Code extension)',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user'],
    docs: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
    verified: true,
    path(scope, ctx) {
      return path.join(
        appConfig(ctx), 'Code', 'User', 'globalStorage',
        'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'
      );
    },
    entry(spec) {
      return { ...plainEntry(spec), disabled: false, alwaysAllow: [], type: 'stdio' };
    },
  },
  {
    id: 'zed',
    label: 'Zed',
    kind: 'mcp-json',
    container: 'context_servers',
    scopes: ['user'],
    docs: 'https://zed.dev/docs/ai/mcp',
    verified: true,
    path(scope, ctx) { return path.join(zedConfig(ctx), 'settings.json'); },
    // Zed wraps the process in a `command` object and requires the custom
    // source tag; a bare `command` string here is silently ignored.
    entry(spec) {
      const command = { path: spec.command, args: spec.args };
      const env = orEnv(spec);
      if (env) command.env = env;
      return { source: 'custom', command };
    },
  },
  {
    id: 'continue',
    label: 'Continue (VS Code / JetBrains)',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user'],
    docs: 'https://docs.continue.dev/customize/deep-dives/mcp',
    verified: true,
    path(scope, ctx) { return dot(ctx, '.continue', 'config.json'); },
    entry: plainEntry,
    // Continue has moved to config.yaml; writing config.json into a directory
    // that already holds a yaml config produces a file Continue ignores.
    yamlWins: true,
  },
  {
    id: 'claude',
    label: 'Claude Code (project scope)',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['workspace'],
    docs: 'https://docs.claude.com/en/docs/claude-code/mcp',
    verified: true,
    path(scope, ctx) { return path.join(ctx.cwd, '.mcp.json'); },
    entry: plainEntry,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user'],
    docs: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md',
    verified: true,
    path(scope, ctx) { return dot(ctx, '.gemini', 'settings.json'); },
    entry: plainEntry,
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    kind: 'mcp-toml',
    container: 'mcp_servers',
    scopes: ['user'],
    docs: 'https://github.com/openai/codex/blob/main/docs/config.md',
    verified: true,
    path(scope, ctx) { return dot(ctx, '.codex', 'config.toml'); },
  },
  {
    id: 'junie',
    label: 'JetBrains Junie / AI Assistant',
    kind: 'mcp-json',
    container: 'mcpServers',
    scopes: ['user', 'workspace'],
    docs: 'https://www.jetbrains.com/help/junie/mcp.html',
    verified: false,
    note: 'JetBrains reads this file but the IDE also caches MCP config in Settings — restart the IDE and confirm the server is listed there.',
    path(scope, ctx) {
      return scope === 'workspace'
        ? path.join(ctx.cwd, '.junie', 'mcp', 'mcp.json')
        : dot(ctx, '.junie', 'mcp', 'mcp.json');
    },
    entry: plainEntry,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    kind: 'mcp-json',
    container: 'mcp',
    scopes: ['user'],
    docs: 'https://opencode.ai/docs/mcp-servers/',
    verified: false,
    note: 'OpenCode takes a single command array instead of command + args.',
    path(scope, ctx) { return path.join(appConfig(ctx), 'opencode', 'opencode.json'); },
    entry(spec) {
      const env = orEnv(spec);
      const out = { type: 'local', command: [spec.command, ...spec.args], enabled: true };
      if (env) out.environment = env;
      return out;
    },
  },
];

const BY_ID = new Map(TARGETS.map((t) => [t.id, t]));

/** Aliases people actually type, and the VS Code variants' shared row. */
const ALIASES = {
  code: 'vscode',
  'vs-code': 'vscode',
  'vscode-code': 'vscode',
  windsurfcodeium: 'windsurf',
  'roo-code': 'roo',
  'roocode': 'roo',
  jetbrains: 'junie',
  'claude-code': 'claude',
  gemini_cli: 'gemini',
  'codex-cli': 'codex',
  vsc: 'vscodium',
};

function getTarget(id) {
  if (!id) return null;
  const key = String(id).toLowerCase().trim();
  return BY_ID.get(key) || BY_ID.get(ALIASES[key]) || null;
}

function targetIds() {
  return TARGETS.map((t) => t.id);
}

/**
 * Hosts whose MCP config lives inside a VS Code-family `User` directory, keyed
 * by the directory name — used by `status` to explain a missing file.
 */
const VSCODE_VARIANTS = ['Code', 'Code - Insiders', 'VSCodium'];

module.exports = {
  TARGETS,
  ALIASES,
  VSCODE_VARIANTS,
  getTarget,
  targetIds,
  SERVER_NAME,
  appConfig,
  zedConfig,
  home,
};
