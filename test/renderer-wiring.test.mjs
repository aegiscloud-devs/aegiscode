#!/usr/bin/env node
/**
 * Wiring guard for desktop/renderer/*.
 *
 * `node --check` proves a file parses; it cannot see an undefined global. That
 * is exactly how stream-policy.js shipped unwired: app.js called shouldFollow()
 * while index.html never loaded the file, so the renderer threw a
 * ReferenceError on the first message paint and the syntax check stayed green.
 *
 * This asserts:
 *   1. every renderer/*.js is loaded by some *.html entry point (no orphan);
 *   2. each entry point loads only its own scripts (index.html vs quick.html);
 *   3. a script is always loaded before the scripts that consume its globals —
 *      including a renderer script consuming another renderer script, which is
 *      how transcript-view.js depends on stream-policy.js;
 *   4. the specific wiring the transcript policy depends on, so an
 *      "Escape is unbound" or "the veto moved back into app.js" edit fails here
 *      as well as behaviourally in renderer-dom.test.mjs.
 *
 * The behavioural half lives in test/renderer-dom.test.mjs (rafPainter
 * coalescing, follow-only-at-tail, Escape → stopPendingTurn). This file is the
 * static half: it is what fails when a script tag goes missing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const rendererDir = join(here, '..', 'desktop', 'renderer');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
const quickHtml = readFileSync(join(rendererDir, 'quick.html'), 'utf8');

// Script tags in document order — classic scripts execute in this order, so
// order is what decides whether a global exists at call time.
const scriptSrcs = (src) => [...src.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const loaded = scriptSrcs(html);
assert(loaded.length > 0, 'index.html loads at least one script');

// Local (non-vendor) scripts, in load order.
const localLoaded = loaded.filter((s) => !s.startsWith('vendor/'));

// ---------------------------------------------------------- 1. no orphan files
// A renderer/*.js that no entry point loads is dead code at best, and an
// unwired dependency at worst. There are two windows — index.html (main) and
// quick.html (the launcher) — each with its own script list, so the orphan
// check spans every *.html in the directory while the order rules below apply
// to index.html specifically.
const htmlFiles = readdirSync(rendererDir).filter((f) => f.endsWith('.html'));
assert(htmlFiles.includes('index.html'), 'index.html is present');
assert(htmlFiles.includes('quick.html'), 'quick.html is present');

const loadedAnywhere = new Set();
for (const f of htmlFiles) {
  for (const src of scriptSrcs(readFileSync(join(rendererDir, f), 'utf8'))) loadedAnywhere.add(src);
}

const onDisk = readdirSync(rendererDir).filter((f) => f.endsWith('.js'));
const orphans = onDisk.filter((f) => !loadedAnywhere.has(f));
assert(
  orphans.length === 0,
  `renderer/*.js loaded by no *.html entry point (unwired module): ${orphans.join(', ')}`
);

// Every loaded local script must exist.
for (const src of localLoaded) {
  assert(onDisk.includes(src), `index.html loads renderer/${src}, which does not exist`);
}

// --------------------------------------------------- 2. one script, one window
// quick.js belongs to quick.html, the second window entry point. Loading it in
// the main window (or leaving it out of the quick window) has already shipped
// once as a launch-crashing regression, so the ownership is explicit.
assert(
  loadedAnywhere.has('quick.js'),
  'quick.js must be loaded by an entry point (quick.html)'
);
assert(
  !loaded.includes('quick.js'),
  'index.html must not load quick.js — it belongs to quick.html, the launcher window'
);
assert(
  scriptSrcs(quickHtml).includes('quick.js'),
  'quick.html loads quick.js'
);

// ------------------------------------------------- 3. load order before app.js
const appIdx = loaded.indexOf('app.js');
assert(appIdx !== -1, 'index.html loads app.js');
assert(
  appIdx === loaded.length - 1,
  `app.js must be the last script, found ${loaded.slice(appIdx + 1).join(', ')} after it`
);

// ------------------------------------------------- 4. globals resolve at call time
// Top-level declarations of a classic script become globals (and share one
// global lexical environment with every other script on the page). Collect them
// per file so we can tell which script must be loaded first.
//
// Two things this has to get right, or the check cries wolf:
//   - a file whose whole body is an IIFE (app.js) declares *no* globals — its
//     `const aegis`/`let transcript` live in a function scope;
//   - comments name these symbols all the time ("the rule itself is
//     `shouldFollow`…"), so both declaration scanning and reference scanning run
//     on comment-stripped source.
const DECL = /^(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
const IIFE = /^\s*(?:\(\s*function|!\s*function|\(\s*\(\s*\)\s*=>)/;

/** Strip // and /* *\/ comments, leaving string/regex literals intact. */
function stripComments(code) {
  let out = '';
  let i = 0;
  let prev = ''; // last significant character, to tell a regex from division
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === '/' && n === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i += 1;
      while (i < code.length) {
        if (code[i] === '\\') {
          out += code[i] + (code[i + 1] || '');
          i += 2;
          continue;
        }
        out += code[i];
        if (code[i] === c) {
          i += 1;
          break;
        }
        i += 1;
      }
      prev = c;
      continue;
    }
    if (c === '/' && /[=(,:;[!&|?{}]/.test(prev || '')) {
      // Regex literal: skip to the unescaped closing slash.
      out += c;
      i += 1;
      while (i < code.length && code[i] !== '/') {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      out += code[i] || '';
      i += 1;
      prev = '/';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

const code = new Map(); // file -> comment-stripped source
for (const src of localLoaded) code.set(src, stripComments(readFileSync(join(rendererDir, src), 'utf8')));

const declaredBy = new Map(); // name -> first file that declares it globally
for (const src of localLoaded) {
  const body = code.get(src);
  // A leading 'use strict'; prologue (app.js) precedes the wrapper.
  const head = body.replace(/^\s*['"]use strict['"]\s*;?/, '');
  if (IIFE.test(head)) continue; // scoped wrapper: nothing reaches the global env
  for (const m of body.matchAll(DECL)) {
    if (!declaredBy.has(m[1])) declaredBy.set(m[1], src);
  }
}

/** Reference to `name` in `body`, bounded so `nearBottomX`/`a.nearBottom` don't count. */
const references = (body, name) => new RegExp(`(^|[^\\w$.])${name}\\b`).test(body);

// Every consumer of a cross-file global must be loaded after its declaration.
// This generalises the original app.js-only rule: renderer scripts consume each
// other too (transcript-view.js calls stream-policy.js's shouldFollow).
const missing = [];
for (const src of localLoaded) {
  const body = code.get(src);
  for (const [name, file] of declaredBy) {
    if (file === src) continue;
    if (!references(body, name)) continue;
    if (loaded.indexOf(file) > loaded.indexOf(src)) {
      missing.push(`${name} (declared in ${file}) used by ${src}`);
    }
  }
}
assert(
  missing.length === 0,
  `renderer scripts use globals from a script loaded after them: ${missing.join(', ')}`
);

const appCode = code.get('app.js');
const streamPolicyCode = code.get('stream-policy.js');

// The specific dependency that shipped broken: the streaming decisions must be
// declared by stream-policy.js, loaded before the scripts that call them.
for (const name of ['nearBottom', 'shouldFollow', 'isCancellation']) {
  assert(declaredBy.get(name) === 'stream-policy.js', `${name} is declared by stream-policy.js`);
  assert(
    loaded.indexOf('stream-policy.js') < appIdx,
    `stream-policy.js must load before app.js (${name})`
  );
}
assert(
  references(code.get('transcript-view.js'), 'shouldFollow') &&
    references(code.get('transcript-view.js'), 'nearBottom'),
  'transcript-view.js must call stream-policy.js decisions (shouldFollow/nearBottom), not reimplement them'
);

// Phase 8 extraction: the DOM half of the streaming policy. It must be loaded
// by index.html, ahead of app.js, and app.js must actually call into it —
// otherwise the behavioural tests in renderer-dom.test.mjs prove nothing about
// the shipped renderer.
assert(declaredBy.get('createTranscriptView') === 'transcript-view.js', 'createTranscriptView is declared by transcript-view.js');
assert(declaredBy.get('bindEscapeInterrupt') === 'transcript-view.js', 'bindEscapeInterrupt is declared by transcript-view.js');
assert(onDisk.includes('transcript-view.js'), 'transcript-view.js is on disk');
for (const name of ['createTranscriptView', 'bindEscapeInterrupt']) {
  assert(
    loaded.indexOf('transcript-view.js') < appIdx,
    `transcript-view.js must load before app.js (${name})`
  );
  assert(references(appCode, name), `app.js actually calls ${name}`);
}

// ------------------------------------------------- 5. the two symptom guards
// 5a. Escape → stopPendingTurn. The listener itself lives in transcript-view.js
//     and is asserted behaviourally; here we pin the wiring app.js hands it, so
//     pointing Escape at something else (or at nothing) cannot pass silently.
assert(
  /bindEscapeInterrupt\(\{/.test(appCode),
  'app.js binds the Escape interrupt'
);
assert(
  /stopTurn:\s*stopPendingTurn\b/.test(appCode),
  'Escape must reach stopPendingTurn — the same call the cancel button makes'
);
assert(
  /hasPendingTurn:\s*\(\)\s*=>\s*!!pendingSessionId/.test(appCode),
  'Escape only interrupts a turn that is actually pending'
);
assert(
  /isOverlayOpen:\s*overlayOpen\b/.test(appCode),
  'the memory overlay keeps precedence over Escape-as-interrupt'
);
// A deliberate stop must stay distinguishable from a failure, or the abort the
// user asked for is reported as an error and the partial answer is discarded.
// The stop is scoped to the turn it was asked of. A global flag could be left
// `true` by an earlier turn — making an unrelated transport failure later look
// like a stop the user asked for — and a second press during teardown would
// re-enter the abort. Both are one token comparison now.
assert(
  /function stopPendingTurn\(\)[\s\S]*?stopAppliesTo\(runningTurn,\s*stoppedTurn\)[\s\S]*?stoppedTurn\s*=\s*runningTurn[\s\S]*?models\.cancel\(/.test(appCode),
  'stopPendingTurn gates on stopAppliesTo and records stoppedTurn before aborting the transport'
);
assert(
  /isCancellation\(err,\s*\{\s*userStopped:\s*stoppedTurn\s*===\s*myTurn\s*\}\)/.test(appCode),
  "send()'s catch classifies the abort against this turn's token, not a global"
);
assert(
  /const myTurn\s*=\s*\+\+turnSeq;[\s\S]*?runningTurn\s*=\s*myTurn;[\s\S]*?stoppedTurn\s*=\s*null;/.test(appCode),
  'send() claims its own turn token, clearing any stale stop from a previous turn'
);
assert(
  /finally\s*\{[\s\S]*?if\s*\(runningTurn\s*===\s*myTurn\)/.test(appCode),
  'the teardown only clears the pending state the turn still owns'
);

// 5b. The reader's veto. It must be registered by transcript-view.js
//     (attachScrollVeto → a passive scroll listener) and not re-implemented or
//     bypassed in app.js: a second scroll listener with its own copy of the
//     flag is how the veto silently stops applying.
assert(
  /\btranscript\.attachScrollVeto\(/.test(appCode),
  'app.js installs the scroll veto via transcript.attachScrollVeto()'
);
assert(
  !/addEventListener\(\s*'scroll'/.test(appCode),
  "app.js must not register its own 'scroll' listener — the veto lives in transcript-view.js"
);
assert(
  !/\buserScrolledUp\b/.test(appCode),
  'app.js must not carry its own userScrolledUp flag — it lives in transcript-view.js'
);
assert(
  /createTranscriptView\(\{[\s\S]*?messages:\s*els\.messages[\s\S]*?requestFrame:/.test(appCode),
  'the transcript view is built with the real transcript element and the window frame clock'
);

// 5c. The default class with no key: the connect step. Aegis Cloud is what a
//     fresh install lands on, and its catalog call is key-gated (401 without a
//     key — engine.listModels reports that as `needsKey` instead). The hint
//     that unblocks the user carries a real <a>, so it has to be built as a
//     child node: assigning the string to textContent after appending would
//     wipe the link and leave a dead "free key at aegiscloud.org" sentence —
//     the same shape as the capNotice footgun documented in app.js.
assert(
  /data\.needsKey|needsKey\s*=\s*Boolean\(data\s*&&\s*data\.needsKey\)/.test(appCode),
  'the renderer consumes the engine\'s needsKey state (a keyless catalog is not an error)'
);
assert(
  /document\.createElement\('a'\)[\s\S]{0,400}?GET_AEGIS_KEY_URL[\s\S]{0,200}?appendChild/.test(appCode),
  'the connect hint appends a real anchor to GET_AEGIS_KEY_URL rather than leaving an href in text'
);
assert(
  /const GET_AEGIS_KEY_URL = 'https:\/\/aegiscloud\.org\/key\?s=desktop&c=key_prompt'/.test(appCode),
  'the key URL has one definition (no drift to a second page)'
);

// 5d. The replay guard. This is the guard that exists because of THIS file's
//     own premise: `replayableContent`/`isPlaceholderContent` were written into
//     stream-policy.js, documented at length, and then never exported and never
//     called — so the cancel loop they describe stayed live and every check
//     here stayed green. A helper that is defined but unreferenced is
//     indistinguishable from a fix that was never made, so it is pinned twice:
//     behaviourally (stream-policy.test.mjs) and statically here.
assert(
  references(streamPolicyCode, 'replayableContent') &&
    references(streamPolicyCode, 'isPlaceholderContent') &&
    references(streamPolicyCode, 'replayHistory'),
  'stream-policy.js defines the replay helpers'
);
assert(
  /module\.exports\s*=\s*\{[\s\S]*?\breplayableContent\b[\s\S]*?\bisPlaceholderContent\b[\s\S]*?\breplayHistory\b/.test(
    streamPolicyCode
  ),
  'and exports them — an unexported helper cannot be called from app.js, which is how this shipped dead'
);
assert(
  /threadMessages\.push\(\{\s*role:\s*'assistant',\s*content:\s*replayContent\s*\}\)/.test(appCode),
  "the stop path pushes the annotation into the replayed history, not the salvaged prose"
);
assert(
  /const replayContent\s*=\s*replayableContent\(salvage\.kind,\s*text\)/.test(appCode),
  'the annotation is derived from the salvage kind, so the two cannot drift'
);
assert(
  /content:\s*replayContent,/.test(appCode),
  'the stopped row is STORED annotated — openSession replays stored rows, so the raw prose would come back with the window'
);
assert(
  /threadMessages\s*=\s*replayHistory\(msgs\)/.test(appCode),
  'openSession builds the replay through replayHistory — the reopen half of the same loop'
);
// The replay path is shared, not written twice: both entry points (a reopened
// session and a live thread) must go through the one function that strips the
// annotations AND keeps the roles alternating. Moving a `.slice()` back to the
// live path is how the adjacent-`user` regression would return, silently, with
// every other check here still green.
assert(
  /const historyForModel\s*=\s*replayHistory\(threadMessages\)/.test(appCode),
  'the live snapshot is folded too, not a bare slice — two `user` rows in a row are a provider 400'
);
assert(
  !/const historyForModel\s*=\s*threadMessages\.slice\(\)/.test(appCode),
  'and the bare slice that caused it is gone'
);
// The screen and the history are separate strings: the bubble must keep the
// salvaged prose (addMessage is called with `text`, not `replayContent`), or a
// cancelled turn renders as a bubble reading "(stopped: reasoning only)" and
// the deliberation the user asked to keep is thrown away.
assert(
  /addMessage\('assistant',\s*text,\s*stopBits\.join\(' · '\),\s*sessionId,\s*toolLog\)/.test(appCode),
  'the transcript bubble still shows the salvaged prose while the history gets the annotation'
);
// Scoped to the STOP path, not the whole file: the success path pushes `text`
// too, inside its own isPlaceholderContent guard, and a file-wide "no raw push"
// check would flag it. What must never happen is the stop path pushing the
// salvaged prose — that string IS the unfinished deliberation.
assert(
  /const salvage\s*=\s*salvageTurn\(\{[\s\S]*?\}\)[\s\S]*?const replayContent\s*=[\s\S]*?threadMessages\.push\(\{\s*role:\s*'assistant',\s*content:\s*replayContent\s*\}\)[\s\S]*?const turn\s*=\s*turnAccounting\(undefined/.test(
    appCode
  ),
  'the stop path pushes the annotation and never the raw salvage text'
);

// 5e. The live-meter cadence gate. `renderRollMeter(…, {live})` re-estimates
//     the WHOLE accumulated stream, and this call site runs inside the rAF
//     painter — so ungated it is linear per frame, i.e. quadratic over the
//     turn, on the thread the reader is scrolling (measured: 7.7ms a frame at
//     400k chars, 46% of a 60fps budget). Same failure mode as 5d: the decision
//     can be correct and still buy nothing if the call site does not consult
//     it, and `node --check` cannot see that.
assert(
  references(streamPolicyCode, 'liveMeterDue'),
  'stream-policy.js defines liveMeterDue'
);
assert(
  /module\.exports\s*=\s*\{[\s\S]*?\bliveMeterDue\b/.test(streamPolicyCode),
  'and exports it — the renderer loads it as a global off the script tag'
);
assert(
  /module\.exports\s*=\s*\{[\s\S]*?\bLIVE_METER_GROWTH_FRACTION\b/.test(streamPolicyCode),
  'the growth fraction the rule promises is exported with it, so the test asserts against the real number'
);
// The gate has to be BETWEEN the call and the paint, and the measured figure
// has to be updated at the same moment — otherwise the guard compares the
// stream against a cursor that never advances either, and the meter either
// freezes (never due) or re-estimates every frame anyway (always due).
assert(
  /if\s*\(\s*liveMeterDue\(meterChars,\s*streamChars\)\s*\)\s*\{[\s\S]{0,120}?meterChars\s*=\s*streamChars;[\s\S]{0,200}?renderRollMeter\(sessionId,\s*\{/.test(
    appCode
  ),
  'the painter consults liveMeterDue before re-estimating, and advances meterChars when it does'
);
assert(
  /const streamChars\s*=\s*streamedText\.length\s*\+\s*reasoningText\.length/.test(appCode),
  'the gate measures the same text the estimate does — answer plus reasoning trace'
);
// Per-turn, not module scope: a shared cursor would carry one turn's length
// into the next, so a fresh turn whose reply is shorter than the last one's
// would never come due and the meter would sit frozen on the previous total.
// Asserted by LOCALITY, not by the declaration's text — a bare
// /let meterChars = 0;/ matches a module-scope hoist just as happily (probe
// confirmed: hoisting it to the top of app.js left that form green). It has to
// sit inside `send()`, between the per-turn stream buffers it measures and the
// painter that reads it.
assert(
  /const toolLog = \[\];[\s\S]{0,400}?let meterChars = 0;[\s\S]{0,600}?const paintStream = rafPainter\(/.test(
    appCode
  ),
  'the cursor is declared per turn inside send(), between the stream buffers and the painter'
);
assert(
  !/renderRollMeter\(sessionId,\s*\{[^}]*\}\);/.test(
    appCode.replace(/if\s*\(\s*liveMeterDue\(meterChars,\s*streamChars\)\s*\)[\s\S]{0,400}?\n\s*\}/, '')
  ),
  'the live re-estimate is not also called ungated somewhere else in the painter'
);

console.log(
  `renderer wiring tests passed (${localLoaded.length} local scripts, ` +
    `${declaredBy.size} globals, no orphans, transcript policy wired, meter cadence wired)`
);
