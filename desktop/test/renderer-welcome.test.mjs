#!/usr/bin/env node
/**
 * The welcome panel's connect block — the one screen a fresh install sees, and
 * the gate that decides whether it is ever seen at all.
 *
 * The block shipped on disk in both surfaces (3f62b60) with the CLI half pinned
 * by test/cli-onboarding.test.mjs and the DESKTOP half pinned by nothing: a grep
 * for `welcome` across test/ and desktop/test/ matched only `cli-*` suites, so
 * the single boolean that decides whether a new user is told how to connect —
 * `applyWelcomeConnect()`, `box.hidden = dismissed || keyConfigured === true` —
 * had no test. A gate that is never executed by a test is a gate that can be
 * edited away without a single red run, which is what this file exists to stop.
 *
 * What is asserted, and why each one is a rule rather than a detail:
 *
 *   1. FRESH INSTALL (no key, nothing stored) → the block is on screen. This is
 *      the whole point of the panel; `hidden` is in the markup, so if the gate
 *      stops running (or stops reaching it) a new install is told nothing and
 *      every other assertion here stays green — this is the one that goes red.
 *   2. `keyConfigured === true` → hidden. Same condition the CLI's
 *      connectNeeded() retires on; a connected install must not be advertised
 *      the routes it already took.
 *   3. The dismiss flag → hidden. And it must be READ, not remembered: the
 *      panel is re-rendered from the template on every New chat, so a flag that
 *      only lived in a module variable would still be 'on' here and the block
 *      would come back on the next one.
 *   4. Clicking #welcome-dismiss persists `aegis.welcomeConnectDismissed`='on'
 *      and the block stays hidden across a New-chat re-render (index.html:
 *      "a welcome panel that reappears on every New chat is an ad, not a
 *      welcome"). The re-render is driven through the real renderWelcome(),
 *      which is what newChat() calls — asserted statically at the end.
 *   5. localStorage throwing → treated as NOT dismissed, block visible. A
 *      locked-down profile (storage disabled by policy) is precisely the case
 *      where the block's advice matters most; failing closed would hide it.
 *   6. The `[hidden]` CSS override, because `hidden` only hides anything if a
 *      rule outranks `.welcome-connect { display:flex }` — the UA stylesheet's
 *      `[hidden] { display:none }` loses to a class selector, so the attribute
 *      this file asserts on is not by itself a guarantee (defect fixed in
 *      3f62b60; re-broken here would be invisible to the JS half).
 *
 * Why the production functions are SLICED out of app.js rather than the whole
 * file booted (the convention established by test/renderer-local-row.test.mjs):
 * app.js is an IIFE that queries ~120 elements and calls init() at load, so it
 * only runs under the Electron host — asserted, not assumed, in
 * test/renderer-dom.test.mjs, which excludes it and checks it statically. So the
 * real `renderWelcome()` / `applyWelcomeConnect()` / `dismissWelcomeConnect()`
 * are loaded as-is (a rename breaks this file loudly — sliceFunction throws),
 * over a fake DOM, and only three things are faked that the browser would
 * provide: the document, localStorage, and `els` (init()'s element cache).
 *
 * The `<template>` markup is NOT hand-copied: the fragment is parsed out of the
 * real index.html, so the ids, the `hidden` default and the button copy under
 * test are the ones that ship. `getElementById` deliberately does not search
 * inside the template — a template's content is inert and not in the document,
 * exactly as in the browser — so the block can only be found there by the real
 * cloneNode-into-the-transcript path that renderWelcome() performs.
 *
 * Documented limits of the fake: no layout, no CSS cascade (hence the explicit
 * style.css assertions above), no real event propagation (a click runs the
 * listeners bound to that node, which is all this code path uses), and
 * `classList`/`dataset` are attribute views rather than token lists.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', 'renderer');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const src = readFileSync(join(rendererDir, 'app.js'), 'utf8');

// ------------------------------------------------- slice the shipping code

/** A top-level `const|let NAME = …;` as written, so the values under test are
 *  the ones that ship rather than a copy that can drift. */
function sliceDecl(name) {
  const m = new RegExp(`^(?:const|let) ${name} = .*$`, 'm').exec(src);
  assert(m, `app.js must declare ${name} (the welcome block reads it)`);
  return m[0];
}

/** A top-level `[async] function name(...) { … }` by brace-at-column-0 end. */
function sliceFunction(name) {
  const at = src.indexOf(`function ${name}(`);
  assert(at >= 0, `app.js must define ${name}()`);
  // Keep the `async` keyword: welcomeByok awaits nothing here but is declared
  // async, and dropping it would fail to parse the very code being asserted on.
  const asyncAt = at - 6;
  const start = asyncAt >= 0 && src.slice(asyncAt, at) === 'async ' ? asyncAt : at;
  const end = src.indexOf('\n}\n', at);
  assert(end > at, `could not find the end of ${name}() in app.js`);
  return src.slice(start, end + 2);
}

// --------------------------------------------------- the fake DOM (minimal)

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
   .replace(/&([a-z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));

/** Matches a start tag, an end tag, a comment or a run of text. The template
 *  fragment is hand-written HTML with quoted attributes, so this is a tag
 *  scanner rather than a spec-complete parser — enough to build the real tree
 *  the browser would build, including the bare `hidden` attribute. */
const TOKEN =
  /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?)*)\s*(\/?)>|[^<]+/g;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this._text = '';
  }
  get id() {
    return this.attrs.get('id') || '';
  }
  get className() {
    return this.attrs.get('class') || '';
  }
  /** An attribute view, like the real reflected property: the template ships
   *  `hidden`, and the gate turns it on and off. */
  get hidden() {
    return this.attrs.has('hidden');
  }
  set hidden(v) {
    if (v) this.attrs.set('hidden', '');
    else this.attrs.delete('hidden');
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (c) => self.setAttribute('class', [...new Set([...list(), c])].join(' ')),
      remove: (c) => self.setAttribute('class', list().filter((x) => x !== c).join(' ')),
      contains: (c) => list().includes(c),
    };
  }
  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) {
      if (k.startsWith('data-')) out[k.slice(5).replace(/-(.)/g, (_, c) => c.toUpperCase())] = v;
    }
    return out;
  }
  get textContent() {
    // A node that was assigned text renders that; otherwise it renders its
    // children, which is what the browser does after a textContent assignment
    // (which detaches them — see the setter).
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this._text = String(v);
    for (const c of this.children) c.parentNode = null;
    this.children = [];
  }
  set innerHTML(v) {
    assert(String(v) === '', `the fake DOM only supports innerHTML = '' (got ${JSON.stringify(v)})`);
    this.textContent = '';
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  // cloneNode copies markup and attributes and NOT listeners — which is the
  // reason renderWelcome() re-binds the three controls on every render, and
  // assertion (d) checks that it does.
  cloneNode() {
    const copy = new FakeNode(this.tagName);
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    copy._text = this._text;
    for (const c of this.children) copy.appendChild(c.cloneNode());
    return copy;
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  /** Run the listeners bound to this node — all a button click needs. */
  dispatchEvent(event) {
    const ev = event || {};
    if (!ev.type) ev.type = 'click';
    if (!ev.target) ev.target = this;
    for (const fn of this.listeners.get(ev.type) || []) fn(ev);
    return ev;
  }
  focus() {
    this.focused = true;
  }
  scrollIntoView() {}
  all() {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  contains(node) {
    return this.all().includes(node);
  }
  querySelectorAll(sel) {
    return this.all().slice(1).filter((el) => matches(el, sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    let node = this;
    while (node && !matches(node, sel)) node = node.parentNode;
    return node;
  }
}

/** Enough of a selector for this code path: `#id`, `.class`, `tag`, or a
 *  compound of them (`button.wc-path`). */
function matches(el, sel) {
  return String(sel)
    .split(/(?=[.#])/)
    .every((part) => {
      if (part.startsWith('#')) return el.id === part.slice(1);
      if (part.startsWith('.')) return el.className.split(/\s+/).includes(part.slice(1));
      return el.tagName === part.toUpperCase();
    });
}

function parseFragment(html) {
  const roots = [];
  const stack = [];
  const push = (node) => (stack.length ? stack[stack.length - 1].appendChild(node) : roots.push(node));
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(html))) {
    const [raw, close, tag, attrs, selfClose] = m;
    if (raw.startsWith('<!--')) continue; // template prose, not markup
    if (close) {
      assert(stack.length, `</${close}> with no open tag in the welcome template`);
      stack.pop();
      continue;
    }
    if (tag) {
      const el = new FakeNode(tag);
      ATTR.lastIndex = 0;
      let a;
      while ((a = ATTR.exec(attrs || ''))) {
        const value = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4];
        el.attrs.set(a[1], value === undefined ? '' : decode(value));
      }
      push(el);
      if (!selfClose && !['br', 'hr', 'img', 'input', 'meta', 'link'].includes(tag.toLowerCase())) {
        stack.push(el);
      }
      continue;
    }
    if (raw.trim() === '') continue; // inter-tag whitespace is not content
    const text = new FakeNode('#text');
    text._text = decode(raw);
    push(text);
  }
  assert(stack.length === 0, 'every tag in the welcome template must be closed');
  return roots;
}

// ------------------------------------ the real <template> out of index.html

const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
const tplMatch = /<template id="welcome-template">([\s\S]*?)<\/template>/.exec(html);
assert(tplMatch, 'index.html must declare <template id="welcome-template">');
const tplRoots = parseFragment(tplMatch[1]).filter((n) => n.tagName !== '#TEXT');
assert(
  tplRoots.length === 1 && tplRoots[0].className.split(/\s+/).includes('chat-welcome'),
  'the template holds exactly one .chat-welcome panel'
);
const TEMPLATE_ROOT = tplRoots[0];

// ------------------------------------------------ realms: the shipping code

/** Build a realm holding the real welcome code plus the fakes. */
function makeRealm({ keyConfigured = null, providerConfigured = null, stored = {}, storage } = {}) {
  const messages = new FakeNode('div'); // els.messages — the transcript host
  const els = {
    messages,
    apiKeyHint: new FakeNode('div'),
    apiKeyInput: new FakeNode('input'),
    settingsList: new FakeNode('div'),
    classSelect: new FakeNode('select'),
    sessionMeter: new FakeNode('div'),
    sessionsHint: new FakeNode('div'),
  };

  // The <template> ELEMENT is in the document (that is how renderWelcome()
  // finds it by id) but its content is inert and separate, so the ids inside
  // the template are unreachable until renderWelcome() clones the fragment into
  // the transcript. That is what makes this test prove the CLONE path rather
  // than a getElementById that happens to find the block anyway.
  const templateEl = new FakeNode('template');
  templateEl.attrs.set('id', 'welcome-template');
  templateEl.content = { cloneNode: () => TEMPLATE_ROOT.cloneNode() };

  const document = {
    roots: [messages, templateEl],
    getElementById(id) {
      for (const root of this.roots) {
        const found = root.all().find((el) => el.id === id);
        if (found) return found;
      }
      return null;
    },
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (t) => {
      const n = new FakeNode('#text');
      n._text = String(t);
      return n;
    },
    addEventListener() {},
    querySelectorAll: (sel) => messages.querySelectorAll(sel),
  };

  const store =
    storage ||
    {
      getItem: (k) => (k in stored ? stored[k] : null),
      setItem: (k, v) => {
        stored[k] = String(v);
      },
      removeItem: (k) => {
        delete stored[k];
      },
    };

  const realm = vm.createContext({
    console,
    document,
    localStorage: store,
    els,
    Event: class FakeEvent {
      constructor(type) {
        this.type = type;
      }
    },
  });

  const code = [
    sliceDecl('WELCOME_DISMISS_KEY'),
    sliceDecl('GET_AEGIS_KEY_URL'),
    sliceDecl('keyConfigured'),
    sliceDecl('providerConfigured'),
    sliceFunction('applyGreeting'),
    sliceFunction('quickAction'),
    sliceFunction('renderWelcome'),
    sliceFunction('applyWelcomeConnect'),
    sliceFunction('revealSidebarCard'),
    sliceFunction('welcomeByok'),
    sliceFunction('welcomeCloud'),
    sliceFunction('renderWelcomeHint'),
    sliceFunction('dismissWelcomeConnect'),
  ].join('\n\n');
  vm.runInContext(code, realm, { filename: 'app.js (welcome connect block)' });

  const setKey = (v) => {
    vm.runInContext(`keyConfigured = ${JSON.stringify(v)}`, realm);
    assert(
      vm.runInContext('keyConfigured', realm) === v,
      `the harness must be able to put keyConfigured in the ${JSON.stringify(v)} state`
    );
  };

  /** The BYOK/local route, as main.js ships it in the status payload. Separate
   *  from setKey on purpose: the bug this pins was the two facts drifting —
   *  the main process computing providerConfigured and the renderer never
   *  reading it. */
  const setProvider = (v) => {
    vm.runInContext(`providerConfigured = ${JSON.stringify(v)}`, realm);
    assert(
      vm.runInContext('providerConfigured', realm) === v,
      `the harness must be able to put providerConfigured in the ${JSON.stringify(v)} state`
    );
  };

  if (keyConfigured !== null) setKey(keyConfigured);
  if (providerConfigured !== null) setProvider(providerConfigured);

  return { realm, document, els, stored, store, setKey, setProvider, messages };
}

/** The block as the user would find it: looked up BY ID in the transcript. */
function connectBox(r) {
  return r.document.getElementById('welcome-connect');
}

function click(r, id) {
  const node = r.document.getElementById(id);
  assert(node, `#${id} must be in the transcript before it can be clicked`);
  node.dispatchEvent({ type: 'click' });
  return node;
}

const VISIBLE = (r, msg) => {
  const box = connectBox(r);
  assert(box, `#welcome-connect must be in the transcript — ${msg}`);
  assert(box.hidden === false, `the connect block must be VISIBLE — ${msg}`);
  assert(!box.hasAttribute('hidden'), `the hidden attribute must be cleared, or CSS keeps it off screen — ${msg}`);
  return box;
};
const HIDDEN = (r, msg) => {
  const box = connectBox(r);
  assert(box, `#welcome-connect must still exist (hidden, not removed) — ${msg}`);
  assert(box.hidden === true, `the connect block must be HIDDEN — ${msg}`);
  return box;
};

// ================================ 1. fresh install: the block reaches screen
{
  const r = makeRealm({}); // keyConfigured null (status not read yet), nothing stored
  assert(connectBox(r) === null, 'the template is inert: the block is not in the document before a render');

  r.realm.renderWelcome();
  const box = VISIBLE(r, 'a fresh install (no key, nothing dismissed)');

  // "On screen" also means it is the real panel with the real controls in it,
  // not an empty div: this is the block the CLI half renders as two rows.
  assert(
    r.messages.contains(box) && box.closest('.chat-welcome'),
    'the block is inside the welcome panel renderWelcome() cloned into the transcript'
  );
  const byok = r.document.getElementById('welcome-byok');
  const cloud = r.document.getElementById('welcome-cloud');
  const skip = r.document.getElementById('welcome-dismiss');
  assert(byok && cloud && skip, 'both connect paths and the dismiss control are on screen');
  assert(byok.textContent.includes('Bring your own key'), 'the BYOK path says what it is');
  assert(cloud.textContent.includes('Connect AEGIS Cloud'), 'the Cloud path says what it is');
  assert(skip.textContent.includes("Don't show this again"), 'and the dismiss control says what it does');
  const why = box.querySelector('.wc-why');
  assert(why && why.querySelectorAll('li').length >= 3, 'and the why-AEGIS list is part of the block');
}

// keyConfigured === false is the same fresh install, with the status read done.
{
  const r = makeRealm({ keyConfigured: false });
  r.realm.renderWelcome();
  VISIBLE(r, 'keyConfigured === false (status read, no key on the machine)');
}

// ============================== 2. a connected install is not advertised to
{
  const r = makeRealm({ keyConfigured: true });
  r.realm.renderWelcome();
  HIDDEN(r, 'keyConfigured === true (a key is configured)');
}

// The late arrival of the truth: renderStatus() calls the gate again, so an
// unknown state that showed the block must retire the moment status lands.
{
  const r = makeRealm({});
  r.realm.renderWelcome();
  VISIBLE(r, 'status not read yet (null keeps it visible)');
  r.setKey(true);
  r.realm.applyWelcomeConnect(); // what renderStatus() does when the read returns
  HIDDEN(r, 'after the status read reports a configured key');
}

// ================= 2b. a route of the user's OWN retires the block as well
//
// The block pitches two ways to connect. keyConfigured covers only one of them
// — a BYOK provider key is written to the provider-settings store and never
// reaches aegis.apiKey — so a user who pasted an OpenAI/Anthropic/DeepSeek key
// (or pointed the app at a local model server) had keyConfigured stay false and
// the block kept re-pitching "Bring your own key" at the person who just did.
// main.js providerRouteConfigured() computes this and ships it as
// `providerConfigured`; these cases exist because the first cut of that fix
// shipped the field on the IPC bridge and left the gate reading keyConfigured
// alone, making it inert while every main-process test stayed green.
{
  const r = makeRealm({ keyConfigured: false, providerConfigured: true });
  r.realm.renderWelcome();
  HIDDEN(r, 'providerConfigured === true with no AEGIS key (BYOK-only install)');
}

{
  const r = makeRealm({ keyConfigured: true, providerConfigured: true });
  r.realm.renderWelcome();
  HIDDEN(r, 'both routes configured');
}

{
  // A local base URL counts as a route (no key, not the AEGIS key) — the other
  // way of answering the block.
  const r = makeRealm({ keyConfigured: false, providerConfigured: true });
  r.realm.renderWelcome();
  HIDDEN(r, 'a local-model base URL, no key at all');
}

{
  const r = makeRealm({ keyConfigured: false, providerConfigured: false });
  r.realm.renderWelcome();
  VISIBLE(r, 'neither route configured — still a fresh install');
}

// The same late-arrival path as above, on the BYOK field: renderStatus() sets
// both and re-runs the gate, so a key pasted while the panel is on screen
// retires it without a reload.
{
  const r = makeRealm({});
  r.realm.renderWelcome();
  VISIBLE(r, 'status not read yet (providerConfigured defaults false)');
  r.setProvider(true);
  r.realm.applyWelcomeConnect();
  HIDDEN(r, 'after the status read reports a BYOK route');
}

// A dismiss is a dismiss: the stored flag outranks a route that is configured.
{
  const stored = { 'aegis.welcomeConnectDismissed': 'on' };
  const r = makeRealm({ stored, keyConfigured: false, providerConfigured: true });
  r.realm.renderWelcome();
  HIDDEN(r, 'dismissed AND configured stays hidden');
}

{
  const stored = { 'aegis.welcomeConnectDismissed': 'on' };
  const r = makeRealm({ stored });
  r.realm.renderWelcome();
  HIDDEN(r, 'a stored dismiss flag');
}

// =============== 4. the dismiss click, and the New-chat re-render after it
{
  const stored = {};
  const r = makeRealm({ stored });
  r.realm.renderWelcome();
  const first = VISIBLE(r, 'a fresh install');
  const before = r.document.getElementById('welcome-dismiss');
  click(r, 'welcome-dismiss');

  assert(
    stored['aegis.welcomeConnectDismissed'] === 'on',
    "clicking #welcome-dismiss must persist aegis.welcomeConnectDismissed='on'"
  );
  HIDDEN(r, 'immediately after the dismiss click');

  // New chat: newChat() clears the transcript and calls renderWelcome(), which
  // clones the template again — a brand new node with `hidden` in its markup.
  r.realm.renderWelcome();
  const after = r.document.getElementById('welcome-dismiss');
  assert(after !== before, 'the re-render must clone a new panel (otherwise this proves nothing)');
  const second = HIDDEN(r, 'a New chat after the dismiss');
  assert(
    r.messages.contains(second),
    'the re-rendered block is in the transcript and hidden by the flag, not by a stale node'
  );
  assert(
    after.listeners.get('click').length === 1,
    'the fresh clone has exactly one dismiss listener (cloneNode copies no listeners)'
  );
  // And the flag is what hides it: with the same realm but no stored value the
  // same render shows it (the comparison is the assertion).
  const control = makeRealm({});
  control.realm.renderWelcome();
  VISIBLE(control, 'the same re-render without the flag');
}

// =============== 5. storage disabled: fail OPEN, and only for this session
{
  // getItem throws — a profile with storage disabled by policy.
  const r = makeRealm({ storage: { getItem() { throw new Error('storage disabled'); }, setItem() {} } });
  r.realm.renderWelcome();
  VISIBLE(r, 'localStorage.getItem throwing is treated as not dismissed');
}

{
  // setItem throws: the block still goes away for this session (that is the
  // click's contract) and nothing is persisted, so it comes back next launch.
  const r = makeRealm({ storage: { getItem: () => null, setItem() { throw new Error('storage disabled'); } } });
  r.realm.renderWelcome();
  VISIBLE(r, 'storage writable-read/no');
  click(r, 'welcome-dismiss');
  HIDDEN(r, 'the click still hides the block when the write fails');
  const next = makeRealm({});
  next.realm.renderWelcome();
  VISIBLE(next, 'and the next launch shows it again, since nothing was stored');
}

// ==================== 6. `hidden` is only hidden if CSS agrees (3f62b60)
{
  const css = readFileSync(join(rendererDir, 'style.css'), 'utf8');
  const flex = /\.welcome-connect\s*\{[^}]*display:\s*flex/.test(css);
  assert(flex, '.welcome-connect is a flex container — which is why it outranks the UA [hidden] rule');
  const override = /\.welcome-connect\[hidden\]\s*\{[^}]*display:\s*none/.test(css);
  assert(
    override,
    '.welcome-connect[hidden] { display: none } must exist, or the attribute this file asserts on hides nothing'
  );
  // .flash is added by revealSidebarCard() for 1.2s after a welcome click; with
  // no rule at all the landing spot a click scrolls to was never marked.
  assert(/\.flash\s*\{/.test(css), 'and .flash must be styled, since a welcome click adds it');
}

// ============================== 7. the wiring this behaviour depends on
{
  // The re-render this file drives is the real New-chat path only if newChat()
  // still calls renderWelcome().
  const newChatAt = src.indexOf('function newChat()');
  assert(newChatAt > 0, 'app.js must define newChat()');
  const body = src.slice(newChatAt, src.indexOf('\n}\n', newChatAt));
  assert(/renderWelcome\(\)/.test(body), 'newChat() must render the welcome panel (the re-render under test)');
  // And the three controls are bound in renderWelcome() — an unbound
  // #welcome-dismiss would make the click above a no-op in the app.
  const rwAt = src.indexOf('function renderWelcome(');
  const rw = src.slice(rwAt, src.indexOf('\n}\n', rwAt));
  for (const [id, fn] of [
    ['welcome-byok', 'welcomeByok'],
    ['welcome-cloud', 'welcomeCloud'],
    ['welcome-dismiss', 'dismissWelcomeConnect'],
  ]) {
    assert(rw.includes(`'${id}'`) && rw.includes(fn), `renderWelcome() must bind #${id} to ${fn}()`);
  }
  // The dismiss copy in index.html is what the button shows; the key name it
  // writes lives in app.js, and the two must not drift apart from the test.
  assert(
    sliceDecl('WELCOME_DISMISS_KEY').includes("'aegis.welcomeConnectDismissed'"),
    'the dismiss key stays aegis.welcomeConnectDismissed (the flag older installs already wrote)'
  );
}

console.log('renderer-welcome.test.mjs: ok');
