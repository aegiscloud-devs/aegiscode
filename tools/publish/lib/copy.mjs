/**
 * The copy layer: read the campaign's real post text out of the docs.
 *
 * IT DOES NOT REWRITE THE COPY. The requirement is that the thing published is
 * the thing the campaign docs say, character for character, so this module is a
 * parser and nothing else: it extracts the fenced blocks and blockquotes the
 * docs already ship and reports them. If the docs change, the publisher
 * changes; there is no second copy of the text in this repo to drift.
 *
 * Sources, all repo-tracked:
 *   docs/launch-copy-x-youtube.md   §2.1 X thread · §3.x YouTube descriptions
 *   docs/reddit-drafts.md           §2   the 11 subreddit drafts
 *   docs/social-account-setup.md    §2.2 YouTube channel description
 *                                   §5.1-5.3 Facebook Page posts + group template
 *
 * The week of each item comes from the doc's own `utm_content` slug (`w1-...`,
 * `w3-...`): §5 of the plan is the calendar, and the copy already carries its
 * week. That is why `plan --week 3` needs no second mapping table to rot.
 */

import fs from 'node:fs';
import path from 'node:path';

export const DOC_PATHS = {
  xYoutube: 'docs/launch-copy-x-youtube.md',
  reddit: 'docs/reddit-drafts.md',
  setup: 'docs/social-account-setup.md',
};

/* ------------------------------------------------------------- helpers ---- */

function readDoc(repoRoot, rel, fsImpl) {
  try {
    return fsImpl.readFileSync(path.join(repoRoot, rel), 'utf8');
  } catch {
    return '';
  }
}

/** Slice a section: from the heading matching `headingRe` to the next heading of the same-or-higher level. */
function section(md, headingRe) {
  const lines = String(md || '').split(/\r?\n/);
  const start = lines.findIndex((l) => headingRe.test(l));
  if (start === -1) return '';
  const level = (lines[start].match(/^#+/) || ['##'])[0].length;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^(#+)\s/.exec(lines[i]);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** All fenced ``` blocks in a section, in order, without the fence lines. */
function fencedBlocks(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  let buf = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (buf === null) buf = [];
      else {
        out.push(buf.join('\n'));
        buf = null;
      }
      continue;
    }
    if (buf !== null) buf.push(line);
  }
  return out;
}

function blockquoteLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*>\s?(.*)$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

/** `<week>-<asset>` → week number, or null. */
function weekFromSlug(slug) {
  const m = /(?:^|-)w(\d+)-/.exec(String(slug || ''));
  return m ? Number(m[1]) : null;
}

function firstUrl(text) {
  const m = /\bhttps?:\/\/[^\s`)]+/.exec(String(text || ''));
  return m ? m[0] : null;
}

/* ------------------------------------------------------------------ X ----- */

/**
 * §2.1 "Weekly thread — the Monday skeleton, filled in".
 * The six posts are `> N/ ...` blockquotes; wrapped lines are joined with a
 * space, and the `N/` index is kept because it is part of the published text
 * (the thread numbers its own posts).
 */
export function parseXThread(md) {
  const sec = section(md, /^###\s+2\.1\s/);
  if (!sec) return null;
  const posts = [];
  const parts = sec.split(/^\*\*Post\s+(\d+)\/\*\*/m);
  for (let i = 1; i < parts.length; i += 2) {
    const index = Number(parts[i]);
    const body = parts[i + 1] || '';
    const lines = blockquoteLines(body);
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    posts.push({ index, text });
  }
  const slug = /`(w\d+-launch-thread)`/.exec(sec);
  return { posts, week: weekFromSlug(slug ? slug[1] : 'w1-launch-thread') };
}

/* ------------------------------------------------------------- YouTube ---- */

/** §2.2 of the setup doc: the channel description block. */
export function parseYouTubeChannel(setupMd) {
  const sec = section(setupMd, /^###\s+2\.2\s/);
  if (!sec) return null;
  const blocks = fencedBlocks(sec);
  if (blocks.length === 0) return null;
  return {
    description: blocks[0].trim(),
    slug: firstUrl(sec) || null,
    week: 0,
  };
}

/** §3.x video sections: title, utm slug, description. */
export function parseYouTubeVideos(md) {
  const out = [];
  const lines = String(md || '').split(/\r?\n/);
  const headings = [];
  lines.forEach((l, i) => {
    const m = /^###\s+Video\s+(\d+)\s+—\s+(.*)$/.exec(l);
    if (m) headings.push({ i, n: Number(m[1]), name: m[2].trim() });
  });
  for (let h = 0; h < headings.length; h += 1) {
    const from = headings[h].i;
    const to = h + 1 < headings.length ? headings[h + 1].i : lines.length;
    const body = lines.slice(from, to).join('\n');
    const beforeFence = body.split(/^\s*```/m)[0];
    // Video 3 declares two titles: the first is reassigned to video 5 in prose
    // ("→ use for video 5; for this one use:"), so the LAST backticked title
    // before utm_content is the real one.
    const titleBlock = beforeFence.split(/\*\*utm_content:\*\*/)[0];
    const candidates = [...titleBlock.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    const title = candidates.length ? candidates[candidates.length - 1] : null;
    const slug = /\*\*utm_content:\*\*\s*`([^`]+)`/.exec(body);
    const blocks = fencedBlocks(body);
    if (!title || blocks.length === 0) continue;
    out.push({
      n: headings[h].n,
      name: headings[h].name,
      title,
      slug: slug ? slug[1] : null,
      week: weekFromSlug(slug ? slug[1] : ''),
      description: blocks[0].trim(),
    });
  }
  return out;
}

/* -------------------------------------------------------------- Reddit ---- */

/** §2 drafts. Title is the body's first `Title:` line, kept out of the body. */
export function parseRedditDrafts(md) {
  const out = [];
  const lines = String(md || '').split(/\r?\n/);
  const headings = [];
  lines.forEach((l, i) => {
    const m = /^###\s+Draft\s+(\d+)\s+—\s+r\/(\S+)\s*$/.exec(l);
    if (m) headings.push({ i, n: Number(m[1]), subreddit: m[2].trim() });
  });
  for (let h = 0; h < headings.length; h += 1) {
    const from = headings[h].i;
    const to = h + 1 < headings.length ? headings[h + 1].i : lines.length;
    const body = lines.slice(from, to).join('\n');
    const blocks = fencedBlocks(body);
    if (blocks.length === 0) continue;
    const raw = blocks[0].replace(/\s+$/, '');
    const textLines = raw.split('\n');
    const titleIdx = textLines.findIndex((l) => /^Title:\s*/.test(l));
    if (titleIdx === -1) continue;
    const title = textLines[titleIdx].replace(/^Title:\s*/, '').trim();
    const text = textLines.slice(titleIdx + 1).join('\n').replace(/^\n+/, '');
    const headerText = body.split(/^\s*```/m)[0];
    const slug = /`(w\d+-reddit-[a-z0-9-]+)`/i.exec(headerText);
    const format = /\*\*Format:\*\*\s*([^.*]+)/.exec(headerText);
    out.push({
      n: headings[h].n,
      subreddit: headings[h].subreddit,
      title,
      text,
      slug: slug ? slug[1] : null,
      week: weekFromSlug(slug ? slug[1] : ''),
      format: format ? format[1].trim() : null,
      imagePost: /image post/i.test(headerText),
    });
  }
  return out;
}

/* ------------------------------------------------------------ Facebook ---- */

/** §5.1/§5.2 Page posts and §5.3 group template. */
export function parseFacebook(setupMd) {
  const page = [];
  for (const [n, headingRe] of [
    [1, /^###\s+5\.1\s/],
    [2, /^###\s+5\.2\s/],
  ]) {
    const sec = section(setupMd, headingRe);
    if (!sec) continue;
    const blocks = fencedBlocks(sec);
    if (blocks.length === 0) continue;
    const asset = /docs\/marketing-assets\/[A-Za-z0-9._-]+\.png/.exec(sec);
    page.push({
      n,
      text: blocks[0].trim(),
      commentLink: firstUrl(sec.replace(/\n> /g, '\n')),
      asset: asset ? asset[0] : null,
      week: n === 1 ? 0 : 1,
    });
  }
  const groupSec = section(setupMd, /^###\s+5\.3\s/);
  const groupBlocks = fencedBlocks(groupSec);
  return {
    page,
    group: groupBlocks.length
      ? { text: groupBlocks[0].trim(), targets: ['Local LLM / AI Enthusiasts'] }
      : null,
  };
}

/* ---------------------------------------------------------------- load ---- */

/** Read and parse every source doc once. */
export function loadCopy({ repoRoot, fsImpl = fs } = {}) {
  const root = repoRoot || process.cwd();
  const xy = readDoc(root, DOC_PATHS.xYoutube, fsImpl);
  const rd = readDoc(root, DOC_PATHS.reddit, fsImpl);
  const su = readDoc(root, DOC_PATHS.setup, fsImpl);
  return {
    repoRoot: root,
    missing: Object.entries(DOC_PATHS)
      .filter(([, rel]) => !fsImpl.existsSync(path.join(root, rel)))
      .map(([, rel]) => rel),
    x: parseXThread(xy),
    youtube: {
      channel: parseYouTubeChannel(su),
      videos: parseYouTubeVideos(xy),
    },
    reddit: { drafts: parseRedditDrafts(rd) },
    facebook: parseFacebook(su),
  };
}

/** Character budgets per surface (platform limits, enforced by `plan`). */
export const CHAR_LIMITS = {
  'x-post': 280,
  'youtube-description': 5000,
  'youtube-title': 100,
  'youtube-channel-description': 1000,
  'reddit-title': 300,
  'reddit-body': 40000,
  'facebook-post': 63206,
  'facebook-group-post': 63206,
};

/**
 * Flatten one week into the publishable items, with the surface each one lands
 * on. Weeks come from the docs' own slugs; anything the docs do not carry is
 * reported as absent rather than invented.
 *
 * @returns {Array<object>} items
 */
export function itemsForWeek(copy, week = 1) {
  const items = [];
  const wantWeek = Number(week);

  const thread = copy.x;
  if (thread && thread.week === wantWeek) {
    thread.posts.forEach((p, i) => {
      items.push({
        id: `x-thread-${p.index}`,
        channel: 'x',
        surface: 'x-post',
        label: `X thread post ${p.index}/ (${i + 1} of ${thread.posts.length})`,
        text: p.text,
        charLimit: CHAR_LIMITS['x-post'],
        planRef: 'docs/marketing-plan-social.md §4.2 / docs/launch-copy-x-youtube.md §2.1',
        replyToPrevious: i > 0,
      });
    });
  }

  const yt = copy.youtube;
  if (yt.channel && wantWeek === 0) {
    items.push({
      id: 'youtube-channel-description',
      channel: 'youtube',
      surface: 'youtube-channel-description',
      label: 'YouTube channel description (§2.2 copy, channels.update)',
      text: yt.channel.description,
      charLimit: CHAR_LIMITS['youtube-channel-description'],
      planRef: 'docs/social-account-setup.md §2.2',
    });
  }
  for (const v of yt.videos) {
    if (v.week !== wantWeek) continue;
    items.push({
      id: `youtube-video-${v.n}`,
      channel: 'youtube',
      surface: 'youtube-description',
      label: `YouTube video ${v.n} — ${v.name}`,
      title: v.title,
      text: v.description,
      charLimit: CHAR_LIMITS['youtube-description'],
      requiresVideoFile: true,
      media: 'a recorded cut (docs/marketing-plan-social.md §3 R1–R5)',
      planRef: 'docs/marketing-plan-social.md §4.1 / docs/launch-copy-x-youtube.md §3',
    });
  }

  for (const d of copy.reddit.drafts) {
    if (d.week !== wantWeek) continue;
    items.push({
      id: `reddit-draft-${d.n}-${d.subreddit.toLowerCase()}`,
      channel: 'reddit',
      surface: 'reddit-post',
      label: `Reddit r/${d.subreddit} — draft ${d.n}`,
      subreddit: d.subreddit,
      title: d.title,
      text: d.text,
      charLimit: CHAR_LIMITS['reddit-body'],
      imagePost: d.imagePost,
      media: d.imagePost ? 'docs/marketing-assets/01-model-class-picker.png' : null,
      planRef: 'docs/marketing-plan-social.md §4.3 / docs/reddit-drafts.md §2',
    });
  }

  if (wantWeek === 1) {
    for (const p of copy.facebook.page) {
      items.push({
        id: `facebook-page-post-${p.n}`,
        channel: 'facebook',
        surface: 'facebook-page-post',
        label: `Facebook Page post ${p.n}`,
        text: p.text,
        charLimit: CHAR_LIMITS['facebook-post'],
        commentLink: p.commentLink,
        media: p.asset,
        planRef: 'docs/social-account-setup.md §5.' + p.n,
      });
    }
  }

  if (wantWeek >= 2 && copy.facebook.group) {
    const g = copy.facebook.group;
    items.push({
      id: 'facebook-group-post',
      channel: 'facebook',
      surface: 'facebook-group-post',
      group: g.targets[0],
      label: `Facebook group post (template §5.3) — ${g.targets[0]}`,
      text: g.text,
      charLimit: CHAR_LIMITS['facebook-group-post'],
      groupTargets: g.targets,
      planRef: 'docs/marketing-plan-social.md §4.4 / docs/social-account-setup.md §5.3',
    });
  }

  return items;
}
