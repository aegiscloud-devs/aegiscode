/**
 * Mouse marking (text selection) — the drag-to-copy gesture.
 *
 * The TUI owns the alternate screen, so neither the terminal's scrollback nor
 * its own drag-to-select can reach a single painted cell: both are answered by
 * the SGR mouse stream (events.js) and rebuilt against the grid the last frame
 * painted (chatflow.js keeps it as `frameLines`). These cases pin the contracts
 * that rebuild depends on, each of which fails visibly if broken:
 *
 *   - cell columns, not string indices: a selection edge must fall on a whole
 *     code point, or one wide glyph shifts every later column by one and the
 *     copy silently loses half a character (sliceLine).
 *   - reading order: dragging up/left has to copy the same text as down/right
 *     (selectionRange).
 *   - clipboard shape: rows are padded to the full width, so an untrimmed copy
 *     arrives with ~200 trailing spaces per line (selectionText).
 *   - the gesture split: with DECSET 1002 the SAME press can end as a click or
 *     a marking, so the press alone doesn't say which (parseSgrMouse). The
 *     plugin previously named only left presses and returned null for drags and
 *     releases, which made every sweep arrive as a single cell — copyable text
 *     looked marked but nothing reached the clipboard.
 *
 * Ported from aegiscodex-dev/tests/marking.test.js so both hosts mark
 * identically, with the source-level assertions the plugin needs because its
 * gesture resolver lives inside chatflow's session loop and can't be imported.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliDir = join(here, '..', 'cli');
const require = createRequire(import.meta.url);

const screen = require(join(cliDir, 'src', 'screen.js'));
const events = require(join(cliDir, 'src', 'events.js'));
const { C } = require(join(cliDir, 'src', 'theme.js'));

const {
  span, w, lineWidth, padLine,
  selectionRange, sliceLine, selectionText, applySelection,
  SELECT_ON, SELECT_OFF,
} = screen;

const text = (line) => line.map((sp) => sp.t).join('');
const styled = (line) => line.map((sp) => sp.s + sp.t).join('');

// ── the range ────────────────────────────────────────────────────────────────

test('selectionRange normalizes both drag directions', () => {
  const a = { row: 1, col: 4 };
  const b = { row: 3, col: 2 };
  assert.deepEqual(selectionRange(a, b), { startRow: 1, startCol: 4, endRow: 3, endCol: 2 });
  assert.deepEqual(selectionRange(b, a), { startRow: 1, startCol: 4, endRow: 3, endCol: 2 });

  // Same row: reading order is left-to-right whichever way it was swept.
  assert.deepEqual(selectionRange({ row: 2, col: 9 }, { row: 2, col: 3 }), {
    startRow: 2, startCol: 3, endRow: 2, endCol: 9,
  });
  // A zero-length marking is still a valid range (it is the click case).
  assert.deepEqual(selectionRange(a, a), { startRow: 1, startCol: 4, endRow: 1, endCol: 4 });
});

// ── the cell-exact slice ─────────────────────────────────────────────────────

test('sliceLine cuts on cell boundaries and keeps each span’s own style', () => {
  const line = [span(C.red, 'abc'), span('', 'def')];
  assert.equal(text(sliceLine(line, 1, 5)), 'bcde');
  assert.deepEqual(sliceLine(line, 1, 5).map((sp) => sp.s), [C.red, '']);
  // Entirely outside the range in either direction.
  assert.deepEqual(sliceLine(line, 6, 9), []);
  assert.deepEqual(sliceLine(line, 0, 0), []);
  assert.equal(text(sliceLine(line, 0, 99)), 'abcdef');
});

test('sliceLine never splits a wide glyph', () => {
  const line = [span('', '日本')]; // 4 cells
  assert.equal(w('日'), 2);
  // A selection edge landing inside a wide glyph drops it rather than copying
  // half of it (and rather than shifting the columns that follow).
  assert.equal(text(sliceLine(line, 0, 1)), '');
  assert.equal(text(sliceLine(line, 1, 4)), '本');
  assert.equal(text(sliceLine(line, 0, 2)), '日');
  assert.equal(text(sliceLine(line, 0, 4)), '日本');
  // The clipped spans re-measure to the cells they actually cover.
  assert.equal(lineWidth(sliceLine(line, 0, 2)), 2);
});

// ── the clipboard text ───────────────────────────────────────────────────────

test('selectionText joins rows with newlines, trimming padding and blank edges', () => {
  const lines = [
    [span('', 'hello world   ')], // rows are padded to the terminal width
    [span('', 'second row here')],
    [span('', '              ')],
  ];
  // To the end of the second row.
  assert.equal(
    selectionText(lines, { startRow: 0, startCol: 0, endRow: 1, endCol: 15 }),
    'hello world\nsecond row here',
  );
  // Mid-row on both ends, including a partial last row.
  assert.equal(
    selectionText(lines, { startRow: 0, startCol: 6, endRow: 1, endCol: 3 }),
    'world\nsec',
  );
  // A range that reaches into the blank tail: the empty rows are dropped, so
  // the copy doesn't end in a stack of newlines.
  assert.equal(
    selectionText(lines, { startRow: 0, startCol: 0, endRow: 2, endCol: 5 }),
    'hello world\nsecond row here',
  );
  // Marking only padding copies nothing at all.
  assert.equal(selectionText(lines, { startRow: 2, startCol: 0, endRow: 2, endCol: 14 }), '');
  // Rows past the painted grid are blank, not an error (a drag can outrun the
  // frame it started on).
  assert.equal(selectionText(lines, { startRow: 3, startCol: 0, endRow: 4, endCol: 9 }), '');
});

// ── the painted marking ──────────────────────────────────────────────────────

test('applySelection inverts exactly the marked cells and nothing else', () => {
  const lines = [[span('', 'hi')]];
  const out = applySelection(lines, { startRow: 0, startCol: 0, endRow: 0, endCol: 2 }, 10);
  // Reverse video wraps the selection, SELECT_OFF restores the row's tail —
  // paint() only resets attributes at the start of a row, so a missing OFF
  // would wash out every cell after the selection on that line.
  assert.equal(styled(out[0]), `${SELECT_ON}hi${SELECT_OFF}        `);
  assert.equal(text(out[0]), 'hi        '); // padding, but no added glyphs
  assert.equal(lineWidth(out[0]), 10); // the marking adds no width
  // The two markers are zero-width spans, so padding/truncation can't drop the
  // text between them (padLine measures spans, not escape codes).
  assert.deepEqual(padLine(out[0], 10).map((sp) => sp.t).join(''), 'hi        ');
});

test('applySelection pads a short row so the sweep paints over blank cells', () => {
  // A row is only as long as its text, but the reader drags across the empty
  // cells to its right — those cells must invert too or the marking looks
  // truncated at the end of the text.
  const lines = [[span('', 'ab')]];
  const out = applySelection(lines, { startRow: 0, startCol: 0, endRow: 0, endCol: 6 }, 8);
  const marked = out[0].filter((sp) => sp.s === SELECT_ON).length;
  assert.equal(marked, 1);
  const beforeOff = styled(out[0]).split(SELECT_OFF)[0];
  assert.equal(beforeOff.replace(SELECT_ON, ''), 'ab    '); // 2 cells of text + 4 of padding
});

test('applySelection shares untouched rows and clones only the marked ones', () => {
  const lines = [[span('', 'a')], [span('', 'b')], [span('', 'c')]];
  const out = applySelection(lines, { startRow: 1, startCol: 0, endRow: 1, endCol: 1 }, 5);
  assert.equal(out[0], lines[0]); // same object — a sweep repaints ~30x/sec
  assert.equal(out[2], lines[2]);
  assert.notEqual(out[1], lines[1]);
  assert.ok(styled(out[1]).includes(SELECT_ON));
  assert.equal(styled(out[0]).includes(SELECT_ON), false);
});

test('applySelection keeps the styles under the marking (a diff block stays colored)', () => {
  const lines = [
    [span(C.green, '+added'), span('', ' tail')],
    [span(C.red, '-gone')],
  ];
  const out = applySelection(lines, { startRow: 0, startCol: 0, endRow: 1, endCol: 5 }, 12);
  // The inversion opens first and the slice's own color follows, so the marked
  // cells keep their color and add inversion on top.
  assert.ok(styled(out[0]).startsWith(`${SELECT_ON}${C.green}+added`));
  // That only works because a palette color never carries its own reset: an
  // `\x1b[0m` inside a span style would clear SELECT_ON the moment the marked
  // text painted. Asserted against the palette itself, not one code, so a new
  // color built as `${RESET}...` fails here instead of in the terminal.
  for (const [name, code] of Object.entries(C)) {
    assert.equal(code.includes('\x1b[0m'), false, `C.${name} must not reset`);
  }
  const row1 = styled(out[1]);
  assert.ok(row1.includes(`${C.red}${SELECT_ON}`) || row1.startsWith(`${SELECT_ON}${C.red}-gone`));
  assert.ok(row1.includes('-gone'));
});

// ── the wire decoder (events.js) ─────────────────────────────────────────────

test('parseSgrMouse names the three stages the gesture resolver branches on', () => {
  // The whole reason the plugin's marking was dead: only the press was named,
  // so a sweep's motion reports fell through to the ordinary CSI decoder and
  // every marking collapsed to the single cell under the press.
  assert.equal(events.parseSgrMouse('\x1b[<0;1;1M').name, 'click');   // press
  assert.equal(events.parseSgrMouse('\x1b[<32;6;2M').name, 'drag');   // motion bit
  assert.equal(events.parseSgrMouse('\x1b[<0;6;2m').name, 'release'); // SGR terminator
  // The X10-style release some terminals and multiplexers still send.
  assert.equal(events.parseSgrMouse('\x1b[<3;6;2M').name, 'release');

  // Scroll wheel, and right/middle buttons, are not ours: null makes the
  // caller fall through to the CSI decoder, which ignores them — so stray
  // mouse bytes can't type into the editor or abort a turn.
  assert.equal(events.parseSgrMouse('\x1b[<64;1;1M'), 'up');
  assert.equal(events.parseSgrMouse('\x1b[<65;1;1M'), 'down');
  assert.equal(events.parseSgrMouse('\x1b[<2;1;1M'), null);
  assert.equal(events.parseSgrMouse('\x1b[<1;1;1M'), null);
  assert.equal(events.parseSgrMouse('\x1b[A'), null);
});

test('press → sweep → release copies the swept text (the wiring chatflow does)', () => {
  // Reproduce chatflow's resolution over the real parser: a press is deferred,
  // the sweep moves the head, the release copies.
  const frame = [
    [span('', 'hello world')],
    [span('', 'second row here')],
    [span('', 'third')],
  ];
  const press = events.parseSgrMouse('\x1b[<0;1;1M');  // grid cell 0,0
  const sweep = events.parseSgrMouse('\x1b[<32;6;2M'); // dragged to grid 5,1
  const up = events.parseSgrMouse('\x1b[<0;6;2m');     // release there

  assert.equal(press.name, 'click');
  assert.equal(sweep.name, 'drag');
  assert.equal(up.name, 'release');

  let pending = null;
  let mark = null;
  const cell = (k) => ({ col: k.col - 1, row: k.row - 1 });
  for (const k of [press, sweep, up]) {
    if (k.name === 'click') pending = cell(k);
    else if (k.name === 'drag') {
      mark = mark ? { anchor: mark.anchor, head: cell(k) } : { anchor: pending, head: cell(k) };
      pending = null;
    }
  }
  assert.deepEqual(mark, { anchor: { col: 0, row: 0 }, head: { col: 5, row: 1 } });
  assert.equal(selectionText(frame, selectionRange(mark.anchor, mark.head)), 'hello world\nsecon');
});

test('the wire coordinates are 1-based and grid rows are 0-based', () => {
  // A press on the first painted row (grid row 0) is SGR row 1.
  const press = events.parseSgrMouse('\x1b[<0;1;1M');
  assert.equal(press.row - 1, 0);
  assert.equal(press.col - 1, 0);
});

// ── the wiring the pure tests can't reach ────────────────────────────────────

test('chatflow routes all three gesture stages through one resolver', () => {
  // chatflow.js owns the gesture resolver inside the session loop, so it can't
  // be imported and driven here. These assertions are the guard instead: the
  // bug being pinned is that only `key.name === 'click'` was handled, at both
  // the mid-turn and idle-prompt dispatch sites, so a drag-to-mark resolved
  // nowhere and the *release* fell through to the input editor. Marking looked
  // like it worked (the repaint drew it) while nothing reached the clipboard.
  const src = readFileSync(join(cliDir, 'src', 'chatflow.js'), 'utf8');

  assert.ok(src.includes('const mouseGesture = (key) =>'),
    'chatflow must resolve the click/drag/release triplet in one place');
  assert.ok(src.includes('const toggleAtRow = (screenRow) =>'),
    'a press that never swept a cell must toggle through the same path as a click');

  // Both dispatch sites. The idle-prompt one is the one that regressed: routing
  // it through applyLiveScroll is what makes marking work at rest.
  const routes = src.match(/key\.name === 'click' \|\| key\.name === 'drag' \|\| key\.name === 'release'/g) || [];
  assert.equal(routes.length, 2,
    'both dispatch sites (mid-turn and idle) must route drag and release, not just click');

  // The copy reads the UNMARKED grid, or every copied run of text arrives with
  // reverse-video escapes around it.
  assert.ok(/frameLines = lines;/.test(src),
    'frameLines must be assigned from the unmarked lines');
  assert.ok(/copyToClipboard\(text\)/.test(src),
    'the release must actually reach the clipboard');

  // DECSET 1002 is what makes a sweep report its motion at all; without it the
  // decoder above is unreachable no matter how correct it is.
  const screenSrc = readFileSync(join(cliDir, 'src', 'screen.js'), 'utf8');
  assert.ok(/1002/.test(screenSrc), 'mouse tracking must enable 1002 (button-event tracking)');
});
