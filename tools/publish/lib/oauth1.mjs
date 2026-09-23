/**
 * OAuth 1.0a request signing (HMAC-SHA1), RFC 5849 §3.4.
 *
 * WHY THIS IS HERE AND NOT A DEPENDENCY: this repo ships zero-dependency Node
 * (CONTRIBUTING.md: "No new dependencies"). X is also the one channel whose
 * posting credential realistically *is* an OAuth 1.0a user pair -- the OAuth
 * 2.0 user-context token expires in about two hours, so an operator who set the
 * app up before PKCE refresh existed still has the quartet. Both are accepted
 * by `lib/config.mjs`; this file makes the quartet path real rather than
 * documented-but-broken.
 *
 * The signature is exercised in test/publish-oauth1.test.mjs against the
 * RFC 5849 §3.4.1 worked example (base string and `tR3+Ty81lMeYAr/Fid0kMTYa/WM=`),
 * so a regression in the percent-encoding or the parameter sorting cannot ship
 * silently.
 */

import crypto from 'node:crypto';

/**
 * RFC 5849 §3.6 percent-encoding: unreserved characters are `A-Za-z0-9-._~`;
 * everything else is UTF-8 percent-encoded with uppercase hex.
 * (`encodeURIComponent` leaves `!'()*` alone, which is wrong here.)
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Parameter string: sorted by encoded key, then encoded value; `k=v` joined by `&`. */
export function signatureBaseString({ method, url, params }) {
  const parsed = new URL(url);
  const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const all = [...params];
  for (const [k, v] of parsed.searchParams.entries()) all.push([k, v]);
  const normalized = all
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${method.toUpperCase()}&${percentEncode(base)}&${percentEncode(normalized)}`;
}

/** HMAC-SHA1 over the base string, keyed by `consumerSecret&tokenSecret`. */
export function signBaseString(baseString, consumerSecret, tokenSecret) {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

/**
 * Build the `Authorization: OAuth ...` header for a request.
 * @param {{method:string,url:string,consumerKey:string,consumerSecret:string,
 *          token:string,tokenSecret:string,nonce?:string,timestamp?:number,
 *          extraParams?:Array<[string,string]>}} opts
 */
export function oauth1Header(opts) {
  const {
    method,
    url,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret,
    nonce = crypto.randomBytes(16).toString('hex'),
    timestamp = Math.floor(Date.now() / 1000),
  } = opts;
  const oauthParams = [
    ['oauth_consumer_key', consumerKey],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', String(timestamp)],
    ['oauth_token', token],
    ['oauth_version', '1.0'],
  ];
  const baseString = signatureBaseString({ method, url, params: oauthParams });
  const signature = signBaseString(baseString, consumerSecret, tokenSecret);
  const headerParams = [...oauthParams, ['oauth_signature', signature]]
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');
  return { header: `OAuth ${headerParams}`, signature, baseString };
}
