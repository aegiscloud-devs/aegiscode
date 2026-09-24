/**
 * Channel adapters: copy item in, the exact HTTP requests out.
 *
 * This module is deliberately *pure*. It builds a list of request descriptors
 * and never performs I/O, so `dry-run` and `post --live` walk the identical
 * list -- the thing you read in a dry run is literally the thing that gets
 * sent, which is the only property that makes a dry run worth having.
 *
 * Secrets sit in the descriptors in the clear, because that is what a request
 * needs. They are masked on the way to a terminal by `lib/util.mjs#redact`,
 * which masks by key name (`authorization`, `access_token`, ...) *and* by
 * literal value. test/publish-secrets.test.mjs drives every subcommand with
 * canary values and asserts none of them survives to stdout or stderr.
 *
 * Endpoints are the documented public ones:
 *   X        POST https://api.x.com/2/tweets           (v2, user context)
 *   Reddit   POST https://oauth.reddit.com/api/submit  (OAuth 2.0 script app)
 *   Facebook POST https://graph.facebook.com/v21.0/{id}/feed
 *   YouTube  PUT  https://www.googleapis.com/youtube/v3/channels (brandingSettings)
 *            POST https://www.googleapis.com/upload/youtube/v3/videos (resumable)
 *
 * HONEST LIMIT: none of these has ever been executed against the live APIs,
 * because no credential for any of the four accounts exists on this machine
 * (docs/social-publishing.md §1). They are built from the platforms' published
 * request shapes and are covered by mocked tests only.
 */

import { oauth1Header } from './oauth1.mjs';
import { isFacebookGroupSurface } from './util.mjs';

export const GRAPH_VERSION = 'v21.0';

const X_API = 'https://api.x.com/2/tweets';
const X_MEDIA = 'https://upload.twitter.com/1.1/media/upload.json';
const REDDIT_TOKEN = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_SUBMIT = 'https://oauth.reddit.com/api/submit';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const YT_CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const YT_UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';

/** Reddit and friends require a descriptive UA; a default one is rate-limited. */
export const USER_AGENT = 'aegis-social-publisher/1.0 (+https://github.com/aegisinfo/aegiscode-plugin)';

function form(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') p.append(k, String(v));
  }
  return p.toString();
}

function basic(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

export function xAuthHeaders(creds, request = { method: 'POST', url: X_API }) {
  if (creds.bearerToken) {
    return { authorization: `Bearer ${creds.bearerToken}`, 'content-type': 'application/json' };
  }
  const { header } = oauth1Header({
    method: request.method,
    url: request.url,
    consumerKey: creds.apiKey,
    consumerSecret: creds.apiSecret,
    token: creds.accessToken,
    tokenSecret: creds.accessTokenSecret,
  });
  return { authorization: header, 'content-type': 'application/json' };
}

/* ------------------------------------------------------------------ X ----- */

export function xRequests({ item, creds, mediaToken = null }) {
  const body = { text: item.text };
  if (mediaToken) body.media = { media_ids: [mediaToken] };
  if (item.replyToPrevious) {
    body.reply = { in_reply_to_tweet_id: '<tweet_id>' };
  }
  return [
    {
      id: `${item.id}-tweet`,
      label: `${item.label}`,
      method: 'POST',
      url: X_API,
      headers: xAuthHeaders(creds),
      bodyType: 'json',
      body,
      produces: 'tweet_id',
      extract: (json) => json?.data?.id,
      note: item.replyToPrevious
        ? 'reply chain: <tweet_id> is the id returned by the previous request (X threads are replies)'
        : 'first post of the thread — no reply target',
    },
  ];
}

export function xMediaRequests({ item, creds, filePath, bytes, mediaType }) {
  return [
    {
      id: `${item.id}-media-init`,
      label: 'media upload (X v1.1) — INIT',
      method: 'POST',
      url: `${X_MEDIA}?command=INIT&total_bytes=${bytes}&media_type=${encodeURIComponent(mediaType)}`,
      headers: xAuthHeaders(creds),
      bodyType: 'none',
      produces: 'media_id',
      extract: (json) => json?.media_id_string || (json?.media_id ? String(json.media_id) : undefined),
      note: `local file: ${filePath}`,
    },
    {
      id: `${item.id}-media-append`,
      label: 'media upload (X v1.1) — APPEND',
      method: 'POST',
      url: `${X_MEDIA}?command=APPEND&media_id=<media_id>&segment_index=0`,
      headers: { ...xAuthHeaders(creds), 'content-type': 'multipart/form-data' },
      bodyType: 'none',
      body: `<base64 of ${filePath}>`,
      note: 'multipart/form-data with media_data=<base64>',
    },
    {
      id: `${item.id}-media-finalize`,
      label: 'media upload (X v1.1) — FINALIZE',
      method: 'POST',
      url: `${X_MEDIA}?command=FINALIZE&media_id=<media_id>`,
      headers: xAuthHeaders(creds),
      bodyType: 'none',
      produces: 'media_id',
      extract: (json) => json?.media_id_string || (json?.media_id ? String(json.media_id) : undefined),
      note: 'media_id from FINALIZE is attached to the tweet',
    },
  ];
}

/* ------------------------------------------------------------ Mastodon ---- */

export function mastodonAuthHeaders(creds) {
  return { authorization: `Bearer ${creds.accessToken}`, 'content-type': 'application/json' };
}

export function mastodonRequests({ item, creds }) {
  const base = String(creds.instance || '').replace(/\/$/, '');
  const body = { status: item.text, visibility: 'public' };
  if (item.replyToPrevious) body.in_reply_to_id = '<status_id>';
  return [
    {
      id: `${item.id}-status`,
      label: `${item.label}`,
      method: 'POST',
      url: `${base}/api/v1/statuses`,
      headers: mastodonAuthHeaders(creds),
      bodyType: 'json',
      body,
      produces: 'status_id',
      extract: (json) => json?.id,
      note: item.replyToPrevious
        ? 'reply chain: <status_id> is the id returned by the previous request'
        : 'first post — no reply target',
    },
  ];
}

/* ------------------------------------------------------------ Bluesky ----- */

const BSKY_XRPC = 'https://bsky.social/xrpc';

export function blueskyRequests({ item, creds }) {
  const session = {
    id: `${item.id}-session`,
    label: 'create session (app password)',
    method: 'POST',
    url: `${BSKY_XRPC}/com.atproto.server.createSession`,
    headers: { 'content-type': 'application/json' },
    bodyType: 'json',
    body: { identifier: creds.handle, password: creds.appPassword },
    produces: 'access_jwt',
    extract: (json) => json?.accessJwt,
    note: 'the app password never appears in output; the session JWT is used as a Bearer header below',
  };

  const record = {
    $type: 'app.bsky.feed.post',
    text: item.text,
    createdAt: new Date().toISOString(),
  };
  if (item.replyToPrevious) {
    record.reply = {
      root: { uri: '<post_uri>', cid: '<post_cid>' },
      parent: { uri: '<post_uri>', cid: '<post_cid>' },
    };
  }

  const post = {
    id: `${item.id}-post`,
    label: `${item.label}`,
    method: 'POST',
    url: `${BSKY_XRPC}/com.atproto.repo.createRecord`,
    headers: { authorization: 'Bearer <access_jwt>', 'content-type': 'application/json' },
    bodyType: 'json',
    body: { repo: creds.handle, collection: 'app.bsky.feed.post', record },
    produces: 'post_uri',
    extract: (json) => json?.uri,
    note: item.replyToPrevious
      ? 'reply chain: <post_uri>/<post_cid> come from the previous request (cid not resolvable from a dry run)'
      : 'first post — no reply target',
  };

  return [session, post];
}

/* -------------------------------------------------------------- Reddit ---- */

export function redditRequests({ item, creds }) {
  const out = [
    {
      id: `${item.id}-token`,
      label: 'OAuth 2.0 token (script app)',
      method: 'POST',
      url: REDDIT_TOKEN,
      headers: {
        authorization: basic(creds.clientId, creds.clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      bodyType: 'form',
      body: {
        grant_type: 'password',
        username: creds.username,
        password: creds.password,
        scope: 'identity,submit,read',
      },
      produces: 'access_token',
      extract: (json) => json?.access_token,
      note: 'the access token never appears in output; it is used as a Bearer header below',
    },
  ];

  const auth = { authorization: 'Bearer <access_token>', 'user-agent': USER_AGENT };

  if (item.imagePost) {
    out.push({
      id: `${item.id}-media-asset`,
      label: 'media asset lease',
      method: 'POST',
      url: 'https://oauth.reddit.com/api/media_asset.json',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      bodyType: 'form',
      body: { filename: 'model-class-picker.png', mimetype: 'image/png' },
      produces: 'asset_upload_url',
      extract: (json) => json?.args?.action || json?.args?.upload_url,
      note: `local file: ${item.media || 'docs/marketing-assets/01-model-class-picker.png'}`,
    });
  }

  out.push({
    id: `${item.id}-submit`,
    label: `submit to r/${item.subreddit}`,
    method: 'POST',
    url: REDDIT_SUBMIT,
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    bodyType: 'form',
    body: {
      api_type: 'json',
      sr: item.subreddit,
      title: item.title,
      kind: item.imagePost ? 'image' : 'self',
      ...(item.imagePost ? { url: '<asset_url>' } : { text: item.text }),
    },
    produces: 'thing_id',
    extract: (json) => {
      const errs = json?.json?.errors;
      if (Array.isArray(errs) && errs.length > 0) throw new Error(`reddit rejected the submit: ${JSON.stringify(errs)}`);
      return json?.json?.data?.id;
    },
    note: item.imagePost
      ? 'the image goes up first; the body text is posted as the first comment per §4.3 rule 3'
      : '§4.3 rule 3: the link lives at the end of the body, after the limitations',
  });

  if (item.imagePost) {
    out.push({
      id: `${item.id}-selftext-comment`,
      label: 'the explanation, as a comment on your own post',
      method: 'POST',
      url: 'https://oauth.reddit.com/api/comment',
      headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
      bodyType: 'form',
      body: { api_type: 'json', thing_id: '<thing_id>', text: item.text },
      note: 'a body-text post cannot also be an image post; Reddit has one flavour per submission',
    });
  }

  return out;
}

/* ------------------------------------------------------------ Facebook ---- */

export function facebookRequests({ item, creds, optional = {} }) {
  const isGroup = isFacebookGroupSurface(item);
  const token = isGroup ? optional.userToken : creds.pageAccessToken;
  const target = isGroup ? optional.groupId : creds.pageId;

  const out = [
    {
      id: `${item.id}-feed`,
      label: isGroup ? `group feed post (${item.group})` : 'Page feed post',
      method: 'POST',
      url: `${GRAPH}/${target}/feed`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      bodyType: 'form',
      body: { message: item.text, access_token: token },
      produces: 'post_id',
      extract: (json) => json?.id,
      note: isGroup
        ? 'requires a USER token holding publish_to_groups — a Page token cannot post to a group'
        : 'Page token; the UTM link goes in the first comment (§4.2 link discipline)',
    },
  ];

  if (item.commentLink) {
    out.push({
      id: `${item.id}-comment`,
      label: 'first comment carrying the UTM link',
      method: 'POST',
      url: `${GRAPH}/<post_id>/comments`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      bodyType: 'form',
      body: { message: item.commentLink, access_token: token },
      note: 'a post cannot comment on itself in one call, so <post_id> comes from the response above',
    });
  }

  return out;
}

/* ------------------------------------------------------------- YouTube ---- */

export function youtubeRequests({ item, creds, videoPath = null }) {
  const auth = { authorization: 'Bearer <access_token>', 'content-type': 'application/json' };
  const out = [
    {
      id: `${item.id}-token`,
      label: 'OAuth 2.0 refresh (offline access)',
      method: 'POST',
      url: GOOGLE_TOKEN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      bodyType: 'form',
      body: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: creds.refreshToken,
        grant_type: 'refresh_token',
      },
      produces: 'access_token',
      extract: (json) => json?.access_token,
      note: 'the refresh token is the credential you paste once; the access token is per-run',
    },
  ];

  if (item.surface === 'youtube-channel-description') {
    out.push({
      id: `${item.id}-channels`,
      label: 'channel description (brandingSettings)',
      method: 'PUT',
      url: `${YT_CHANNELS}?part=brandingSettings`,
      headers: auth,
      bodyType: 'json',
      body: { id: creds.channelId, brandingSettings: { channel: { description: item.text } } },
      note: 'day-0 YouTube work: the §2.2 description is paste-ready, and there is no video yet',
    });
    return out;
  }

  out.push({
    id: `${item.id}-videos`,
    label: `resumable upload — "${item.title}"`,
    method: 'POST',
    url: `${YT_UPLOAD}?uploadType=resumable&part=snippet,status`,
    headers: { ...auth, 'x-upload-content-type': 'video/mp4' },
    bodyType: 'json',
    body: {
      snippet: {
        title: item.title,
        description: item.text,
        categoryId: '28',
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    },
    produces: 'upload_url',
    extract: (_json, res) => res?.headers?.get?.('location') || undefined,
    note: videoPath ? `local file: ${videoPath}` : 'no --video file given',
  });
  out.push({
    id: `${item.id}-upload`,
    label: 'PUT the recorded file to the resumable session URL',
    method: 'PUT',
    url: '<upload_url>',
    headers: { 'content-type': 'video/mp4' },
    bodyType: 'none',
    body: videoPath ? `<bytes of ${videoPath}>` : '<bytes of the recorded cut>',
    note: 'uploads as private; publish it in Studio once the description and thumbnail are checked (§6)',
  });
  return out;
}

/* --------------------------------------------------------------- router --- */

/**
 * Build the request list for one item.
 * @param {{item:object, credentials:object, media?:{filePath?:string,bytes?:number,mediaType?:string,videoPath?:string}, optional?:object, mediaToken?:string}} opts
 */
export function buildRequests({ item, credentials, media = {}, optional = {}, mediaToken = null }) {
  switch (item.channel) {
    case 'x': {
      const out = [];
      if (media.filePath) {
        out.push(
          ...xMediaRequests({
            item,
            creds: credentials,
            filePath: media.filePath,
            bytes: media.bytes ?? 0,
            mediaType: media.mediaType || 'image/gif',
          }),
        );
      }
      out.push(...xRequests({ item, creds: credentials, mediaToken: mediaToken || (media.filePath ? '<media_id>' : null) }));
      return out;
    }
    case 'reddit':
      return redditRequests({ item, creds: credentials });
    case 'facebook':
      return facebookRequests({ item, creds: credentials, optional });
    case 'youtube':
      return youtubeRequests({ item, creds: credentials, videoPath: media.videoPath || null });
    case 'mastodon':
      return mastodonRequests({ item, creds: credentials });
    case 'bluesky':
      return blueskyRequests({ item, creds: credentials });
    default:
      throw new Error(`no adapter for channel "${item.channel}"`);
  }
}

/** Which credential values each channel needs before it can build requests. */
export function credentialRequirements(item) {
  switch (item.channel) {
    case 'x':
      return { channel: 'x', need: 'x bearerToken, or apiKey/apiSecret/accessToken/accessTokenSecret' };
    case 'reddit':
      return { channel: 'reddit', need: 'clientId/clientSecret/username/password (script app)' };
    case 'facebook':
      return isFacebookGroupSurface(item)
        ? { channel: 'facebook', need: 'groupId/userToken (FB_GROUP_ID, FB_USER_TOKEN) — a Page token cannot post to a group' }
        : { channel: 'facebook', need: 'pageId/pageAccessToken' };
    case 'youtube':
      return { channel: 'youtube', need: 'clientId/clientSecret/refreshToken/channelId' };
    case 'mastodon':
      return { channel: 'mastodon', need: 'instance/accessToken' };
    case 'bluesky':
      return { channel: 'bluesky', need: 'handle/appPassword' };
    default:
      return { channel: item.channel, need: '(unknown)' };
  }
}

export { form, basic };
