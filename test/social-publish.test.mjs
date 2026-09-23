/**
 * tools/publish — the credential-driven publishing layer.
 *
 * No test here makes a real network call: every HTTP path is driven through an
 * injected `fetchImpl`. The fixtures never contain a real credential, and the
 * leak tests assert that the fake ones cannot reach printed output.
 *
 * The campaign docs are read from this repo for the gather/plan tests, because
 * that is the tool's real input — the copy is the source of truth, not a fixture.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNEL_IDS,
  ConfigError,
  configPath,
  loadCredentials,
  secretsFromEnvAndFile,
} from '../tools/publish/lib/config.mjs';
import { COMMENT_MARKER, FB_GROUP_MARKER, readLedger } from '../tools/publish/lib/ledger.mjs';
import {
  checkCompliance,
  checkFacebookGroupRule,
  checkRedditLinkRule,
  disclosureViolation,
  evaluateItem,
  memorySyncViolation,
  parseReadinessIndex,
  readLaunchGate,
} from '../tools/publish/lib/gates.mjs';
import {
  charCount,
  extractMediaMarkers,
  isSecretKey,
  maskSecret,
  redact,
  redactText,
  stripMediaMarkers,
} from '../tools/publish/lib/util.mjs';
import {
  EXIT,
  UsageError,
  commandCheck,
  commandDryRun,
  commandPlan,
  commandPost,
  gather,
  main,
  mediaFor,
} from '../tools/publish/lib/run.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAMPAIGN_DOCS = [
  'docs/launch-copy-x-youtube.md',
  'docs/reddit-drafts.md',
  'docs/social-account-setup.md',
];

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------- fixtures --- */

const PASS_INDEX = [
  '# T-7 launch readiness audit (fixture)',
  '',
  '## 1. Checklist',
  '',
  '| # | Check | Verdict | Command run | Observed output |',
  '|---|---|---|---|---|',
  '| A1 | clean global install | **PASS** | `npm i -g aegis-desktop` | added 84 packages |',
  '| B1 | 40s demo GIF | **PASS** *(re-run §9)* | `ffprobe demo.gif` | 40.000000 s |',
  '',
  '## 2. Notes',
  '',
  'Nothing here publishes.',
].join('\n');

const FAIL_INDEX = PASS_INDEX.replace(
  '| B1 | 40s demo GIF | **PASS** *(re-run §9)* | `ffprobe demo.gif` | 40.000000 s |',
  '| B1 | 40s demo GIF | **FAIL** | `ffprobe demo.gif` | no such file |',
);

function ledgerText({ comments = 0, groupJoined = '2026-09-01' } = {}) {
  const rows = Array.from(
    { length: comments },
    (_, i) => `| 2026-09-${String(10 + (i % 9)).padStart(2, '0')} | r/LocalLLaMA | useful answer ${i + 1} |`,
  );
  return [
    '# Marketing log (fixture)',
    '',
    `<!-- ${COMMENT_MARKER} -->`,
    '| date | subreddit | note |',
    '| --- | --- | --- |',
    ...(rows.length ? rows : ['| — | — | no comments recorded yet |']),
    '',
    `<!-- ${FB_GROUP_MARKER} -->`,
    '| group | joined | note |',
    '| --- | --- | --- |',
    ...(groupJoined === null ? [] : [`| Local LLM / AI Enthusiasts | ${groupJoined} | joined |`]),
    '',
  ].join('\n');
}

function mkRepo({ readiness = PASS_INDEX, log = ledgerText() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-publish-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  if (readiness !== null) fs.writeFileSync(path.join(dir, 'docs/launch-readiness.md'), readiness);
  if (log !== null) fs.writeFileSync(path.join(dir, 'docs/marketing-log.md'), log);
  return dir;
}

/** A repo with the real campaign copy plus a controllable gate and ledger. */
function campaignRepo(opts = {}) {
  const dir = mkRepo({
    readiness: opts.readiness === undefined ? PASS_INDEX : opts.readiness,
    log: ledgerText(opts),
  });
  for (const rel of CAMPAIGN_DOCS) fs.copyFileSync(path.join(REPO, rel), path.join(dir, rel));
  return dir;
}

function collector() {
  let text = '';
  return { write: (s) => { text += s; }, text: () => text };
}

/** A fetch stand-in that records calls and never touches the network. */
function spyFetch(respond = () => ({ ok: true, status: 200, body: '{}' })) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    const res = respond(url, opts) || {};
    return {
      ok: res.ok !== false,
      status: res.status === undefined ? 200 : res.status,
      text: async () => (typeof res.body === 'string' ? res.body : JSON.stringify(res.body || {})),
    };
  };
  fn.calls = calls;
  return fn;
}

/** A fetch stand-in that fails the test if it is called at all. */
function forbiddenFetch() {
  const fn = async (url) => {
    throw new Error(`no network call was expected, but one was made: ${url}`);
  };
  return fn;
}

const X_TOKEN = 'x-bearer-SECRETVALUE9f3a';
const REDDIT_SECRET = 'reddit-client-SECRETVALUE7c1d';
const X_ENV = { X_BEARER_TOKEN: X_TOKEN };
const REDDIT_ENV = {
  REDDIT_CLIENT_ID: 'reddit-app-id',
  REDDIT_CLIENT_SECRET: REDDIT_SECRET,
  REDDIT_USERNAME: 'aegis_bot',
  REDDIT_PASSWORD: 'reddit-PASSWORDnotreal',
};

/* ------------------------------------------------------------ credentials -- */

test('a missing credential file is the documented "nothing pasted yet" state, not an error', () => {
  const home = mkRepo();
  const creds = loadCredentials({ env: {}, home });
  assert.equal(creds.path, configPath({ home }));
  assert.equal(creds.filePresent, false);
  for (const id of CHANNEL_IDS) {
    assert.equal(creds.channels[id].live, false, `${id} must be dark with no credentials`);
    assert.equal(creds.channels[id].source, 'none');
  }
});

test('env-only credentials are a complete setup, and every channel is reported separately', () => {
  const creds = loadCredentials({ env: { ...X_ENV, ...REDDIT_ENV }, home: mkRepo() });
  assert.equal(creds.channels.x.live, true);
  assert.equal(creds.channels.x.source, 'env');
  assert.equal(creds.channels.x.setName, 'oauth2-user');
  assert.equal(creds.channels.reddit.live, true);
  assert.equal(creds.channels.facebook.live, false);
  assert.equal(creds.channels.youtube.live, false);
});

test('a blank or whitespace environment variable is not a credential', () => {
  const creds = loadCredentials({ env: { X_BEARER_TOKEN: '   ' }, home: mkRepo() });
  assert.equal(creds.channels.x.live, false);
});

test('a partially configured channel names the env vars it still needs', () => {
  const creds = loadCredentials({ env: { X_API_KEY: 'k', X_API_SECRET: 's' }, home: mkRepo() });
  const oauth1 = creds.channels.x.alternatives.find((a) => a.name === 'oauth1-user');
  assert.equal(oauth1.complete, false);
  assert.deepEqual(oauth1.missing, ['X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']);
});

test('the file store is read from ~/.aegisc/social.json, and env wins over a file value', () => {
  const home = mkRepo();
  fs.mkdirSync(path.join(home, '.aegisc'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.aegisc/social.json'),
    JSON.stringify({ channels: { x: { bearerToken: 'from-FILE-token' } } }),
  );
  const fromFile = loadCredentials({ env: {}, home });
  assert.equal(fromFile.filePresent, true);
  assert.equal(fromFile.channels.x.live, true);
  assert.equal(fromFile.channels.x.source, 'file');

  const mixed = loadCredentials({ env: X_ENV, home });
  assert.equal(mixed.channels.x.source, 'env', 'the only field of that set came from the env');
  assert.equal(mixed.channels.x.values.bearerToken, X_TOKEN);

  // A multi-field set drawn from both sources reports env+file.
  fs.writeFileSync(
    path.join(home, '.aegisc/social.json'),
    JSON.stringify({ channels: { reddit: { clientId: 'file-id', clientSecret: 'file-secret' } } }),
  );
  const both = loadCredentials({
    env: { REDDIT_USERNAME: 'aegis_bot', REDDIT_PASSWORD: 'pw' },
    home,
  });
  assert.equal(both.channels.reddit.live, true);
  assert.equal(both.channels.reddit.source, 'env+file');
});

test('a config file that is present but is not valid JSON is a named, clean failure', () => {
  const home = mkRepo();
  fs.mkdirSync(path.join(home, '.aegisc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aegisc/social.json'), '{ this is not json');
  assert.throws(
    () => loadCredentials({ env: {}, home }),
    (err) => err instanceof ConfigError && err.code === 2,
  );
});

test('the Facebook group token is a separate capability from the Page token', () => {
  const pageOnly = loadCredentials({ env: { FB_PAGE_ID: '1', FB_PAGE_ACCESS_TOKEN: 'p' }, home: mkRepo() });
  assert.equal(pageOnly.channels.facebook.live, true);
  assert.equal(pageOnly.channels.facebook.optional['group-publisher'].resolved.complete, false);

  const both = loadCredentials({
    env: { FB_PAGE_ID: '1', FB_PAGE_ACCESS_TOKEN: 'p', FB_GROUP_ID: '2', FB_USER_TOKEN: 'u' },
    home: mkRepo(),
  });
  const group = both.channels.facebook.optional['group-publisher'];
  assert.equal(group.resolved.complete, true);
  assert.equal(group.surface, 'facebook-group');
});

/* --------------------------------------------------------------- secrets --- */

test('maskSecret keeps at most the last four characters and never the whole value', () => {
  assert.equal(maskSecret('abcdefgh1234'), '****1234');
  assert.equal(maskSecret('abc'), '****');
  assert.equal(maskSecret(''), '', 'an unset value is reported as unset, not as a masked one');
  assert.equal(maskSecret(undefined), '');
  assert.ok(!maskSecret('abcdefgh1234').includes('abcdefgh'));
});

test('authorization-style keys are recognised as secret, so header values get masked', () => {
  assert.equal(isSecretKey('Authorization'), true);
  assert.equal(isSecretKey('X-API-SECRET'), true);
  assert.equal(isSecretKey('Content-Type'), false);
});

test('the redactor removes a secret wherever it appears, including inside an error message', () => {
  const secrets = [X_TOKEN];
  assert.ok(!redactText(`fetch failed: Authorization: Bearer ${X_TOKEN}`, secrets).includes(X_TOKEN));
  const deep = redact({ nested: [{ token: X_TOKEN }, `prefix ${X_TOKEN}`] }, secrets);
  assert.ok(!JSON.stringify(deep).includes(X_TOKEN));
});

test('a half-pasted credential is still collected, so it cannot leak from an error path', () => {
  const secrets = secretsFromEnvAndFile({ env: { X_API_KEY: 'half-pasted-value' }, home: mkRepo() });
  assert.ok(secrets.includes('half-pasted-value'));
});

test('check prints no raw secret, in text or in --json', async () => {
  const out = collector();
  const code = await commandCheck({ env: { ...X_ENV, ...REDDIT_ENV }, home: mkRepo(), repoRoot: mkRepo(), write: out.write });
  assert.equal(code, EXIT.OK);
  assert.ok(!out.text().includes(X_TOKEN), 'the X token must not appear in check output');
  assert.ok(!out.text().includes(REDDIT_SECRET));
  assert.ok(out.text().includes('****9f3a'), 'the masked tail is what identifies the token');

  const json = collector();
  await commandCheck({
    env: { ...X_ENV, ...REDDIT_ENV },
    home: mkRepo(),
    repoRoot: mkRepo(),
    write: json.write,
    json: true,
  });
  const parsed = JSON.parse(json.text());
  assert.ok(!json.text().includes(X_TOKEN));
  assert.equal(parsed.channels.x.alternatives[0].masked.bearerToken, '****9f3a');
});

/* --------------------------------------------------------- media markers --- */

test('inline media markers are stripped from publishable text but kept as a media note', () => {
  assert.equal(stripMediaMarkers('Terminal thread → app. <GIF>'), 'Terminal thread → app.');
  assert.equal(
    stripMediaMarkers('The diff card. <GIF: R3, tool loop + diff card>'),
    'The diff card.',
  );
  assert.deepEqual(extractMediaMarkers('see <GIF: R3, tool loop + diff card>'), ['GIF: R3, tool loop + diff card']);
});

test('the media marker pattern does not eat request placeholders', () => {
  const text = 'reply to <tweet_id> at <asset_url>';
  assert.equal(stripMediaMarkers(text), text);
  assert.deepEqual(extractMediaMarkers(text), []);
});

test('no item parsed from the real campaign copy carries a media marker in its text', () => {
  const { items } = gather({ env: {}, home: mkRepo(), repoRoot: REPO });
  assert.ok(items.length > 0, 'the campaign docs must yield items');
  for (const item of items) {
    assert.ok(
      !/<(GIF|IMG|IMAGE|VIDEO|SHOT|SCREENSHOT)(\s*:[^>]*)?>/i.test(item.text),
      `${item.id} still carries a media marker in its publishable text`,
    );
    assert.ok(
      !/<(GIF|IMG|IMAGE|VIDEO|SHOT|SCREENSHOT)(\s*:[^>]*)?>/i.test(item.title || ''),
      `${item.id} still carries a media marker in its title`,
    );
  }
});

test('a stripped GIF marker still attaches the file passed with --media', () => {
  const { items } = gather({ env: {}, home: mkRepo(), repoRoot: REPO });
  const gifItem = items.find((i) => /\bgif\b/i.test(i.media || ''));
  assert.ok(gifItem, 'expected at least one item whose copy asks for a GIF');
  assert.equal(/<gif/i.test(gifItem.text), false, 'the marker itself must not survive in the text');
  const media = mediaFor(gifItem, { file: 'docs/marketing-assets/01-model-class-picker.png' });
  assert.equal(media.filePath, 'docs/marketing-assets/01-model-class-picker.png');
  assert.equal(media.mediaType, 'image/gif');
});

/* ------------------------------------------------------------ plan rules --- */

test('the retired "opt-in per message" line is refused, and its negation is not', () => {
  assert.ok(memorySyncViolation('Cloud memory sync is opt-in per message (the remember button).'));
  assert.equal(memorySyncViolation('Cloud memory is not opt-in per message in this build.'), null);
  assert.equal(memorySyncViolation('It is no longer opt-in per message.'), null);
  assert.ok(memorySyncViolation('opt-in per message'));
});

test('§8 banned claims are refused with the reason attached', () => {
  const bad = checkCompliance({ channel: 'x', surface: 'x-post', text: 'A revolutionary 10x tool.' });
  assert.equal(bad.ok, false);
  assert.ok(bad.violations.some((v) => v.rule === 'banned-claim'));
  assert.ok(bad.violations.every((v) => typeof v.detail === 'string' && v.detail.length > 0));
});

test('a Reddit post must open with the authorship disclosure', () => {
  assert.ok(disclosureViolation({ channel: 'reddit', text: 'A tool I like.\nMore text.' }));
  assert.equal(
    disclosureViolation({ channel: 'reddit', text: 'I built this, so take it with salt.\nBody.' }),
    null,
  );
});

test('§4.3: a Reddit post with a link is refused until 10 useful comments are on record', () => {
  const item = { channel: 'reddit', surface: 'reddit-body', subreddit: 'r/LocalLLaMA', text: 'I built this.\nhttps://aegiscloud.org/?utm_source=reddit' };

  const none = readLedger({ repoRoot: mkRepo({ log: ledgerText({ comments: 0 }) }) });
  const refused9 = checkRedditLinkRule({ item, ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ comments: 9 }) }) }) });
  assert.equal(refused9.ok, false);
  assert.equal(refused9.have, 9);
  assert.equal(refused9.required, 10);
  assert.match(refused9.detail, /9 of the 10/);

  const ok10 = checkRedditLinkRule({ item, ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ comments: 10 }) }) }) });
  assert.equal(ok10.ok, true);

  const noLink = checkRedditLinkRule({
    item: { ...item, text: 'I built this. No link here.' },
    ledger: none,
  });
  assert.equal(noLink.ok, true, 'a link-free draft needs no comment credit');
});

test('§4.3 comment credit is per-subreddit', () => {
  const item = { channel: 'reddit', surface: 'reddit-body', subreddit: 'r/programming', text: 'I built this.\nhttps://aegiscloud.org/' };
  const ledger = readLedger({ repoRoot: mkRepo({ log: ledgerText({ comments: 12 }) }) });
  const res = checkRedditLinkRule({ item, ledger });
  assert.equal(res.ok, false, 'credit earned in r/LocalLLaMA must not carry to r/programming');
  assert.equal(res.have, 0);
});

test('§4.4: a Facebook group post is refused until 14 days of participation are logged', () => {
  const item = { channel: 'facebook', surface: 'facebook-group', group: 'Local LLM / AI Enthusiasts', text: 'Disclosure: I built this.' };

  const none = checkFacebookGroupRule({
    item,
    ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ groupJoined: null }) }) }),
    now: new Date('2026-09-20T00:00:00Z'),
  });
  assert.equal(none.ok, false);
  assert.match(none.detail, /no participation row/);

  const fiveDays = checkFacebookGroupRule({
    item,
    ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ groupJoined: '2026-09-15' }) }) }),
    now: new Date('2026-09-20T00:00:00Z'),
  });
  assert.equal(fiveDays.ok, false);
  assert.equal(fiveDays.days, 5);

  const twentyDays = checkFacebookGroupRule({
    item,
    ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ groupJoined: '2026-08-31' }) }) }),
    now: new Date('2026-09-20T00:00:00Z'),
  });
  assert.equal(twentyDays.ok, true);
  assert.equal(twentyDays.days, 20);
});

test('§4.4 fails closed on an unreadable joined date instead of assuming the warmup is done', () => {
  const res = checkFacebookGroupRule({
    item: { channel: 'facebook', surface: 'facebook-group', group: 'Local LLM / AI Enthusiasts', text: 'x' },
    ledger: readLedger({ repoRoot: mkRepo({ log: ledgerText({ groupJoined: 'joined ages ago' }) }) }),
    now: new Date('2026-09-20T00:00:00Z'),
  });
  assert.equal(res.ok, false);
  assert.match(res.detail, /unreadable joined date/);
});

/* ----------------------------------------------------------- launch gate --- */

test('the launch gate is CLOSED when the readiness index has any non-PASS row', () => {
  const gate = readLaunchGate({ repoRoot: mkRepo({ readiness: FAIL_INDEX }) });
  assert.equal(gate.open, false);
  assert.deepEqual(gate.fails.map((f) => f.id), ['B1']);
  assert.match(gate.reason, /B1=FAIL/);
});

test('the launch gate opens only when every index row is PASS', () => {
  const gate = readLaunchGate({ repoRoot: mkRepo({ readiness: PASS_INDEX }) });
  assert.equal(gate.open, true);
  assert.equal(gate.total, 2);
  assert.match(gate.reason, /all 2 rows PASS/);
});

test('a missing or verdict-less readiness doc fails closed', () => {
  const missing = readLaunchGate({ repoRoot: mkRepo({ readiness: null }) });
  assert.equal(missing.open, false);
  assert.match(missing.reason, /missing/);
  assert.match(missing.reason, /Fail-closed/);

  const unreadable = readLaunchGate({ repoRoot: mkRepo({ readiness: '# nothing\n\nno table here\n' }) });
  assert.equal(unreadable.open, false);
  assert.match(unreadable.reason, /no readable verdict rows/);
});

test('only the verdict column counts — a PASS row whose evidence mentions a past FAIL does not close the gate', () => {
  const rows = parseReadinessIndex(
    [
      '## 1. Checklist',
      '| # | Check | Verdict | Command run | Observed output |',
      '|---|---|---|---|---|',
      '| D3 | licence on the mirror | **PASS** *(fixed)* | `gh api` | was FAIL, now 200 |',
      '',
      '## 2. Notes',
      '| E9 | not a checklist row | **FAIL** | n/a | n/a |',
    ].join('\n'),
  );
  assert.deepEqual(rows, [{ id: 'D3', verdict: 'PASS' }]);
});

test('check exits DARK (4), not OK, when no channel has credentials — and reports the closed gate', async () => {
  const out = collector();
  const code = await commandCheck({ env: {}, home: mkRepo(), repoRoot: REPO, write: out.write });
  assert.equal(code, EXIT.DARK, 'zero live channels means "nothing can be published yet", not "the report printed"');
  assert.match(out.text(), /launch gate: {6}CLOSED/);
  assert.match(out.text(), /Fail-closed/);
  assert.match(out.text(), /0 of 4 channel\(s\) live/);
});

test('a closed gate refuses every parsed item, and evaluateItem says which rule did it', () => {
  const gate = readLaunchGate({ repoRoot: mkRepo({ readiness: FAIL_INDEX }) });
  const ledger = readLedger({ repoRoot: mkRepo() });
  const item = { id: 'x-1', channel: 'x', surface: 'x-post', text: 'A plain post.', charLimit: 280 };
  const refused = evaluateItem(item, { gate, ledger });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.refusals[0].rule, 'launch-gate');

  const open = readLaunchGate({ repoRoot: mkRepo({ readiness: PASS_INDEX }) });
  assert.equal(evaluateItem(item, { gate: open, ledger }).status, 'ready');
});

/* --------------------------------------------------------------- the CLI --- */

test('usage: no subcommand, an unknown subcommand, and a bad --channel', async () => {
  const noCommand = await main([], { env: {}, home: mkRepo(), repoRoot: mkRepo(), write: () => {} });
  assert.equal(noCommand.code, EXIT.USAGE);

  const unknown = await main(['frobnicate'], { env: {}, home: mkRepo(), repoRoot: mkRepo(), write: () => {} });
  assert.equal(unknown.code, EXIT.USAGE);
  assert.match(unknown.out, /unknown subcommand "frobnicate"/);

  await assert.rejects(
    () => main(['post', '--channel', 'myspace'], { env: {}, home: mkRepo(), repoRoot: mkRepo(), write: () => {} }),
    (err) => err instanceof UsageError && /--channel must be one of/.test(err.message),
  );
});

test('plan reports every item as refused while the gate is closed, and makes no network call', async () => {
  const out = collector();
  const code = commandPlan({ env: {}, home: mkRepo(), repoRoot: REPO, write: out.write, now: new Date('2026-09-23T00:00:00Z') });
  assert.equal(code, EXIT.OK);
  assert.match(out.text(), /status: REFUSED/);
  assert.match(out.text(), /launch-gate/);
});

test('dry-run prints the exact requests and sends nothing', async () => {
  const out = collector();
  const fetchImpl = forbiddenFetch();
  const { code } = await main(['dry-run', '--channel', 'x'], {
    env: { ...X_ENV, AEGIS_SOCIAL_NOW: '2026-09-23T00:00:00Z' },
    home: mkRepo(),
    repoRoot: campaignRepo(),
    write: out.write,
    fetchImpl,
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.text(), /Nothing was sent\./);
  assert.match(out.text(), /\d+ ready, 0 refused/);
});

test('post without --live is a dry run: the requests are printed and nothing is sent', async () => {
  const out = collector();
  const fetchImpl = forbiddenFetch();
  const code = await commandPost({
    argv: { channel: 'x' },
    env: X_ENV,
    home: mkRepo(),
    repoRoot: campaignRepo(),
    write: out.write,
    fetchImpl,
    live: false,
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.equal(code, EXIT.OK);
  assert.match(out.text(), /POST https:\/\/api\.x\.com\/2\/tweets/);
  assert.match(out.text(), /header authorization: \*\*\*\*9f3a/i);
  assert.ok(!out.text().includes(X_TOKEN));
});

test('--live is refused when the plan rules block the post, without touching the network', async () => {
  const out = collector();
  const fetchImpl = forbiddenFetch();
  const code = await commandPost({
    argv: { channel: 'x' },
    env: X_ENV,
    home: mkRepo(),
    repoRoot: REPO, // the real gate is CLOSED
    write: out.write,
    fetchImpl,
    live: true,
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.equal(code, EXIT.REFUSED);
  assert.match(out.text(), /Nothing was sent/);
});

test('--live with a complete credential set and an open gate sends, and never prints the token', async () => {
  const out = collector();
  const fetchImpl = spyFetch(() => ({ ok: true, status: 201, body: { data: { id: '1900' } } }));
  const code = await commandPost({
    argv: { channel: 'x' },
    env: X_ENV,
    home: mkRepo(),
    repoRoot: campaignRepo(),
    write: out.write,
    fetchImpl,
    live: true,
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.equal(code, EXIT.OK);
  assert.ok(fetchImpl.calls.length > 0, 'the live path must actually call fetch');
  assert.ok(!out.text().includes(X_TOKEN), 'the access token must never reach the output');
  assert.match(out.text(), /done\./);
});

test('a live failure is reported without leaking the credential in the error message', async () => {
  const out = collector();
  const fetchImpl = async () => {
    throw new Error(`connect ECONNREFUSED while sending Authorization: Bearer ${X_TOKEN}`);
  };
  const code = await commandPost({
    argv: { channel: 'x' },
    env: X_ENV,
    home: mkRepo(),
    repoRoot: campaignRepo(),
    write: out.write,
    fetchImpl,
    live: true,
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.equal(code, EXIT.LIVE_FAILED);
  assert.match(out.text(), /FAILED:/);
  assert.ok(!out.text().includes(X_TOKEN), 'the token must be redacted out of the failure line');
});

test('a channel with no credentials is DARK, not a crash', async () => {
  const out = collector();
  const code = await commandPost({
    argv: { channel: 'youtube' },
    env: {},
    home: mkRepo(),
    repoRoot: campaignRepo(),
    write: out.write,
    fetchImpl: forbiddenFetch(),
    live: true,
    now: new Date('2026-09-23T00:00:00Z'),
  });
  assert.ok(code === EXIT.DARK || code === EXIT.REFUSED, `expected DARK or REFUSED, got ${code}`);
});

test('check --verify makes no network call for a dark channel', async () => {
  const out = collector();
  const fetchImpl = forbiddenFetch();
  const code = await commandCheck({
    env: {},
    home: mkRepo(),
    repoRoot: mkRepo(),
    write: out.write,
    fetchImpl,
    verify: true,
  });
  assert.equal(code, EXIT.DARK, '--verify probes nothing when every channel is dark, so the answer is still DARK');
  assert.match(out.text(), /skipped — dark/);
});

test('an over-length item is measured after markers are stripped, not before', () => {
  const withMarker = 'Cloud memory sync is a Settings toggle. <GIF: R3, tool loop + diff card>';
  assert.ok(charCount(stripMediaMarkers(withMarker)) < charCount(withMarker));
  assert.equal(charCount(stripMediaMarkers(withMarker)), charCount('Cloud memory sync is a Settings toggle.'));
});
