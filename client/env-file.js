'use strict';

/**
 * The shared `~/.aegiscode/.env` loader.
 *
 * One file holding every key this product family can use, for every host:
 *
 *     AEGIS_API_KEY=aegis_…
 *     OPENAI_API_KEY=sk-…
 *     DEEPSEEK_API_KEY=sk-…
 *
 * Before this module each host read `process.env` only, which meant a key was
 * configured if — and only if — the user had exported it in the shell that
 * happened to launch the app. That is why the byok flow needed a separate
 * `/byok-key <provider>` step and an encrypted per-provider store: the file was
 * never read. Reading it into `process.env` at startup makes the instruction
 * the same in the CLI and the desktop — "put it in ~/.aegiscode/.env" — and it
 * needs no other change in either, because `AEGIS_API_KEY` is already the FIRST
 * entry in `client/credentials.js`'s documented resolution order.
 *
 * Two rules this module deliberately obeys:
 *
 *   1. A variable already present in the environment is never overwritten. The
 *      file is a convenience for the common case, not a way for a stale file to
 *      shadow an explicit `AEGIS_API_KEY=… aegiscode` in CI.
 *   2. It reads only. Nothing here writes a secret, so the 0600 store remains
 *      the one thing this repo creates; if the file the user made is readable
 *      by other accounts we say so rather than fixing it silently.
 */

const fs = require('node:fs');
const path = require('node:path');
const credentials = require('./credentials.js');

const ENV_FILE = '.env';

/**
 * provider id -> the env var a BYOK key is conventionally exported as, for the
 * ids where the generic rule below would spell the wrong name. The generic rule
 * is `ID_API_KEY` in upper snake case, which already covers openai, anthropic,
 * deepseek, groq, mistral, openrouter, together and most of the catalogue — so
 * this table is only the exceptions, kept short on purpose.
 */
const ALIASES = Object.freeze({
  google: 'GEMINI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  'google-ai': 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
  'x-ai': 'XAI_API_KEY',
  grok: 'XAI_API_KEY',
  huggingface: 'HF_TOKEN',
  together: 'TOGETHER_API_KEY',
  'together-ai': 'TOGETHER_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  'azure-openai': 'AZURE_OPENAI_API_KEY',
  'voyage-ai': 'VOYAGE_API_KEY',
});

/** The file this host would read, honouring `$AEGISCODE_HOME`. */
function envFileFor(dir) {
  return path.join(dir || credentials.aegisHome(), ENV_FILE);
}

/**
 * The env var one BYOK provider's key is read from.
 *
 * @param {string} providerId e.g. 'openai', 'deepseek', 'Google'
 * @returns {string} e.g. 'OPENAI_API_KEY' — '' when there is no usable id
 */
function envVarFor(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (!id) return '';
  // A `byok:` prefixed row is the same provider — accept it so callers can pass
  // whatever spelling they hold without stripping it first.
  const bare = id.startsWith('byok:') ? id.slice('byok:'.length).trim() : id;
  if (!bare) return '';
  if (ALIASES[bare]) return ALIASES[bare];
  const name = bare.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return name ? `${name}_API_KEY` : '';
}

/**
 * Parse dotenv text. Deliberately small and total: an unparseable line is
 * skipped rather than thrown, so one bad line cannot stop the rest of the file
 * (and a stray `#` comment or a blank line is normal, not an error).
 *
 * Handles `export `, `KEY=value`, `KEY="value"`, `KEY='value'` and a trailing
 * ` # comment` on an unquoted value.
 */
function parseEnvText(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let name = line.slice(0, eq).trim();
    if (name.startsWith('export ')) name = name.slice('export '.length).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[name] = value;
  }
  return out;
}

/**
 * Read the env file into `process.env` (or `o.env`), without overwriting
 * anything already set.
 *
 * @param {object} [o]
 * @param {object} [o.env]   defaults to process.env
 * @param {string} [o.dir]   defaults to aegisHome()
 * @param {string} [o.file]  an explicit path, for tests
 * @returns {{ok:boolean, file:string, loaded:string[], kept:string[],
 *            reason:string, loose:boolean, mode:number}}
 *   `loaded` — names taken from the file. `kept` — names the environment
 *   already had, left alone (a real export always wins).
 */
function loadEnvFile(o = {}) {
  const env = o.env || process.env;
  const file = o.file || envFileFor(o.dir);
  const result = { ok: false, file, loaded: [], kept: [], reason: '', loose: false, mode: 0 };

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    result.reason = e && e.code === 'ENOENT' ? 'absent' : 'unreadable';
    return result;
  }

  try {
    const st = fs.statSync(file);
    result.mode = st.mode & 0o777;
    // Group- or world-readable: worth one line to the user, never a rewrite of
    // a file we did not create.
    result.loose = (st.mode & 0o077) !== 0;
  } catch { /* stat is advisory only */ }

  const parsed = parseEnvText(text);
  for (const [name, value] of Object.entries(parsed)) {
    if (env[name] === undefined || env[name] === '') {
      env[name] = value;
      result.loaded.push(name);
    } else {
      result.kept.push(name);
    }
  }
  result.ok = true;
  return result;
}

/**
 * The BYOK key for a provider out of the environment, if the env file (or the
 * shell) supplies one. Returns '' when it does not — the encrypted store then
 * remains the only source, exactly as before.
 */
function providerKeyFromEnv(providerId, env) {
  const name = envVarFor(providerId);
  if (!name) return { key: '', env: '' };
  const raw = (env || process.env)[name];
  const key = typeof raw === 'string' ? raw.trim() : '';
  return { key, env: name };
}

module.exports = {
  ENV_FILE,
  ALIASES,
  envFileFor,
  envVarFor,
  parseEnvText,
  loadEnvFile,
  providerKeyFromEnv,
};
