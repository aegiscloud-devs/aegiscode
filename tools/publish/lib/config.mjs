/**
 * Credential layer.
 *
 * SOURCES, AND ONLY THESE TWO (plan §8: "Never commit a secret"):
 *   1. the process environment, or
 *   2. ~/.aegisc/social.json
 *
 * The file is *outside* the repo on purpose. `.gitignore` still carries the
 * path (line ~/.aegisc/) because the natural mistake is to create the file in
 * a working directory and then `git add -A` it.
 *
 * A missing file is NOT an error: it is the documented "you have not pasted
 * your credentials yet" state, and `check` reports every channel `dark`. The
 * errors that do exist are the two that would otherwise be silent: a config
 * file that is present but unreadable, and one that is present but is not
 * valid JSON. Both exit 2 with a message naming the path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSecretKey, maskSecret } from './util.mjs';

/** Path inside $HOME. Exported so the docs, tests and error text agree. */
export const CONFIG_RELATIVE_PATH = '.aegisc/social.json';

/** Exit code for "the credential store itself is broken". */
export const EXIT_CONFIG = 2;

export class ConfigError extends Error {
  constructor(message, { code = EXIT_CONFIG, cause } = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.cause = cause;
  }
}

export function configPath({ home = os.homedir() } = {}) {
  return path.join(home, ...CONFIG_RELATIVE_PATH.split('/'));
}

/**
 * Channel specs.
 *
 * `sets` are ALTERNATIVES: a channel is `live` when *any one* complete set is
 * configured. X genuinely has two (OAuth 2.0 user token, or the OAuth 1.0a
 * signing quartet) and which one an operator has depends on which app type they
 * created in the developer portal, so refusing one of them would be wrong.
 *
 * `scopes` is documentation for docs/social-publishing.md and for the
 * `check --explain` output: it is what the operator must have granted.
 */
export const CHANNELS = {
  x: {
    id: 'x',
    label: 'X (twitter)',
    docs: 'docs/social-publishing.md#x',
    sets: [
      {
        name: 'oauth2-user',
        fields: [
          { key: 'bearerToken', env: 'X_BEARER_TOKEN', label: 'OAuth 2.0 user access token' },
        ],
      },
      {
        name: 'oauth1-user',
        fields: [
          { key: 'apiKey', env: 'X_API_KEY', label: 'API key (consumer key)' },
          { key: 'apiSecret', env: 'X_API_SECRET', label: 'API secret (consumer secret)' },
          { key: 'accessToken', env: 'X_ACCESS_TOKEN', label: 'Access token' },
          { key: 'accessTokenSecret', env: 'X_ACCESS_TOKEN_SECRET', label: 'Access token secret' },
        ],
      },
    ],
    scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    credentialUrl: 'https://developer.x.com/en/portal/dashboard',
  },
  reddit: {
    id: 'reddit',
    label: 'Reddit',
    docs: 'docs/social-publishing.md#reddit',
    sets: [
      {
        name: 'script-app',
        fields: [
          { key: 'clientId', env: 'REDDIT_CLIENT_ID', label: 'app client id (script app)' },
          { key: 'clientSecret', env: 'REDDIT_CLIENT_SECRET', label: 'app secret' },
          { key: 'username', env: 'REDDIT_USERNAME', label: 'bot account username' },
          { key: 'password', env: 'REDDIT_PASSWORD', label: 'account password' },
        ],
      },
    ],
    scopes: ['identity', 'submit', 'edit', 'read'],
    credentialUrl: 'https://www.reddit.com/prefs/apps',
  },
  facebook: {
    id: 'facebook',
    label: 'Facebook',
    docs: 'docs/social-publishing.md#facebook',
    sets: [
      {
        name: 'page',
        fields: [
          { key: 'pageId', env: 'FB_PAGE_ID', label: 'Page id' },
          { key: 'pageAccessToken', env: 'FB_PAGE_ACCESS_TOKEN', label: 'Page access token' },
        ],
      },
    ],
    // Group publishing is a separate capability with a separate token; a Page
    // token cannot post to a group. Kept as an optional add-on so `check` can
    // say "Page live, groups dark" rather than only "facebook dark".
    optionalSets: [
      {
        name: 'group-publisher',
        surface: 'facebook-group',
        fields: [
          { key: 'groupId', env: 'FB_GROUP_ID', label: 'group id' },
          { key: 'userToken', env: 'FB_USER_TOKEN', label: 'user token with publish_to_groups' },
        ],
      },
    ],
    scopes: ['pages_manage_posts', 'pages_read_engagement', 'publish_to_groups'],
    credentialUrl: 'https://developers.facebook.com/tools/explorer/',
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    docs: 'docs/social-publishing.md#youtube',
    sets: [
      {
        name: 'oauth-refresh',
        fields: [
          { key: 'clientId', env: 'YT_CLIENT_ID', label: 'OAuth client id' },
          { key: 'clientSecret', env: 'YT_CLIENT_SECRET', label: 'OAuth client secret' },
          { key: 'refreshToken', env: 'YT_REFRESH_TOKEN', label: 'refresh token' },
          { key: 'channelId', env: 'YT_CHANNEL_ID', label: 'channel id' },
        ],
      },
    ],
    scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
    credentialUrl: 'https://console.cloud.google.com/apis/credentials',
  },
};

export const CHANNEL_IDS = Object.keys(CHANNELS);

/** Every env var name this tool reads, for `check` and for the docs. */
export function envVarNames(channelId) {
  const spec = CHANNELS[channelId];
  const all = [...spec.sets, ...(spec.optionalSets || [])];
  return all.flatMap((s) => s.fields.map((f) => f.env));
}

function readFileJson(file, fsImpl) {
  if (!fsImpl.existsSync(file)) return { present: false, value: null };
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `credential file ${file} exists but could not be read (${err.code || err.message}). ` +
        `Fix its permissions or move it aside -- this tool never guesses a credential.`,
      { cause: err },
    );
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('top level must be a JSON object');
    }
    return { present: true, value };
  } catch (err) {
    throw new ConfigError(
      `credential file ${file} is not valid JSON (${err.message}). ` +
        `It must be an object keyed by channel: {"x":{"bearerToken":"..."}, ...}. ` +
        `Nothing was published and no request was made.`,
      { cause: err },
    );
  }
}

/**
 * Load credentials from env + the config file.
 *
 * Precedence: the environment wins per-field. That is deliberate -- it is how a
 * CI job or a one-off shell export overrides a stale file without the operator
 * editing (and forgetting) the stored copy.
 *
 * @returns {{path:string, filePresent:boolean, fromEnv:string[], channels:object}}
 *   `channels[id]` = { live, source, setName, set, optional: {...} }
 */
export function loadCredentials({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  const file = configPath({ home });
  const { present, value } = readFileJson(file, fsImpl);
  const fileChannels = (value && present && value.channels && typeof value.channels === 'object'
    ? value.channels
    : value) || {};

  const channels = {};
  for (const id of CHANNEL_IDS) {
    const spec = CHANNELS[id];
    const fileValues = (fileChannels && fileChannels[id]) || {};

    const resolveSet = (set) => {
      const values = {};
      const missing = [];
      let fromEnv = false;
      let fromFile = false;
      for (const field of set.fields) {
        const envValue = field.env ? env[field.env] : undefined;
        const fileValue = fileValues[field.key];
        if (typeof envValue === 'string' && envValue.trim() !== '') {
          values[field.key] = envValue.trim();
          fromEnv = true;
        } else if (typeof fileValue === 'string' && fileValue.trim() !== '') {
          values[field.key] = fileValue.trim();
          fromFile = true;
        } else {
          missing.push(field);
        }
      }
      return {
        complete: missing.length === 0,
        values,
        missing,
        source: fromEnv && fromFile ? 'env+file' : fromEnv ? 'env' : fromFile ? 'file' : 'none',
      };
    };

    const alternatives = spec.sets.map((s) => ({ set: s, resolved: resolveSet(s) }));
    const winner = alternatives.find((a) => a.resolved.complete) || null;

    const optional = {};
    for (const s of spec.optionalSets || []) {
      optional[s.name] = { set: s, surface: s.surface, resolved: resolveSet(s) };
    }

    channels[id] = {
      id,
      label: spec.label,
      live: Boolean(winner),
      setName: winner ? winner.set.name : null,
      values: winner ? winner.resolved.values : {},
      source: winner ? winner.resolved.source : 'none',
      alternatives: alternatives.map((a) => ({
        name: a.set.name,
        complete: a.resolved.complete,
        missing: a.resolved.missing.map((f) => f.env),
        masked: Object.fromEntries(Object.entries(a.resolved.values).map(([k, v]) => [k, maskSecret(v)])),
      })),
      optional,
    };
  }

  return {
    path: file,
    filePresent: present,
    envNames: Array.from(
      new Set(CHANNEL_IDS.flatMap((id) => envVarNames(id))),
    ),
    channels,
  };
}

/**
 * Every secret string currently configured, for the redactor. Includes values
 * that are NOT part of a complete set: a half-pasted credential is exactly the
 * kind of thing that leaks into an error message.
 */
export function secretsFromEnvAndFile({ env = process.env, home = os.homedir(), fsImpl = fs } = {}) {
  const out = [];
  for (const id of CHANNEL_IDS) {
    for (const name of envVarNames(id)) {
      const v = env[name];
      if (typeof v === 'string' && v.trim() !== '' && isSecretKey(name)) out.push(v.trim());
    }
  }
  const file = configPath({ home });
  try {
    const { present, value } = readFileJson(file, fsImpl);
    if (present && value) {
      const walk = (obj) => {
        for (const [k, v] of Object.entries(obj || {})) {
          if (typeof v === 'string' && v.trim() !== '' && isSecretKey(k)) out.push(v.trim());
          else if (v && typeof v === 'object') walk(v);
        }
      };
      walk(value);
    }
  } catch {
    // A broken config file must not stop redaction from being applied to the
    // env-provided secrets we already collected.
  }
  return Array.from(new Set(out));
}
