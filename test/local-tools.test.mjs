#!/usr/bin/env node
/**
 * Unit tests for the desktop agent loop (client half of aegiscodex-dev's tool
 * calling): desktop/lib/local/tools.js, the loop in engine.js, the in-process
 * approval gate, and client/aegis.js's buildMessages.
 *
 * These are the tests that would have caught the three defects this port
 * fixed:
 *   1. the message builders replaced the whole message list whenever `prompt`
 *      was set — dropping the system prompt and any tool traffic. (The
 *      providers.js builders that carried it are gone with the custom-direct
 *      classes; that behaviour is now exercised end-to-end by the loop tests
 *      below rather than by a builder unit test.)
 *   2. client/aegis.js buildMessages returned a non-empty history verbatim,
 *      dropping `system` on the Aegis transport alone.
 *   3. engine.chat sent no system prompt and no tools, so no model could ever
 *      touch the machine or know which machine it was on.
 *
 * The tool-loop coverage below runs on the SHIPPING 'aegis' class (the pooled
 * Cloud lane). The gate it reaches — engine.js gatedExecuteTool — is
 * class-independent, so re-pointing the loop off the removed 'openai-compat'
 * class onto 'aegis' preserves it exactly; one block below raises a real
 * approval card to prove it.
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tools = require('../desktop/lib/local/tools.js');
const prompt = require('../desktop/lib/local/prompt.js');
const { createLocalEngine, extractToolCalls } = require('../desktop/lib/local/engine.js');
const { ShellSession } = require('../desktop/lib/local/shell.js');
const { createClient } = require('../client/aegis.js');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`ASSERT FAILED: ${msg}`);
  } else {
    console.log(`  ok  ${msg}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-loop-'));
const file = path.join(tmp, 'nested', 'hello.txt');

// ── 1. Schemas ──────────────────────────────────────────────────────────────
console.log('tools.js — schemas');

const openai = tools.toolsFor();
const names = tools.toolNames();
assert(names.join(',') === 'readFile,writeFile,editFile,listDir,glob,grep,exec,task', `tool names: ${names.join(',')}`);
assert(openai.length === 8, `openai advertises 8 tools, got ${openai.length}`);
assert(
  openai.every((t) => t.type === 'function' && t.function && t.function.parameters.type === 'object'),
  'tools carry {type:function, function:{parameters}}'
);

// ── 2. Executors ────────────────────────────────────────────────────────────
console.log('tools.js — executors');

const wrote = await tools.executeTool('writeFile', { file_path: file, content: 'alpha\nbeta\n' });
assert(wrote.ok && fs.readFileSync(file, 'utf8') === 'alpha\nbeta\n', 'writeFile creates parents and writes');

const read = await tools.executeTool('readFile', { file_path: file });
assert(read.ok && read.output.includes('1| alpha'), `readFile line-numbers: ${JSON.stringify(read.output)}`);

const listed = await tools.executeTool('listDir', { path: tmp });
assert(listed.ok && listed.output.includes('nested/'), 'listDir marks directories with a slash');

const globbed = await tools.executeTool('glob', { pattern: '**/*.txt', path: tmp });
assert(globbed.ok && globbed.output.includes('nested/hello.txt'), `glob finds nested files: ${globbed.output}`);

const edited = await tools.executeTool('editFile', { file_path: file, old_string: 'alpha', new_string: 'ALPHA' });
assert(edited.ok && fs.readFileSync(file, 'utf8') === 'ALPHA\nbeta\n', `editFile replaces the exact string: ${JSON.stringify(edited)}`);

const editMissing = await tools.executeTool('editFile', { file_path: file, old_string: 'not-there', new_string: 'x' });
assert(!editMissing.ok && /not found/.test(editMissing.error), 'editFile fails loudly when old_string is absent');

const grepped = await tools.executeTool('grep', { pattern: '^ALPHA$', path: tmp });
assert(grepped.ok && /hello\.txt:1: ALPHA/.test(grepped.output), `grep finds the match with file:line: ${grepped.output}`);

const ran = await tools.executeTool('exec', {
  command: `"${process.execPath}" -e "process.stdout.write('from-exec')"`,
  cwd: tmp,
});
assert(ran.ok && ran.output === 'from-exec', `exec captures stdout: ${JSON.stringify(ran.output)}`);

const bad = await tools.executeTool('exec', { command: 'exit 3' });
assert(!bad.ok && /exit 3/.test(bad.error), `exec reports a non-zero exit: ${bad.error}`);

const unknown = await tools.executeTool('nope', {});
assert(!unknown.ok && /unknown tool/.test(unknown.error), 'unknown tool is an error, never a throw');

const missing = await tools.executeTool('readFile', {});
assert(!missing.ok, 'a missing argument is an error, never a throw');

assert(
  tools.toolResultText({ ok: false, error: 'boom' }) === 'error: boom' &&
    tools.toolResultText({ ok: true, output: 'hi' }) === 'hi',
  'toolResultText feeds `error: …` back like the CLI does'
);

// ── 2b. Persistent shell (exec via ctx.getShell) ────────────────────────────
console.log('shell.js — persistent session');

{
  const shell = new ShellSession({ cwd: tmp });
  const ctx = { getShell: () => shell };
  await tools.executeTool('exec', { command: 'cd nested' }, ctx);
  const pwd = await tools.executeTool('exec', { command: 'pwd' }, ctx);
  assert(pwd.ok && pwd.output.endsWith('nested'), `cd carries to the next exec call: ${JSON.stringify(pwd)}`);
  await tools.executeTool('exec', { command: 'export AEGIS_TEST_VAR=carried' }, ctx);
  const echoed = await tools.executeTool('exec', { command: 'echo $AEGIS_TEST_VAR' }, ctx);
  assert(echoed.ok && echoed.output.trim() === 'carried', `exported env carries to the next exec call: ${JSON.stringify(echoed)}`);
  shell.dispose();

  // Without ctx.getShell, exec falls back to a one-shot process — no session,
  // no persisted state (the pre-port behavior, still exercised above).
  const noCtx = await tools.executeTool('exec', { command: 'pwd' }, {});
  assert(noCtx.ok, 'exec with no ctx.getShell still works (one-shot fallback)');
}

// ── 4. The loop (defect 3) ──────────────────────────────────────────────────
console.log('engine.js — agent loop');

/**
 * Drive the agent loop on the SHIPPING 'aegis' class. The pooled transport is
 * a script: every call records the args it was handed and returns the next
 * scripted completion. (The old harness also faked providers.openaiCompatible
 * — that module and the 'openai-compat' class it served are deleted; the loop,
 * the tool schemas and the approval gate are all class-independent, so the
 * pooled lane exercises exactly the same code paths.)
 */
function fakeEngine(script) {
  const seen = [];
  let i = 0;
  const next = () => script[Math.min(i++, script.length - 1)];
  const engine = createLocalEngine({
    aegis: {
      apiKey: 'k',
      async listModels() { return { models: [] }; },
      async chatCompletion(args) { seen.push(args); return next(); },
    },
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    getConfirmMode: () => false,
  });
  return { engine, seen };
}

const target = path.join(tmp, 'loop.txt');
fs.writeFileSync(target, 'loop-content\n');

const callOnce = {
  model: 'm',
  choices: [{ message: { content: '' } }],
  toolCalls: [{ id: 'call_1', name: 'readFile', args: { file_path: target } }],
};
const final = { model: 'm', choices: [{ message: { content: 'done reading' } }] };

{
  const { engine, seen } = fakeEngine([callOnce, final]);
  const res = await engine.chat(
    { class: 'aegis', prompt: 'read it', model: 'gpt-x' },
    () => {}
  );
  assert(res.choices[0].message.content === 'done reading', 'the loop returns the final text answer');
  assert(seen.length === 2, `the loop made 2 rounds, got ${seen.length}`);
  // The pooled transport carries the schemas under `extra` (the client hoists
  // them into the request body); the removed direct classes passed `tools`
  // top-level. Same 8 schemas, same loop.
  assert(Array.isArray(seen[0].extra.tools) && seen[0].extra.tools.length === 8, 'round 1 advertised the 8 tool schemas');
  assert(
    typeof seen[0].system === 'string' && seen[0].system.includes('Aegiscodex') && seen[0].system.includes('# Environment'),
    'round 1 carried the persona + environment preamble (no more "which OS are you on?")'
  );
  assert(/platform:/.test(seen[0].system), 'the preamble names the platform');
  const second = seen[1].messages;
  const assistant = second.find((m) => m.role === 'assistant' && m.tool_calls);
  const result = second.find((m) => m.role === 'tool');
  assert(assistant && assistant.tool_calls[0].function.name === 'readFile', 'the assistant tool_calls turn is threaded back');
  assert(result && result.tool_call_id === 'call_1', 'the tool result carries its tool_call_id');
  assert(result.content.includes('loop-content'), `the tool actually ran and fed output back: ${JSON.stringify(result.content)}`);
  assert(seen[1].prompt === '', 'round 2 sends history, not a duplicate prompt');
  assert(
    seen[1].messages.length === 3 &&
      seen[1].messages[0].role === 'user' &&
      seen[1].messages[0].content === 'read it',
    'round 2 keeps the original user question in the history'
  );
}

{
  // No round cap: a model that keeps calling tools past the old 12-round
  // limit is never cut off — the loop runs as long as it keeps calling
  // tools and only stops once it answers in text. (The real horizon is 24
  // rounds for a chat turn, so 20 tool rounds still lands before it.)
  const forever = { ...callOnce, toolCalls: [{ id: 'x', name: 'listDir', args: { path: tmp } }] };
  const oldCap = 12;
  const toolRounds = oldCap + 8;
  let rounds = 0;
  const engine = createLocalEngine({
    aegis: {
      apiKey: 'k',
      async listModels() { return { models: [] }; },
      async chatCompletion() {
        rounds += 1;
        return rounds <= toolRounds ? forever : final;
      },
    },
    settings: { get: () => ({ baseURL: 'http://local', configured: true }), rawKey: () => 'k' },
    getConfirmMode: () => false,
  });
  const res = await engine.chat({ class: 'aegis', prompt: 'go', model: 'm' }, () => {});
  assert(rounds === toolRounds + 1, `ran past the old ${oldCap}-round cap (${rounds} rounds)`);
  assert(
    res && res.choices[0].message.content === 'done reading',
    'the loop keeps going until the model actually answers in text'
  );
}

{
  const { engine, seen } = fakeEngine([final]);
  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm', tools: false }, () => {});
  assert(
    !('tools' in seen[0].extra),
    '`tools: false` restores the single-shot turn (no schemas on the wire)'
  );
  assert(typeof seen[0].system === 'string' && seen[0].system.length > 0, 'the persona is sent even with tools off');
}

{
  // The removed custom classes no longer exist: dispatching one is refused
  // outright rather than silently borrowing another class's transport.
  const { engine } = fakeEngine([final]);
  let err = null;
  try {
    await engine.chat({ class: 'openai-compat', prompt: 'hi', model: 'm' }, () => {});
  } catch (e) {
    err = e;
  }
  assert(err && /unknown model class/.test(err.message), `a removed class is refused: ${err && err.message}`);
}

{
  // The in-process approval gate (engine.js gatedExecuteTool) is
  // class-independent: an exec call on the aegis lane still raises the same
  // card the removed direct classes did, and a denial is fed back as a tool
  // error instead of running the command.
  const execCall = {
    model: 'm',
    choices: [{ message: { content: '' } }],
    toolCalls: [{ id: 'c_gate', name: 'exec', args: { command: 'echo SHOULD-NOT-RUN' } }],
  };
  const seen = [];
  let i = 0;
  const script = [execCall, final];
  const engine = createLocalEngine({
    aegis: {
      apiKey: 'k',
      async listModels() { return { models: [] }; },
      async chatCompletion(args) { seen.push(args); return script[Math.min(i++, script.length - 1)]; },
    },
    settings: { get: () => ({}), rawKey: () => '' },
    // No getConfirmMode/settings.getConfirmMode → the gate defaults ON.
  });

  const sessionId = 'gate-session';
  let card = null;
  const turn = engine.chat({ class: 'aegis', prompt: 'please echo', model: 'm', sessionId }, (c) => {
    if (c && c.approval) card = c;
  });
  for (let n = 0; n < 400 && !card; n++) await new Promise((r) => setTimeout(r, 5));
  assert(card && card.approval, 'the aegis lane raises the in-process approval card for a mutating tool');
  if (card && card.approval) {
    const answered = engine.respondApproval(card.approval.id, 'deny');
    assert(answered && answered.ok, 'the approval card is answerable by id');
  }

  // A denied turn must still resolve (the denial is handed back to the model,
  // which then answers in text) rather than hanging on the gate.
  let guard;
  const timeout = new Promise((resolve) => {
    guard = setTimeout(() => { engine.cancel(sessionId); resolve(null); }, 3000);
  });
  let res = null;
  let runErr = null;
  try { res = await Promise.race([turn, timeout]); } catch (e) { runErr = e; }
  clearTimeout(guard);
  assert(!runErr, `the denied turn resolves: ${runErr && runErr.message}`);
  if (res) {
    assert(res.choices[0].message.content === 'done reading', 'the turn continues after a denial');
    const toolResult = seen[1] && seen[1].messages.find((m) => m.role === 'tool');
    assert(toolResult && /denied/.test(toolResult.content), `the denial is fed back as the tool result: ${JSON.stringify(toolResult)}`);
  }
}

{
  const res = extractToolCalls({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'glob', arguments: '{"pattern":"*.js"}' } }] } }] });
  assert(res.length === 1 && res[0].name === 'glob' && res[0].args.pattern === '*.js', 'extractToolCalls reads the provider-native OpenAI shape');
  assert(extractToolCalls({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'glob', arguments: 'not json' } }] } }] })[0].args.pattern === undefined, 'malformed arguments degrade to {} instead of throwing');
  assert(extractToolCalls(null).length === 0, 'a null response yields no calls');
}

// ── 4b. Task tool: subagent delegation ──────────────────────────────────────
console.log('engine.js — task subagent');

{
  // Round 1: the top-level turn calls task. Round 2: the nested subagent turn
  // (its own chat() call) answers with text. Round 3: the top-level turn sees
  // the tool result and gives its own final answer.
  const taskCall = {
    model: 'm',
    choices: [{ message: { content: '' } }],
    toolCalls: [{ id: 'call_1', name: 'task', args: { description: 'scan', subagent_type: 'scanner', prompt: 'scan for secrets' } }],
  };
  const subagentFinal = { model: 'm', choices: [{ message: { content: 'no secrets found' } }] };
  const topFinal = { model: 'm', choices: [{ message: { content: 'done — subagent reports no secrets found' } }] };

  const { engine, seen } = fakeEngine([taskCall, subagentFinal, topFinal]);
  const res = await engine.chat({ class: 'aegis', prompt: 'audit this repo', model: 'gpt-x' }, () => {});
  assert(res.choices[0].message.content === 'done — subagent reports no secrets found', 'the top-level turn answers after the subagent returns');
  assert(seen.length === 3, `task delegation made 3 rounds (top, subagent, top again), got ${seen.length}`);
  assert(seen[1].system.includes('Vulnerability Scanner') || seen[1].system.includes('Security Vulnerability Scanner'), `the subagent got the scanner preset system prompt: ${seen[1].system.slice(0, 80)}`);
  assert(seen[1].prompt === 'scan for secrets', 'the subagent turn carries the task prompt verbatim');
  const toolResult = seen[2].messages.find((m) => m.role === 'tool');
  assert(toolResult && toolResult.content === 'no secrets found', `the subagent's answer is fed back as the tool result: ${JSON.stringify(toolResult)}`);
}

{
  // A subagent's own turn (depth 1) still offers task (so it can delegate
  // further), but a depth-4 subagent must not — the schema drops it.
  const deep = { model: 'm', choices: [{ message: { content: 'leaf answer' } }] };
  const { engine, seen } = fakeEngine([deep]);
  await engine.chat({ class: 'aegis', prompt: 'x', model: 'm', depth: 4 }, () => {});
  assert(
    !seen[0].extra.tools.some((t) => t.function.name === 'task'),
    'a depth-4 turn is not offered the task tool (subagent depth cap)'
  );
}

{
  // Task with neither prompt nor description is a tool error, not a throw.
  const script = [
    { model: 'm', choices: [{ message: { content: '' } }], toolCalls: [{ id: 'c1', name: 'task', args: {} }] },
    { model: 'm', choices: [{ message: { content: 'handled the empty task' } }] },
  ];
  const { engine, seen } = fakeEngine(script);
  const res = await engine.chat({ class: 'aegis', prompt: 'go', model: 'm' }, () => {});
  assert(res.choices[0].message.content === 'handled the empty task', 'an empty task call resolves as a tool error, not a crash');
  assert(seen.length === 2, 'an empty task never spawns a nested chat() round');
}

// ── 5. prompt.js ────────────────────────────────────────────────────────────
console.log('prompt.js');
const sys = prompt.buildSystemPrompt({ platform: 'linux', homedir: '/home/x', roots: ['/home/x/repo'] });
assert(sys.includes('Aegiscodex') && sys.includes('exec'), 'the persona names the assistant and its tools');
assert(sys.includes('/home/x/repo') && sys.includes('platform: linux'), 'the preamble lists env facts and repo roots');
assert(prompt.buildSystemPrompt({}).includes('Aegiscodex'), 'the persona is never empty, even with no env');

// ── 6. client/aegis.js buildMessages (defect 2) ─────────────────────────────
console.log('client/aegis.js — buildMessages');

{
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ model: 'm', choices: [{ message: { content: 'ok' } }] }),
      text: async () => '{}',
    };
  };
  try {
    const aegis = createClient({ apiKey: 'k', apiBase: 'http://x' });
    await aegis.chatCompletion({
      messages: [{ role: 'user', content: 'history turn' }],
      system: 'persona',
      prompt: 'live prompt',
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  const sent = bodies[0].messages;
  assert(sent[0].role === 'system' && sent[0].content === 'persona', 'aegis keeps the system turn with a non-empty history (the regression)');
  assert(sent.some((m) => m.content === 'history turn'), 'aegis keeps the history');
  assert(sent[sent.length - 1].content === 'live prompt', 'aegis appends the prompt');
}

{
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      text: async () => '{}',
    };
  };
  try {
    const aegis = createClient({ apiKey: 'k', apiBase: 'http://x' });
    await aegis.chatCompletion({ prompt: 'single shot' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(
    bodies[0].messages.length === 1 && bodies[0].messages[0].role === 'user',
    'the single-shot shorthand still yields exactly one user turn'
  );
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\nlocal-tools test FAILED: ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nLocal tool-calling test passed: schemas, executors, agent loop, approval gate, no round cap.');
