/**
 * The one place the CLI tells a user where to get an account key.
 *
 * Every prompt used to say "free at https://aegiscloud.org" — the marketing
 * homepage. No registration panel, no route to the page that shows the key,
 * and (because the landing URL carried no UTM) no way for aegis1 to tell the
 * signup came from the CLI at all. That is a round trip the user has to
 * complete unaided, at the exact moment they have already decided to keep the
 * tool: the prompts were the top of the funnel and they dead-ended.
 *
 * So the prompt now prints a short, typeable deep link instead:
 *
 *     https://aegiscloud.org/key?s=cli&c=key_screen
 *
 * `/key` is a real aegis1 route (app.py `key_short_link`) that expands —
 * server-side — into the register panel plus the key page, with the channel
 * UTMs attached. Two consequences worth knowing before editing anything here:
 *
 *   - `s=cli` must stay in aegis1's SIGNUP_SOURCES or the signup is filed as
 *     'direct' and this channel looks dead in the funnel. `s` is deliberately
 *     not caller-supplied: one wrong value silently zeroes the channel.
 *   - the URL is displayed, not just linked, so it has to stay short enough
 *     not to wrap in an 80-column terminal. That is the whole reason the
 *     expansion is a server-side redirect rather than a long query string: the
 *     full form is 108 chars and shears across lines.
 *
 * `campaign` is the prompt that printed the link, so prompts can be compared
 * against each other instead of reported as one number. Unknown or absent
 * campaigns are simply not sent — unattributed is a missing datapoint, never a
 * wrong one.
 */

const SIGNUP_ORIGIN = 'https://aegiscloud.org';

/** The short aegis1 route that expands to "register, then show me my key". */
const SIGNUP_PATH = '/key';

/** The channel every CLI signup is filed under in aegis1 (SIGNUP_SOURCES). */
const SIGNUP_SOURCE = 'cli';

/** Bare `https://aegiscloud.org` for copy about the project rather than the
 *  key — the docs/troubleshooting links in system.js want the homepage. */
const HOME_URL = SIGNUP_ORIGIN;

/** Longest campaign slug aegis1 will record (`_sanitize_signup_slug`). */
const CAMPAIGN_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The deep link to show a user who has no key.
 *
 * A campaign that would not survive aegis1's slug sanitiser is dropped rather
 * than sent: a link that records nothing is honest, a link that records the
 * wrong prompt is not.
 */
function signupUrl(campaign) {
  const url = new URL(SIGNUP_ORIGIN + SIGNUP_PATH);
  url.searchParams.set('s', SIGNUP_SOURCE);
  const slug = campaign === undefined || campaign === null ? '' : String(campaign).trim().toLowerCase();
  if (CAMPAIGN_RE.test(slug)) url.searchParams.set('c', slug);
  return url.toString();
}

/**
 * Any other aegiscloud.org page the CLI links to, tagged with the same
 * channel so the visit is attributable if it ends in a signup.
 *
 * aegis1's first-touch hook stores the UTMs on whichever page the visitor
 * lands on, so a tagged link to the desktop page or the subscribe page is
 * enough for the signup it eventually produces to be credited to the CLI —
 * no separate route needed, unlike the key link above.
 */
function link(path, campaign) {
  const url = new URL(SIGNUP_ORIGIN + (String(path).startsWith('/') ? path : `/${path}`));
  url.searchParams.set('utm_source', SIGNUP_SOURCE);
  url.searchParams.set('utm_medium', 'app');
  const slug = campaign === undefined || campaign === null ? '' : String(campaign).trim().toLowerCase();
  if (CAMPAIGN_RE.test(slug)) url.searchParams.set('utm_campaign', slug);
  return url.toString();
}

/**
 * The printed form of the same link: scheme-less.
 *
 * Not cosmetic, and not a second URL — it is `signupUrl()` with the `https://`
 * stripped, so the host, the route and the channel still come from one place.
 * It exists because the welcome screen's connect row wraps its text at
 * `cols - 4 - indent` (screens.js `wrapped()`), which is 75 cells at 80
 * columns, and the row's copy already spends 45 of them:
 *
 *     AEGIS Desktop: same engine on your machine — <url>
 *
 *   https://aegiscloud.org/key?s=cli            -> 77 cells, wraps
 *   aegiscloud.org/key?s=cli                    -> 69 cells, fits
 *
 * A wrapped row is not just ugly there: the welcome screen fills 23 of an
 * 80x24 terminal's 24 rows, so the extra line pushes the footer hint off the
 * bottom (test/cli-onboarding.test.mjs measures it). Given that, the scheme is
 * the cheapest thing to lose — a browser prepends it when the user pastes, and
 * `aegiscloud.org/teleport` is already printed this way in commands.js — while
 * `s=cli` is not, because dropping that files the signup as 'direct'.
 *
 * Screens with room for the real thing (the key screen puts the link on its
 * own row) must use `signupUrl()`.
 */
function signupDisplayUrl(campaign) {
  return signupUrl(campaign).replace(/^https?:\/\//, '');
}

/** aegis1's paid-prompt indirection: `/go/<page>` (app.py `GO_TARGETS`). */
const GO_PATH = '/go/';

/**
 * A paid prompt's destination, in the short form `/go/<page>` documents.
 *
 * Deliberately NOT `link()`, and this is the whole reason the function exists.
 * `link()` appends the wire names (`utm_source`/`utm_campaign`) because
 * aegis1's first-touch hook reads those off whichever page the visitor lands
 * on. `/go/<page>` is not that kind of link: it is a redirect, and it reads the
 * short names (`s`/`c`) and re-emits the wire names itself.
 *
 * Sending wire names to `/go/` does not fail loudly. It fails silently, in the
 * worst available way — the route finds no `s`, files the click as 'direct',
 * drops the campaign, and the client that sent it reads as zero conversions
 * while the link still visibly works. Measured against a real app instance:
 *
 *     /go/upgrade?s=cli&c=memory_quota   -> ?utm_source=cli&utm_campaign=memory_quota
 *     /go/upgrade?utm_source=cli&...     -> ?utm_source=direct&utm_medium=app
 *
 * The route now also accepts the wire names as a fallback, so that mistake can
 * no longer zero a channel — but the short form is still what to send, and not
 * only for correctness: it is ~40 cells shorter, on rows that `padLine()`
 * truncates rather than wraps (see `signupDisplayUrl()` above).
 */
function goUrl(page, campaign) {
  const slug = String(page == null ? '' : page).trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  const url = new URL(SIGNUP_ORIGIN + GO_PATH + slug);
  url.searchParams.set('s', SIGNUP_SOURCE);
  const c = campaign === undefined || campaign === null ? '' : String(campaign).trim().toLowerCase();
  if (CAMPAIGN_RE.test(c)) url.searchParams.set('c', c);
  return url.toString();
}

module.exports = {
  signupUrl,
  signupDisplayUrl,
  goUrl,
  link,
  HOME_URL,
  SIGNUP_SOURCE,
  SIGNUP_PATH,
  SIGNUP_ORIGIN,
  CAMPAIGN_RE,
};
