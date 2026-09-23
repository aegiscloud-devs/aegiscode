// Costing for the pay-per-use X API (tools/publish/lib/rates.mjs).
//
// WHY THESE CASES EXIST: the campaign budget (§9 of marketing-plan-social.md)
// priced the X channel at €0, which was true when scheduling tools were free and
// the API was free. X's 2026 pay-per-use card broke that in a way that is easy
// to get wrong in exactly one direction: a post carrying a link is $0.200 while
// a plain post is $0.015. A naive "count the posts, multiply by the cheap rate"
// estimator under-reports the week-1 launch thread by 3x ($0.09 vs $0.275).
//
// So the load-bearing cases here are the link-premium ones, plus the two ways an
// estimator lies by omission: pricing a refused item as if it would send, and
// pricing a non-X channel as "$0" without saying why that zero is not an
// oversight. Both are asserted against the real campaign docs where possible,
// because the real docs are what ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateItem, estimatePlan, textHasLink, formatUsd, X_WRITE_RATES } from '../tools/publish/lib/rates.mjs';
import { gather } from '../tools/publish/lib/run.mjs';

const repoRoot = new URL('..', import.meta.url).pathname;

test('a post containing a URL is billed at the link rate, and one without at the plain rate', () => {
  const plain = estimateItem({ channel: 'x', status: 'ready', text: 'no links here at all' });
  assert.equal(plain.usd, X_WRITE_RATES.postCreate);

  const linked = estimateItem({ channel: 'x', status: 'ready', text: 'install it https://example.com now' });
  assert.equal(linked.usd, X_WRITE_RATES.postCreateWithUrl);
});

test('the link premium is the 13.3x ratio the docs quote', () => {
  // The §9 note says "13.3 times". If the rate card ever changes this ratio the
  // note and the code have to move together, so the assertion is on the ratio.
  const ratio = X_WRITE_RATES.postCreateWithUrl / X_WRITE_RATES.postCreate;
  assert.ok(Math.abs(ratio - 13.333) < 0.01, `expected ~13.3x, got ${ratio}`);
});

test('textHasLink sees the URL shapes the campaign docs actually use', () => {
  assert.ok(textHasLink('free key at https://aegiscloud.org/?utm_source=x'));
  assert.ok(textHasLink('see http://example.com'));
  assert.ok(textHasLink('github.com is not matched without a scheme') === false);
  assert.ok(!textHasLink('npm i -g aegis-desktop && aegis'));
});

test('a link moved into a reply comment does not dodge the premium', () => {
  // The plan's own text suggests link-in-first-comment as a reach tactic. That
  // is still a billable write, and still a link post.
  const withCommentLink = estimateItem({
    channel: 'x',
    status: 'ready',
    text: 'plain body',
    commentLink: 'https://aegiscloud.org/?utm_source=x',
  });
  assert.equal(withCommentLink.calls, 2);
  assert.equal(withCommentLink.usd, X_WRITE_RATES.postCreate + X_WRITE_RATES.postCreateWithUrl);
});

test('a refused item costs nothing, because nothing would be sent', () => {
  const refused = estimateItem({ channel: 'x', status: 'refused', text: 'https://example.com' });
  assert.equal(refused.usd, 0);
  assert.match(refused.detail, /refused/i);
});

test('non-X channels report zero with a stated reason, not a bare zero', () => {
  for (const channel of ['reddit', 'facebook', 'youtube']) {
    const e = estimateItem({ channel, status: 'ready', text: 'body https://example.com' });
    assert.equal(e.usd, 0);
    assert.equal(e.billable, false);
    assert.ok(e.detail.length > 10, `${channel} must explain its zero`);
  }
});

test('the real week-1 X thread costs $0.275 — five plain posts plus one link post', () => {
  // Derived from the shipping docs, not a fixture. This is the number the plan
  // is actually wrong about, so it is the one worth pinning.
  const { items } = gather({ repoRoot, week: 1, channelFilter: 'x' });
  assert.equal(items.length, 6);
  const cost = estimatePlan(items);
  assert.equal(cost.totalUsd, 0.275);
  assert.equal(cost.byChannel.find((c) => c.channel === 'x').calls, 6);
});

test('a naive flat-rate estimate would under-report the real thread, which is the point', () => {
  const { items } = gather({ repoRoot, week: 1, channelFilter: 'x' });
  const naive = items.length * X_WRITE_RATES.postCreate;
  const real = estimatePlan(items).totalUsd;
  assert.ok(real > naive * 3, `real ${real} should dwarf naive ${naive}`);
});

test('plan notes call out the 402 as a billing state rather than a credential error', () => {
  // The observed live failure was HTTP 402 "credits depleted" arriving *after*
  // auth and app-permission passed. Calling that a credential problem sends the
  // operator to regenerate tokens, which fixes nothing.
  const { items } = gather({ repoRoot, week: 1, channelFilter: 'x' });
  const notes = estimatePlan(items).notes.join(' ');
  assert.match(notes, /402/);
  assert.match(notes, /credits/i);
});

test('cost formatting keeps sub-dollar amounts legible', () => {
  assert.equal(formatUsd(0.015), '$0.015');
  assert.equal(formatUsd(0.275), '$0.275');
  assert.equal(formatUsd(12.5), '$12.50');
});
