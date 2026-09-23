/**
 * Credit costing for the pay-per-use X API, and zero-ledgers for the rest.
 *
 * WHY THIS FILE EXISTS: `marketing-plan-social.md` §9 priced the X channel at
 * €0, because the thing being priced was a *scheduler* (Buffer/Typefully free
 * tier). That stopped being the whole cost when X retired the free tier and
 * moved developers to pay-per-use credits. Crucially the rate card is not flat:
 * a plain post is $0.015, but ANY post carrying a link is $0.200 — 13.3x more.
 * The week-1 launch thread contains exactly one link-bearing post (5/6), so the
 * thread costs $0.275, not the $0.09 that "6 posts x $0.015" predicts. A tool
 * whose stated job is to print *exactly what would go out* is the right place to
 * surface that, because a link premium is precisely the cost a plan gets wrong
 * quietly and then discovers on the invoice.
 *
 * Rates verified against https://docs.x.com/x-api/getting-started/pricing on
 * 2026-09-23. X states the Developer Console is authoritative and that rates are
 * subject to change, so this table is a *planning* estimate, not a quote.
 *
 * Only X bills per request. Reddit, Facebook and YouTube are quota-limited
 * rather than credit-metered; they are listed with an explicit reason so their
 * $0 reads as "no such charge" rather than "we forgot to price it".
 */

/** X write rates, in USD per request. Source: docs.x.com pay-per-use pricing. */
export const X_WRITE_RATES = {
  postCreate: 0.015,
  postCreateWithUrl: 0.2,
  postCreateSummoned: 0.01,
  source: 'https://docs.x.com/x-api/getting-started/pricing',
};

const URL_RE = /\bhttps?:\/\/\S+/i;

/** A post is billed at the link rate if it contains any URL at all. */
export function textHasLink(text) {
  return URL_RE.test(String(text || ''));
}

const NON_BILLING = {
  reddit: 'Reddit API is free; rate-limited per OAuth client, not credit-metered',
  facebook: 'Graph API has no per-call charge; rate-limited by app',
  youtube: 'quota-limited (10,000 units/day), not billed per call',
};

/**
 * Cost of one plan item.
 * @returns {{channel:string,usd:number,calls:number,billable:boolean,detail:string}}
 */
export function estimateItem(item) {
  const channel = item.channel;
  if (channel !== 'x') {
    return {
      channel,
      usd: 0,
      calls: 0,
      billable: false,
      detail: NON_BILLING[channel] || 'no per-request charge known for this channel',
    };
  }
  if (item.status === 'refused') {
    return { channel, usd: 0, calls: 0, billable: true, detail: 'refused by a plan rule — nothing would be sent' };
  }

  const parts = [];
  let usd = 0;
  let calls = 0;

  if (textHasLink(item.text)) {
    usd += X_WRITE_RATES.postCreateWithUrl;
    calls += 1;
    parts.push(`post with link $${X_WRITE_RATES.postCreateWithUrl.toFixed(3)}`);
  } else {
    usd += X_WRITE_RATES.postCreate;
    calls += 1;
    parts.push(`post $${X_WRITE_RATES.postCreate.toFixed(3)}`);
  }

  // A "link in the first comment" second post is a second write, and by X's rule
  // it is a link post regardless of how plain the parent text is.
  if (item.commentLink) {
    usd += X_WRITE_RATES.postCreateWithUrl;
    calls += 1;
    parts.push(`link comment $${X_WRITE_RATES.postCreateWithUrl.toFixed(3)}`);
  }

  if (item.media) {
    // X's write rate card lists no line for media UPLOAD (the $0.005 "Media
    // Metadata" entry is a read). Treating it as $0 is an assumption, and it is
    // flagged as one rather than silently folded in.
    parts.push('media upload: not separately priced in the rate card (assumed $0)');
  }

  return { channel, usd, calls, billable: true, detail: parts.join(', ') };
}

/**
 * Cost of a whole plan, grouped by channel.
 * @returns {{totalUsd:number,byChannel:Array,notes:string[]}}
 */
export function estimatePlan(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.channel)) {
      groups.set(item.channel, { channel: item.channel, items: 0, calls: 0, usd: 0, billable: false, reasons: new Set() });
    }
    const g = groups.get(item.channel);
    const e = estimateItem(item);
    g.items += 1;
    g.calls += e.calls;
    g.usd += e.usd;
    if (e.billable) g.billable = true;
    else g.reasons.add(e.detail);
  }

  const byChannel = [...groups.values()].map((g) => ({
    channel: g.channel,
    items: g.items,
    calls: g.calls,
    usd: Math.round(g.usd * 1e6) / 1e6,
    detail: g.billable ? `${g.calls} billable write(s)` : [...g.reasons].join('; ') || 'no charge',
  }));

  const notes = [];
  const x = byChannel.find((c) => c.channel === 'x');
  if (x && x.usd > 0) {
    notes.push('X bills per request against prepaid credits; a zero balance blocks writes with HTTP 402 (not a credential error).');
    notes.push('X charges $0.200 for any post containing a link vs $0.015 plain (13.3x) — moving a URL into a reply comment does NOT avoid it.');
  }

  return {
    totalUsd: Math.round(byChannel.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6,
    byChannel,
    notes,
  };
}

export function formatUsd(n) {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}
