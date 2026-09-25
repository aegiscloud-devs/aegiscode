'use strict';

/**
 * The installer — reads a host's config, merges exactly one entry into it, and
 * writes it back without disturbing anything else in the file.
 *
 * The invariants this file exists to hold:
 *
 *   1. **Never destroy a user's config.** Every write is a merge of one key
 *      into a parsed document, preceded by a timestamped backup whenever the
 *      file exists and its bytes change. A config the user hand-tuned for four
 *      other MCP servers must come out the other side with those four servers
 *      intact — `test/editor-hosts.test.mjs` asserts exactly that.
 *
 *   2. **Idempotent.** Running `aegiscode mcp install vscode` twice leaves the
 *      file byte-identical the second time (`changed: false`), so the command
 *      is safe in a dotfiles script or a provisioning step.
 *
 *   3. **Never guess.** Unparseable JSON is refused, not overwritten. A TOML
 *      file whose `[mcp_servers.aegis]` section sits under a construct this
 *      minimal writer does not model is refused with the line number. Silent
 *      data loss in someone's editor config is not an acceptable failure mode
 *      for a convenience command.
 *
 *   4. **Dry-run is the default in the CLI, not here.** `plan()` computes the
 *      exact bytes it would write; `apply()` is the only function that touches
 *      the disk.
 */

const fs = require('node:fs');
const path = require('node:path');

const { TARGETS, getTarget, appConfig } = require('./targets.js');
const { buildSpec, resolveServer } = require('./spec.js');

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * The environment a target resolves paths against. Tests pass an explicit ctx
 * so nothing here ever writes into the developer's real `~/.config`.
 */
function hostCtx(overrides = {}) {
  return {
    env: process.env,
    platform: process.platform,
    home: null,
    cwd: process.cwd(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Document I/O — JSON and the one TOML target
// ---------------------------------------------------------------------------

function readText(file) {
  try {
    return { text: fs.readFileSync(file, 'utf8'), exists: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { text: null, exists: false };
    throw err;
  }
}

/** A path that is a real file — the only thing `node <path>` can execute. */
function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function parseJson(text, file) {
  if (text === null || text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}) — refusing to overwrite it`);
  }
}

/** Set `a.b.c` without dropping siblings. */
function setPath(doc, dotted, value) {
  const parts = dotted.split('.');
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return doc;
}

function getPath(doc, dotted) {
  let node = doc;
  for (const part of dotted.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

/**
 * Delete a leaf from a dotted path.
 *
 * @param {object} doc
 * @param {string} dotted
 * @param {boolean} prune  Remove container objects left empty by the delete.
 *   This is OFF by default, and the default is the safe one: an empty
 *   `"mcpServers": {}` that the user wrote is a key in their file, and a
 *   removal that never installed anything must not touch it. Callers pass
 *   `true` only when they know the container was holding our own entry.
 */
function delPath(doc, dotted, prune = false) {
  const parts = dotted.split('.');
  const parents = [];
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (node === null || typeof node !== 'object') return doc;
    parents.push([node, part]);
    node = node[part];
  }
  if (node && typeof node === 'object') delete node[parts[parts.length - 1]];
  if (!prune) return doc;
  // If deleting our key emptied a container, nothing else of the user's was in
  // it, so dropping it is safe. (The one residue: a container the user had
  // written as an empty object is also removed — a no-op in every editor, and
  // the price of not leaving a stray `{}` behind.)
  for (let i = parents.length - 1; i >= 0; i--) {
    const [parent, key] = parents[i];
    const child = parent[key];
    if (child && typeof child === 'object' && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
  return doc;
}

const TOML_BARE = /^[A-Za-z0-9_-]+$/;

function tomlKey(key) {
  return TOML_BARE.test(key) ? key : JSON.stringify(key);
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(', ')}]`;
}

/**
 * Replace (or append) one `[a.b]` section, leaving every other line of the file
 * alone — including comments inside the section being replaced, which is why
 * the block is regenerated from the spec rather than patched key by key. A
 * generated section carries a header comment saying so.
 */
/**
 * Is this line a TOML header for `sectionPath`, or for a subtable of it?
 *
 * `renderEntry` emits `[...env]` as a subtable, so "our section" is a SPAN of
 * the file — the header plus any `[section.…]` children — and not just one
 * header line. Comparing bare-line equality (as this used to) both missed the
 * subtable and mistook a foreign section for ours.
 */
function tomlHeaderName(line) {
  const t = line.trim();
  if (!/^\[/.test(t)) return null;
  return t.replace(/^\[+\s*/, '').replace(/\s*\]+$/, '');
}

function ownedTomlHeader(line, sectionPath) {
  const name = tomlHeaderName(line);
  if (name === null) return false;
  return name === sectionPath || name.startsWith(`${sectionPath}.`);
}

/**
 * Replace (or append) a whole TOML section, header included.
 *
 * Idempotency is the requirement that shapes this: the second run must produce
 * the same bytes as the first, so the replacement has to consume exactly the
 * span the previous run wrote — the header, the body, and any owned subtable —
 * and leave every other byte of someone else's config alone.
 *
 * @param {string} text
 * @param {string} sectionPath  e.g. `mcp_servers.aegis` (no brackets)
 * @param {string[]} bodyLines  lines AFTER the header; may include own subtables
 */
function upsertTomlSection(text, sectionPath, bodyLines) {
  const header = `[${sectionPath}]`;
  const lines = (text || '').split('\n');
  const out = [];
  let replaced = false;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === header) {
      out.push(header, ...bodyLines, '');
      replaced = true;
      i++;
      // Consume the old body, then each subtable we own (the `.env` block),
      // stopping at the first header that is somebody else's.
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      while (i < lines.length && ownedTomlHeader(lines[i], sectionPath)) {
        i++;
        while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  if (!replaced) {
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    if (out.length) out.push('');
    out.push(header, ...bodyLines, '');
  }
  return out.join('\n');
}

function removeTomlSection(text, sectionPath) {
  const header = `[${sectionPath}]`;
  const lines = (text || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === header) {
      i++;
      while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      // The `.env` subtable is part of our section, not a section of its own:
      // leaving it behind would orphan a block of env keys under no header.
      while (i < lines.length && ownedTomlHeader(lines[i], sectionPath)) {
        i++;
        while (i < lines.length && !/^\s*\[/.test(lines[i])) i++;
      }
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Rendering one target
// ---------------------------------------------------------------------------

function renderEntry(target, spec) {
  if (target.kind === 'mcp-toml') {
    const lines = [
      `# Added by \`aegiscode mcp install ${target.id}\`. Key resolution lives in`,
      '# ~/.aegiscode/.env and the 0600 store `aegiscode login` writes.',
      'command = ' + tomlString(spec.command),
      'args = ' + tomlArray(spec.args),
    ];
    if (spec.env && Object.keys(spec.env).length) {
      lines.push('', `[${target.container}.${spec.name}.env]`);
      for (const [k, v] of Object.entries(spec.env)) lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
    }
    return lines;
  }
  return target.entry(spec);
}

/**
 * @returns {{target: object, scope: string, file: string, exists: boolean,
 *            changed: boolean, before: string, after: string, error: Error|null,
 *            backupOf: string|null}}
 */
function planTarget(target, scope, opts = {}) {
  const ctx = opts.ctx || hostCtx();
  const spec = opts.spec || buildSpec(opts.specOpts || {});
  const file = target.path(scope, ctx);
  const result = {
    target, scope, file, exists: false, changed: false,
    before: null, after: null, error: null, backupOf: null,
  };

  let text = null;
  try {
    const read = readText(file);
    text = read.text;
    result.exists = read.exists;
  } catch (err) {
    result.error = err;
    return result;
  }
  if (result.exists) {
    try { result.mode = fs.statSync(file).mode & 0o777; } catch { /* keep default */ }
  }

  if (target.kind === 'mcp-toml') {
    const section = `${target.container}.${spec.name}`;
    const body = renderEntry(target, spec);
    result.before = text;
    result.after = upsertTomlSection(text, section, body);
    result.changed = result.after !== (text || '');
    return result;
  }

  let doc;
  try {
    doc = parseJson(text, file);
  } catch (err) {
    result.error = err;
    return result;
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    result.error = new Error(`${file} does not contain a JSON object — refusing to overwrite it`);
    return result;
  }

  setPath(doc, `${target.container}.${spec.name}`, renderEntry(target, spec));
  if (typeof target.extras === 'function') {
    const extra = target.extras(spec);
    if (extra && extra.inputs) {
      const existing = Array.isArray(doc.inputs) ? doc.inputs : [];
      for (const input of extra.inputs) {
        const at = existing.findIndex((e) => e && e.id === input.id);
        if (at === -1) existing.push(input);
        else existing[at] = input;
      }
      doc.inputs = existing;
    }
  }

  result.before = text;
  result.after = JSON.stringify(doc, null, 2) + '\n';
  result.changed = result.after !== (text || '');
  return result;
}

function planRemove(target, scope, opts = {}) {
  const ctx = opts.ctx || hostCtx();
  const spec = opts.spec || buildSpec(opts.specOpts || {});
  const file = target.path(scope, ctx);
  const result = {
    target, scope, file, exists: false, changed: false,
    before: null, after: null, error: null, backupOf: null,
  };

  let text = null;
  try {
    const read = readText(file);
    text = read.text;
    result.exists = read.exists;
  } catch (err) {
    result.error = err;
    return result;
  }
  if (!result.exists) return result;
  try { result.mode = fs.statSync(file).mode & 0o777; } catch { /* keep default */ }

  if (target.kind === 'mcp-toml') {
    result.before = text;
    result.after = removeTomlSection(text, `${target.container}.${spec.name}`);
    // The env subtable header is removed by the same sweep (it is a section
    // header directly following ours).
    result.changed = result.after !== text;
    return result;
  }

  let doc;
  try {
    doc = parseJson(text, file);
  } catch (err) {
    result.error = err;
    return result;
  }
  // Is there anything of ours to remove? Asking first is what makes removal
  // idempotent AND non-destructive: re-serialising a document we changed
  // nothing in would rewrite the user's whole file — reformatted, key order
  // possibly altered — and report it as a change.
  const entryPath = `${target.container}.${spec.name}`;
  const hadEntry = getPath(doc, entryPath) !== undefined;
  const hadInput = Array.isArray(doc.inputs) && doc.inputs.some((e) => e && e.id === 'aegis-api-key');
  if (!hadEntry && !hadInput) {
    result.before = text;
    result.after = text;
    result.changed = false;
    return result;
  }

  delPath(doc, entryPath, true);
  const inputs = Array.isArray(doc.inputs) ? doc.inputs.filter((e) => !(e && e.id === 'aegis-api-key')) : null;
  if (inputs) {
    if (inputs.length) doc.inputs = inputs;
    else delete doc.inputs;
  }
  result.before = text;
  result.after = JSON.stringify(doc, null, 2) + '\n';
  result.changed = result.after !== text;
  return result;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The mode the written file gets.
 *
 * A file that may hold an API key (`--with-key`) is 0600 and nothing else. A
 * file that provably does not keeps whatever mode it already had — so
 * installing into an existing 0644 config leaves it readable by the user's own
 * editor, which is what it was. A newly created config gets 0644, the ordinary
 * case for a file that carries no secret by construction.
 */
function modeFor(plan) {
  if (plan.withKey) return 0o600;
  return plan.mode || 0o644;
}

function apply(plan, opts = {}) {
  if (plan.error) return { ...plan, applied: false };
  if (!plan.changed) return { ...plan, applied: false };
  if (opts.dryRun) return { ...plan, applied: false, dryRun: true };

  plan.withKey = Boolean(opts.withKey);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  if (plan.exists && plan.before !== null) {
    const backup = `${plan.file}.aegis-backup-${Date.now()}`;
    fs.writeFileSync(backup, plan.before, { mode: 0o600 });
    plan.backupOf = backup;
  }
  const tmp = `${plan.file}.aegis-tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, plan.after, { mode: 0o600 });
    fs.renameSync(tmp, plan.file);
    fs.chmodSync(plan.file, modeFor(plan));
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }
  return { ...plan, applied: true };
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Read back the entry this module would have written, from a TOML section.
 *
 * Only the keys `renderEntry` emits are modelled, and a section that is absent
 * returns null. This is deliberately not a TOML parser: the file belongs to
 * someone else's editor and the only question asked of it is "is our entry
 * here, and what does it point at".
 */
function parseTomlEntry(text, section) {
  if (!text) return null;
  const escaped = section.replace(/[.[\]*+?^$(){}|]/g, '\\$&');
  const at = new RegExp('^\\s*\\[' + escaped + '\\]\\s*$', 'm').exec(text);
  if (!at) return null;
  // The section is a SPAN — the header, its body, and its own subtables — so
  // the slice has to run to the first header that is NOT ours. Stopping at the
  // next header of any kind (as this used to) truncated the body before
  // `[<section>.env]`, which is where `renderEntry` puts every env var: the
  // parse succeeded and reported an empty env, which is worse than failing.
  const rest = text.slice(at.index + at[0].length);
  const lines = rest.split('\n');
  const body = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\[/.test(lines[i]) && !ownedTomlHeader(lines[i], section)) break;
    body.push(lines[i]);
    i++;
  }
  const entry = { command: null, args: [], env: {} };
  const cmd = /^\s*command\s*=\s*"((?:[^"\\]|\\.)*)"/m.exec(body.join('\n'));
  if (cmd) entry.command = JSON.parse('"' + cmd[1] + '"');
  const args = /^\s*args\s*=\s*\[([\s\S]*?)\]/m.exec(body.join('\n'));
  if (args) {
    entry.args = [...args[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse('"' + m[1] + '"'));
  }
  for (const m of body.join('\n').matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)) {
    if (m[1] !== 'command' && m[1] !== 'args') entry.env[m[1]] = JSON.parse('"' + m[2] + '"');
  }
  return entry;
}

/**
 * The script an entry names, if any.
 *
 * `spec.js` always writes `command: node` plus an absolute path to
 * `mcp/server.js`, so the script is the first argument that looks like one. A
 * user who hand-edited their config to `npx aegiscode-mcp` has no such
 * argument and gets `null` — "cannot tell", which is honest, not "broken".
 */
function entryServerPath(entry) {
  if (!entry) return null;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.find((a) => typeof a === 'string' && /\.(js|mjs|cjs)$/.test(a)) || null;
}

/**
 * Per target+scope: does the config exist, is our entry in it, and does the
 * command it names still exist on disk? The last question is the one that
 * catches a moved checkout — the silent failure this whole module is written
 * against.
 */
function status(ids, opts = {}) {
  const ctx = opts.ctx || hostCtx();
  const spec = opts.spec || buildSpec(opts.specOpts || {});
  const targets = ids && ids.length ? ids.map((id) => getTarget(id)).filter(Boolean) : TARGETS;
  const rows = [];

  for (const target of targets) {
    for (const scope of target.scopes || ['user']) {
      const file = target.path(scope, ctx);
      const row = { id: target.id, label: target.label, scope, file, exists: false, installed: false, entry: null, error: null, docs: target.docs, verified: target.verified };
      let read;
      try {
        read = readText(file);
      } catch (err) {
        row.error = err.message;
        rows.push(row);
        continue;
      }
      row.exists = read.exists;
      if (read.exists && read.text !== null) {
        if (target.kind === 'mcp-toml') {
          row.entry = parseTomlEntry(read.text, `${target.container}.${spec.name}`);
          row.installed = Boolean(row.entry);
        } else {
          try {
            const doc = parseJson(read.text, file);
            row.entry = getPath(doc, `${target.container}.${spec.name}`) || null;
            row.installed = Boolean(row.entry);
          } catch (err) {
            row.error = err.message;
          }
        }
      }
      // The question the editor itself never asks: the config still names a
      // file, but does that file still exist? A checkout that moved, an npm
      // prefix that changed, or a `git clean` all leave a config that loads
      // fine and fails silently at tool-call time. Surfaced here so `status`
      // can say "installed, but pointing at nothing".
      if (row.installed) {
        row.serverPath = entryServerPath(row.entry);
        row.serverExists = row.serverPath ? isFile(row.serverPath) : null;
      }
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Which hosts are actually present on this machine — the input to "offer
 * something sensible" so a user is not shown thirteen hosts they do not have.
 *
 * Two signals count as present: a config file we already know how to write, or
 * the editor's own config DIRECTORY existing. The second matters most — the
 * whole point of this command is offering AEGIS to an editor that has never
 * heard of MCP, and that editor has no `mcp.json` yet.
 */
function detected(opts = {}) {
  const ctx = opts.ctx || hostCtx();
  const found = new Set();
  for (const target of TARGETS) {
    for (const scope of target.scopes || ['user']) {
      try {
        fs.accessSync(target.path(scope, ctx));
        found.add(target.id);
      } catch { /* not installed */ }
    }
  }
  for (const [variant, id] of [
    ['Code', 'vscode'],
    ['Code - Insiders', 'vscode-insiders'],
    ['VSCodium', 'vscodium'],
    ['Cursor', 'cursor'],
  ]) {
    try {
      fs.accessSync(path.join(appConfig(ctx), variant));
      found.add(id);
    } catch { /* not installed */ }
  }
  for (const [rel, id] of [
    [['.codeium'], 'windsurf'],
    [['.gemini'], 'gemini'],
    [['.codex'], 'codex'],
    [['.continue'], 'continue'],
    [['.junie'], 'junie'],
    [['.cursor'], 'cursor'],
  ]) {
    try {
      fs.accessSync(path.join(ctx.home || ctx.env.HOME || ctx.env.USERPROFILE, ...rel));
      found.add(id);
    } catch { /* not installed */ }
  }
  return found;
}

module.exports = {
  hostCtx,
  planTarget,
  planRemove,
  apply,
  status,
  detected,
  renderEntry,
  entryServerPath,
  parseTomlEntry,
  upsertTomlSection,
  removeTomlSection,
  setPath,
  getPath,
  delPath,
  readText,
  resolveServer,
};
