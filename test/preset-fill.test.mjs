#!/usr/bin/env node
/**
 * Behavioural coverage for the Model-card preset click (plan: the local-only
 * endpoint policy).
 *
 * The gap this closes: after the local-only policy landed, the recovery path
 * for a REFUSED endpoint — picking a preset replaces the stored URL the engine
 * will not dial — was provable only structurally. blockedCustomClasses was
 * wired at seven sites and the branch ordering was readable, but nothing
 * executed applyCustomPreset(), because it lived inside app.js, which boots
 * only under the Electron host (renderer-dom.test.mjs loads the six pure
 * scripts and asserts app.js statically; renderer-wiring.test.mjs is a static
 * grep). "The click repairs a blocked row" and "the click never clobbers your
 * own endpoint" were therefore claims, not tests.
 *
 * The fix is the one this repo already uses for unprovable renderer policy —
 * extract the decision to a pure script, test it here, let app.js perform the
 * writes. preset-fill.js holds the branches; this file drives them directly
 * and pins the wiring so the branches cannot drift back into app.js.
 *
 * The last block is a billing-policy guard rather than a preset test: every
 * shipped preset must point at a LOCAL endpoint. A remote one would advertise
 * a URL that settings.set() now refuses and the engine will not dial — the GUI
 * would offer a preset whose Save button fails. It is asserted against the
 * same lib/local/endpoints.js the engine enforces with, so the two cannot
 * disagree about what "local" means.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rendererDir = join(root, 'desktop', 'renderer');
const require = createRequire(import.meta.url);

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const html = readFileSync(join(rendererDir, 'index.html'), 'utf8');
const appCode = readFileSync(join(rendererDir, 'app.js'), 'utf8');

// ---------------------------------------------------------------- load order
// Classic scripts share one global lexical environment, so order is what makes
// planPresetFill exist by the time app.js's applyCustomPreset runs. Loaded
// last, app.js would see a ReferenceError on the first preset click.
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
const fillIdx = scriptSrcs.indexOf('preset-fill.js');
const appIdx = scriptSrcs.indexOf('app.js');
assert(fillIdx !== -1, 'index.html must load preset-fill.js (an unwired script is a dead file)');
assert(appIdx !== -1, 'index.html loads app.js');
assert(fillIdx < appIdx, `preset-fill.js must load before app.js (${fillIdx} vs ${appIdx})`);

// ------------------------------------------------- the script, as a browser loads it
// No `module` binding, so the file must take its classic-script path: a
// top-level `function` declaration has to publish a global. That is the
// mechanism app.js consumes — asserted, not assumed.
const realm = vm.createContext({ console });
vm.runInContext(readFileSync(join(rendererDir, 'preset-fill.js'), 'utf8'), realm, {
  filename: 'preset-fill.js',
});
assert(
  typeof realm.planPresetFill === 'function',
  'preset-fill.js must publish planPresetFill as a global when loaded as a classic script'
);
const { planPresetFill } = realm;

// ------------------------------------------------------------- the presets
// Read the real CUSTOM_MODEL_PRESETS out of app.js rather than restating it:
// a preset added to the app is covered here without editing this file.
const presetSrc = appCode.slice(appCode.indexOf('const CUSTOM_MODEL_PRESETS = {'));
const presetObjSrc = presetSrc.slice(0, presetSrc.indexOf('\n};') + 3);
const presets = vm.runInNewContext(`${presetObjSrc}\nCUSTOM_MODEL_PRESETS;`);
assert(presets && typeof presets === 'object', 'CUSTOM_MODEL_PRESETS must be parseable from app.js');
const classes = Object.keys(presets);
assert(classes.length > 0, 'CUSTOM_MODEL_PRESETS defines at least one class');
const ollama = presets['openai-compat'].find((p) => /127\.0\.0\.1:11434/.test(p.baseURL));
assert(ollama, 'the openai-compat presets still include the Ollama shim (the other free lane)');

// ============================================ 1. a BLOCKED row is repairable
// The regression this whole file exists for: the general rule is "never
// silently overwrite a configured base URL", which left a row whose stored
// endpoint the engine refuses with no way back through the UI.
{
  const plan = planPresetFill({
    preset: ollama,
    current: 'https://api.z.ai/api/paas/v4',
    blocked: true,
  });
  assert(plan.baseURL === ollama.baseURL, 'a blocked row must have its refused URL replaced by the preset');
  assert(plan.model === ollama.model, 'the model id is written on every branch');
  assert(
    /stored endpoint refused/.test(plan.hint) && /Save/.test(plan.hint),
    `the hint must say the endpoint was refused and to Save (got: ${plan.hint})`
  );
  assert(
    plan.hint.includes(ollama.baseURL),
    'the hint names the replacement URL so the user can see what they are about to save'
  );

  // Blocked outranks the other branches: it is checked first, so a blocked row
  // whose field is empty is still repaired rather than taking the "filled in"
  // path with a softer message.
  const emptyBlocked = planPresetFill({ preset: ollama, current: '', blocked: true });
  assert(emptyBlocked.baseURL === ollama.baseURL, 'a blocked empty row still receives the preset URL');
  assert(/refused/.test(emptyBlocked.hint), 'a blocked row is always reported as blocked, never as "filled in"');

  // And it is not shadowed by the match branch either — a refused URL can only
  // equal the preset's if the preset itself were remote, which block 4 forbids.
  const sameBlocked = planPresetFill({ preset: ollama, current: ollama.baseURL, blocked: true });
  assert(sameBlocked.baseURL === ollama.baseURL, 'blocked writes the preset URL even when the field already matches');
}

// ============================== 2. an empty field is filled (first-time setup)
{
  const plan = planPresetFill({ preset: ollama, current: '', blocked: false });
  assert(plan.baseURL === ollama.baseURL, 'an empty field is filled from the preset');
  assert(
    plan.hint.includes(ollama.label) && /filled in/.test(plan.hint),
    `the first-time hint names the preset and says it was filled (got: ${plan.hint})`
  );
  assert(/Save/.test(plan.hint), 'the first-time hint says to Save, or the fill is never stored');
}

// ============ 3. the user's own endpoint is NEVER clobbered by a stray click
{
  const mine = 'http://192.168.1.50:8000/v1';
  const plan = planPresetFill({ preset: ollama, current: mine, blocked: false });
  assert(plan.baseURL === null, 'a configured endpoint must not be overwritten (null = leave the field alone)');
  assert(plan.model === ollama.model, 'the model id still fills in, even when the URL is left alone');
  assert(plan.hint.includes(mine), 'the hint quotes the endpoint already configured');
  assert(plan.hint.includes(ollama.baseURL), 'the hint names the endpoint the preset actually needs');
}

// =============== 4. already matching: no write, no clobber, no bogus hint
{
  const plan = planPresetFill({ preset: ollama, current: ollama.baseURL, blocked: false });
  assert(plan.baseURL === null, 'a matching endpoint needs no write');
  assert(
    plan.hint === null,
    'a matching endpoint sets no hint (null, not "" — the element also carries the endpoint/key line)'
  );
}

// =============================== 5. no preset: the caller does nothing at all
{
  assert(planPresetFill({ preset: { label: 'x', baseURL: 'http://127.0.0.1:1' }, current: '' }) === null,
    'a preset without a model id plans nothing');
  assert(planPresetFill({ preset: null, current: '' }) === null, 'a missing preset plans nothing');
  assert(planPresetFill({}) === null, 'an empty input plans nothing rather than throwing');
  assert(planPresetFill() === null, 'a missing argument plans nothing rather than throwing');
  // A non-string `current` must not leak "undefined" into the hint text.
  const odd = planPresetFill({ preset: ollama, current: undefined, blocked: false });
  assert(odd.baseURL === ollama.baseURL, 'an undefined field value is treated as empty, so it is filled');
  assert(!/undefined/.test(odd.hint), `an undefined value must not reach the hint (got: ${odd.hint})`);
}

// ================================== 6. the wiring: app.js calls, does not re-implement
{
  assert(
    /planPresetFill\s*\(/.test(appCode),
    'app.js must call planPresetFill() — the decision living here is worthless if nothing invokes it'
  );
  // The branches moving back into app.js is the drift this pins. If a hint
  // string reappears in app.js, two copies of the rule exist and only one is
  // tested by this file.
  for (const orphan of ['stored endpoint refused', 'needs base URL', 'click Save in Provider settings below to store']) {
    assert(
      !appCode.includes(orphan),
      `app.js must not re-implement the preset branches (found ${JSON.stringify(orphan)} in app.js)`
    );
  }
}

// ============ 7. billing policy: every shipped preset is a LOCAL endpoint ====
// A remote preset would offer a URL that settings.set() refuses and engine.chat()
// will not dial: the GUI would advertise a preset whose Save button fails, and
// the row would be born blocked. Enforced with the engine's own predicate.
{
  const { isLocalEndpoint } = require(join(root, 'desktop', 'lib', 'local', 'endpoints.js'));
  let checked = 0;
  for (const cls of classes) {
    for (const p of presets[cls]) {
      assert(p.label && p.model && p.baseURL, `every ${cls} preset needs a label, model and baseURL`);
      assert(
        isLocalEndpoint(p.baseURL) === true,
        `${cls} preset "${p.label}" points at ${p.baseURL}, which the local-only policy refuses — ` +
          'a remote model is reached through the billed byok class, never a direct-dial preset'
      );
      checked += 1;
    }
  }
  assert(checked >= 5, `expected the local presets to be covered, checked ${checked}`);
}

console.log(
  `preset-fill tests passed (blocked-row repair, no-clobber, ${classes.reduce(
    (n, c) => n + presets[c].length,
    0
  )} presets all local, wiring pinned)`
);
