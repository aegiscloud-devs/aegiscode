// The social publishing layer (tools/publish/).
//
// Two kinds of case live here, and the split is deliberate:
//
//   * REGRESSION cases drawn from the two defects this layer shipped with. A
//     media marker (`<GIF: R3, ...>`) was counted as post text -- reporting a
//     compliant post as over-length -- and, worse, nothing stripped it before
//     the request body was built, so a live run would have published the
//     marker itself as visible text. Both are asserted against the real
//     campaign docs, not a fixture, because the real docs are what ship.
//
//   * GATE cases, on synthetic repos, for the rules that must fail closed:
//     an unreadable launch index, a Reddit draft carrying a link before the
//     ten comments exist, a Facebook group posted to before the warmup. These
//     need controlled inputs, so they build their own repo.
//
// Nothing here touches the network. `fetchImpl` is always injected.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyWriteProbe, EXIT, gather, main, parseArgs, renderRequest, UsageError, writeProbes,
} from '../tools/publish/lib/run.mjs';
import { buildRequests } from '../tools/publish/lib/channels.mjs';
import { CHAR_LIMITS } from '../tools/publish/lib/copy.mjs';
import {
  checkCompliance, checkFacebookGroupRule, checkRedditLinkRule, memorySyncViolation, readLaunchGate,
} from '../tools/publish/lib/gates.mjs';
import { readLedger } from '../tools/publish/lib/ledger.mjs';
import {
  charCount, extractMediaMarkers, placeholderNames, stripMediaMarkers,
} from '../tools/publish/lib/util.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// An empty $HOME is the documented "credentials not pasted yet" state, and it
// also guarantees a real ~/.aegisc/social.json on the machine running the tests
// can never leak into an assertion.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-home-'));
const tmpDirs = [];
after(() => {
  for (const d of [...tmpDirs, HOME]) fs.rmSync(d, { recursive: true, force: true });
});

/* -------------------------------------------------------------- fixtures -- */

/** A §1 verdict table, as `readLaunchGate` parses it. */
const readinessIndex = (rows) =>
  '# Launch readiness\n\n## 1. Checklist\n\n| # | Check | Verdict | Evidence |\n|---|---|---|---|\n' +
  rows.map(([id, verdict]) => `| ${id} | check ${id} | ${verdict} | evidence ${id} |`).join('\n') +
  '\n\n## 2. Detail\n\nProse that must not be parsed as verdicts.\n';

const ALL_PASS = readinessIndex([['A1', '**PASS**'], ['A2', '**PASS**']]);

const EMPTY_LEDGER_DOC = `# Marketing log

## 5. Ledger

<!-- publish-ledger:comments -->
| date | subreddit | note |
|---|---|---|
<!-- publish-ledger:fb-groups -->
| group | joined | note |
|---|---|---|
`;

/** A minimal but real X thread: §2.1, the `w1-launch-thread` slug, blockquotes. */
const X_THREAD_DOC = `# Copy

### 2.1 Weekly thread — \`w1-launch-thread\`

**Post 1/** *(the hook)*
> 1/ first post of the synthetic thread

**Post 2/** *(the reply)*
> 2/ second post, a reply to the first
`;

const ledgerWithGroup = (joined) => ({
  path: 'docs/marketing-log.md',
  comments: [],
  fbGroups: [{ group: 'claude ai users', joined, note: '' }],
  found: { comments: true, fbGroups: true },
});

const EMPTY_LEDGER = {
  path: 'docs/marketing-log.md', comments: [], fbGroups: [], found: { comments: true, fbGroups: true },
};

function makeRepo({ readiness = ALL_PASS, log = EMPTY_LEDGER_DOC, copy = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-repo-'));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  if (readiness !== null) fs.writeFileSync(path.join(dir, 'docs/launch-readiness.md'), readiness);
  if (log !== null) fs.writeFileSync(path.join(dir, 'docs/marketing-log.md'), log);
  if (copy !== null) fs.writeFileSync(path.join(dir, 'docs/launch-copy-x-youtube.md'), copy);
  return dir;
}

/** Run `main` with an output sink, so a test can assert on what a user sees. */
async function runCli(argv, opts = {}) {
  const out = [];
  const { code } = await main(argv, {
    env: {}, home: HOME, repoRoot: REPO_ROOT, write: (s) => out.push(s), ...opts,
  });
  return { code, text: out.join('') };
}

/* ------------------------------------------------- media markers (bug 1+2) -- */

test('an annotated media marker parses, though PLACEHOLDER_RE cannot match it', () => {
  // Root cause of bug 1: PLACEHOLDER_RE is /<([a-z0-9_.]+)>/i, so it matches a
  // bare `<gif>` but not `<GIF: R3, tool loop + diff card>` -- uppercase, a
  // colon, spaces, commas. Anything built on it misses the annotated form.
  const marker = '<GIF: R3, tool loop + diff card>';
  assert.equal(placeholderNames(marker).size, 0, 'PLACEHOLDER_RE does not match the annotated marker');
  assert.deepEqual(extractMediaMarkers(marker), ['GIF: R3, tool loop + diff card']);
  assert.equal(stripMediaMarkers(marker), '');
  assert.equal(extractMediaMarkers('<GIF>').length, 1, 'the bare form is a marker too');
});

test('no campaign item carries a media marker in its text', () => {
  const { items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1 });
  assert.ok(items.length > 0, 'week 1 has copy to publish');
  for (const item of items) {
    assert.ok(!/<(GIF|IMG|IMAGE|VIDEO|SHOT|SCREENSHOT)\b/i.test(item.text), `${item.id} still embeds a marker`);
  }
});

test('the marker that made post 3 look over-length is stripped and surfaced as media', () => {
  // Regression for bug 1. The doc's post 3 embeds `<GIF: R3, ...>`; counting it
  // as text reported 289/280 for a post that is inside the budget.
  const { items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1, channelFilter: 'x' });
  const post3 = items.find((i) => i.id === 'x-thread-3');
  assert.ok(post3, 'the doc carries X thread post 3');
  assert.ok(charCount(post3.text) <= CHAR_LIMITS['x-post'], `post 3 is ${charCount(post3.text)} chars`);
  assert.match(post3.media, /^GIF: R3/, 'what was stripped is reported as the item\'s media');
});

test('a media marker can never reach a channel request body', () => {
  // Regression for bug 2, the one that would have shipped visibly: channels.mjs
  // sends `body = { text: item.text }`, so an unstripped marker is published as
  // literal text in the tweet.
  const { items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1, channelFilter: 'x' });
  const post3 = items.find((i) => i.id === 'x-thread-3');
  const requests = buildRequests({ item: post3, credentials: { bearerToken: 'tok' } });
  const dumped = JSON.stringify(requests);
  assert.ok(!/<GIF/i.test(dumped), 'a marker reached an outgoing request');
  assert.ok(!dumped.includes('tool loop + diff card'), 'the marker description reached an outgoing request');
});

test('every X post in the campaign docs fits the 280-character budget', () => {
  // This is the invariant that caught the real defect in post 4 (364 chars):
  // measured on the text that would actually be sent, markers excluded.
  const { items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1, channelFilter: 'x' });
  const over = items
    .filter((i) => charCount(i.text) > CHAR_LIMITS['x-post'])
    .map((i) => `${i.id}=${charCount(i.text)}`);
  assert.deepEqual(over, [], `posts over the budget: ${over.join(', ')}`);
});

test('the reply chain resolves tweet_id through the previous response', () => {
  // The thread is built as replies, so post 2's target only exists at send
  // time; the item carries the placeholder rather than a guessed id.
  const repo = makeRepo({ copy: X_THREAD_DOC });
  const { items } = gather({ env: {}, home: HOME, repoRoot: repo, week: 1, channelFilter: 'x' });
  assert.equal(items.length, 2);
  const second = buildRequests({ item: items[1], credentials: { bearerToken: 'tok' } })[0];
  assert.equal(second.body.reply.in_reply_to_tweet_id, '<tweet_id>');
  assert.equal(items[0].replyToPrevious, false, 'the first post of a thread is not a reply');
});

/* --------------------------------------------------------- the launch gate -- */

test('an unreadable or missing launch index keeps the gate closed', () => {
  // Fail-closed direction: an instrument that cannot be read is never evidence
  // that the launch sequence completed.
  assert.equal(readLaunchGate({ repoRoot: makeRepo({ readiness: null }) }).open, false);
  assert.equal(readLaunchGate({ repoRoot: makeRepo({ readiness: '# no table here\n' }) }).open, false);
});

test('one FAIL row closes the gate and the reason names it', () => {
  const repo = makeRepo({ readiness: readinessIndex([['A1', '**PASS**'], ['A7', '**FAIL**']]) });
  const gate = readLaunchGate({ repoRoot: repo });
  assert.equal(gate.open, false);
  assert.match(gate.reason, /A7=FAIL/);
});

test('an all-PASS index opens the gate', () => {
  const gate = readLaunchGate({ repoRoot: makeRepo({}) });
  assert.equal(gate.open, true);
  assert.equal(gate.fails.length, 0);
});

test('while the gate is closed, nothing in the campaign is ready to post', () => {
  // Durable implication rather than "the gate is closed today": the assertion
  // holds before and after launch.
  const { gate, items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1 });
  if (gate.open) return;
  assert.ok(items.length > 0);
  assert.deepEqual(items.filter((i) => i.status !== 'refused').map((i) => i.id), []);
});

/* ------------------------------------------------- §4.3 / §4.4 (fail-closed) -- */

test('a Reddit draft with a link is refused until ten comments are logged', () => {
  const item = {
    channel: 'reddit', surface: 'reddit-post', subreddit: 'LocalLLaMA',
    text: 'I built this. https://example.com/thing',
  };
  assert.equal(checkRedditLinkRule({ item, ledger: EMPTY_LEDGER }).ok, false);

  const ten = {
    ...EMPTY_LEDGER,
    comments: Array.from({ length: 10 }, (_, i) => ({ subreddit: 'localllama', date: `2026-01-0${(i % 9) + 1}`, note: '' })),
  };
  assert.equal(checkRedditLinkRule({ item, ledger: ten }).ok, true);
});

test('a Reddit draft with no link goes through — that is the comment-farming phase', () => {
  const item = { channel: 'reddit', surface: 'reddit-post', subreddit: 'LocalLLaMA', text: 'I built this. No link yet.' };
  assert.equal(checkRedditLinkRule({ item, ledger: EMPTY_LEDGER }).ok, true);
});

test('a Facebook group post needs 14 days of logged participation', () => {
  const item = {
    channel: 'facebook', surface: 'facebook-group-post', group: 'Claude AI Users',
    text: 'Disclosure: I built this.',
  };
  assert.equal(checkFacebookGroupRule({ item, ledger: EMPTY_LEDGER }).ok, false, 'no row at all is refused');

  const ledger = ledgerWithGroup('2026-01-10');
  assert.equal(checkFacebookGroupRule({ item, ledger, now: new Date('2026-01-20T00:00:00Z') }).ok, false, '9 days');
  assert.equal(checkFacebookGroupRule({ item, ledger, now: new Date('2026-01-25T00:00:00Z') }).ok, true, '15 days');
  assert.equal(checkFacebookGroupRule({ item, ledger: ledgerWithGroup('last tuesday'), now: new Date('2026-02-01T00:00:00Z') }).ok, false, 'unreadable date fails closed');
});

test('a ledger that is missing its marker reads as zero rows, not as enough', () => {
  const repo = makeRepo({ log: '# Marketing log\n\nNo markers in this one.\n' });
  const ledger = readLedger({ repoRoot: repo });
  assert.equal(ledger.comments.length, 0);
  assert.equal(ledger.found.comments, false);
});

/* -------------------------------------------------------------- §8 copy ---- */

test('§8 refuses banned claims, and the negation of the retired memory claim is not', () => {
  assert.equal(checkCompliance({ text: 'a 10x faster agent' }).ok, false);
  assert.match(memorySyncViolation('cloud sync is opt-in per message'), /opt-in per message/);
  // draft 11 writes the negation, which is the *correct* statement; a blunt
  // substring ban would have refused a compliant post.
  assert.equal(memorySyncViolation('cloud sync is not opt-in per message'), null);
});

test('every campaign item passes the §8 copy rules on the text that would be sent', () => {
  const { items } = gather({ env: {}, home: HOME, repoRoot: REPO_ROOT, week: 1 });
  const violations = items
    .filter((i) => !checkCompliance(i).ok)
    .map((i) => `${i.id}: ${checkCompliance(i).violations.map((v) => v.rule).join(',')}`);
  assert.deepEqual(violations, []);
});

/* ------------------------------------------------------------------ check --- */

test('check is a readiness probe: no live channel exits 4, not 0', () => {
  // The distinction the exit table promises: DARK means "not yet", CONFIG means
  // "broken". A check that returned OK with nothing configured would make
  // `publish check && publish post ...` a lie.
  return runCli(['check']).then(({ code, text }) => {
    assert.equal(code, EXIT.DARK);
    assert.match(text, /0 of 4 channel\(s\) live/);
  });
});

test('check exits 0 as soon as one channel is live', async () => {
  const { code, text } = await runCli(['check'], { env: { X_BEARER_TOKEN: 'a'.repeat(30) + 'TAIL' } });
  assert.equal(code, EXIT.OK);
  assert.match(text, /1 of 4 channel\(s\) live/);
});

test('no secret can appear in check output — text or JSON', async () => {
  const bearer = 'BEARER-SECRET-0000-4321';
  const pageToken = 'PAGE-SECRET-0000-9876';
  const env = { X_BEARER_TOKEN: bearer, FB_PAGE_ID: '1234567890', FB_PAGE_ACCESS_TOKEN: pageToken };

  for (const argv of [['check'], ['check', '--json']]) {
    const { text } = await runCli(argv, { env });
    assert.ok(!text.includes(bearer), `${argv.join(' ')} leaked the X bearer token`);
    assert.ok(!text.includes(pageToken), `${argv.join(' ')} leaked the page token`);
    assert.match(text, /4321/, 'the masked last 4 are shown so the operator can tell which token is in use');
    assert.match(text, /1234567890/, 'the Page id is an identifier, not a secret, and prints in full');
  }
});

test('a broken credential file exits 2 rather than reporting every channel dark', async () => {
  // A store that is present but unparseable must not read as "nothing
  // configured": that is the silent failure the ConfigError exists for.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-badhome-'));
  tmpDirs.push(home);
  fs.mkdirSync(path.join(home, '.aegisc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aegisc/social.json'), '{ not json');
  await assert.rejects(() => main(['check'], { env: {}, home, repoRoot: REPO_ROOT, write: () => {} }), /social\.json/);
});

test('check exits 4 when the credential file is absent — a valid, documented state', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-nohome-'));
  tmpDirs.push(home);
  const { code, text } = await runCli(['check'], { home });
  assert.equal(code, EXIT.DARK);
  assert.match(text, /not present — env only/);
});

/* --------------------------------------------------------- --verify-write --- */

test('classifyWriteProbe reads each write outcome the way X reports it', () => {
  // 400 is the *healthy* case: the probe body is deliberately invalid, so X
  // rejects it before a post can exist -- and reaching that stage proves both
  // the permission and the billing gates were passed.
  assert.deepEqual(classifyWriteProbe(400, '{}'), {
    ok: true, kind: 'writable',
    note: 'write permission and billing are both clear (400 is expected: the probe body is invalid on purpose)',
  });
  assert.equal(classifyWriteProbe(402, '{"title":"depleted"}').kind, 'billing');
  assert.equal(
    classifyWriteProbe(403, '{"detail":"Your app is not configured with the appropriate permissions"}').kind,
    'permissions',
  );
  assert.equal(classifyWriteProbe(403, '{"detail":"oauth1-permissions required"}').kind, 'permissions');
  assert.equal(classifyWriteProbe(401, '{"title":"Unauthorized"}').kind, 'auth');
  assert.equal(classifyWriteProbe(500, 'boom').kind, 'unknown');
  assert.equal(classifyWriteProbe(403, '{"title":"Forbidden"}').kind, 'unknown', 'a 403 without the permission wording is not assumed to be permissions');
  // Every non-writable outcome must be a failure, so a script cannot read it green.
  for (const [status, body] of [[402, '{}'], [403, 'oauth1-permissions'], [401, '{}'], [500, 'boom']]) {
    assert.equal(classifyWriteProbe(status, body).ok, false, `${status} must not read as ok`);
  }
});

test('writeProbes sends one POST whose body cannot create a post', () => {
  const probes = writeProbes('x', { bearerToken: 'a'.repeat(30) + 'TAIL' });
  assert.equal(probes.length, 1);
  const [probe] = probes;
  assert.equal(probe.method, 'POST');
  assert.equal(probe.url, 'https://api.x.com/2/tweets');
  assert.equal(probe.bodyType, 'json');
  assert.deepEqual(probe.body, {}, 'the body is empty');
  // The safety property: post creation requires `text`, so with no `text` field
  // X must reject this request -- the probe cannot publish anything.
  assert.ok(!('text' in probe.body), 'the probe body must never carry a text field');
  assert.match(probe.headers.authorization, /^Bearer /);
});

test('writeProbes has no probe for a channel that is not X', () => {
  assert.equal(writeProbes('reddit', { username: 'u', password: 'p' }), null);
  assert.equal(writeProbes('facebook', { pageAccessToken: 't' }), null);
});

test('check without --verify-write never issues a POST', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { username: 'aegis' } }) };
  };
  const env = { X_BEARER_TOKEN: 'a'.repeat(30) + 'TAIL' };

  // A plain check is offline by construction: no flag, no network at all.
  const plain = await runCli(['check'], { env, fetchImpl });
  assert.equal(plain.code, EXIT.OK);
  assert.equal(calls.length, 0, 'plain check made a network call');

  // --verify adds the read-only GET, still no POST.
  const verified = await runCli(['check', '--verify'], { env, fetchImpl });
  assert.equal(verified.code, EXIT.OK);
  assert.ok(calls.length > 0, '--verify did contact the API');
  assert.deepEqual(calls.filter((c) => c.method === 'POST'), [], '--verify issued a POST');
  assert.ok(calls.some((c) => c.url.includes('/2/users/me')), '--verify issued the identity GET');
});

test('check --verify-write surfaces the permissions blocker and exits 5', async () => {
  // The false green this whole change exists to kill: the GET succeeds (so
  // --verify alone says LIVE) on an app that cannot write a byte.
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init?.method });
    if (init?.method === 'POST') {
      return {
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ title: 'Forbidden', detail: 'Your app is not configured with the appropriate permissions' }),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { username: 'aegis' } }) };
  };
  const { code, text } = await runCli(['check', '--verify-write'], {
    env: { X_BEARER_TOKEN: 'a'.repeat(30) + 'TAIL' },
    fetchImpl,
  });

  assert.equal(code, EXIT.LIVE_FAILED, 'a proven write failure is exit 5, not a green LIVE');
  const post = calls.find((c) => c.method === 'POST');
  assert.ok(post, 'the write probe was sent');
  assert.equal(post.url, 'https://api.x.com/2/tweets');
  assert.match(text, /BLOCKER PERMISSIONS/);
  assert.match(text, /REGENERATE the access token/);
});

test('check --verify-write reports a writable app (400) as ok and exits 0', async () => {
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') return { ok: false, status: 400, text: async () => JSON.stringify({ title: 'Invalid Request' }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { username: 'aegis' } }) };
  };
  const { code, text } = await runCli(['check', '--verify-write'], {
    env: { X_BEARER_TOKEN: 'a'.repeat(30) + 'TAIL' },
    fetchImpl,
  });
  assert.equal(code, EXIT.OK);
  assert.match(text, /write scope: 400 ok/);
  assert.match(text, /write permission and billing are both clear/);
});

test('--verify-write implies --verify and is parsed as a boolean flag', () => {
  const parsed = parseArgs(['check', '--verify-write']);
  assert.equal(parsed.writeVerify, true);
  assert.equal(parsed.verify, undefined, 'the value flag --verify is not set by --verify-write itself');
});

/* -------------------------------------------------------------- rendering --- */

test('renderRequest masks secrets in headers, URLs and bodies', () => {
  const secret = 'LIVE-TOKEN-0000-1357';
  const item = {
    id: 'x-thread-1', channel: 'x', surface: 'x-post', label: 'post 1',
    text: 'hello', planRef: 'ref', replyToPrevious: false,
  };
  const requests = buildRequests({ item, credentials: { bearerToken: secret } });
  const rendered = requests.flatMap((r, i) => renderRequest(r, i + 1, [secret])).join('\n');
  assert.ok(!rendered.includes(secret), 'a live token reached the dry-run output');
  assert.match(rendered, /1357/, 'the masked tail is still shown');
});

/* ------------------------------------------------------------------- post --- */

test('post on a dark channel exits 4 and says which credential is missing', async () => {
  const repo = makeRepo({ copy: X_THREAD_DOC });
  const { code, text } = await runCli(['post', '--channel', 'x'], { repoRoot: repo });
  assert.equal(code, EXIT.DARK);
  assert.match(text, /bearerToken/);
});

test('post without --channel, or with an unknown one, is a usage error', async () => {
  const noChannel = await runCli(['post']);
  assert.equal(noChannel.code, EXIT.USAGE);
  assert.match(noChannel.text, /--channel/);

  await assert.rejects(
    () => main(['post', '--channel', 'myspace'], { env: {}, home: HOME, repoRoot: REPO_ROOT, write: () => {} }),
    UsageError,
  );
  const unknown = await runCli(['teleport']);
  assert.equal(unknown.code, EXIT.USAGE);
});

test('post --live sends the built request and reports the response (stubbed fetch)', async () => {
  const repo = makeRepo({ copy: X_THREAD_DOC });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, text: async () => JSON.stringify({ data: { id: '9001' } }) };
  };
  const { code, text } = await runCli(['post', '--channel', 'x', '--live', '--week', '1'], {
    repoRoot: repo,
    env: { X_BEARER_TOKEN: 'live-token' },
    fetchImpl,
  });

  assert.equal(code, EXIT.OK);
  assert.equal(calls.length, 2, 'two posts in the thread, two requests');
  assert.match(calls[0].init.headers.authorization, /live-token/);
  assert.match(text, /9001/, 'the id returned by the first response is reported');
  // Post 2 replies to post 1, so its target must come from the response, not
  // from a guess in the copy.
  assert.equal(JSON.parse(calls[1].init.body).reply.in_reply_to_tweet_id, '9001');
});

test('post --live does not send when the copy needs an input only a response can give', async () => {
  // Fail-closed with no partial send: if the chain cannot resolve, stop before
  // anything leaves the machine.
  const repo = makeRepo({ copy: X_THREAD_DOC });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 201, text: async () => JSON.stringify({}) }; // no id returned
  };
  const { code } = await runCli(['post', '--channel', 'x', '--live'], {
    repoRoot: repo,
    env: { X_BEARER_TOKEN: 'live-token' },
    fetchImpl,
  });

  assert.equal(code, EXIT.LIVE_FAILED);
  assert.equal(calls.length, 1, 'the reply was never attempted');
});

test('post --live reports a non-2xx from the platform instead of claiming success', async () => {
  const repo = makeRepo({ copy: X_THREAD_DOC });
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '{"title":"Forbidden"}' });
  const { code, text } = await runCli(['post', '--channel', 'x', '--live'], {
    repoRoot: repo,
    env: { X_BEARER_TOKEN: 'live-token' },
    fetchImpl,
  });
  assert.equal(code, EXIT.LIVE_FAILED);
  assert.match(text, /403/);
});

test('a dry run sends nothing, even with credentials configured', async () => {
  const repo = makeRepo({ copy: X_THREAD_DOC });
  let called = false;
  const { code, text } = await runCli(['post', '--channel', 'x'], {
    repoRoot: repo,
    env: { X_BEARER_TOKEN: 'live-token' },
    fetchImpl: async () => { called = true; return { ok: true, status: 200, text: async () => '{}' }; },
  });
  assert.equal(called, false);
  assert.equal(code, EXIT.OK);
  assert.match(text, /nothing was sent/);
});

/* -------------------------------------------------------------------- args -- */

test('parseArgs separates value flags from boolean flags', () => {
  const parsed = parseArgs(['post', '--channel', 'x', '--live', '--json']);
  assert.equal(parsed.channel, 'x');
  assert.equal(parsed.live, true);
  assert.equal(parsed.json, true);
  assert.deepEqual(parsed._, ['post']);
});

test('a value flag with no value is a usage error, not a silent undefined', () => {
  assert.throws(() => parseArgs(['--week']), /needs a value/);
  assert.throws(() => parseArgs(['--week', '--live']), /needs a value/);
});

test('--week must be a non-negative integer', async () => {
  await assert.rejects(() => main(['plan', '--week', 'soon'], { env: {}, home: HOME, repoRoot: REPO_ROOT, write: () => {} }), /non-negative integer/);
  await assert.rejects(() => main(['plan', '--week', '-1'], { env: {}, home: HOME, repoRoot: REPO_ROOT, write: () => {} }), /non-negative integer/);
});

test('--json output is machine-readable for every command', async () => {
  for (const argv of [['check', '--json'], ['plan', '--json'], ['dry-run', '--json']]) {
    const { text } = await runCli(argv);
    assert.doesNotThrow(() => JSON.parse(text), `${argv.join(' ')} did not emit valid JSON`);
  }
});
