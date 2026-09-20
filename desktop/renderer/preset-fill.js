'use strict';

/**
 * The decision behind clicking a Model-card preset: what to type into the
 * model-id field, whether to touch the base-URL field, and what the hint
 * should say. Kept out of app.js — like stream-policy.js and budget.js — so
 * the rule is testable from plain Node without the Electron host. app.js only
 * calls into this and performs the DOM writes.
 *
 * Why it exists: after the local-only endpoint policy, one branch here is
 * load-bearing rather than cosmetic. A row whose stored endpoint the engine
 * REFUSES (non-local — see lib/local/endpoints.js) must be repairable by
 * click. The general rule is "never silently overwrite a configured base URL":
 * the user's own custom endpoint must not be clobbered by a stray preset
 * click, so when the field disagrees with the preset the hint says so instead
 * of writing. That rule would leave a refused row unfixable forever — there is
 * nothing left to preserve in a URL the engine will not dial — so `blocked`
 * is the one exception and overwrites outright.
 *
 * The return value is a plan, not a mutation: `baseURL: null` and `hint: null`
 * both mean "leave that alone", which keeps a caller from being able to write
 * an unintended value by ignoring a field.
 */

/** What the hint says when the preset's endpoint replaces a refused one. */
function blockedFillHint(baseURL) {
  return (
    `stored endpoint refused — replaced with ${baseURL}; ` +
    'click Save in Provider settings to replace the refused endpoint.'
  );
}

/**
 * Plan one preset click.
 *
 * @param {object}   input
 * @param {object}   input.preset   a CUSTOM_MODEL_PRESETS entry ({model,baseURL,label})
 * @param {string}   input.current  the base-URL field's current value, trimmed
 * @param {boolean}  input.blocked  the engine refused this class's stored endpoint
 * @returns {{model: string, baseURL: string|null, hint: string|null}|null}
 *          null when there is no preset to apply (the caller does nothing).
 */
function planPresetFill(input) {
  const args = input || {};
  const preset = args.preset;
  // No preset means no click to act on. Guarded on the model id specifically:
  // the model field is what every branch is required to write.
  if (!preset || !preset.model) return null;
  const current = typeof args.current === 'string' ? args.current : '';

  // The one case that overwrites a configured endpoint. Checked first so it
  // cannot be shadowed by the !current / mismatch branches below.
  if (args.blocked) {
    return { model: preset.model, baseURL: preset.baseURL, hint: blockedFillHint(preset.baseURL) };
  }
  if (!current) {
    return {
      model: preset.model,
      baseURL: preset.baseURL,
      hint: `filled in — click Save in Provider settings below to store the ${preset.label} endpoint.`,
    };
  }
  if (current !== preset.baseURL) {
    return {
      model: preset.model,
      baseURL: null, // never clobber a configured endpoint
      hint: `${preset.label} needs base URL ${preset.baseURL} — Provider settings below has ${current}. Update it there too.`,
    };
  }
  // Already pointing at the preset's endpoint: nothing to write and nothing to
  // say. `hint: null` rather than '' — the hint element also carries the
  // endpoint/key line and the max-output suffix, so this branch must not clear
  // text it did not set.
  return { model: preset.model, baseURL: null, hint: null };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planPresetFill, blockedFillHint };
}
