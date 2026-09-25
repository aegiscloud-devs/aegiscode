'use strict';

/**
 * The terminal title bar — the session's *topic*.
 *
 * Claude Code keeps the window/tab title pointed at what the session is about
 * ("✳ Fixing the nexus hang") rather than at a static product string, so a row
 * of terminal tabs is readable at a glance. This host shipped the static half
 * only: `chatflow.js`'s `setTitle()` wrote "AEGIS Code" forever, spinning a
 * braille frame while a turn ran and never naming the work. Every tab of every
 * session read the same, which is exactly the problem the topic solves.
 *
 * The topic is derived from the user's own prompt, locally — no model call, so
 * it costs nothing, adds no latency to the first frame, and cannot invent a
 * task the user never asked for. It is re-derived per prompt and adopted only
 * when the ask is about something new (`adoptTopic`), so a follow-up like
 * "now add a test for that" keeps the title it inherited.
 *
 * Everything here is pure and returns strings, so the whole surface is
 * assertable without a TTY; `writeTitle` is the one function that touches a
 * stream, and it swallows a non-writable one.
 */

/** The title the app wears before a topic exists (and after one is cleared). */
const DEFAULT_TITLE = 'AEGIS Code';

/** The braille frames the title spins while a turn runs (the reference's). */
const TITLE_SPIN = ['⠐', '⠂', '⠄', '⠆', '⠈', '⠠', '⠰', '⠁'];

/** Longest topic, in cells, before it is clipped on a word boundary. */
const TOPIC_MAX = 48;

/** Longest string that ever reaches the terminal (topic + " · AEGIS Code"). */
const TITLE_MAX = 96;

/**
 * Politeness and throat-clearing, stripped from the front of a prompt so the
 * title says "Add a retry to the fetcher" instead of "Please can you add a
 * retry to the fetcher". Applied repeatedly — "ok so please can you…" is one
 * habit, not four.
 */
const FILLER =
  /^(?:please|pls|plz|hey|hi|hello|ok(?:ay)?|so|now|just|also|and|then|maybe|well|um|uh|can you|could you|would you|will you|i want you to|i want to|i need you to|i need to|i'?d like you to|i would like you to|i'?d like to|help me|help|let'?s|lets|go ahead and|i'?m trying to|i am trying to|i'?m working on|i am working on)\b[\s,:;-]*/i;

/** Leading markdown/list/quote noise: `> `, `- `, `1. `, `## `. */
const LEADING_NOISE = /^(?:[>#*•·\-–—]+|\d+[.)])\s*/;

/** Words that carry no topic signal when comparing two asks. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'you', 'your', 'yours',
  'can', 'could', 'would', 'should', 'will', 'please', 'pls', 'hey', 'now', 'then',
  'from', 'into', 'onto', 'over', 'under', 'about', 'also', 'just', 'like', 'want',
  'need', 'make', 'made', 'use', 'using', 'get', 'got', 'let', 'lets', 'its', 'it',
  'are', 'was', 'were', 'been', 'has', 'have', 'had', 'but', 'not', 'all', 'any',
  'how', 'what', 'when', 'where', 'which', 'who', 'why', 'there', 'here', 'some',
  'one', 'two', 'add', 'new', 'fix', 'fixing', 'help', 'doing', 'does', 'did', 'me',
  'my', 'our', 'we', 'i', 'a', 'an', 'to', 'of', 'in', 'on', 'at', 'is', 'be', 'do',
]);

/** Strip anything that could break out of the OSC title sequence. */
function sanitize(text, max = TITLE_MAX) {
  const flat = String(text == null ? '' : text)
    // Control chars (including ESC, BEL, CR, LF, TAB) become a space, so a
    // prompt can never inject an escape sequence into the title bar — the one
    // place in this UI where user text reaches the terminal unsanitized.
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * A short, single-line topic for a user prompt.
 *
 * Uses the first line that has anything on it (a pasted block's first line is
 * its subject), drops politeness and list noise, collapses whitespace, and
 * clips on a word boundary with an ellipsis. Returns '' when there is nothing
 * to say — the caller then keeps the title it already had.
 */
function topicFrom(text, { max = TOPIC_MAX } = {}) {
  if (text == null) return '';
  const lines = String(text).split(/[\r\n]+/);
  let line = '';
  for (const raw of lines) {
    const cleaned = sanitize(raw, 4_000).replace(LEADING_NOISE, '').trim();
    // A pasted block's fence marker is not the topic; the code under it is.
    if (!cleaned || /^```/.test(cleaned)) continue;
    line = cleaned;
    break;
  }
  if (!line) return '';
  let body = line;
  for (let i = 0; i < 6; i++) {
    const next = body.replace(FILLER, '');
    if (next === body) break;
    body = next.replace(LEADING_NOISE, '').trim();
  }
  body = body.replace(/[.!?]+$/, '').trim();
  if (!body) body = line;
  if (/^[a-z]/.test(body)) body = body[0].toUpperCase() + body.slice(1);
  return sanitize(body, max);
}

/** Topic-defining words of a phrase: lowercase, deduped, stopwords dropped. */
function keywords(phrase) {
  const out = new Set();
  for (const word of String(phrase || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []) {
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    out.add(word);
  }
  return [...out];
}

/**
 * Does `next` read as a *different* task from `prev`?
 *
 * The overlap is measured against the shorter keyword set, so a long follow-up
 * that repeats the subject ("also add a test for the config loader") is not
 * mistaken for a new task, while a genuinely unrelated ask ("now write the
 * changelog") is. An empty `next` is never a shift — it means "no topic", and
 * the caller keeps what it had.
 */
function titleShift(prev, next, { threshold = 0.34 } = {}) {
  if (!next) return false;
  if (!prev) return true;
  const a = keywords(prev);
  const b = keywords(next);
  if (!a.length || !b.length) return true;
  const set = new Set(a);
  let hits = 0;
  for (const word of b) if (set.has(word)) hits++;
  return hits / Math.min(a.length, b.length) < threshold;
}

/** The topic after this prompt: the new one only when it is a new task. */
function adoptTopic(prev, prompt, opts) {
  const next = topicFrom(prompt);
  if (!next) return prev || '';
  return titleShift(prev, next, opts) ? next : prev || '';
}

/**
 * The composed title.
 *
 *  working, with topic   `⠂ Fixing the config loader`
 *  idle, with topic      `Fixing the config loader · AEGIS Code`
 *  no topic              `AEGIS Code`
 *
 * The idle form keeps the product name so a tab is still identifiable as this
 * CLI; the working form is the topic alone, which is what Claude Code shows
 * while a turn runs.
 */
function titleText({ topic = '', frame = null, app = DEFAULT_TITLE } = {}) {
  const clean = sanitize(topic, TOPIC_MAX);
  if (!clean) return sanitize(app, TITLE_MAX) || DEFAULT_TITLE;
  const head = frame ? `${frame} ` : '';
  return sanitize(frame ? `${head}${clean}` : `${clean} · ${app}`, TITLE_MAX);
}

/** Truthiness for the env flags: `1`, `true`, `yes`, `on` (any case). */
function flagOn(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  return /^(?:1|true|yes|on)$/i.test(String(value).trim());
}

/**
 * Is the title bar ours to write?
 *
 * On by default — a title that follows the work is the feature. Off via
 * `AEGIS_DISABLE_TERMINAL_TITLE=1` (and Claude Code's own
 * `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, so a shell configured for the
 * reference behaves the same here), or `terminalTitle: false` in config.json.
 * `AEGIS_TERMINAL_TITLE=1` wins over the config, for a one-off run.
 */
function titleEnabled(env = {}, config = {}) {
  const e = env || {};
  if (flagOn(e.AEGIS_TERMINAL_TITLE)) return true;
  if (flagOn(e.AEGIS_DISABLE_TERMINAL_TITLE)) return false;
  if (flagOn(e.CLAUDE_CODE_DISABLE_TERMINAL_TITLE)) return false;
  const cfg = config || {};
  if (cfg.terminalTitle === false || cfg.terminalTitleBar === false) return false;
  return true;
}

/**
 * Write one title to a stream as an OSC 0 sequence. `''` clears it (what the
 * teardown wants, so the shell that gets the terminal back is not left wearing
 * this app's title). Never throws: a stubbed, closed or non-TTY stream is a
 * missing nicety, not a reason to lose a turn.
 */
function writeTitle(text, out) {
  const stream = out || process.stdout;
  if (!stream || typeof stream.write !== 'function') return false;
  try {
    stream.write(`\x1b]0;${sanitize(text, TITLE_MAX)}\x07`);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_TITLE,
  TITLE_SPIN,
  TOPIC_MAX,
  TITLE_MAX,
  sanitize,
  topicFrom,
  keywords,
  titleShift,
  adoptTopic,
  titleText,
  titleEnabled,
  writeTitle,
};
