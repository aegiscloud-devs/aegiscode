#!/usr/bin/env node
/**
 * The "where do I get a key" link, in BOTH clients — the constant desktop
 * prints, and the one the CLI prints, asserted against each other.
 *
 * Why this file exists: desktop/renderer/app.js says
 *
 *   // KEEP IN SYNC with the CLI's twin (cli/src/signup.js, SIGNUP_SOURCE) —
 *   // desktop/test/renderer-key-link.test.mjs fails if the two diverge.
 *
 * and for one revision that comment cited a test that did not exist. A comment
 * promising a guard is worse than no comment: the next person reads it, edits
 * the constant, and trusts a red run that can never come. This is that test.
 *
 * The bug being pinned (fixed in this change set): every prompt that told a
 * user with no key where to get one printed the bare marketing homepage —
 * `https://aegiscloud.org` — which carries no register panel, no route to the
 * page that actually *displays* the key, and, with no UTM, no way for aegis1 to
 * credit the signup to the app that sent it. The single highest-intent moment
 * in a fresh install dead-ended, and the resulting signups were filed as
 * 'direct'. The fix is a server-expanded short link,
 * `https://aegiscloud.org/key?s=desktop&c=key_prompt`, whose `/key` route on
 * aegis1 (`key_short_link`) 302s into
 * `/login?next=%2Fapi-keys&utm_source=desktop&utm_medium=app&utm_campaign=…#register`.
 *
 * What is asserted, and why each is a rule rather than a detail:
 *
 *   1. The constant is NOT the bare homepage. `pathname !== '/'`. This is the
 *      regression: everything else here can stay green while the link points at
 *      a page with no key on it, which is the state that shipped.
 *   2. Desktop and CLI agree on origin and path, and DIFFER on `s`. Agreement on
 *      the first two is what "keep in sync" means — a fix to `/key` that lands
 *      in one client and not the other splits the funnel in half and is exactly
 *      the drift the comment promised to catch. Difference on `s` is the other
 *      half: one shared channel value would silently merge the two clients into
 *      one number and make "which surface converts" unanswerable.
 *   3. The channel is on aegis1's SIGNUP_SOURCES allowlist — checked against the
 *      real `_sanitize_signup_source` tuple when the aegis1 tree is present
 *      beside this repo (it is on the dev box; it is not in CI, and that skip is
 *      printed rather than silent). This is the assertion with the sharpest
 *      failure mode: a channel missing from that tuple is not an error anywhere,
 *      it just files every signup as 'direct' and reports the channel as zero.
 *      One line, no crash, no datapoint.
 *   4. The campaign slug survives aegis1's `_sanitize_signup_slug` regex — read
 *      from the CLI's exported CAMPAIGN_RE rather than copied, so the two
 *      sanitisers cannot disagree. An unsanitised campaign is dropped, which
 *      reports one prompt as unattributed instead of reporting the wrong one.
 *   5. No bare `https://aegiscloud.org` literal is left assigned to an anchor,
 *      and the two quoted literals in app.js are exactly the two declared
 *      constants. This is what stops the bug from coming back one prompt at a
 *      time: an inline homepage URL added to a new prompt fails here instead of
 *      being discovered by reading the funnel three weeks later.
 *   6. The display text of the key link and the CLI's scheme-less printed form
 *      are the CLI's problem, not this file's: the CLI prints a URL the user has
 *      to TYPE, so its width budget is pinned by test/cli-onboarding.test.mjs,
 *      which measures the rendered row. What is checked here is only that the
 *      scheme-less form still carries `s=cli` — dropping the channel to save
 *      cells would buy two columns at the cost of the measurement it exists for.
 *
 * Loaded the way the rest of this repo loads renderer code (test/renderer-dom
 * .test.mjs, test/renderer-welcome.test.mjs): app.js is an IIFE that calls
 * init() at load and only runs under Electron, so it is parsed and the two
 * constants are SLICED out as written — a rename breaks this file loudly rather
 * than asserting against a hand-copied string.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const appPath = join(here, '..', 'renderer', 'app.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const src = readFileSync(appPath, 'utf8');

/** A top-level `const NAME = '<literal>';` as written, so the value under test
 *  is the one that ships rather than a copy that can drift. */
function sliceStringConst(name) {
  const m = new RegExp(`^const ${name} = '([^']*)';$`, 'm').exec(src);
  assert(m, `app.js must declare ${name} as a single-quoted string literal`);
  return m[1];
}

const KEY_URL = sliceStringConst('GET_AEGIS_KEY_URL');
const SUBSCRIBE_URL = sliceStringConst('AEGIS_SUBSCRIBE_URL');

// The CLI's twin. `cli/` has no "type" field, so signup.js is CommonJS — hence
// createRequire from an .mjs file rather than an import.
const cli = require(join(here, '..', '..', 'cli', 'src', 'signup.js'));

const parsed = (u) => new URL(u);

// ===================== 1. the regression: not the bare homepage, keyed page
{
  const url = parsed(KEY_URL);
  assert(
    url.pathname !== '/' && url.pathname !== '',
    `the key link must not be the bare homepage — that page has no register panel and no key on it (got ${KEY_URL})`
  );
  assert(url.protocol === 'https:', `the key link must be https (got ${url.protocol})`);
  assert(
    url.toString() === KEY_URL,
    `the key link must be a canonical URL — the printed/copyable form relies on it (got ${KEY_URL})`
  );
}

// ============ 2. desktop and CLI agree on the route, differ on the channel
{
  const url = parsed(KEY_URL);
  assert(
    url.origin === cli.SIGNUP_ORIGIN,
    `desktop and CLI must point at the same origin: desktop says ${url.origin}, cli/src/signup.js says ${cli.SIGNUP_ORIGIN}`
  );
  assert(
    url.pathname === cli.SIGNUP_PATH,
    `desktop and CLI must use the same short route: desktop says ${url.pathname}, cli/src/signup.js says ${cli.SIGNUP_PATH}`
  );

  // Same shape as the CLI's own builder, so a change to signupUrl()'s parameter
  // names (s/c) fails here rather than at the funnel.
  const cliUrl = parsed(cli.signupUrl('key_screen'));
  assert(
    [...url.searchParams.keys()].sort().join(',') === [...cliUrl.searchParams.keys()].sort().join(','),
    `desktop and CLI must send the same parameter names (desktop: ${[...url.searchParams.keys()]}, cli: ${[...cliUrl.searchParams.keys()]})`
  );

  const desktopSource = url.searchParams.get('s');
  assert(desktopSource, 'the desktop link must name its channel in `s`');
  assert(
    desktopSource !== cli.SIGNUP_SOURCE,
    `desktop and CLI must file under DIFFERENT channels — one shared value merges the two surfaces into a single unattributable number (both are ${desktopSource})`
  );
  assert(
    /^[a-z0-9][a-z0-9_-]*$/.test(desktopSource),
    `the channel must be a slug aegis1 will accept (got ${desktopSource})`
  );
}

// ============ 3. the channel is on aegis1's allowlist (skipped without it)
//
// The failure this catches makes no noise: `_sanitize_signup_source` returns
// 'direct' for anything unrecognised, so a channel missing from SIGNUP_SOURCES
// is not a 500, not a log line — it is a zero in a dashboard.
{
  const aegis1 = join(here, '..', '..', '..', 'aegis1', 'app.py');
  if (existsSync(aegis1)) {
    const app = readFileSync(aegis1, 'utf8');
    const tuple = /^SIGNUP_SOURCES = \(([^)]*)\)/m.exec(app);
    assert(tuple, 'aegis1/app.py must declare SIGNUP_SOURCES as a tuple of channel slugs');
    const allowed = tuple[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    for (const channel of [parsed(KEY_URL).searchParams.get('s'), cli.SIGNUP_SOURCE]) {
      assert(
        allowed.includes(channel),
        `aegis1 SIGNUP_SOURCES must include '${channel}' or every signup from it files as 'direct' (allowlist: ${allowed.join(', ')})`
      );
    }
    // And the route the link depends on must exist, since the whole design is
    // that the expansion happens server-side: the client only has to get one
    // short URL right, and a copy change ships without an npm release.
    assert(
      app.includes(`KEY_SHORT_PATH = "${cli.SIGNUP_PATH}"`),
      `aegis1 must define KEY_SHORT_PATH = "${cli.SIGNUP_PATH}" — the link expands there, not in the clients`
    );
  } else {
    console.log(`SKIP: ${aegis1} not present — channel allowlist not verified against aegis1`);
  }
}

// ============ 4. the campaign survives aegis1's slug sanitiser
{
  const campaign = parsed(KEY_URL).searchParams.get('c');
  assert(campaign, 'the desktop key link must name the prompt that printed it, or its clicks cannot be compared to another prompt');
  assert(
    cli.CAMPAIGN_RE.test(campaign),
    `the campaign must pass aegis1's slug sanitiser (${cli.CAMPAIGN_RE}); '${campaign}' does not, and would report as unattributed`
  );
}

// ============ 5. no bare homepage href, and no third URL constant
{
  const bareHref = /\.href\s*=\s*['"]https:\/\/aegiscloud\.org\/?['"]/g;
  assert(
    !bareHref.test(src),
    'no anchor may point at the bare homepage — that is the dead end this change removed'
  );

  // Every quoted aegiscloud.org URL in app.js must be one of the two declared
  // constants. A new inline URL in a new prompt is the bug returning.
  const literals = [...src.matchAll(/['"](https:\/\/aegiscloud\.org[^'"]*)['"]/g)].map((m) => m[1]);
  const declared = [KEY_URL, SUBSCRIBE_URL];
  const stray = literals.filter((u) => !declared.includes(u));
  assert(
    stray.length === 0,
    `every URL in app.js must be GET_AEGIS_KEY_URL or AEGIS_SUBSCRIBE_URL — untagged/stray: ${stray.join(', ')}`
  );

  // Both the prompts that offer a key use the constant. A floor, not an exact
  // count: dropping a prompt should force someone to read this line, not pass
  // silently.
  const uses = [...src.matchAll(/\.href\s*=\s*GET_AEGIS_KEY_URL;/g)].length;
  assert(
    uses >= 2,
    `both key prompts (welcome hint + model hint) must use GET_AEGIS_KEY_URL (found ${uses} uses)`
  );

  // The upgrade/checkout link carries the same channel, for the same reason:
  // a bare /subscribe click cannot be credited to the app. Server-supplied
  // upgradeUrls are intentionally untagged and expected to win at the call
  // sites — only this fallback is asserted.
  const sub = parsed(SUBSCRIBE_URL);
  assert(sub.origin === cli.SIGNUP_ORIGIN, `AEGIS_SUBSCRIBE_URL must stay on ${cli.SIGNUP_ORIGIN}`);
  assert(
    sub.searchParams.get('utm_source') === parsed(KEY_URL).searchParams.get('s'),
    'the subscribe fallback must be tagged with the same channel as the key link, or the two appear as different apps'
  );
  assert(sub.searchParams.get('utm_medium') === 'app', 'the subscribe fallback must carry utm_medium=app');
}

// ============ 6. the CLI's scheme-less printed form keeps its channel
{
  const display = cli.signupDisplayUrl('welcome');
  assert(
    !/^https?:\/\//.test(display),
    `signupDisplayUrl() exists to fit the welcome row's width budget — it must be scheme-less (got ${display})`
  );
  assert(
    parsed(`https://${display}`).searchParams.get('s') === cli.SIGNUP_SOURCE,
    `the printed form must keep s=${cli.SIGNUP_SOURCE}: it is the only thing that makes the signup attributable, and the scheme is the cheaper thing to drop`
  );
  assert(
    parsed(`https://${display}`).origin + parsed(`https://${display}`).pathname ===
      `${cli.SIGNUP_ORIGIN}${cli.SIGNUP_PATH}`,
    'the printed form must be the same host and route as the clickable form, not a second URL that can drift'
  );
  // And an invalid campaign is dropped rather than sent — a link that records
  // the WRONG prompt is worse than one that records none.
  assert(
    !parsed(cli.signupUrl('Not A Slug!')).searchParams.has('c'),
    'a campaign that would not survive aegis1 sanitising must be dropped, not sent'
  );
  assert(
    parsed(cli.signupUrl('key_screen')).searchParams.get('c') === 'key_screen',
    'a valid campaign must survive to the URL'
  );
}

console.log('OK: renderer key link matches the CLI twin and points at the key, not the homepage');
