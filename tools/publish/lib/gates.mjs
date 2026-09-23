/**
 * The plan's rules, as code, failing closed.
 *
 * Four gates, in the order they can stop a post:
 *
 *   1. LAUNCH GATE  -- §6/§8. `docs/marketing-plan-social.md` §6 is the launch
 *      sequence: "Nothing in this plan works if the install hiccups." The repo
 *      already carries the index of those T-7 checks -- the verdict table in
 *      `docs/launch-readiness.md` §1 -- so the gate is read from it rather than
 *      from a new hand-flipped boolean. Any row that is FAIL or BLOCKED keeps
 *      every channel dark. A missing or unparseable index is also closed:
 *      an unreadable instrument is never evidence that the gate opened.
 *
 *   2. §8 COMPLIANCE -- the copy itself. Banned unverifiable claims, the
 *      memory-sync sentence (never "opt-in per message", L15), and the
 *      authorship disclosure §8 requires on Reddit first lines and Facebook
 *      posts. Scanned on the exact text about to be sent.
 *
 *   3. REDDIT LINK RULE -- §4.3 rule 2: ten genuinely useful comments in a
 *      subreddit *before* anything about your own product, counted from the
 *      comment ledger in docs/marketing-log.md. A draft with no URL is allowed
 *      through (that is the "comment-farming" phase itself); a draft with a URL
 *      is refused until the ledger shows the ten.
 *
 *   4. FACEBOOK GROUP RULE -- §4.4: participate in the group for two weeks
 *      before posting to it. Same ledger, dated rows, compared against the
 *      injected clock.
 *
 * Every gate returns a *reason string citing the plan section*, because the
 * refusal has to tell the operator which rule they are up against -- a bare
 * "refused" is how a fail-closed tool becomes a tool people route around.
 */

import fs from 'node:fs';
import path from 'node:path';

import { commentCredits, groupParticipation, normalizeGroup } from './ledger.mjs';

export const READINESS_RELATIVE_PATH = 'docs/launch-readiness.md';

/** A verdict cell such as `**PASS** *(re-run §9)*`. */
const VERDICT_RE = /^\s*(?:\*\*)?(PASS|FAIL|BLOCKED)(?:\*\*)?/i;

/**
 * Parse the §1 checklist index of docs/launch-readiness.md.
 * Only the Verdict column (index 2) is inspected: PASS rows legitimately
 * contain the words "FAIL -> PASS" in their evidence column.
 */
export function parseReadinessIndex(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  let inChecklist = false;
  for (const line of lines) {
    if (/^##\s+1\./.test(line)) {
      inChecklist = true;
      continue;
    }
    if (inChecklist && /^##\s+/.test(line)) break;
    if (!inChecklist) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^#?$/.test(cells[0]) || /^#$/i.test(cells[0])) continue; // header
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
    const m = VERDICT_RE.exec(cells[2] || '');
    if (!m) continue;
    rows.push({ id: cells[0], verdict: m[1].toUpperCase() });
  }
  return rows;
}

/**
 * Read the launch gate.
 * @returns {{open:boolean, reason:string, source:string, pass:number,
 *            fails:Array<{id:string,verdict:string}>, total:number}}
 */
export function readLaunchGate({ repoRoot, fsImpl = fs } = {}) {
  const file = path.join(repoRoot || process.cwd(), READINESS_RELATIVE_PATH);
  const rel = READINESS_RELATIVE_PATH;
  let text = null;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    text = null;
  }
  if (text === null) {
    return {
      open: false,
      source: rel,
      total: 0,
      pass: 0,
      fails: [],
      reason:
        `${rel} is missing, so the §6 T-7 launch index cannot be read. ` +
        `Fail-closed: every channel stays dark until the index exists and shows no FAIL/BLOCKED row.`,
    };
  }
  const rows = parseReadinessIndex(text);
  if (rows.length === 0) {
    return {
      open: false,
      source: rel,
      total: 0,
      pass: 0,
      fails: [],
      reason:
        `${rel} §1 carries no readable verdict rows. Fail-closed: the launch gate cannot be ` +
        `shown open, so nothing publishes (§6 T-7).`,
    };
  }
  const fails = rows.filter((r) => r.verdict !== 'PASS');
  const pass = rows.length - fails.length;
  if (fails.length > 0) {
    const list = fails.map((f) => `${f.id}=${f.verdict}`).join(', ');
    return {
      open: false,
      source: rel,
      total: rows.length,
      pass,
      fails,
      reason:
        `§6 T-7 launch index in ${rel} §1 has ${fails.length} unresolved row(s): ${list}. ` +
        `Fail-closed: no channel publishes while the launch sequence's own index says the launch is not ready.`,
    };
  }
  return {
    open: true,
    source: rel,
    total: rows.length,
    pass,
    fails: [],
    reason: `§6 T-7 launch index: all ${rows.length} rows PASS.`,
  };
}

/* ------------------------------------------------------------------ §8 ---- */

/**
 * §8's forbidden claims. These are the plan's own examples plus the two the
 * campaign docs correct explicitly; each entry carries the reason so a
 * refusal explains itself.
 */
export const BANNED_CLAIMS = [
  { re: /\b10x\b/i, why: '§8: no "10x faster" or any unmeasured multiplier' },
  { re: /\b100x\b/i, why: '§8: no unmeasured multipliers' },
  { re: /thousands of (users|developers|people)/i, why: '§8: no invented user counts' },
  { re: /\bmillions of\b/i, why: '§8: no invented user counts' },
  { re: /\brevolutionary\b/i, why: '§8 voice rule (reddit-drafts.md posting note): no "revolutionary"' },
  { re: /game[- ]?changing/i, why: '§8 voice rule: no unverifiable superlatives' },
  { re: /\bblazing(ly)? fast\b/i, why: '§8: no unmeasured speed claims' },
  { re: /industry[- ]leading/i, why: '§8: no unverifiable claims' },
];

/**
 * The memory-sync sentence. §8 and reddit-drafts.md L15: cloud memory sync is
 * default-ON and a Settings toggle; the retired phrasing was "opt-in per
 * message". Negations of the old phrasing are *correct* ("is not opt-in per
 * message") and must not be refused -- draft 11 uses exactly that, and a blunt
 * substring ban would have blocked a compliant post.
 */
export function memorySyncViolation(text) {
  const src = String(text || '');
  const re = /opt-in per message/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = src.slice(Math.max(0, m.index - 32), m.index);
    if (/(not|n't|no longer|never|isn't|wasn't)\s+(the\s+)?$/i.test(before)) continue;
    return '§8/L15: cloud memory sync is default-ON and a Settings toggle -- never write "opt-in per message"';
  }
  return null;
}

/**
 * Authorship disclosure (§8 "Disclose authorship everywhere"; §4.3 rule 4
 * "disclose authorship in the first line"; §4.4 groups "disclosure first").
 */
export function disclosureViolation(item) {
  const text = String(item.text || '');
  const firstLines = text.split(/\r?\n/).slice(0, 2).join('\n');
  if (item.channel === 'reddit') {
    if (!/I built this/i.test(firstLines)) {
      return '§4.3 rule 4: "I built this, so take the comparison with salt." must be the first line of a Reddit post';
    }
    return null;
  }
  if (item.surface === 'facebook-group') {
    if (!/I built this/i.test(firstLines)) {
      return '§4.4: a group post opens with the disclosure line ("Disclosure: I built this...") before anything else';
    }
    return null;
  }
  if (item.channel === 'facebook') {
    if (!/author|I built this/i.test(text)) {
      return '§8: the Page post names you as the author (the Page "About" carries it too)';
    }
    return null;
  }
  return null;
}

/** Run every §8 copy rule against one item. */
export function checkCompliance(item) {
  const violations = [];
  for (const claim of BANNED_CLAIMS) {
    if (claim.re.test(item.text || '') || claim.re.test(item.title || '')) {
      violations.push({ rule: 'banned-claim', detail: claim.why });
    }
  }
  const memory = memorySyncViolation(`${item.title || ''}\n${item.text || ''}`);
  if (memory) violations.push({ rule: 'memory-sync', detail: memory });
  const disclosure = disclosureViolation(item);
  if (disclosure) violations.push({ rule: 'disclosure', detail: disclosure });
  return { ok: violations.length === 0, violations };
}

/* -------------------------------------------------------- §4.3 / §4.4 ----- */

const URL_RE = /\bhttps?:\/\/\S+/i;

/** §4.3 rule 2. */
export function checkRedditLinkRule({ item, ledger, requiredComments = 10 }) {
  if (item.channel !== 'reddit') return { ok: true };
  if (!URL_RE.test(item.text || '')) return { ok: true };
  const subreddit = item.subreddit || '';
  const have = commentCredits(ledger, subreddit).length;
  if (have >= requiredComments) return { ok: true, have };
  return {
    ok: false,
    have,
    required: requiredComments,
    detail:
      `§4.3 rule 2 (9:1): r/${subreddit} has ${have} of the ${requiredComments} genuinely useful comments ` +
      `recorded in ${ledger.path} (marker "${'publish-ledger:comments'}"). ` +
      `This draft contains a link, so it is refused until the ledger shows ${requiredComments}. ` +
      `Post the comments first -- they carry no links.`,
  };
}

export const FB_GROUP_WARMUP_DAYS = 14;

/** §4.4. */
export function checkFacebookGroupRule({ item, ledger, now = new Date(), warmupDays = FB_GROUP_WARMUP_DAYS }) {
  if (item.surface !== 'facebook-group') return { ok: true };
  const group = item.group || '';
  const row = groupParticipation(ledger, group);
  if (!row) {
    return {
      ok: false,
      detail:
        `§4.4: "${group}" has no participation row in ${ledger.path} (marker "publish-ledger:fb-groups"). ` +
        `Join the group and participate for ${warmupDays} days before posting; a drive-by link is what ` +
        `gets the account removed from all the groups at once.`,
    };
  }
  const joined = new Date(`${row.joined}T00:00:00Z`);
  if (Number.isNaN(joined.getTime())) {
    return {
      ok: false,
      detail:
        `§4.4: the participation row for "${group}" has an unreadable joined date ("${row.joined}"). ` +
        `Fail-closed: use YYYY-MM-DD so the ${warmupDays}-day warmup can be verified.`,
    };
  }
  const days = Math.floor((now.getTime() - joined.getTime()) / 86400000);
  if (days < warmupDays) {
    return {
      ok: false,
      days,
      detail:
        `§4.4: "${group}" has ${days} day(s) of logged participation; ${warmupDays} are required before ` +
        `a group post. (Joined ${row.joined}.)`,
    };
  }
  return { ok: true, days };
}

/**
 * All gates for one item.
 * @returns {{status:'ready'|'refused', refusals:Array<{rule:string,detail:string}>}}
 */
export function evaluateItem(item, { gate, ledger, now = new Date() } = {}) {
  const refusals = [];
  if (gate && !gate.open) refusals.push({ rule: 'launch-gate', detail: gate.reason });

  const compliance = checkCompliance(item);
  for (const v of compliance.violations) refusals.push({ rule: v.rule, detail: v.detail });

  const reddit = checkRedditLinkRule({ item, ledger });
  if (!reddit.ok) refusals.push({ rule: 'reddit-link-rule', detail: reddit.detail });

  const fb = checkFacebookGroupRule({ item, ledger, now });
  if (!fb.ok) refusals.push({ rule: 'facebook-group-rule', detail: fb.detail });

  return { status: refusals.length === 0 ? 'ready' : 'refused', refusals };
}

/** Group targets from §4.4, for `check`/`plan` reporting. */
export const FB_GROUP_TARGETS = [
  'Local LLM / AI Enthusiasts',
  'Claude AI Users',
  'AI for Developers',
  'Self-Hosted AI',
  'Indie Hackers',
];

export { normalizeGroup };
