#!/usr/bin/env node
/**
 * The `local` class's Settings row — the only row that configures an ENDPOINT
 * instead of a credential.
 *
 * The defect this file pins down: the class shipped selectable in the class
 * picker and unconfigurable in the UI. `loadSettings()` built the byok rows
 * (and the byok fee note) and nothing else, so a daemon on a non-default port
 * had no place to be named — the engine read a `local` settings row that no
 * affordance could create. `buildLocalSettingRow` is that row.
 *
 * Why the production functions are sliced out of app.js rather than the whole
 * file being booted: app.js is an IIFE that queries ~120 elements and calls
 * init() at load, so it only runs under the Electron host (this is asserted,
 * not assumed, in test/renderer-dom.test.mjs, which excludes it and checks it
 * statically instead). Slicing TWO functions out of the real file keeps the
 * assertions on shipping code — the row markup, the save path, the refusal
 * copy — without a fake Electron, and a rename or a move breaks this file
 * loudly (sliceFunction throws) rather than silently testing nothing.
 *
 * What is asserted here, and why each one is a rule rather than a detail:
 *
 *   1. the row is a TEXT field for a Base URL, and the realm contains no
 *      password input at all — a local daemon takes no credential (local.js
 *      sends no Authorization header because there is none), so a key field
 *      would be a place to paste a real secret with no consumer;
 *   2. the placeholder is the address a stock daemon answers on, so an empty
 *      field still says where the class will dial;
 *   3. saving goes through `models.settings.set` and the row is re-rendered
 *      from what the STORE returned, not from what was typed — the store is
 *      where the loopback policy lives, so its answer is the only truth, and a
 *      refused URL has to reach the user as a sentence;
 *   4. a refusal changes the hint and does NOT re-render the list, because
 *      nothing was written.
 *
 * The wiring half of the same fix — the typed-model-tag box refreshing the
 * budget note — is a static assertion at the end: that listener lives inside
 * init(), which needs the whole app booted.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'desktop', 'renderer', 'app.js'), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** The `const NAME = …;` line as written, so the values under test are the
 *  ones that ship rather than a copy that can drift. */
function sliceDecl(name) {
  const m = new RegExp(`^const ${name} = .*$`, 'm').exec(src);
  assert(m, `app.js must declare ${name} (the local row reads it)`);
  return m[0];
}

/** A top-level `[async] function name(...) { … }` by brace-at-column-0 end. */
function sliceFunction(name) {
  const at = src.indexOf(`function ${name}(`);
  assert(at >= 0, `app.js must define ${name}()`);
  // Keep the `async` keyword: saveLocalBase awaits the store, and dropping it
  // would make this harness fail to parse the very code it is asserting on.
  const asyncAt = at - 6;
  const start = asyncAt >= 0 && src.slice(asyncAt, at) === 'async ' ? asyncAt : at;
  const end = src.indexOf('\n}\n', at);
  assert(end > at, `could not find the end of ${name}() in app.js`);
  return src.slice(start, end + 2);
}

// ------------------------------------------------------------------ fake DOM

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.disabled = false;
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  /** Await each listener (the save handler is async) and return the results. */
  async dispatch(event) {
    const out = [];
    for (const fn of this.listeners.get(event.type) || []) out.push(await fn(event));
    return out;
  }
  all() {
    return [this, ...this.children.flatMap((c) => (c.all ? c.all() : [c]))];
  }
}

/** Build a realm holding ONLY the real row builder + save path, plus stubs. */
function makeRealm({ set, calls }) {
  const created = [];
  const document = {
    createElement: (tag) => {
      const el = new FakeEl(tag);
      created.push(el);
      return el;
    },
  };
  const els = { settingsHint: { textContent: '' }, classSelect: { value: 'local' } };
  const context = vm.createContext({
    console,
    document,
    els,
    Error,
    Promise,
    JSON,
    String,
    Number,
    Object,
    Array,
    Boolean,
    setTimeout,
    models: { settings: { set } },
    loadSettings: async () => calls.push('loadSettings'),
    loadModels: async (cls) => calls.push(['loadModels', cls]),
    removeSetting: (p) => calls.push(['removeSetting', p]),
  });
  const code = [
    sliceDecl('LOCAL_PROVIDER'),
    sliceDecl('LOCAL_DEFAULT_BASE'),
    sliceFunction('buildLocalSettingRow'),
    sliceFunction('saveLocalBase'),
  ].join('\n\n');
  vm.runInContext(code, context, { filename: 'app.js (local settings row)' });
  return { context, created, els };
}

/** A settings-row record in the shape desktop/lib/settings.js `get()` returns. */
const cfgFor = (over = {}) =>
  Object.assign({ provider: 'local', baseURL: '', configured: false, keyMask: null }, over);

// ------------------------------------------------- 1. the row's own structure
{
  const calls = [];
  const realm = makeRealm({ set: async () => cfgFor(), calls });
  const row = realm.context.buildLocalSettingRow(cfgFor());

  assert(row.className === 'setting-row', 'the local row uses the shared row class');
  assert(row.dataset.provider === 'local', 'the local row is the `local` provider row');

  const inputs = row.all().filter((el) => el.tagName === 'INPUT');
  assert(inputs.length === 1, `the local row has exactly one input (got ${inputs.length})`);
  const [field] = inputs;
  assert(field.type === 'text', 'the local row\'s input is a text field (a Base URL)');
  assert(field.id === 'local-base-url', 'the base URL field has a stable id');
  assert(
    field.placeholder === 'http://localhost:11434',
    `the placeholder names the stock daemon address (got ${JSON.stringify(field.placeholder)})`
  );
  assert(
    realm.created.every((el) => el.type !== 'password'),
    'NO password/key field is built for the local class — a local server takes no credential'
  );

  const labels = row.all().filter((el) => el.className === 'setting-name').map((el) => el.textContent);
  assert(labels.includes('Local model server'), 'the row is labelled'); 

  const buttons = row.all().filter((el) => el.tagName === 'BUTTON').map((el) => el.textContent);
  assert(buttons.includes('Save'), 'the row has a Save button');

  const status = row.all().filter((el) => el.className === 'setting-status')[0];
  assert(
    status && status.textContent === 'default (http://localhost:11434)',
    `an unconfigured row states the address it will actually dial (got ${status && status.textContent})`
  );
}

// A stored row prefills the field and shows the stored address.
{
  const calls = [];
  const realm = makeRealm({ set: async () => cfgFor(), calls });
  const row = realm.context.buildLocalSettingRow(cfgFor({ baseURL: 'http://192.168.1.20:11434' }));
  const [field] = row.all().filter((el) => el.tagName === 'INPUT');
  assert(field.value === 'http://192.168.1.20:11434', 'a configured row prefills the stored base URL');
  const status = row.all().filter((el) => el.className === 'setting-status')[0];
  assert(status.textContent === 'http://192.168.1.20:11434', 'and reports it');
}

// --------------------------------------------------------- 2. the save path
// The value written is the typed one, under the `local` provider id.
{
  const calls = [];
  const seen = [];
  const realm = makeRealm({
    set: async (provider, cfg) => {
      seen.push([provider, cfg]);
      // A store that normalizes: proves the row re-reads the RETURNED settings
      // rather than echoing what was typed.
      return cfgFor({ baseURL: 'http://127.0.0.1:9999' });
    },
    calls,
  });
  const row = realm.context.buildLocalSettingRow(cfgFor());
  const [field] = row.all().filter((el) => el.tagName === 'INPUT');
  field.value = 'http://127.0.0.1:9999/';
  const [saveBtn] = row.all().filter((el) => el.tagName === 'BUTTON' && el.textContent === 'Save');

  await saveBtn.dispatch({ type: 'click' });

  assert(seen.length === 1, 'Save writes exactly one settings row');
  assert(seen[0][0] === 'local', `Save writes the \`local\` provider row (got ${seen[0][0]})`);
  assert(
    seen[0][1].baseURL === 'http://127.0.0.1:9999/',
    'and passes the typed Base URL through (the store owns normalization)'
  );
  assert(seen[0][1].key === undefined, 'and never sends a key — there is no credential to store');
  assert(calls.includes('loadSettings'), 'the row list is reloaded after a save');
  assert(
    calls.some((c) => Array.isArray(c) && c[0] === 'loadModels' && c[1] === 'local'),
    'and the model list is reloaded for the current class'
  );
  assert(
    realm.els.settingsHint.textContent === 'saved: local model server at http://127.0.0.1:9999',
    `the hint reports what the STORE returned (got ${JSON.stringify(realm.els.settingsHint.textContent)})`
  );
}

// A blank field falls back to the default address rather than writing an empty
// string, so "cleared" and "stock address" cannot become two states.
{
  const calls = [];
  const seen = [];
  const realm = makeRealm({
    set: async (provider, cfg) => {
      seen.push(cfg);
      return cfgFor({ baseURL: cfg.baseURL });
    },
    calls,
  });
  const row = realm.context.buildLocalSettingRow(cfgFor());
  const [field] = row.all().filter((el) => el.tagName === 'INPUT');
  field.value = '   ';
  const [saveBtn] = row.all().filter((el) => el.tagName === 'BUTTON' && el.textContent === 'Save');
  await saveBtn.dispatch({ type: 'click' });
  assert(
    seen[0].baseURL === 'http://localhost:11434',
    `a blank field saves the default (got ${JSON.stringify(seen[0].baseURL)})`
  );
}

// ------------------------------------------------- 3. the refusal reaches the UI
// The store refuses a non-local URL (desktop/lib/settings.js → remoteRefusal).
// What matters here is that the user SEES why, in the store's own words, and
// that nothing is re-rendered as if a write had happened.
{
  const calls = [];
  const refusal = new Error(
    'local: "https://api.openai.com" is not on this machine, so it is not the local class. ' +
      'Running a model you own is free because there is no vendor to pay — a remote URL here ' +
      'would be an unpaid turn instead. Use the aegis or byok class for remote models.'
  );
  refusal.status = 400;
  const realm = makeRealm({
    set: async () => {
      throw refusal;
    },
    calls,
  });
  const row = realm.context.buildLocalSettingRow(cfgFor());
  const [field] = row.all().filter((el) => el.tagName === 'INPUT');
  field.value = 'https://api.openai.com/v1';
  const [saveBtn] = row.all().filter((el) => el.tagName === 'BUTTON' && el.textContent === 'Save');
  await saveBtn.dispatch({ type: 'click' });

  const hint = realm.els.settingsHint.textContent;
  assert(hint.startsWith('save failed: '), `a refusal is reported as a failed save (got ${JSON.stringify(hint)})`);
  assert(hint.includes('not on this machine'), 'and quotes the store refusal verbatim');
  assert(hint.includes('api.openai.com'), 'naming the address that was refused');
  assert(calls.length === 0, 'a refused save reloads nothing — no write happened');

  // Enter in the field takes the same path as the button.
  field.value = 'http://localhost:11434';
  // The keydown handler calls saveLocalBase() without returning its promise
  // (ordinary event-handler style), so the hint settles a microtask later —
  // flushed here rather than assumed.
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  await field.dispatch({ type: 'keydown', key: 'Enter' });
  await flush();
  assert(
    realm.els.settingsHint.textContent.includes('not on this machine'),
    'Enter in the Base URL field saves through the same path as the button'
  );
  realm.els.settingsHint.textContent = 'untouched';
  await field.dispatch({ type: 'keydown', key: 'a' });
  await flush();
  assert(
    realm.els.settingsHint.textContent === 'untouched',
    'and an ordinary keystroke does not save'
  );
}

// --------------------------------------- 4. loadSettings renders this row
// The defect was an absent row, so the row must be attached by loadSettings —
// and before the byok block, whose fetch throws when the server is unreachable
// (that block is wrapped in a try; a row after it would vanish with the server).
{
  const start = src.indexOf('async function loadSettings()');
  assert(start >= 0, 'app.js must define loadSettings()');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  const localAt = body.indexOf('buildLocalSettingRow(');
  assert(localAt >= 0, 'loadSettings() appends the local row (buildLocalSettingRow)');
  const byokAt = body.indexOf("listModels('byok')");
  assert(byokAt >= 0, 'loadSettings() still renders the byok rows');
  assert(
    localAt < byokAt,
    'the local row is appended BEFORE the byok catalog fetch, so it survives an unreachable server'
  );
  assert(
    /settings\.find\(\(s\) => s && s\.provider === LOCAL_PROVIDER\)/.test(body),
    'the local row is looked up by the shared LOCAL_PROVIDER constant, not a literal'
  );
}

// ------------------------------------------ 5. the typed model tag is wired
// The box is the selection while it is visible (see currentModelId), and the
// budget note is the only place the resulting token figure appears — so an
// unlistened box means the note describes a model the user is not using.
assert(
  /els\.modelFree\.addEventListener\('input'/.test(src),
  'app.js must listen for input on els.modelFree (model-input) so typing a tag refreshes the budget note'
);
assert(
  /els\.modelFree\.addEventListener\('input',[\s\S]{0,400}?updateBudgetControls\(/.test(src),
  'and that listener must call updateBudgetControls()'
);

console.log('renderer local-row tests passed');
