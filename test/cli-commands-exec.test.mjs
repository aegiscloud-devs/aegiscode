#!/usr/bin/env node
/**
 * The EXECUTION half of the slash-command table.
 *
 * test/cli-commands.test.mjs pins the *shape* of every command (name, category,
 * handler-ness). Shape is not behaviour: a command can be registered, carry a
 * handler, and still do nothing — which is exactly how `/upgrade` went missing
 * from the vocabulary and how `/multi <task> run` ended up calling
 * `runPrompt(task)` (a single-model answer wearing the fan-out's label) and
 * `/multiyolo` only *composed* a task instead of running it.
 *
 * So this file drives the real handlers with a stub context and asserts what
 * actually happened: prompts dispatched, panels rendered, guards degrading
 * honestly. Offline and side-effect free by construction:
 *
 *   • `latestPublishedVersion` is stubbed through the module cache, so /upgrade
 *     never touches the npm registry (the real helpers are still exercised).
 *   • $AEGISCODE_HOME/$AEGIS_HOME point at a throwaway dir, so /multiyolo's
 *     `savePermissions` writes there and never to the user's real
 *     ~/.aegiscode/permissions.json (which is asserted unchanged at the end).
 *
 * Style matches test/cli-commands.test.mjs: createRequire, a local assert()
 * that throws `ASSERT FAILED: ...`, no test framework.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) => assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ── the user's real state is off limits ─────────────────────────────────────
// Must precede every require of cli/src: config.js resolves the data dir from
// the env at call time, but the modules that read it are loaded below.
const home = fs.mkdtempSync(join(os.tmpdir(), 'cli-commands-exec-'));
process.env.AEGIS_HOME = home;
process.env.AEGISCODE_HOME = home;
process.env.AEGIS_NO_UPDATE_CHECK = '1';

const realPermissionsPath = join(os.homedir(), '.aegiscode', 'permissions.json');
const realPermissionsBefore = fs.existsSync(realPermissionsPath)
  ? fs.readFileSync(realPermissionsPath, 'utf8')
  : null;

// ── /upgrade's registry lookup is stubbed, its logic is not ─────────────────
const UPDATE = join(root, 'cli', 'src', 'update.js');
const update = require(UPDATE);

assert(typeof update.compareVersions === 'function', 'update.js exports compareVersions');
assert(typeof update.upgradeAdvice === 'function', 'update.js exports upgradeAdvice');
assert(typeof update.latestPublishedVersion === 'function', 'update.js exports latestPublishedVersion');
assert(update.compareVersions('6.8.3', '6.9.0') < 0, 'compareVersions: 6.8.3 < 6.9.0');
eq(update.compareVersions('6.9.0', '6.9.0'), 0, 'compareVersions: equal');
assert(update.compareVersions('7.0.0', '6.9.0') > 0, 'compareVersions: 7.0.0 > 6.9.0');

const adviceNewer = update.upgradeAdvice({ current: '6.8.3', latest: '6.9.0' });
const adviceSame = update.upgradeAdvice({ current: '6.8.3', latest: '6.8.3' });
const adviceNull = update.upgradeAdvice({ current: '6.8.3', latest: null });
for (const [label, advice] of [['newer', adviceNewer], ['up to date', adviceSame], ['lookup failed', adviceNull]]) {
  assert(Array.isArray(advice.lines) && advice.lines.length > 0, `upgradeAdvice returns lines (${label})`);
}
assert(
  adviceNewer.lines.join('\n') !== adviceSame.lines.join('\n'),
  'advice for an outdated install differs from an up-to-date one'
);

// commands.js destructures require('./update.js') at module scope, so the stub
// has to be in the cache BEFORE commands.js is required.
const STUB_LATEST = '99.0.0';
require.cache[require.resolve(UPDATE)] = {
  id: UPDATE,
  filename: UPDATE,
  loaded: true,
  exports: { ...update, latestPublishedVersion: async () => STUB_LATEST },
};

const commands = require(join(root, 'cli', 'src', 'commands.js'));
const { COMMANDS, findCommand } = commands;

// ── a stub context: enough of the real one to run a handler ──────────────────
function makeCtx(opts = {}) {
  const calls = { prompts: [], asks: [], notes: [], rows: [], renders: 0 };
  return {
    calls,
    // note()/panel() render through c.push
    push: (row) => { calls.rows.push(row); },
    write: (s) => { calls.rows.push(s); },
    log: () => {},
    print: () => {},
    runPrompt: opts.noRunPrompt ? undefined : async (p) => { calls.prompts.push(p); },
    // the real call convention: c.withWorking(fn) — one arg, fn gets the signal
    withWorking: async (fn) => (typeof fn === 'function'
      ? fn({ aborted: false, addEventListener() {}, removeEventListener() {} })
      : undefined),
    ask: async (p) => {
      calls.asks.push(p);
      return { text: 'CANNED MULTI ANSWER', model: 'test-model' };
    },
    state: () => ({ yolo: false, model: 'test-model' }),
    ctx: { model: 'test-model', cwd: root, effort: 'high' },
    render: () => { calls.renders += 1; },
    note: (m) => { calls.notes.push(String(m)); },
  };
}

async function run(name, argv, ctxOpts) {
  const entry = findCommand(name);
  assert(entry, `/${name} is resolvable via findCommand`);
  assert(typeof entry.handler === 'function', `/${name} is handler-backed`);
  const ctx = makeCtx(ctxOpts);
  const args = { ...argv, _rest: argv._rest };
  let ret;
  let err = null;
  try {
    ret = await entry.handler(ctx, args);
  } catch (e) {
    err = e;
  }
  // rows are span arrays; flatten to something searchable
  return { name, ctx, ret, err, text: JSON.stringify(ctx.calls.rows), dispatched: [...ctx.calls.asks, ...ctx.calls.prompts] };
}

// ── /upgrade ────────────────────────────────────────────────────────────────
{
  const entry = findCommand('upgrade');
  eq(entry.category, 'support', '/upgrade is filed under support');
  const r = await run('upgrade', { action: 'check' });
  assert(!r.err, `/upgrade does not throw (${r.err && r.err.message})`);
  eq(r.ret, true, '/upgrade returns true');
  assert(r.ctx.calls.renders > 0, '/upgrade renders a panel');
  assert(new RegExp(STUB_LATEST.replace(/\./g, '\\.')).test(r.text), `/upgrade surfaced the latest version (${STUB_LATEST})`);
}

// ── /multi <task> run — the fan-out, not a bare runPrompt ───────────────────
{
  const task = 'refactor the auth layer';
  const r = await run('multi', { task, mode: 'run', _rest: `${task} run` });
  assert(!r.err, `/multi run does not throw (${r.err && r.err.message})`);
  eq(r.ret, true, '/multi run returns true');
  assert(r.dispatched.length > 0, '/multi run actually dispatched work');
  const sent = r.dispatched.join('\n');
  assert(sent.includes(task), '/multi run forwarded the task text');
  assert(/subagent|task tool/i.test(sent), '/multi run dispatched a delegation prompt, not the bare task');
  assert(r.text.includes('CANNED MULTI ANSWER'), '/multi run rendered the fan-out result');
}

// ── /multi <task> (no run) still composes only ──────────────────────────────
{
  const r = await run('multi', { task: 'compose only', _rest: 'compose only' });
  assert(!r.err, `/multi compose does not throw (${r.err && r.err.message})`);
  assert(r.ctx.calls.renders > 0, '/multi compose renders its panel');
}

// ── /multiyolo EXECUTES, and its permission write stays in the throwaway home ─
{
  const task = 'ship the yolo task';
  const r = await run('multiyolo', { task, _rest: task });
  assert(!r.err, `/multiyolo does not throw (${r.err && r.err.message})`);
  eq(r.ret, true, '/multiyolo returns true');
  assert(r.dispatched.length > 0, '/multiyolo actually EXECUTES the task');
  assert(/yolo/i.test(r.text), '/multiyolo still shows the YOLO panel');
  assert(r.text.includes('CANNED MULTI ANSWER'), '/multiyolo rendered the fan-out result');

  const tmpPermissions = join(home, 'permissions.json');
  assert(fs.existsSync(tmpPermissions), '/multiyolo wrote permissions into $AEGISCODE_HOME');
  eq(
    fs.readFileSync(tmpPermissions, 'utf8').includes('"defaultMode"'),
    true,
    'the written permissions file carries a defaultMode'
  );
}

// ── /aegis-multi <task> run ─────────────────────────────────────────────────
{
  const r = await run('aegis-multi', { task: 'multi via aegis', mode: 'run', _rest: 'multi via aegis run' });
  assert(!r.err, `/aegis-multi run does not throw (${r.err && r.err.message})`);
  assert(r.dispatched.length > 0, '/aegis-multi run dispatched work');
}

// ── the guarded trio degrades honestly when runPrompt is absent ─────────────
const GUARDED = [
  ['research', { question: 'how does caching work', _rest: 'how does caching work' }],
  ['debate', { topic: 'monorepo or not', _rest: 'monorepo or not' }],
  ['aegis-council', { question: 'should we ship', _rest: 'should we ship' }],
];
for (const [name, argv] of GUARDED) {
  const r = await run(name, argv, { noRunPrompt: true });
  assert(!r.err, `/${name} without runPrompt does not throw (the guard holds)`);
  eq(r.ret, true, `/${name} returns true without runPrompt`);
  assert(/Composed/i.test(r.text), `/${name} reports composed-but-unrunnable instead of crashing`);
}

// ── ...and forwards exactly one perspective prompt when it IS present ───────
for (const [name, argv] of GUARDED) {
  const r = await run(name, argv);
  assert(!r.err, `/${name} with runPrompt does not throw (${r.err && r.err.message})`);
  eq(r.ctx.calls.prompts.length, 1, `/${name} sent exactly one prompt`);
  assert(
    /perspective|council|debate|vote|research/i.test(r.ctx.calls.prompts.join('\n')),
    `/${name} sent a perspective-style prompt`
  );
}

// ── table integrity ─────────────────────────────────────────────────────────
{
  const names = COMMANDS.map((c) => c.name);
  eq(new Set(names).size, names.length, 'no duplicate command names');
  assert(COMMANDS.length >= 83, `the table still carries every command (got ${COMMANDS.length})`);
  assert(!!findCommand('upgrade'), '/upgrade is registered, not just referenced');
}

// ── the user's real permissions file survived ───────────────────────────────
{
  const after = fs.existsSync(realPermissionsPath) ? fs.readFileSync(realPermissionsPath, 'utf8') : null;
  eq(after, realPermissionsBefore, 'the real ~/.aegiscode/permissions.json was not touched');
}

fs.rmSync(home, { recursive: true, force: true });
console.log('CLI command execution test passed');
console.log(`  commands: ${COMMANDS.length} entries · scratch home: ${home}`);
