#!/usr/bin/env node
/**
 * The terminal title bar — the session's topic.
 *
 * What it pins, and why each one matters:
 *
 *  · the topic is derived from the *user's own prompt*, locally: no model call,
 *    so the title costs nothing and cannot name work the user never asked for;
 *  · politeness and list noise are stripped, because a tab reading "Please can
 *    you add a retry" wastes the eight words that fit;
 *  · a follow-up keeps the topic it inherited, and only a genuinely different
 *    ask adopts a new one — otherwise every "now do that" renames the tab and
 *    the title tells you nothing about the session;
 *  · a prompt can never inject an escape sequence into the title bar, which is
 *    the one place user text reaches the terminal raw;
 *  · the loop actually writes it: the tab carries the topic while a turn runs
 *    (spinning) and after it (idle, with the product name), and the teardown
 *    clears it so the shell gets its title back;
 *  · and it is genuinely off when disabled — no OSC 0 in either direction.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { EventEmitter } from 'node:events';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliDir = join(__dirname, '..', 'cli');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
const eq = (a, b, msg) =>
  assert(a === b, `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const title = require(join(cliDir, 'src', 'title.js'));
const chatflow = require(join(cliDir, 'src', 'chatflow.js'));

// ── the pure surface: topic derivation ──────────────────────────────────────

eq(title.topicFrom('please can you add a retry to the fetcher'), 'Add a retry to the fetcher', 'politeness is stripped');
eq(title.topicFrom('ok so now I want you to fix the config loader'), 'Fix the config loader', 'filler strips repeatedly, not once');
eq(title.topicFrom('  ## Rebuild the docs index  '), 'Rebuild the docs index', 'markdown heading noise is dropped');
eq(title.topicFrom('1. Ship the changelog'), 'Ship the changelog', 'ordered-list noise is dropped');
eq(title.topicFrom('> why is the nexus hang still there'), 'Why is the nexus hang still there', 'a quote marker is not the topic');
eq(
  title.topicFrom('here is the stack trace:\n\n    at nexus.py:41\n    at base.py:12'),
  'Here is the stack trace:',
  "a pasted block's first line is its subject",
);
eq(title.topicFrom('```js\nconst x = 1;\n```'), 'Const x = 1;', 'a fence marker is not the topic');
eq(title.topicFrom(''), '', 'an empty prompt has no topic');
eq(title.topicFrom('   \n\n '), '', 'whitespace has no topic');
eq(title.topicFrom(null), '', 'null has no topic');
eq(
  title.topicFrom('can you'),
  'Can you',
  'a prompt that is *only* filler keeps its own text rather than losing the topic',
);

// Clipped on a word boundary, and never longer than the budget.
const long = title.topicFrom('rewrite the whole streaming reassembly path in the provider base class today');
assert(title.sanitize(long).length <= title.TOPIC_MAX, `a long topic is clipped (got ${long.length})`);
assert(long.endsWith('…'), 'a clipped topic ends in an ellipsis');
assert(!/\s…$/.test(long), 'the clip trims the boundary space before the ellipsis');

// ── the pure surface: injection safety ─────────────────────────────────────

const hostile = title.topicFrom('fix it\u0007\u001b]0;pwned\u0007\u001b[2J now');
assert(!/[\u0000-\u001f\u007f]/.test(hostile), 'control characters never survive into the title');
assert(!hostile.includes('\u001b]0;'), 'a prompt cannot forge a new OSC title');
const written = [];
title.writeTitle(hostile, { write: (s) => written.push(s) });
eq(written.length, 1, 'one write per title update');
eq((written[0].match(/\x1b\]0;/g) || []).length, 1, 'exactly one OSC 0 in the sequence');
assert(written[0].endsWith('\x07'), 'the OSC is BEL-terminated');

// ── the pure surface: which ask renames the tab ────────────────────────────

const first = title.topicFrom('fix the config loader');
eq(
  title.adoptTopic(first, 'also add a test for the config loader'),
  first,
  'a follow-up about the same subject keeps the topic it inherited',
);
eq(
  title.adoptTopic(first, 'now write the changelog'),
  'Write the changelog',
  'an unrelated ask adopts a new topic',
);
eq(title.adoptTopic(first, ''), first, 'an empty ask never clears the topic');
eq(title.adoptTopic('', 'fix the config loader'), first, 'the first ask always becomes the topic');
assert(title.titleShift('', first) === true, 'a topic appears out of nothing');
assert(title.titleShift(first, '') === false, 'no topic is never a shift');

// ── the pure surface: composition and gating ───────────────────────────────

eq(title.titleText({}), 'AEGIS Code', 'before any ask the title is the product name');
eq(title.titleText({ topic: first }), 'Fix the config loader · AEGIS Code', 'idle keeps the product name so a tab is identifiable');
eq(title.titleText({ topic: first, frame: '⠂' }), '⠂ Fix the config loader', 'working shows the topic alone, behind a frame');
eq(title.titleText({ topic: '   ' }), 'AEGIS Code', 'a blank topic composes to the product name');
assert(title.TITLE_SPIN.includes(title.titleText({ topic: first, frame: title.TITLE_SPIN[0] })[0]), 'the frame comes from the shared spinner set');

assert(title.titleEnabled({}, {}) === true, 'the title follows the work by default');
assert(title.titleEnabled({ AEGIS_DISABLE_TERMINAL_TITLE: '1' }, {}) === false, 'AEGIS_DISABLE_TERMINAL_TITLE=1 turns it off');
assert(title.titleEnabled({ CLAUDE_CODE_DISABLE_TERMINAL_TITLE: 'true' }, {}) === false, 'the reference env var is honoured too');
assert(title.titleEnabled({}, { terminalTitle: false }) === false, 'terminalTitle:false in config turns it off');
assert(title.titleEnabled({ AEGIS_TERMINAL_TITLE: '1' }, { terminalTitle: false }) === true, 'AEGIS_TERMINAL_TITLE=1 wins over config for one run');
assert(title.titleEnabled({ AEGIS_DISABLE_TERMINAL_TITLE: '0' }, {}) === true, 'a falsey flag is not a disable');

// The writer is a nicety: a stubbed, closed or non-TTY stream must not throw.
{
  const real = process.stdout.write.bind(process.stdout);
  const seen = [];
  process.stdout.write = (s) => { seen.push(String(s)); return true; };
  try {
    eq(title.writeTitle('AEGIS Code', undefined), true, 'with no stream given, the title goes to stdout');
    eq(seen.join(''), '\x1b]0;AEGIS Code\x07', 'and it is a single OSC 0 sequence');
  } finally {
    process.stdout.write = real;
  }
}
eq(title.writeTitle('x', {}), false, 'a stream without write() is skipped');
eq(
  title.writeTitle('x', { write: () => { throw new Error('EPIPE'); } }),
  false,
  'a throwing stream is swallowed, not propagated',
);
eq(title.writeTitle('', { write: () => {} }), true, 'the empty title clears the bar');

// ── the loop, driven for real ──────────────────────────────────────────────

function fakeStdin() {
  const s = new EventEmitter();
  s.isTTY = true;
  s.setRawMode = () => {};
  s.setEncoding = () => {};
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

/** Run `runSession` with stdout captured and a scripted key sequence. */
async function drive(script, { extra = {} } = {}) {
  const stdin = fakeStdin();
  const captured = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowD = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true, writable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true, writable: true });

  const rows = [];
  const host = {
    ctx: { light: false, model: null, effort: 'high', vim: false, sessionId: 'title-test' },
    version: '9.9.9',
    transcript: rows,
    session: { turns: 0, calls: 0, tokens: 0 },
    client: {},
    ask: async (prompt, { presenter }) => {
      presenter.text('the answer');
      return { text: 'the answer', model: 'nexus', ms: 12, usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } };
    },
    loadConfig: () => ({}),
    makeCommandContext: () => ({
      ctx: host.ctx,
      transcript: rows,
      push: () => {},
      note: () => {},
      panel: () => {},
      render: () => {},
      openOverlay: () => {},
      closeOverlay: () => {},
      askInput: () => Promise.resolve(null),
      withWorking: (fn) => fn(new AbortController().signal),
      runPrompt: async () => {},
      ask: async () => ({ text: '' }),
      runTool: async () => '',
      refreshSpend: async () => null,
      state: () => ({}),
      setInput: () => {},
      exit: () => {},
      client: {},
      TOOLS: {},
      saveConfig: () => {},
      showThemePicker: () => {},
    }),
    buildState: () => ({}),
    dispatchLine: async () => true,
    refreshSpend: async () => ({ balance: 5, lastCost: 0 }),
    updateConfig: () => {},
    visibleCommands: () => [],
    tokensFor: (u) => (u && u.total_tokens) || null,
    recordTurn: () => {},
    tokenSummary: () => 'summary',
    resumeSession: async () => {},
    requestExit: () => {},
    wantsExit: () => false,
    isYolo: () => false,
    stdin,
    ...extra,
  };

  let done = false;
  const run = chatflow.runSession(host).then((code) => {
    done = true;
    return code;
  });

  for (const step of script) {
    if (typeof step === 'number') {
      await new Promise((r) => setTimeout(r, step));
      continue;
    }
    await new Promise((r) => setTimeout(r, 15));
    stdin.emit('data', step);
  }
  for (let i = 0; i < 40 && !done; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (i >= 16 && i % 4 === 0) stdin.emit('data', '\x03');
  }

  await Promise.race([run, new Promise((r) => setTimeout(() => r('TIMEOUT'), 2000))]);
  process.stdout.write = realWrite;
  if (cols) Object.defineProperty(process.stdout, 'columns', cols);
  if (rowD) Object.defineProperty(process.stdout, 'rows', rowD);
  return captured.join('');
}

// 1. The ask becomes the tab's topic, spinning during the turn and idle after.
{
  const out = await drive(['add a retry to the fetcher\r', 60, '\x03']);
  assert(out.includes('\x1b]0;AEGIS Code\x07'), 'the tab wears the product name before any ask');
  assert(
    /\x1b\]0;[⠐⠂⠄⠆⠈⠠⠰⠁] Add a retry to the fetcher\x07/.test(out),
    'the running turn spins the derived topic in the tab',
  );
  assert(
    out.includes('\x1b]0;Add a retry to the fetcher · AEGIS Code\x07'),
    'the finished turn leaves the topic idle beside the product name',
  );
  const titles = out.match(/\x1b\]0;([^\x07]*)\x07/g) || [];
  assert(titles.length >= 3, `the title is written across the turn (got ${titles.length})`);
  assert(titles.some((t) => t === '\x1b]0;\x07'), 'the teardown clears the title so the shell gets its tab back');
}

// 2. Disabled means disabled: no OSC 0 in either direction.
{
  const prev = process.env.AEGIS_DISABLE_TERMINAL_TITLE;
  process.env.AEGIS_DISABLE_TERMINAL_TITLE = '1';
  try {
    const out = await drive(['add a retry to the fetcher\r', 60, '\x03']);
    assert(!out.includes('\x1b]0;'), 'AEGIS_DISABLE_TERMINAL_TITLE=1 writes no title, and clears none');
  } finally {
    if (prev === undefined) delete process.env.AEGIS_DISABLE_TERMINAL_TITLE;
    else process.env.AEGIS_DISABLE_TERMINAL_TITLE = prev;
  }
}

// 3. The config file speaks too, for a user who never sets an env var.
{
  const out = await drive(['add a retry to the fetcher\r', 60, '\x03'], {
    extra: { loadConfig: () => ({ terminalTitle: false }) },
  });
  assert(!out.includes('\x1b]0;'), 'terminalTitle:false in config.json is honoured by the loop');
}

console.log('CLI title test passed');
console.log('  topic: derived locally from the prompt — no model call, no invented task');
console.log(`  clip: ${title.TOPIC_MAX} cells on a word boundary · safety: no escape can reach the bar`);
console.log('  gating: env + config verified against a real driven session');
