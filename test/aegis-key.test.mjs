#!/usr/bin/env node
/**
 * Regression tests for the AEGIS-key / BYOK-key wiring review:
 *
 *   1. the in-app AEGIS key must live in a reserved namespace, never as a
 *      provider entry the Settings pane can list or remove;
 *   2. listClasses() must report the 'byok' class as configured only when a
 *      provider key actually resolves — a stored row with no key and no env
 *      key is NOT configured;
 *   3. the AEGIS account key must never leak into the BYOK lane: the relay
 *      authenticates on the caller's own PROVIDER key, resolved from the store
 *      (byok:<provider> row) and then from `~/.aegiscode/.env`.
 *
 * This build ships exactly 'aegis' (Aegis Cloud) and 'byok'. The custom
 * direct-dial classes are gone, so `providers.anthropicMessages` (and the
 * class-level assertions that used it) no longer exist; the transport they
 * covered is asserted end-to-end in test/local-tools.test.mjs and
 * test/autonomous-mode.test.mjs. `anthropic`/`openai`/`deepseek` below are
 * BYOK *provider* ids, not model classes.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createSettingsStore,
  AEGIS_KEY_NAMESPACE,
  LEGACY_AEGIS_NAMESPACE,
  isReservedNamespace,
} = require('../desktop/lib/settings.js');
const { createLocalEngine } = require('../desktop/lib/local/engine.js');
const { envVarFor } = require('../client/env-file.js');
const { createModelDispatch } = require('../desktop/main.js');

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// Runtime-built secrets so the repo secret scanners stay quiet.
const AEGIS_KEY = `aegis_${'x'.repeat(24)}`;
const PROVIDER_KEY = `sk-${'p'.repeat(24)}`;
const tmp = (n) => mkdtempSync(join(tmpdir(), `aegis-key-${n}-`));

const byClass = async (engine) => {
  const out = {};
  for (const c of await engine.listClasses()) out[c.class] = c;
  return out;
};

// Custom endpoints are LOCAL-ONLY by policy (see test/endpoints.test.mjs).
const LOCAL_BASE = 'http://127.0.0.1:11434';

// ---------------------------------------------------------------- defect #1
{
  const dir = tmp('store');
  const store = createSettingsStore({ dir });

  assert(isReservedNamespace(AEGIS_KEY_NAMESPACE), 'AEGIS namespace is reserved');

  store.setAegisKey(AEGIS_KEY);
  store.set('openai-compat', { baseURL: LOCAL_BASE, key: PROVIDER_KEY });

  const list = store.list();
  assert(list.length === 1, `list() shows provider configs only, got ${list.length}`);
  assert(
    !list.some((s) => s.provider === AEGIS_KEY_NAMESPACE),
    'the AEGIS key namespace must never appear in settings.list()'
  );
  assert(!JSON.stringify(list).includes(AEGIS_KEY), 'the AEGIS key never serialises into list()');
  assert(store.aegisKey().configured === true, 'aegisKey() reports the key is set');
  assert(store.aegisRawKey() === AEGIS_KEY, 'aegisRawKey() is the main-process accessor');

  // The provider CRUD surface refuses the reserved namespace outright…
  for (const fn of ['set', 'remove']) {
    let threw = false;
    try {
      if (fn === 'set') store.set(AEGIS_KEY_NAMESPACE, { key: '' });
      else store.remove(AEGIS_KEY_NAMESPACE);
    } catch {
      threw = true;
    }
    assert(threw, `settings.${fn}() must refuse the reserved AEGIS namespace`);
  }
  // …and the legacy 'aegis' pseudo-provider is equally unusable.
  let legacyThrew = false;
  try {
    store.remove(LEGACY_AEGIS_NAMESPACE);
  } catch {
    legacyThrew = true;
  }
  assert(legacyThrew, "settings.remove('aegis') must refuse the legacy namespace");
  assert(store.aegisRawKey() === AEGIS_KEY, 'the AEGIS key survives every remove attempt');

  // Raw key still only readable through the AEGIS accessor.
  assert(store.rawKey('openai-compat') === PROVIDER_KEY, 'provider rawKey unchanged');
}

// --------------------------------------------- defect #1, through the IPC too
{
  const dir = tmp('ipc');
  const store = createSettingsStore({ dir });
  store.setAegisKey(AEGIS_KEY);
  store.set('openai-compat', { baseURL: LOCAL_BASE, key: PROVIDER_KEY });

  const stub = () => ({ model: 'm', choices: [{ message: { content: 'ok' } }] });
  const engine = createLocalEngine({
    aegis: { apiKey: AEGIS_KEY, listModels: async () => ({ models: [] }), chatCompletion: stub },
    settings: store,
    getConfirmMode: () => false,
  });
  const dispatch = createModelDispatch(engine);

  const rows = await dispatch['settings.get']();
  assert(
    rows.every((r) => r.provider !== AEGIS_KEY_NAMESPACE && !isReservedNamespace(r.provider)),
    'model:settings.get must not expose a removable AEGIS entry'
  );
  assert(!JSON.stringify(rows).includes(AEGIS_KEY), 'no AEGIS key over the model: IPC');

  // Even a hand-crafted IPC call naming the reserved namespace cannot delete it.
  let rejected = false;
  try {
    await dispatch['settings.remove']({ provider: AEGIS_KEY_NAMESPACE });
  } catch {
    rejected = true;
  }
  assert(rejected, 'model:settings.remove cannot delete the AEGIS key');
  assert(store.aegisRawKey() === AEGIS_KEY, 'AEGIS key intact after IPC remove attempt');
}

// --------------------------------------------- legacy key migration on boot
{
  const dir = tmp('legacy');
  const legacyStore = createSettingsStore({ dir });
  // Write the pre-fix shape directly (what settings.set('aegis', …) produced).
  legacyStore.setAegisKey(AEGIS_KEY);
  const file = legacyStore.file;
  const data = JSON.parse(readFileSync(file, 'utf8'));
  data[LEGACY_AEGIS_NAMESPACE] = data[AEGIS_KEY_NAMESPACE];
  delete data[AEGIS_KEY_NAMESPACE];
  writeFileSync(file, JSON.stringify(data));

  const store = createSettingsStore({ dir });
  assert(
    !store.list().some((s) => s.provider === LEGACY_AEGIS_NAMESPACE),
    "a pre-fix 'aegis' entry is hidden from list() even before migration"
  );
  const res = store.migrateLegacyAegisKey();
  assert(res.migrated === true, 'legacy AEGIS key migrated');
  assert(store.aegisRawKey() === AEGIS_KEY, 'migrated key is readable at the reserved namespace');
  assert(store.migrateLegacyAegisKey().migrated === false, 'migration is idempotent');
}

// ---------------------------------------------------------------- defect #2
{
  const dir = tmp('classes');
  const settings = createSettingsStore({ dir });
  const makeEngine = () =>
    createLocalEngine({
      aegis: { apiKey: '', listModels: async () => ({ models: [] }) },
      settings,
      getConfirmMode: () => false,
    });

  // A byok provider with a row but NO key anywhere (store or env) must NOT
  // read as configured — `configured` is a key fact, never a row fact. A
  // synthetic provider id keeps the control independent of whichever real
  // provider keys happen to be exported in the test environment.
  settings.set('byok:acme', { baseURL: LOCAL_BASE });
  let cls = await byClass(makeEngine());
  assert(cls.aegis.configured === false, 'aegis without a key is not configured');
  assert(cls.byok.configured === false, 'byok with a keyless row and no env key is not configured');

  // A provider key in the store flips it on.
  settings.set('byok:acme', { key: PROVIDER_KEY });
  cls = await byClass(makeEngine());
  assert(cls.byok.configured === true, 'byok with a stored provider key is configured');
}

// --------------------------------- AEGIS key never reaches the byok lane
{
  const settings = createSettingsStore({ dir: tmp('auth') });
  settings.set('byok:openai', { key: PROVIDER_KEY });
  settings.setAegisKey(AEGIS_KEY);

  const seen = [];
  const engine = createLocalEngine({
    aegis: {
      apiKey: AEGIS_KEY,
      async listModels() {
        return { models: [] };
      },
      async chatCompletion(args) {
        seen.push(['chatCompletion', args]);
        return { model: args.model, choices: [{ message: { content: 'ok' } }] };
      },
      // The BYOK lane goes through the relay, which authenticates on the
      // caller's OWN provider key and attaches the account key itself.
      async byokChatCompletion(args) {
        seen.push(['byok', args]);
        return { model: args.model, choices: [{ message: { content: 'ok' } }] };
      },
    },
    settings,
    getConfirmMode: () => false,
  });

  await engine.chat({ class: 'aegis', prompt: 'hi', model: 'm' }, () => {});
  await engine.chat({ class: 'byok', prompt: 'hi', model: 'openai:gpt-4o-mini' }, () => {});

  const byName = Object.fromEntries(seen);
  assert(byName.chatCompletion, 'aegis routes to the AEGIS-authenticated chatCompletion');
  assert(byName.byok, 'byok routes through the relay (byokChatCompletion)');
  assert(
    byName.byok.provider === 'openai' && byName.byok.model === 'gpt-4o-mini',
    'the byok lane splits "<provider>:<model>" for the relay'
  );
  assert(byName.byok.providerKey === PROVIDER_KEY, 'byok spends the PROVIDER key from its own store row');
  assert(byName.byok.providerKey !== AEGIS_KEY, 'the AEGIS key is never used as a provider key');
  assert(
    !JSON.stringify(byName.byok).includes(AEGIS_KEY),
    'the AEGIS key never reaches the byok relay arguments'
  );
}

// ------------------------------------------- BYOK key from ~/.aegiscode/.env
{
  const dir = tmp('envfile');
  const settings = createSettingsStore({ dir });

  assert(envVarFor('openai') === 'OPENAI_API_KEY', `openai maps to OPENAI_API_KEY, got ${envVarFor('openai')}`);
  assert(envVarFor('deepseek') === 'DEEPSEEK_API_KEY', 'deepseek maps to DEEPSEEK_API_KEY');
  assert(envVarFor('byok:anthropic') === 'ANTHROPIC_API_KEY', 'a byok: prefixed row maps to the same provider var');

  const envVar = envVarFor('openai');
  const prior = process.env[envVar];
  try {
    const engine = createLocalEngine({
      aegis: {
        apiKey: AEGIS_KEY,
        listModels: async () => ({ models: [] }),
        byokProviders: async () => ({
          providers: [{ id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini'] }],
          fee: null,
        }),
        async byokChatCompletion(args) {
          return { model: args.model, choices: [{ message: { content: 'ok' } }] };
        },
      },
      settings,
      getConfirmMode: () => false,
    });

    // A row exists for the provider but holds NO key, and nothing is in the
    // environment yet — the negative control.
    settings.set('byok:openai', {});
    delete process.env[envVar];
    let cls = await byClass(engine);
    assert(cls.byok.configured === false, 'no stored key and no env key → byok is not configured');

    // Now the key exists ONLY as OPENAI_API_KEY (what loading
    // `~/.aegiscode/.env` produces). It must read as configured.
    process.env[envVar] = PROVIDER_KEY;

    cls = await byClass(engine);
    assert(cls.byok.configured === true, 'a key present only as OPENAI_API_KEY reads as configured');

    const models = await engine.listModels('byok');
    assert(models.models.length > 0, 'the byok catalog is listed');
    assert(
      models.models.every((m) => m.configured === true),
      'listModels reports the provider configured straight from the env key'
    );
    assert(models.needsProviderKey === false, 'needsProviderKey is cleared by the env-file key');

    // …and chat() actually spends it, without any stored row holding a key.
    let spent = null;
    const runEngine = createLocalEngine({
      aegis: {
        apiKey: AEGIS_KEY,
        async byokChatCompletion(args) {
          spent = args;
          return { model: args.model, choices: [{ message: { content: 'ok' } }] };
        },
      },
      settings,
      getConfirmMode: () => false,
    });
    await runEngine.chat({ class: 'byok', prompt: 'hi', model: 'openai:gpt-4o-mini' }, () => {});
    assert(spent && spent.providerKey === PROVIDER_KEY, 'chat() resolves the env-file key for the provider');
    assert(spent.providerKey !== AEGIS_KEY, 'the env-file lane still never spends the AEGIS key');
  } finally {
    if (prior === undefined) delete process.env[envVar];
    else process.env[envVar] = prior;
  }
}

console.log('aegis-key tests passed');
