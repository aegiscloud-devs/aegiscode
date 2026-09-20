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
// The direct-dial policy, from the ONE implementation both hosts share
// (desktop/lib/local/endpoints.js). Resolved by path rather than required
// relatively because the CLI consumes desktop/lib/ in two layouts — beside cli/
// in the repo, and under cli/vendor/ in an installed package (src/deps.js
// documents both); sharedpaths.js is that resolution with no side effects, and
// it exists separately precisely so this module can reach the policy WITHOUT
// pulling in the engine (custommodels -> deps -> engine -> custommodels is a
// require cycle, and the cycle resolves to a half-built exports object).
//
// One implementation on purpose: a second copy is how the desktop would keep
// refusing remote endpoints while the terminal quietly served them — the exact
// drift that produces an unpaid turn.
const { hostOf, isLocalEndpoint, remoteRefusal } = require(
  require('./sharedpaths.js').resolveShared(require('node:path').join('desktop', 'lib', 'local', 'endpoints.js'))
);

/** The settings-store row a custom model's key lives in. */
function customNamespace(id) {
  return `custom:${id}`;
}

// `hostOf`, `isLocalEndpoint` and `remoteRefusal` come from the shared policy
// module above (see the require for why it is reached by path). The CLI's
// refusal text is that module's, plus the one thing only the CLI can name: the
// command that moves the user onto the billed lane. Previously this file held
// its own copy of all three, which is how the two hosts would have drifted.
const CLI_REMOTE_HINT =
  'Remote providers are billed, so use /class byok with /byok-key <provider> ' +
  '(the AEGIS relay charges the handling fee there), or point this entry at a local address.';

/** The refusal a remote custom endpoint gets here, in the CLI's own words. */
function customRefusal(baseURL) {
  return remoteRefusal(baseURL, { subject: 'custom endpoints', hint: CLI_REMOTE_HINT });
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

  if (!isLocalEndpoint(cleanBase)) return { error: customRefusal(cleanBase) };

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
  customRefusal,
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
