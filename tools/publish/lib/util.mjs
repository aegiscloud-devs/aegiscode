/**
 * Shared helpers for the publishing layer: masking, redaction, safe JSON.
 *
 * WHY THE MASKING LIVES IN ITS OWN MODULE: every failure mode of this tool is
 * "printed a secret to a terminal, a CI log, or a shell history file". So the
 * rule is enforced in one place, is used by *every* printer (check, plan,
 * dry-run, live errors), and is covered by test/publish-secrets.test.mjs.
 *
 * A secret is never printed whole. `maskSecret` keeps the last 4 characters so
 * the operator can tell *which* key is configured without the value being
 * reusable. Values of 4 characters or fewer mask entirely -- keeping "last 4"
 * of a 4-character secret is keeping all of it.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Marker used everywhere a secret would otherwise appear. */
export const MASK_PREFIX = '****';

/**
 * Resolve the repo root from a module URL.
 * tools/publish/lib/util.mjs → <repo root> (three levels up).
 */
export function repoRootFrom(importMetaUrl) {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..', '..', '..');
}

/** Key names whose values are secrets (case-insensitive, substring match). */
const SECRET_KEY_RE =
  /(token|secret|password|passwd|pwd|api[_-]?key|authorization|auth|bearer|cookie|credential)/i;

/** Placeholder syntax for values that only exist after a prior response. */
export const PLACEHOLDER_RE = /<([a-z0-9_.]+)>/gi;

/**
 * Mask a secret, keeping at most its last 4 characters.
 * @param {unknown} value
 * @returns {string} '' for empty, `****` for short values, `****abcd` otherwise.
 */
export function maskSecret(value) {
  if (value === undefined || value === null) return '';
  const s = String(value);
  if (s.length === 0) return '';
  if (s.length <= 4) return MASK_PREFIX;
  return `${MASK_PREFIX}${s.slice(-4)}`;
}

/** True when a key name looks like it carries a secret. */
export function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

/** Walk an arbitrary config object and collect every secret-looking value. */
export function collectSecrets(value, out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectSecrets(v, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') {
        if (v.length >= 4 && isSecretKey(k)) out.push(v);
      } else {
        collectSecrets(v, out);
      }
    }
  }
  return out;
}

/**
 * Replace every occurrence of every known secret in a string with its mask.
 * This is the last line of defence: even if a printer forgets to mask a field,
 * the literal value cannot survive a pass through here.
 */
export function redactText(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (!secret || String(secret).length < 4) continue;
    out = out.split(String(secret)).join(maskSecret(secret));
  }
  return out;
}

/**
 * Deep-redact a value for printing:
 *  - values under secret-looking keys are masked (last 4 kept);
 *  - any literal secret from `secrets` is replaced anywhere it appears.
 */
export function redact(value, secrets = [], keyHint = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (keyHint && isSecretKey(keyHint)) return maskSecret(value);
    return redactText(value, secrets);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, keyHint));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, secrets, k);
    return out;
  }
  return String(value);
}

/** JSON for humans: stable 2-space indent, secrets masked. */
export function safeJson(value, secrets = []) {
  return JSON.stringify(redact(value, secrets), null, 2);
}

/**
 * Code-point length, not UTF-16 length: an emoji costs 2 in `.length` and 1 on
 * every one of these platforms. Threads in this campaign literally end with a
 * 🧵, so getting this wrong misreports the budget.
 */
export function charCount(text) {
  return Array.from(String(text ?? '')).length;
}

/**
 * Media markers the copy bank embeds inline — `<GIF>` and the annotated
 * `<GIF: R3, tool loop + diff card>`. They are instructions to attach an
 * asset, never publishable text: counting one against a character limit
 * reports a post as over-length when it is not, and letting one reach a
 * channel's body publishes the marker itself.
 *
 * Deliberately broader than PLACEHOLDER_RE, which matches only a bare
 * `<lowercase_word>` and so misses the annotated form completely — it contains
 * a colon, spaces and commas. `<tweet_id>` / `<asset_url>` request placeholders
 * are unaffected: they are resolved by fillPlaceholders at send time and never
 * appear in an item's text.
 */
export const MEDIA_MARKER_RE = /<(GIF|IMG|IMAGE|VIDEO|SHOT|SCREENSHOT)(?:\s*:[^>]*)?>/gi;

/** Every media marker in a value, as its trimmed inner description. */
export function extractMediaMarkers(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(MEDIA_MARKER_RE)) out.push(m[0].slice(1, -1).trim());
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      return;
    }
    if (v && typeof v === 'object') {
      for (const item of Object.values(v)) walk(item);
    }
  };
  walk(value);
  return out;
}

/** Remove media markers and close up the whitespace they leave behind. */
export function stripMediaMarkers(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(MEDIA_MARKER_RE, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Fill `<name>` placeholders from a vars map. Unresolved ones are left alone. */
export function fillPlaceholders(value, vars) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER_RE, (m, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m,
    );
  }
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fillPlaceholders(v, vars);
    return out;
  }
  return value;
}

/** All placeholder names appearing anywhere in a value. */
export function placeholderNames(value, out = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(PLACEHOLDER_RE)) out.add(m[1]);
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) placeholderNames(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) placeholderNames(v, out);
  }
  return out;
}

/**
 * Is this a Facebook *group* post, as opposed to a Page post?
 *
 * The surface string has been spelled two ways: `copy.mjs` builds the real
 * group item as `facebook-group-post` and `channels.mjs` routes group tokens on
 * that spelling, while `gates.mjs` and `config.mjs` wrote `facebook-group`. A
 * strict equality test in the gates therefore never matched the item that
 * actually gets published, which silently skipped §4.4's two-week group warmup
 * on the only surface it exists to protect. One prefix test, defined once, so
 * the two spellings cannot diverge again — and a future rename fails *into* the
 * gate rather than out of it.
 */
export function isFacebookGroupSurface(item) {
  return String((item && item.surface) || '').startsWith('facebook-group');
}
