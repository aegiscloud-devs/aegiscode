/**
 * The ledger reader -- the *instrument* side of the refusal rules.
 *
 * `docs/marketing-plan-social.md` §4.3 rule 2 and §4.4 both make a channel
 * conditional on work that happens *before* the post: ten genuinely useful
 * comments in a subreddit, two weeks of participation in a Facebook group.
 * Those are only enforceable if they are recorded somewhere machine-readable,
 * so this module reads them out of `docs/marketing-log.md` -- the campaign's
 * own log file (§7 "instrument once") -- from two marked tables.
 *
 * The markers exist because the log is prose first and a table second: a
 * heading can be reworded, an HTML comment survives. If a marker is missing the
 * reader returns zero rows, which closes the corresponding gate. That is the
 * fail-closed direction: an unreadable instrument must never read as "enough".
 *
 * Nothing here invents a row. An empty table is the honest state of the
 * campaign today and it is why Reddit link posts and Facebook group posts are
 * refused.
 */

import fs from 'node:fs';
import path from 'node:path';

export const COMMENT_MARKER = 'publish-ledger:comments';
export const FB_GROUP_MARKER = 'publish-ledger:fb-groups';

export const LOG_RELATIVE_PATH = 'docs/marketing-log.md';

/** Rows whose first cell is one of these are placeholders, not records. */
const EMPTY_CELL_RE = /^(|—|-|--|n\/?a|none|\(none( yet)?\))$/i;

function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
  return cells;
}

function isSeparator(cells) {
  return cells.every((c) => /^:?-{2,}:?$/.test(c));
}

/** Normalise a subreddit name: `r/LocalLLaMA`, `LocalLLaMA` → `localllama`. */
export function normalizeSubreddit(name) {
  return String(name || '')
    .trim()
    .replace(/^\/?r\//i, '')
    .toLowerCase();
}

/** Normalise a Facebook group name: case/space insensitive. */
export function normalizeGroup(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function rowsAfterMarker(lines, marker) {
  const start = lines.findIndex((l) => l.includes(marker));
  if (start === -1) return null;
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes('publish-ledger:')) break;
    if (line.trim().startsWith('#')) break;
    const cells = splitRow(line);
    if (!cells) {
      // A blank line directly after the table ends the block; blank lines
      // inside are tolerated by simply continuing.
      continue;
    }
    if (isSeparator(cells)) continue;
    rows.push(cells);
  }
  // Drop the header row if its first cell is the literal "date"/"group".
  return rows.filter((cells) => !/^(date|group|group name)$/i.test(cells[0] || ''));
}

/**
 * Read the ledgers.
 * @returns {{comments:Array<{date:string,subreddit:string,note:string}>,
 *            fbGroups:Array<{group:string,joined:string,note:string}>,
 *            path:string, found:{comments:boolean,fbGroups:boolean}}}
 */
export function readLedger({ repoRoot, fsImpl = fs } = {}) {
  const file = path.join(repoRoot || process.cwd(), LOG_RELATIVE_PATH);
  let text = '';
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/);

  const commentRows = rowsAfterMarker(lines, COMMENT_MARKER) || [];
  const fbRows = rowsAfterMarker(lines, FB_GROUP_MARKER) || [];

  const comments = commentRows
    .map((cells) => ({ date: cells[0] || '', subreddit: normalizeSubreddit(cells[1] || ''), note: cells[2] || '' }))
    .filter((r) => r.subreddit && !EMPTY_CELL_RE.test(r.subreddit));

  const fbGroups = fbRows
    .map((cells) => ({ group: normalizeGroup(cells[0] || ''), joined: cells[1] || '', note: cells[2] || '' }))
    .filter((r) => r.group && !EMPTY_CELL_RE.test(r.group));

  return {
    path: path.relative(repoRoot || process.cwd(), file) || LOG_RELATIVE_PATH,
    comments,
    fbGroups,
    found: {
      comments: commentRows !== null,
      fbGroups: fbRows !== null,
    },
  };
}

/** Comments recorded for one subreddit (§4.3 rule 2). */
export function commentCredits(ledger, subreddit) {
  const want = normalizeSubreddit(subreddit);
  return ledger.comments.filter((r) => r.subreddit === want);
}

/** Group participation row, or null. */
export function groupParticipation(ledger, group) {
  const want = normalizeGroup(group);
  return ledger.fbGroups.find((r) => r.group === want) || null;
}
