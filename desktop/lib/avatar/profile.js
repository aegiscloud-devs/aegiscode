'use strict';

/**
 * profile.js — what *this holder's* memory is allowed to personalise (Phase 25,
 * identity plan §4).
 *
 * `identity.js` answers "whose memory is it"; this module answers the question
 * that follows immediately: given that holder's own rows, what may the avatar
 * say it knows about them — and what is the provenance of each claim?
 *
 * The shape is a **fold**, not an inference engine:
 *
 *   fold({ holder, entries, ledger, corrections, now }) →
 *     { holder, facets, budget, coldStart, dropped }
 *
 * Six properties, each asserted in `desktop/test/avatar-profile.test.mjs`
 * rather than promised in prose:
 *
 *  1. PROVENANCE-BACKED. Every facet carries `sources: [entryId…]`, and every
 *     one of those ids is an entry id from *this holder's* input set — the
 *     `citable()` filter below is the single place that guarantees it. A facet
 *     that cannot cite a row it was actually built from is not emitted at all
 *     (`sources.length === 0` drops the facet), so "the avatar can show you
 *     why it knows this" is structurally true rather than a UI promise.
 *  2. CLOSED NAMESPACE. `FACET_IDS` is a frozen list of seven classes and
 *     `checkFacetId` throws on anything else. There is deliberately no code
 *     path for identity, health, politics, employer or location: the fold only
 *     ever iterates `FOLDERS`, which is keyed by `FACET_IDS` and length-checked
 *     against it at load, so an eighth class is a visible diff to the frozen
 *     list rather than a quiet addition. The closure is the proof; §7's
 *     "no profiling creep" is what it is for.
 *  3. EVIDENCE-GATED. `doNotRepeat` is honoured at a single observation —
 *     negatives are cheap to act on and expensive to ignore. Every *positive*
 *     facet needs its §4 gate (≥1 correction or ≥3 consistent observations,
 *     ≥5 non-English entries, ≥2 recent entries on a path, ≥1 decision, …).
 *     Absence of evidence produces no facet: never "probably prefers terse
 *     answers".
 *  4. COLD START IS NEUTRAL. No evidence ⇒ `coldStart: true`, `facets: []`,
 *     `budget.used: 0`. Phase 27 renders that as an empty fragment, i.e. an
 *     avatar that behaves exactly like an unconfigured install. It does not
 *     guess a personality, the same honesty rule as `avatar-plan.md` §1.4.
 *  5. DETERMINISTIC. No clock (`now` is an argument), no randomness, no map
 *     iteration order leaking into output: facets are ordered by
 *     `(confidence desc, lastSeen desc, id asc)` and, for two facets of the
 *     same class on the same day, `key asc` — one extra term so the order is
 *     total and a permutation of the input cannot change the output bytes.
 *  6. BOUNDED. The assembled facets are capped at `BUDGET_TOKENS` (900, per
 *     §Phase 27), dropped whole, lowest priority first — never sliced
 *     mid-sentence, which is the failure mode a naive `slice()` produces.
 *
 * Pure: no fs, no Electron, no clock, no crypto. It reuses `persona.cleanText`
 * (the storage boundary's sanitizer) and `register.estimateTokens` (the same
 * 4-chars-per-token ceiling Phase 21 uses) so the two prompt fragments Phase 27
 * concatenates are measured with one ruler.
 */

const persona = require('./persona.js');
const register = require('./register.js');
const identity = require('./identity.js');

/**
 * The closed facet namespace (§4's table). Frozen twice on purpose: freeze the
 * array so it cannot be extended at runtime, and length-check `FOLDERS` against
 * it below so the *implementation* cannot grow a class the list does not name.
 */
const FACET_IDS = Object.freeze([
  'vocabulary',
  'language',
  'codebase',
  'decisions',
  'openThreads',
  'doNotRepeat',
  'toneCalibration',
]);

/** §Phase 27: the profile fragment's ceiling. */
const BUDGET_TOKENS = 900;

/** Longest a single facet `value` may be (it is UI text and prompt text). */
const MAX_VALUE_CHARS = 180;
/** Longest a facet `key` may be. */
const MAX_KEY_CHARS = 64;
/** Distinct ids a single facet may cite; provenance stays readable. */
const MAX_SOURCES = 24;

/** Per-class caps — a fold is a summary, not a dump. */
const MAX_VOCABULARY = 5;
const MAX_LANGUAGE = 2;
const MAX_CODEBASE = 5;
const MAX_DECISIONS = 5;
const MAX_OPEN_THREADS = 3;
const MAX_DO_NOT_REPEAT = 5;
const MAX_TONE = 2;

/** §4 gate constants. Named so the tests can assert the gate, not a magic 5. */
const MIN_LANGUAGE_ENTRIES = 5;
const MIN_CODEBASE_ENTRIES = 2;
const MIN_OBSERVATIONS = 3;
const MIN_TONE_SAMPLES = 5;
const RECENT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Ledger kinds this fold reads. Everything else is noise here. */
const CORRECTION_KIND = 'memory.corrected';
const RECALL_KINDS = Object.freeze(['memory.recalled', 'memory.saved', 'memory.reinforced']);
/**
 * Kinds that state a negative. `xp.js` does not pay for them (they are not in
 * its table) — a deletion is not work — but the fold honours them, which is the
 * whole point of §4's "negatives are honoured even at one observation".
 */
const NEGATIVE_KINDS = Object.freeze(['memory.deleted', 'memory.contradicted', 'memory.forgotten']);
/** Entry tags that mark the entry itself as a negative. */
const NEGATIVE_TAGS = Object.freeze(['do-not-repeat', 'never-repeat', 'avoid', 'never']);
/** Entry tags that mark a decision. aegis1 rows carry tags, not `kind`. */
const DECISION_TAGS = Object.freeze(['decision', 'decided', 'adr']);

/** Confidence a facet may carry, before the clamping in `makeFacet`. */
const MAX_CONFIDENCE = 0.95;
const MIN_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

/** The closed-namespace guard. Throws — this is a programming error, not data. */
function checkFacetId(id) {
  if (!FACET_IDS.includes(id)) {
    throw new Error(`unknown facet id ${JSON.stringify(String(id))} — FACET_IDS is closed (identity plan §4)`);
  }
  return id;
}

/** Single-line, capped, control-character-free text (the same sanitizer persona uses). */
function clean(value, max) {
  return persona.cleanText(value == null ? '' : String(value), max);
}

/** `Kebab Case` → `kebab-case`, for stable keys. */
function keyOf(value) {
  return clean(value, MAX_KEY_CHARS).toLowerCase().replace(/\s+/g, ' ').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(entry) {
  if (!entry) return '';
  if (typeof entry.content === 'string' && entry.content) return entry.content;
  if (typeof entry.text === 'string' && entry.text) return entry.text;
  return '';
}

/** A usable timestamp, or `null`. Nothing here ever calls `Date.now()`. */
function timeOf(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = row.t != null ? row.t : row.createdAt != null ? row.createdAt : row.ts;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  if (typeof direct === 'string' && direct.trim()) {
    const parsed = Date.parse(direct);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof row.timestamp === 'string' && row.timestamp.trim()) {
    const parsed = Date.parse(row.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Entry id, or `null`. An entry with no id can never be cited, so it is skipped. */
function idOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.id == null || entry.id === '') return null;
  return String(entry.id);
}

function tagsOf(entry) {
  return asArray(entry && entry.tags).map((t) => keyOf(t)).filter(Boolean);
}

function holderStamp(row) {
  if (!row || typeof row !== 'object') return null;
  const value = row.holder;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

/** Clamp and round to 2dp so two runs on two machines produce identical bytes. */
function clampConfidence(value) {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : MIN_CONFIDENCE;
  return Math.round(Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, n)) * 100) / 100;
}

/**
 * Levenshtein distance, iteratively and with a bounded row (only ever 2 rows of
 * `b.length + 1`), because tone calibration runs over a handful of strings but
 * a hostile input can make them long. Capped at `cap` characters per side: an
 * edit-distance estimate does not improve with the tail of a 10 kB paragraph,
 * and the cap keeps the fold linear-time by construction.
 */
function editDistance(a, b, cap = 400) {
  const s = String(a == null ? '' : a).slice(0, cap);
  const t = String(b == null ? '' : b).slice(0, cap);
  if (!s) return t.length;
  if (!t) return s.length;
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length];
}

// ---------------------------------------------------------------------------
// language detection — deterministic, and blind on purpose
// ---------------------------------------------------------------------------

/** Script ranges we can name without a model. Order matters: first match wins. */
const SCRIPT_RANGES = Object.freeze([
  { code: 'ja', re: /[\u3040-\u30ff]/ },
  { code: 'ko', re: /[\uac00-\ud7af]/ },
  { code: 'zh', re: /[\u4e00-\u9fff]/ },
  { code: 'ru', re: /[\u0400-\u04ff]/ },
  { code: 'ar', re: /[\u0600-\u06ff]/ },
  { code: 'he', re: /[\u0590-\u05ff]/ },
  { code: 'el', re: /[\u0370-\u03ff]/ },
  { code: 'th', re: /[\u0e00-\u0e7f]/ },
  { code: 'hi', re: /[\u0900-\u097f]/ },
]);

/**
 * A closed stopword set for the Latin-script languages where a script check
 * cannot help. Small on purpose: the fold only needs to answer "is this holder
 * writing durably in a language that is not English", and a wrong guess here
 * would produce a facet about a person that is not true — the exact failure §4's
 * non-goal forbids. When the score is close or low, the answer is `und`.
 */
const STOPWORDS = Object.freeze({
  en: Object.freeze(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'you', 'are', 'have']),
  de: Object.freeze(['der', 'die', 'das', 'und', 'nicht', 'mit', 'ist', 'ich', 'auch', 'dass', 'noch']),
  fr: Object.freeze(['le', 'la', 'les', 'des', 'est', 'pas', 'que', 'qui', 'dans', 'pour', 'avec']),
  es: Object.freeze(['el', 'los', 'las', 'que', 'no', 'con', 'para', 'una', 'pero', 'como', 'está']),
  pt: Object.freeze(['não', 'uma', 'com', 'para', 'que', 'está', 'mais', 'como', 'isso', 'você']),
  it: Object.freeze(['il', 'lo', 'gli', 'che', 'non', 'con', 'per', 'una', 'come', 'anche']),
  nl: Object.freeze(['het', 'een', 'niet', 'met', 'dat', 'zijn', 'voor', 'maar', 'ook', 'nog']),
});

/** Human names for the codes we can emit; anything else displays as its code. */
const LANGUAGE_NAMES = Object.freeze({
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', pt: 'Portuguese',
  it: 'Italian', nl: 'Dutch', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', he: 'Hebrew', el: 'Greek', th: 'Thai', hi: 'Hindi',
});

const LANGUAGE_CODE_RE = /^[a-z]{2}(?:-[a-z0-9]{2,8})?$/;

/**
 * Detect the language of one entry. `lang`/`language` from the row wins if it is
 * shaped like a code (aegis1 does not send one today, but a row that does is
 * better evidence than a guess), then script, then stopwords. `und` means
 * "not enough signal", which is not a language and never becomes a facet.
 */
function detectLanguage(entry) {
  const declared = entry && (entry.lang != null ? entry.lang : entry.language);
  if (typeof declared === 'string' && declared.trim()) {
    const code = declared.trim().toLowerCase();
    if (LANGUAGE_CODE_RE.test(code)) return code.split('-')[0];
  }
  const text = textOf(entry);
  if (!text) return 'und';
  for (const { code, re } of SCRIPT_RANGES) {
    if (re.test(text)) return code;
  }
  const words = text.toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(Boolean);
  if (!words.length) return 'und';
  const seen = new Set(words);
  let best = 'und';
  let bestScore = 0;
  let englishScore = 0;
  for (const code of Object.keys(STOPWORDS)) {
    let score = 0;
    for (const word of STOPWORDS[code]) if (seen.has(word)) score += 1;
    if (code === 'en') { englishScore = score; continue; }
    // Ties resolve by code ascending, so the same text always yields one answer.
    if (score > bestScore || (score === bestScore && score > 0 && code < best)) {
      best = code;
      bestScore = score;
    }
  }
  // A non-English language must actually beat English, and clear a floor: two
  // shared stopwords is the smallest signal that is not a coincidence.
  if (bestScore >= 2 && bestScore > englishScore) return best;
  return englishScore > 0 ? 'en' : 'und';
}

// ---------------------------------------------------------------------------
// facet construction
// ---------------------------------------------------------------------------

/**
 * Build one facet. `value` is the sentence the prompt will see; `key` is the
 * stable identity within the class (a term, a language code, a path, a topic).
 * Returns `null` for a facet with no citable source — see property 1 in the
 * header: a claim the holder cannot trace back to a row is not emitted.
 */
function makeFacet(id, key, value, sources, confidence, firstSeen, lastSeen) {
  checkFacetId(id);
  const cleanKey = keyOf(key);
  const cleanValue = clean(value, MAX_VALUE_CHARS);
  const ids = asArray(sources).map((s) => String(s)).filter(Boolean);
  if (!cleanKey || !cleanValue || !ids.length) return null;
  const seen = ids.slice().sort().slice(0, MAX_SOURCES);
  const first = typeof firstSeen === 'number' && Number.isFinite(firstSeen) ? firstSeen : null;
  const last = typeof lastSeen === 'number' && Number.isFinite(lastSeen) ? lastSeen : null;
  const times = [first, last].filter((t) => t !== null);
  return {
    id,
    key: cleanKey,
    value: cleanValue,
    tokens: register.estimateTokens(cleanKey) + register.estimateTokens(cleanValue),
    sources: seen,
    confidence: clampConfidence(confidence),
    // `0` rather than a guess when the source rows carry no usable timestamp:
    // unknown recency sorts last, which is where an unprovable claim belongs.
    firstSeen: times.length ? Math.min(...times) : 0,
    lastSeen: times.length ? Math.max(...times) : 0,
  };
}

/**
 * The order the fragment is assembled in, and the order the budget drops in:
 * `(confidence desc, lastSeen desc, id asc)`, with `key asc` as the final term
 * so two facets of one class on one day still have a total order. An unknown id
 * here throws — this is the second of the two closure guards (the first is
 * `checkFacetId` on the way in), so a facet list crossing this boundary can
 * never carry a class the design does not name.
 */
function orderFacets(facets) {
  return asArray(facets)
    .map((facet) => {
      checkFacetId(facet.id);
      return facet;
    })
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      if (b.lastSeen !== a.lastSeen) return b.lastSeen - a.lastSeen;
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      if (a.key !== b.key) return a.key < b.key ? -1 : 1;
      return 0;
    });
}

/**
 * Take facets in priority order while they fit. Whole facets only: a fragment
 * that ends mid-sentence reads as a truncated thought, which is worse than a
 * shorter one, and §Phase 27 asserts exactly this.
 */
function applyBudget(ordered, limit = BUDGET_TOKENS) {
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const facet of asArray(ordered)) {
    if (used + facet.tokens <= limit) {
      kept.push(facet);
      used += facet.tokens;
    } else {
      dropped.push({ id: facet.id, key: facet.key, tokens: facet.tokens });
    }
  }
  return { facets: kept, used, dropped };
}

// ---------------------------------------------------------------------------
// input normalisation (and the isolation filter)
// ---------------------------------------------------------------------------

/**
 * Does this row belong to the holder being folded?
 *
 * Unstamped rows belong to whoever is asking: they predate Phase 26's stamping
 * and the alternative — dropping them — would silently empty the profile of
 * every existing install. A row stamped for *someone else* is never folded, and
 * that is the pure-seam half of §3's "isolation is the load-bearing property":
 * `sources` built downstream can only cite ids that survived this filter. The
 * real-seam half (Phase 28) asserts it again through actual turn assembly,
 * because a filter applied after the wrong cache is exactly the bug a
 * pure-function test misses.
 */
function belongsTo(row, holder) {
  if (!holder) return true;
  const stamp = holderStamp(row);
  return !stamp || stamp === holder;
}

function normalizeEntries(rows, holder) {
  const out = [];
  for (const raw of asArray(rows)) {
    if (!raw || typeof raw !== 'object') continue;
    if (!belongsTo(raw, holder)) continue;
    const id = idOf(raw);
    if (!id) continue;
    const text = textOf(raw);
    if (!text) continue;
    const t = timeOf(raw);
    out.push({
      id,
      text,
      t,
      tagged: tagsOf(raw),
      kind: clean(raw.kind, 24).toLowerCase(),
      lang: clean(raw.lang != null ? raw.lang : raw.language, 8).toLowerCase(),
      role: clean(raw.role, 16).toLowerCase(),
      source: clean(raw.source, 40),
      session: clean(raw.session, 64),
      holder: holderStamp(raw),
    });
  }
  return out;
}

function normalizeLedger(rows, holder) {
  const out = [];
  for (const raw of asArray(rows)) {
    if (!raw || typeof raw !== 'object') continue;
    if (!belongsTo(raw, holder)) continue;
    const kind = typeof raw.kind === 'string' ? raw.kind : '';
    if (!kind) continue;
    out.push({
      kind,
      ref: raw.ref == null || raw.ref === '' ? null : String(raw.ref),
      session: clean(raw.session, 64),
      t: timeOf(raw),
    });
  }
  return out;
}

/**
 * Correction observations. Two shapes share this input, because both are "the
 * holder told us it was wrong":
 *
 *   { ref, term, insteadOf }        a terminology correction (→ `vocabulary`)
 *   { proposed, kept }              an edit of what the avatar wrote (→ `toneCalibration`)
 *   { ref, term, negative: true }   a negative, honoured at one observation (→ `doNotRepeat`)
 */
function normalizeCorrections(rows, holder) {
  const out = [];
  for (const raw of asArray(rows)) {
    if (!raw || typeof raw !== 'object') continue;
    if (!belongsTo(raw, holder)) continue;
    out.push({
      ref: raw.ref == null && raw.entryId == null ? null : String(raw.ref != null ? raw.ref : raw.entryId),
      term: clean(raw.term != null ? raw.term : raw.from, MAX_KEY_CHARS),
      insteadOf: clean(raw.insteadOf != null ? raw.insteadOf : raw.was, MAX_KEY_CHARS),
      proposed: raw.proposed == null ? '' : String(raw.proposed),
      kept: raw.kept == null ? '' : String(raw.kept),
      negative: raw.negative === true || raw.removed === true || raw.deleted === true,
      t: timeOf(raw),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the seven folds
// ---------------------------------------------------------------------------

/** Backtick-quoted spans — the only place a "project noun" is read from prose. */
function backticked(text) {
  const out = [];
  const re = /`([^`\n]{1,48})`/g;
  let match = re.exec(text);
  while (match) {
    const term = keyOf(match[1]);
    if (term) out.push(term);
    match = re.exec(text);
  }
  return out;
}

/** Paths and filenames — again, only shapes we can point at, never guesswork. */
const PATH_RE = /(?:^|[\s("'`\[])((?:[\w.@-]+\/)+[\w.@-]+|[\w.@-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|jsonl|md|yml|yaml|sh|rs|go|java|rb|toml|css|html))/g;
function pathsIn(text) {
  const out = [];
  let match = PATH_RE.exec(text);
  while (match) {
    const path = keyOf(match[1]).replace(/[.,;:]+$/, '');
    if (path) out.push(path);
    match = PATH_RE.exec(text);
  }
  PATH_RE.lastIndex = 0;
  return out;
}

/** `vocabulary` — terms the holder corrected us on, or observed consistently. */
function foldVocabulary(ctx) {
  const perTerm = new Map();
  const bump = (term, { entryId, t, corrected, insteadOf }) => {
    const key = keyOf(term);
    if (!key || key.length < 2) return;
    const rec = perTerm.get(key) || {
      key, ids: new Set(), corrections: 0, observations: 0,
      first: null, last: null, insteadOf: null,
    };
    if (entryId) rec.ids.add(entryId);
    if (corrected) {
      rec.corrections += 1;
      if (insteadOf) rec.insteadOf = keyOf(insteadOf);
    } else {
      rec.observations += 1;
    }
    if (typeof t === 'number') {
      rec.first = rec.first === null ? t : Math.min(rec.first, t);
      rec.last = rec.last === null ? t : Math.max(rec.last, t);
    }
    perTerm.set(key, rec);
  };

  // Corrections: explicit rows first, then the entries the ledger marked as
  // corrected (`memory.corrected`). Both are the holder disagreeing with us.
  const correctedRefs = new Set();
  for (const row of ctx.ledger) {
    if (row.kind === CORRECTION_KIND && row.ref) correctedRefs.add(row.ref);
  }
  for (const corr of ctx.corrections) {
    if (corr.negative || !corr.term) continue;
    const entry = corr.ref ? ctx.byId.get(corr.ref) : null;
    bump(corr.term, {
      entryId: entry ? entry.id : null,
      t: corr.t != null ? corr.t : entry ? entry.t : null,
      corrected: true,
      insteadOf: corr.insteadOf,
    });
  }
  for (const id of correctedRefs) {
    const entry = ctx.byId.get(String(id));
    if (!entry) continue;
    for (const term of backticked(entry.text)) {
      bump(term, { entryId: entry.id, t: entry.t, corrected: true });
    }
  }
  // Consistent observations: the same backticked term in ≥3 entries.
  for (const entry of ctx.entries) {
    if (ctx.negative.has(entry.id)) continue;
    for (const term of backticked(entry.text)) {
      bump(term, { entryId: entry.id, t: entry.t, corrected: false });
    }
  }

  const facets = [];
  const keys = [...perTerm.keys()].sort();
  for (const key of keys) {
    const rec = perTerm.get(key);
    if (!rec.corrections && rec.observations < MIN_OBSERVATIONS) continue; // §4 gate
    const sources = ctx.citable(rec.ids);
    const confidence = rec.corrections
      ? 0.75 + Math.min(0.15, (rec.corrections - 1) * 0.05)
      : 0.6;
    const value = rec.insteadOf
      ? `calls it "${rec.key}", not "${rec.insteadOf}"`
      : `calls it "${rec.key}"`;
    const facet = makeFacet('vocabulary', rec.key, value, sources, confidence, rec.first, rec.last);
    if (facet) facets.push(facet);
  }
  return facets.slice(0, MAX_VOCABULARY);
}

/** `language` — the holder's own durable entries, ≥5 in one non-English language. */
function foldLanguage(ctx) {
  const perLang = new Map();
  for (const entry of ctx.entries) {
    if (ctx.negative.has(entry.id)) continue;
    if (entry.role && entry.role !== 'user') continue; // "the holder's own" entries
    // Entries with a `lang` field win over the script/stopword guess.
    const code = detectLanguage({ content: entry.text, lang: entry.lang });
    if (code === 'und' || code === 'en') continue;
    const rec = perLang.get(code) || { key: code, ids: new Set(), first: null, last: null, count: 0 };
    rec.ids.add(entry.id);
    rec.count += 1;
    if (typeof entry.t === 'number') {
      rec.first = rec.first === null ? entry.t : Math.min(rec.first, entry.t);
      rec.last = rec.last === null ? entry.t : Math.max(rec.last, entry.t);
    }
    perLang.set(code, rec);
  }
  const facets = [];
  for (const code of [...perLang.keys()].sort()) {
    const rec = perLang.get(code);
    if (rec.count < MIN_LANGUAGE_ENTRIES) continue; // §4 gate
    const name = LANGUAGE_NAMES[rec.key] || rec.key;
    const facet = makeFacet(
      'language',
      rec.key,
      `writes durably in ${name} (${rec.key}), so reply in ${name} unless asked otherwise`,
      ctx.citable(rec.ids),
      rec.count >= 10 ? 0.8 : 0.7,
      rec.first,
      rec.last,
    );
    if (facet) facets.push(facet);
  }
  // Most evidence wins the slice, ties by code asc — `orderFacets` re-sorts the
  // final list, so this only decides which languages survive the per-class cap.
  facets.sort((a, b) => (b.sources.length - a.sources.length) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return facets.slice(0, MAX_LANGUAGE);
}

/** `codebase` — paths in entries that were recalled and kept, ≥2 in 30 days. */
function foldCodebase(ctx) {
  const recalled = new Set();
  for (const row of ctx.ledger) {
    if (row.ref && RECALL_KINDS.includes(row.kind)) recalled.add(row.ref);
  }
  const perPath = new Map();
  for (const entry of ctx.entries) {
    if (ctx.negative.has(entry.id)) continue;
    if (!recalled.has(entry.id)) continue; // "recalled and kept", not merely mentioned
    for (const path of pathsIn(entry.text)) {
      const rec = perPath.get(path) || { key: path, ids: new Set(), recent: new Set(), first: null, last: null };
      rec.ids.add(entry.id);
      if (typeof entry.t === 'number' && ctx.now - entry.t <= RECENT_DAYS * DAY_MS && entry.t <= ctx.now) {
        rec.recent.add(entry.id);
      }
      if (typeof entry.t === 'number') {
        rec.first = rec.first === null ? entry.t : Math.min(rec.first, entry.t);
        rec.last = rec.last === null ? entry.t : Math.max(rec.last, entry.t);
      }
      perPath.set(path, rec);
    }
  }
  const facets = [];
  for (const key of [...perPath.keys()].sort()) {
    const rec = perPath.get(key);
    if (rec.recent.size < MIN_CODEBASE_ENTRIES) continue; // §4 gate: ≥2 recent
    const facet = makeFacet(
      'codebase',
      rec.key,
      `works in ${rec.key} (${rec.recent.size} entries touched in the last ${RECENT_DAYS} days)`,
      ctx.citable(rec.ids),
      rec.recent.size >= 4 ? 0.75 : 0.6,
      rec.first,
      rec.last,
    );
    if (facet) facets.push(facet);
  }
  facets.sort((a, b) => (b.sources.length - a.sources.length) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return facets.slice(0, MAX_CODEBASE);
}

/** `decisions` — newest first, superseded ones dropped, always allowed. */
function foldDecisions(ctx) {
  const isDecision = (entry) =>
    entry.tagged.some((tag) => DECISION_TAGS.includes(tag)) || entry.kind === 'decision';
  const superseded = new Set();
  for (const raw of asArray(ctx.rawEntries)) {
    const id = idOf(raw);
    if (!id) continue;
    for (const target of asArray(raw.supersedes)) {
      if (target != null && target !== '') superseded.add(String(target));
    }
  }

  /** Two decisions on one topic: the newer one wins, so only it is folded. */
  const topic = (entry) => {
    const named = entry.tagged.find((tag) => !DECISION_TAGS.includes(tag));
    return named || keyOf(entry.text).slice(0, 40);
  };

  const groups = new Map();
  for (const entry of ctx.entries) {
    if (ctx.negative.has(entry.id) || superseded.has(entry.id)) continue;
    if (!isDecision(entry)) continue;
    const key = topic(entry);
    if (!key) continue;
    const rec = groups.get(key) || { key, entry: null };
    const current = rec.entry;
    const newer =
      !current ||
      (entry.t == null ? -Infinity : entry.t) > (current.t == null ? -Infinity : current.t) ||
      ((entry.t == null ? -Infinity : entry.t) === (current.t == null ? -Infinity : current.t) && entry.id < current.id);
    if (newer) rec.entry = entry;
    groups.set(key, rec);
  }

  const facets = [];
  for (const key of [...groups.keys()].sort()) {
    const { entry } = groups.get(key);
    const facet = makeFacet('decisions', key, entry.text, ctx.citable([entry.id]), 0.8, entry.t, entry.t);
    if (facet) facets.push(facet);
  }
  return facets.slice(0, MAX_DECISIONS);
}

/** `openThreads` — entries recalled in a session that is no longer the current one. */
function foldOpenThreads(ctx) {
  const withSession = ctx.ledger.filter((row) => row.session && row.ref && RECALL_KINDS.includes(row.kind));
  if (!withSession.length) return []; // no silence: no sessions, no threads
  // "Current" is the newest session the ledger mentions. Deterministic: session
  // ids are compared as strings, and only their ordering matters here.
  let current = '';
  for (const row of withSession) if (row.session > current) current = row.session;
  if (!current) return [];

  const threads = new Map();
  for (const row of withSession) {
    if (row.session === current) continue; // answered/referenced since — not open
    const entry = ctx.byId.get(row.ref);
    if (!entry || ctx.negative.has(entry.id)) continue;
    const rec = threads.get(entry.id) || { entry, count: 0, t: null };
    rec.count += 1;
    if (typeof row.t === 'number') rec.t = rec.t === null ? row.t : Math.max(rec.t, row.t);
    threads.set(entry.id, rec);
  }
  const recs = [...threads.values()].sort((a, b) => {
    const at = a.t == null ? -Infinity : a.t;
    const bt = b.t == null ? -Infinity : b.t;
    if (bt !== at) return bt - at;
    return a.entry.id < b.entry.id ? -1 : 1;
  });
  const facets = [];
  for (const rec of recs.slice(0, MAX_OPEN_THREADS)) {
    const facet = makeFacet(
      'openThreads',
      rec.entry.id,
      `left open: ${rec.entry.text}`,
      ctx.citable([rec.entry.id]),
      0.5,
      rec.entry.t,
      rec.t != null ? rec.t : rec.entry.t,
    );
    if (facet) facets.push(facet);
  }
  return facets;
}

/** `doNotRepeat` — negatives, honoured at a single observation. */
function foldDoNotRepeat(ctx) {
  const hits = new Map();
  const add = (entry, label, t) => {
    if (!entry) return;
    const rec = hits.get(entry.id) || { entry, labels: new Set(), t: null };
    if (label) rec.labels.add(keyOf(label));
    if (typeof t === 'number') rec.t = rec.t === null ? t : Math.max(rec.t, t);
    hits.set(entry.id, rec);
  };

  for (const row of ctx.ledger) {
    if (!NEGATIVE_KINDS.includes(row.kind) || !row.ref) continue;
    add(ctx.byId.get(row.ref), null, row.t);
  }
  for (const corr of ctx.corrections) {
    if (!corr.negative) continue;
    // A negative with no entry to cite is not folded: every claim has to be
    // showable and deletable (§4), and an uncitable one is neither.
    if (corr.ref) add(ctx.byId.get(corr.ref), corr.term || corr.insteadOf, corr.t);
  }
  for (const entry of ctx.entries) {
    if (entry.tagged.some((tag) => NEGATIVE_TAGS.includes(tag))) add(entry, entry.tagged.find((t) => NEGATIVE_TAGS.includes(t)));
  }

  const facets = [];
  for (const id of [...hits.keys()].sort()) {
    const rec = hits.get(id);
    const label = [...rec.labels].sort()[0] || null;
    const value = label
      ? `never repeat "${label}" — the holder removed or contradicted it`
      : `never repeat: ${rec.entry.text}`;
    const facet = makeFacet('doNotRepeat', rec.entry.id, value, ctx.citable([rec.entry.id]), 0.95, rec.t != null ? rec.t : rec.entry.t, rec.t != null ? rec.t : rec.entry.t);
    if (facet) facets.push(facet);
  }
  return facets.slice(0, MAX_DO_NOT_REPEAT);
}

/** `toneCalibration` — how far the holder moves what the avatar proposed. */
function foldToneCalibration(ctx) {
  const samples = ctx.corrections.filter((corr) => corr.proposed.trim() && corr.kept.trim());
  if (samples.length < MIN_TONE_SAMPLES) return []; // §4 gate: register stands unchanged
  let distance = 0;
  let ratio = 0;
  let first = null;
  let last = null;
  for (const sample of samples) {
    const a = clean(sample.proposed, 400);
    const b = clean(sample.kept, 400);
    distance += a.length ? editDistance(a, b, 400) / Math.max(a.length, 1) : 0;
    ratio += b.length / Math.max(a.length, 1);
    if (typeof sample.t === 'number') {
      first = first === null ? sample.t : Math.min(first, sample.t);
      last = last === null ? sample.t : Math.max(last, sample.t);
    }
  }
  const meanDistance = distance / samples.length;
  const meanRatio = ratio / samples.length;
  const pct = Math.round(meanDistance * 100);
  const lengthPct = Math.round(Math.abs(1 - meanRatio) * 100);
  const direction = meanRatio < 0.9 ? 'shorter' : meanRatio > 1.1 ? 'longer' : 'about the same length as';
  // The correction rows ARE the sources here, so the facet cites the entries the
  // samples referenced; a sample citing no entry cannot be shown to the holder
  // and therefore cannot be folded (§4: every claim is deletable).
  const ids = ctx.citable(samples.map((s) => s.ref).filter(Boolean));

  const facets = [];
  const editFacet = makeFacet('toneCalibration', 'edit-distance', `the holder rewrites about ${pct}% of what the avatar drafts`, ids, 0.7, first, last);
  if (editFacet) facets.push(editFacet);
  const lengthFacet = makeFacet('toneCalibration', 'length', `the holder keeps answers about ${lengthPct}% ${direction} the draft`, ids, 0.65, first, last);
  if (lengthFacet) facets.push(lengthFacet);
  return facets.slice(0, MAX_TONE);
}

/**
 * The fold table. Keyed by `FACET_IDS`; the length check right below is what
 * makes "the namespace is closed" an invariant of the implementation rather
 * than a comment — adding an eighth class here without adding it to the frozen
 * list throws at require-time, on every machine, including CI.
 */
const FOLDERS = Object.freeze({
  vocabulary: foldVocabulary,
  language: foldLanguage,
  codebase: foldCodebase,
  decisions: foldDecisions,
  openThreads: foldOpenThreads,
  doNotRepeat: foldDoNotRepeat,
  toneCalibration: foldToneCalibration,
});

if (Object.keys(FOLDERS).length !== FACET_IDS.length || FACET_IDS.some((id) => typeof FOLDERS[id] !== 'function')) {
  throw new Error('profile.js: FOLDERS and FACET_IDS disagree — the facet namespace is closed and must match exactly');
}

// ---------------------------------------------------------------------------
// fold()
// ---------------------------------------------------------------------------

/**
 * Fold one holder's own rows into a bounded, provenance-backed facet list.
 *
 * @param {object} input
 * @param {string} [input.holder]      the holder these rows belong to. Supplying
 *   it is how a caller states *whose* memory this is: rows stamped for another
 *   holder are dropped here and can therefore never be cited by a facet. Phase
 *   26 always passes it (the registry's `active`); omitting it means "the caller
 *   already scoped this input", which is why Phase 28 asserts the same property
 *   again at the real turn-assembly seam.
 * @param {Array} [input.entries]      memory entries for this holder, aegis1's
 *   row shape: `{ id, content, role, tags: [], session, createdAt, … }`.
 * @param {Array} [input.ledger]       `xp.js` ledger rows: `{ kind, ref, session, t }`.
 * @param {Array} [input.corrections]  correction observations, see
 *   `normalizeCorrections`.
 * @param {number} [input.now]         the clock, passed in. Defaults to the
 *   newest timestamp in the input, so a fixture folds without one and the module
 *   still never reads a clock of its own.
 * @returns {{ holder: string|null, facets: Array, budget: { tokens: number, used: number },
 *             coldStart: boolean, dropped: Array<{id: string, key: string, tokens: number}> }}
 */
function fold(input) {
  const args = input && typeof input === 'object' ? input : {};
  const holder = identity.HOLDER_ID_SHAPE.test(String(args.holder || '').trim().toLowerCase())
    ? String(args.holder).trim().toLowerCase()
    : null;

  const entries = normalizeEntries(args.entries, holder);
  const ledger = normalizeLedger(args.ledger, holder);
  const corrections = normalizeCorrections(args.corrections, holder);

  // The citable set: exactly the ids that survived the holder filter. This is
  // the one place provenance is decided, and the plan names it as the negative
  // control for the isolation leg — remove the filter and the leg goes red.
  const knownIds = new Set(entries.map((entry) => entry.id));

  const stamps = [];
  for (const row of asArray(args.entries)) {
    const t = timeOf(row);
    if (typeof t === 'number') stamps.push(t);
  }
  for (const row of ledger) if (typeof row.t === 'number') stamps.push(row.t);
  const now = typeof args.now === 'number' && Number.isFinite(args.now) ? args.now : stamps.length ? Math.max(...stamps) : 0;

  // Entries the holder has negated. Nothing negative-derived is folded twice,
  // and a negative entry never also becomes a positive facet in the same pass.
  const negative = new Set();
  for (const row of ledger) if (NEGATIVE_KINDS.includes(row.kind) && row.ref) negative.add(row.ref);
  for (const corr of corrections) if (corr.negative && corr.ref) negative.add(corr.ref);
  for (const entry of entries) {
    if (entry.tagged.some((tag) => NEGATIVE_TAGS.includes(tag))) negative.add(entry.id);
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const citable = (ids) => {
    const out = [];
    for (const id of asArray(ids)) {
      const key = String(id);
      if (knownIds.has(key) && !out.includes(key)) out.push(key);
    }
    return out;
  };

  const ctx = {
    entries,
    rawEntries: args.entries,
    byId,
    citable,
    knownIds,
    ledger,
    corrections,
    negative,
    now,
  };

  let facets = [];
  for (const id of FACET_IDS) facets = facets.concat(FOLDERS[id](ctx));

  const ordered = orderFacets(facets).map((facet) =>
    Object.assign({}, facet, {
      // `id`/`lang` are normalisation-only fields; keep the record to the §4 shape.
      sources: facet.sources.filter((source) => knownIds.has(source)),
    })
  );
  const surviving = ordered.filter((facet) => facet.sources.length > 0);
  const { facets: kept, used, dropped } = applyBudget(surviving);

  return {
    holder,
    facets: kept,
    budget: { tokens: BUDGET_TOKENS, used },
    coldStart: surviving.length === 0,
    dropped,
  };
}

module.exports = {
  FACET_IDS,
  FOLDERS,
  BUDGET_TOKENS,
  MAX_VALUE_CHARS,
  MAX_KEY_CHARS,
  MAX_SOURCES,
  MIN_LANGUAGE_ENTRIES,
  MIN_CODEBASE_ENTRIES,
  MIN_OBSERVATIONS,
  MIN_TONE_SAMPLES,
  RECENT_DAYS,
  DAY_MS,
  CORRECTION_KIND,
  RECALL_KINDS,
  NEGATIVE_KINDS,
  NEGATIVE_TAGS,
  DECISION_TAGS,
  LANGUAGE_NAMES,
  checkFacetId,
  editDistance,
  detectLanguage,
  backticked,
  pathsIn,
  makeFacet,
  orderFacets,
  applyBudget,
  belongsTo,
  fold,
};
