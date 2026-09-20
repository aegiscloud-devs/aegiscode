'use strict';

/**
 * The direct-dial policy: which base URLs may reach a provider transport, and
 * why that is the only free lane left.
 *
 * Both hosts that can talk to a user-supplied endpoint — the desktop app
 * (settings pane → 'openai-compat' / 'anthropic' classes) and the CLI
 * (src/engine.js prepareCustom, the `/model add` catalog) — share THIS file
 * rather than a copy each. The CLI vendors `desktop/lib/local/` wholesale and
 * resolves this module through src/sharedpaths.js, so the two hosts cannot
 * drift apart about what "local" means or which error a remote URL gets. A
 * second implementation is how one host would keep billing correctly while the
 * other quietly served unpaid traffic.
 *
 * The rule: every lane that can bill does. `aegis` is the pooled route (the
 * account key is attached and the pool takes its margin); `byok` is the relay
 * (`services/pricing.price_byok_call` → `token_bank.charge_byok`, the AEGIS
 * handling fee, charged against the account resolved from `X-AEGIS-Key`). The
 * provider transports in providers.js bill NOTHING — they are a direct dial to
 * whoever owns the URL — so the only usage they may carry is an endpoint on
 * this machine, where there is no vendor to pay in the first place.
 *
 * That is why a remote base URL is refused rather than metered: the relay
 * accepts a fixed catalog of provider ids (`services/nexus_provider/catalog.py`,
 * upstream key read from `X-Provider-Key`), so an arbitrary remote URL has
 * nothing to be billed against even if a client wanted to invoice it. Remote
 * providers belong on BYOK, which bills. There is deliberately no flag or env
 * var that re-opens the direct lane for a remote URL, because such a flag would
 * be a billing bypass.
 *
 * Where the gate lives — the seams, not the transport:
 *   · desktop/lib/settings.js   `set()` refuses to STORE a remote base URL, so
 *                              the unusable configuration cannot be created.
 *   · desktop/lib/local/engine.js  `chat()` refuses to DIAL one before any
 *                              transport call (a row hand-edited into the
 *                              settings file, or written before this policy
 *                              existed, still cannot be used).
 *   · cli/src/custommodels.js  refuses one at `/model add` and again at
 *                              dispatch, for the same two reasons.
 * providers.js itself stays policy-free: it is a wire-format function, and
 * pinning the policy there would make it unreachable for the tests that check
 * URL building. Same split the BYOK balance gate uses — the relay owns the
 * decision, the client refuses to send.
 */

/** Host of a URL, lower-cased, or '' if it does not parse. */
function hostOf(url) {
  try {
    return new URL(String(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Whether a base URL addresses an endpoint on this machine — the gate that
 * decides whether the free direct lane is available at all.
 *
 * True for: loopback (localhost, `*.localhost`, 127.0.0.0/8, `::1`), RFC1918
 * private ranges (10/8, 172.16/12, 192.168/16), IPv6 unique-local fc00::/7,
 * link-local (169.254/16, fe80::/10), the reserved local suffixes `.local`,
 * `.internal`, `.lan`, and a bare dotless hostname (`ollama`, `gpu-box` — it
 * can only resolve through this machine's own resolver).
 *
 * FAIL CLOSED: anything that does not parse, carries no host, is a public
 * address or name, or is merely ambiguous is NOT local. That direction is the
 * whole point — a false "local" is an unpaid turn, a false "remote" is a
 * refusal the user can fix by pointing at a local address or by moving to the
 * billed lane, which is the outcome we want in a tie.
 */
function isLocalEndpoint(url) {
  let host = '';
  let scheme = '';
  try {
    const parsed = new URL(String(url == null ? '' : url));
    host = parsed.hostname.toLowerCase();
    scheme = parsed.protocol.toLowerCase();
  } catch {
    return false;
  }
  // Only a base URL a transport can actually dial. The transports in
  // providers.js append '/chat/completions' and fetch it, so anything that is
  // not http(s) — or has no scheme at all — is not an endpoint, and is refused
  // by the same fail-closed rule as an unparseable value. Checked before the
  // host, so `ftp://box.local` cannot ride the local suffix to a pass.
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  if (!host) return false;
  // WHATWG keeps the brackets on an IPv6 hostname; strip them so one spelling
  // covers both `[::1]` and a bare `::1`.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s/\\@]/.test(host)) return false;

  // Loopback by name, plus the reserved local suffixes. `.local`/`.internal`/
  // `.lan` are the mDNS / split-DNS names an on-box service answers to. The
  // suffix must END the name: `example.local.evil.com` is somebody else's host.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan)$/.test(host)) return true;

  // IPv6 literals.
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true; // loopback
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    return false;
  }

  // IPv4 literals.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    const o = quad.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false; // not an address, and not local
    const [a, b] = o;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false; // a real, routable address — remote, and billed
  }

  // A bare, dotless hostname is local by convention (`ollama`, `llama-box`):
  // it can only resolve through this machine's own resolver or /etc/hosts.
  // Anything with a dot is a DNS name for somebody else's machine.
  return !host.includes('.');
}

/** What IS allowed here, in one sentence, shared by both hosts' refusals. */
const ALLOWED_HINT =
  'Allowed: localhost, 127.0.0.1, a private/LAN address (10.x, 172.16-31.x, 192.168.x), ' +
  '*.local/.internal/.lan, or a dotless host like "ollama".';

/**
 * The refusal a non-local base URL gets, in the words the user needs in order
 * to act: it names the offending URL, the kind of address that IS allowed, and
 * the lane that replaces this one. `hint` is the host-specific half —
 * `/class byok` in the terminal, the Bring-your-own-key Settings row in the
 * GUI — while the policy half is shared, so the two hosts cannot describe the
 * same rule differently.
 */
function remoteRefusal(baseURL, { subject = 'custom endpoints', hint = '' } = {}) {
  const where = String(baseURL == null ? '' : baseURL);
  const tail = hint || 'Remote providers are billed, so use the lane that bills them, or point this at a local address.';
  return `${subject} must be LOCAL — remote base URL ${JSON.stringify(where)} is not offered on this lane. ` +
    `${ALLOWED_HINT} ${tail}`;
}

/**
 * Throw the refusal (as a 400-class error every caller already paints) unless
 * the base URL is local. The one-line form of the gate for the dispatch and
 * storage seams, so neither has to remember the status code.
 *
 * An EMPTY base URL is refused here like any other non-local value, because
 * there is no endpoint to dial. The storage seam does not use this function
 * directly for that reason — see allowsDirectDialRow below, which treats "no
 * URL configured" as "nothing to gate".
 */
function ensureLocalEndpoint(baseURL, opts) {
  if (isLocalEndpoint(baseURL)) return true;
  const err = new Error(remoteRefusal(baseURL, opts));
  err.status = 400;
  err.code = 'CUSTOM_ENDPOINT_NOT_LOCAL';
  throw err;
}

/**
 * The settings-store rows whose base URL is dialled DIRECTLY by the transports
 * in providers.js — i.e. the rows the gate above exists for.
 *
 *   'openai-compat', 'anthropic'  the desktop's two custom endpoints (its
 *                                 Settings pane names them exactly so, and
 *                                 engine.js's CUSTOM_CLASSES reads the row
 *                                 under the class name).
 *   'custom:*'                    the CLI's per-model namespace (src/
 *                                 custommodels.js). The CLI keeps the base URL
 *                                 in config.json `customModels` and stores only
 *                                 the KEY here, so this prefix is a second lock
 *                                 on a door that is already shut — deliberate:
 *                                 a future writer that puts a URL in this row
 *                                 must not silently reopen the lane.
 *
 * It matters that this is a NAMED list and not "every row". The same store
 * holds the billed lanes' rows, and those legitimately carry remote values or
 * nothing at all:
 *   · `byok:<provider>` — always remote by definition (the provider's own API,
 *     reached through AEGIS's relay, which is what bills it). The desktop's
 *     Settings pane saves those rows with baseURL '' (the relay owns the URL),
 *     and a blanket "must be local" rule would refuse even the empty string,
 *     breaking BYOK configuration entirely.
 *   · `aegis` — reserved namespace, never touched through this surface.
 * So a gate keyed on the value alone is wrong; it is keyed on the ROW.
 */
const DIRECT_DIAL_ROWS = Object.freeze(['openai-compat', 'anthropic']);
const DIRECT_DIAL_PREFIXES = Object.freeze(['custom:']);

/** Whether a settings-store row's base URL is dialled directly (and so gated). */
function isDirectDialRow(provider) {
  const p = String(provider == null ? '' : provider);
  if (DIRECT_DIAL_ROWS.includes(p)) return true;
  return DIRECT_DIAL_PREFIXES.some((pre) => p.startsWith(pre));
}

/**
 * Whether a row may STORE this base URL — the storage seam's question, which is
 * not quite the dispatch seam's.
 *
 * A direct-dial row with no URL is fine to store: that is how a row is cleared,
 * and how it looks before it is configured (`customStatus` reports it as
 * unconfigured, so nothing dials it). What must never be stored is a NON-EMPTY
 * remote URL, which would make the row look configured and usable.
 */
function allowsDirectDialRow(provider, baseURL) {
  if (!isDirectDialRow(provider)) return true;
  const url = String(baseURL == null ? '' : baseURL).trim();
  if (!url) return true; // clearing the row, or a not-yet-configured one
  return isLocalEndpoint(url);
}

module.exports = {
  hostOf,
  isLocalEndpoint,
  remoteRefusal,
  ensureLocalEndpoint,
  isDirectDialRow,
  allowsDirectDialRow,
  ALLOWED_HINT,
  DIRECT_DIAL_ROWS,
};
