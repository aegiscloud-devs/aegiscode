'use strict';

/**
 * The named custom-model catalog behind the `custom` class.
 *
 * This is the aegiscodex-dev `/model add` concept ported into the CLI: a user
 * registers an endpoint they bring themselves — their own base URL, their own
 * model string, their own API key — and the turn is called DIRECTLY through the
 * desktop transport (desktop/lib/local/providers.js openaiCompatible /
 * anthropicMessages), the full agent loop and all, never through the pooled
 * route and never through the BYOK relay. That lane is free of AEGIS margin and
 * handling fee for exactly one reason: the request never touches
 * aegiscloud.org — and that is only defensible for an endpoint ON THIS MACHINE.
 *
 * LOCAL ENDPOINTS ONLY (the policy this module enforces, see isLocalEndpoint).
 * Every class that can bill does: `aegis` is the pooled route, `byok` is the
 * stateless relay (services/pricing.price_byok_call → token_bank.charge_byok,
 * the AEGIS handling fee). The direct transport bills nothing, so the ONLY
 * unpaid-by-design usage it may carry is a local endpoint, where there is no
 * vendor to pay in the first place. A remote base URL has nothing to bill
 * against — the relay accepts a fixed catalog of provider ids
 * (services/nexus_provider/catalog.py, key read from X-Provider-Key), so an
 * arbitrary remote URL cannot be metered there either — and it is therefore
 * REFUSED here, with a pointer at /class byok (billed) or a local address.
 * Remote endpoints are not offered on this lane at all; there is deliberately
 * no flag or env var that re-opens it, because such a flag would be a billing
 * bypass.
 *
 * Split storage, on purpose:
 *   · metadata (id, name, model, baseURL, wire) → config.json `customModels`.
 *     None of it is secret, and config.json is where /model pins already live.
 *   · the API key → the settings store under `custom:<id>` (file mode 0600,
 *     the same store byok keys use). config.json is NOT 0600 and participates in
 *     cloud sync, so a provider key must never land there.
 *
 * `wire` selects the transport: 'anthropic' → anthropicMessages (x-api-key,
 * the Messages API), 'openai' → openaiCompatible (Bearer, /chat/completions).
 * It is auto-detected from the base URL host on add, and overridable.
 */

const { loadConfig, updateConfig } = require('./config.js');

/** The settings-store row a custom model's key lives in. */
function customNamespace(id) {
  return `custom:${id}`;
}

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
 * refusal the user can fix by pointing at a local address or by moving to
 * /class byok, which bills.
 */
function isLocalEndpoint(url) {
  let host = '';
  try {
    host = new URL(String(url == null ? '' : url)).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  // WHATWG keeps the brackets on an IPv6 hostname; strip them so one spelling
  // covers both `[::1]` and a bare `::1`.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s/\\@]/.test(host)) return false;

  // Loopback by name, plus the reserved local suffixes. `.local`/`.internal`/
  // `.lan` are the mDNS / split-DNS names an on-box service answers to.
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

  // A bare, dotless hostname is local by convention (`ollama`, `llama-box`).
  // Anything with a dot is a DNS name for somebody else's machine.
  return !host.includes('.');
}

/**
 * The one refusal a non-local custom endpoint gets, in the words the user needs
 * to act on: it names the offending URL, the kind of address that IS allowed,
 * and the billed lane that replaces this one. Shared by the add/validation
 * seam and the dispatch gate so both surfaces cannot drift apart.
 */
function remoteRefusal(baseURL) {
  return `custom endpoints must be LOCAL — remote base URL ${JSON.stringify(String(baseURL == null ? '' : baseURL))} is not offered on this lane. ` +
    'Allowed: localhost, 127.0.0.1, a private/LAN address (10.x, 172.16-31.x, 192.168.x), *.local/.internal/.lan, or a dotless host like "ollama". ' +
    'Remote providers are billed, so use /class byok with /byok-key <provider> (the AEGIS relay charges the handling fee there), ' +
    'or point this entry at a local address.';
}

/**
 * Which transport a base URL implies. Anthropic's Messages API is a different
 * wire format (x-api-key, `/v1/messages`, a `system` top-level field) from the
 * OpenAI-compatible majority, so it must be recognised rather than guessed at
 * call time. Everything else — OpenAI, Groq, DeepSeek, together, openrouter,
 * a local llama.cpp — speaks the OpenAI shape.
 */
function inferWire(baseURL) {
  const host = hostOf(baseURL);
  return host && /(^|\.)anthropic\.com$/.test(host) ? 'anthropic' : 'openai';
}

const VALID_WIRES = Object.freeze(['openai', 'anthropic']);

/**
 * Validate and normalise a would-be catalog entry. Returns `{ entry }` on
 * success or `{ error }` with a one-line reason — never throws, so the command
 * layer can show the reason and keep the session alive.
 *
 * The id rules are load-bearing, not cosmetic: a `:` would collide with the
 * `provider:model` shape byok parses, and a whitespace id cannot be typed back
 * to `/model <id>`. A base URL is required and must be http(s) — the transport
 * POSTs to `${baseURL}/…`, so a bare host or a typo becomes an unroutable call
 * later instead of a clear refusal now.
 *
 * The last gate is the policy one: a base URL that is not local to this machine
 * is refused (isLocalEndpoint). A custom entry is the only thing that reaches
 * the direct transport, and the direct transport bills nothing, so a remote URL
 * here would be unpaid non-local usage. The refusal names /class byok, which is
 * billed, and a local address, which is free.
 */
function normalizeEntry({ id, name, model, baseURL, wire } = {}) {
  const cleanId = String(id == null ? '' : id).trim();
  if (!cleanId) return { error: 'an id is required — /model add <id> <name> <model> <baseURL>' };
  if (/[\s:]/.test(cleanId)) return { error: `invalid id "${cleanId}" — no spaces or ":" (":" is the byok separator)` };

  const cleanModel = String(model == null ? '' : model).trim();
  if (!cleanModel) return { error: 'a model string is required — the id the provider expects on the wire' };

  const cleanBase = String(baseURL == null ? '' : baseURL).trim();
  if (!/^https?:\/\//i.test(cleanBase)) return { error: `base URL must start with http(s):// — got ${JSON.stringify(cleanBase)}` };
  if (!hostOf(cleanBase)) return { error: `base URL does not parse — got ${JSON.stringify(cleanBase)}` };

  let cleanWire = String(wire == null ? '' : wire).trim().toLowerCase();
  if (cleanWire && !VALID_WIRES.includes(cleanWire)) {
    return { error: `wire must be one of ${VALID_WIRES.join(', ')} — got ${JSON.stringify(cleanWire)}` };
  }
  if (!cleanWire) cleanWire = inferWire(cleanBase);

  if (!isLocalEndpoint(cleanBase)) return { error: remoteRefusal(cleanBase) };

  const cleanName = String(name == null ? '' : name).trim() || cleanId;
  return { entry: { id: cleanId, name: cleanName, model: cleanModel, baseURL: cleanBase, wire: cleanWire } };
}

/** The stored catalog (metadata only), always an array. */
function rawCatalog() {
  const list = loadConfig().customModels;
  return Array.isArray(list) ? list.filter((e) => e && typeof e.id === 'string') : [];
}

/** One entry's metadata by id, or null. */
function getCustom(id) {
  const want = String(id == null ? '' : id).trim();
  return rawCatalog().find((e) => e.id === want) || null;
}

/**
 * The catalog as pickable model rows ({ id, label, note, configured, local }) —
 * the shape /models, the picker and the engine share. `configured` reflects
 * whether a key is saved for the row, so the list can say which entries can
 * actually run.
 *
 * `local` is recomputed from the base URL on every read rather than read off
 * the stored row: a config.json written before this lane closed can still hold
 * a remote entry, and it must classify as remote (and be refused by the
 * dispatch gate) rather than inherit a stale "local: true" flag.
 */
function listCustomModels(settings) {
  return rawCatalog().map((e) => {
    const local = isLocalEndpoint(e.baseURL);
    return {
      id: e.id,
      label: e.name || e.id,
      note: `${e.model} · ${hostOf(e.baseURL) || e.baseURL} · ${e.wire}${local ? '' : ' · REMOTE — refused on this lane, use /class byok'}`,
      configured: hasKey(settings, e.id),
      wire: e.wire,
      local,
    };
  });
}

/** Whether a key is stored for this custom id. */
function hasKey(settings, id) {
  if (!settings || typeof settings.rawKey !== 'function') return false;
  return Boolean(settings.rawKey(customNamespace(id)));
}

/**
 * Add or replace a catalog entry, and store its key (when supplied) in the
 * 0600 settings row. Returns `{ entry }` or `{ error }`. Adding an id that
 * already exists REPLACES its metadata (and its key when a new one is given),
 * so `/model add` doubles as an edit — re-running it to fix a typo'd base URL
 * does not leave a second, dead row.
 */
function addCustom(fields, settings) {
  const res = normalizeEntry(fields);
  if (res.error) return res;
  const { entry } = res;
  const next = rawCatalog().filter((e) => e.id !== entry.id);
  next.push(entry);
  updateConfig({ customModels: next });
  if (settings && typeof settings.set === 'function' && fields && fields.key != null && String(fields.key).trim()) {
    settings.set(customNamespace(entry.id), { key: String(fields.key).trim() });
  }
  return { entry };
}

/** Store (or clear) just the key for an existing custom id. */
function setCustomKey(id, key, settings) {
  if (!settings || typeof settings.set !== 'function') return { error: 'no key store available' };
  settings.set(customNamespace(id), { key: key ? String(key).trim() : null });
  return { ok: true };
}

/**
 * Remove a catalog entry and forget its key. Returns whether anything was
 * removed, so the command can say "removed" vs "there was no such entry".
 */
function removeCustom(id, settings) {
  const want = String(id == null ? '' : id).trim();
  const before = rawCatalog();
  const after = before.filter((e) => e.id !== want);
  const removed = after.length !== before.length;
  if (removed) updateConfig({ customModels: after });
  if (settings && typeof settings.remove === 'function') {
    try { settings.remove(customNamespace(want)); } catch { /* nothing stored */ }
  }
  return { removed };
}

/**
 * Resolve a pinned custom id to everything the dispatch needs: the transport
 * class it maps to ('anthropic' | 'openai-compat'), its base URL, its wire
 * model string, its key, and whether the endpoint is local. Null when the id is
 * not in the catalog. The key is read live from the settings store, never
 * cached, so a key saved after the engine was constructed is picked up on the
 * very next turn. `local` is likewise computed live from the base URL, so the
 * engine's gate cannot be fooled by a row that was stored under the old,
 * open-to-remote policy.
 */
function resolveCustom(id, settings) {
  const entry = getCustom(id);
  if (!entry) return null;
  const key = settings && typeof settings.rawKey === 'function' ? settings.rawKey(customNamespace(entry.id)) : null;
  return {
    wireClass: entry.wire === 'anthropic' ? 'anthropic' : 'openai-compat',
    baseURL: entry.baseURL,
    model: entry.model,
    key: key || null,
    wire: entry.wire,
    id: entry.id,
    local: isLocalEndpoint(entry.baseURL),
  };
}

module.exports = {
  customNamespace,
  inferWire,
  isLocalEndpoint,
  remoteRefusal,
  normalizeEntry,
  getCustom,
  listCustomModels,
  hasKey,
  addCustom,
  setCustomKey,
  removeCustom,
  resolveCustom,
  VALID_WIRES,
};
