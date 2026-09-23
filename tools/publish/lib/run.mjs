/**
 * Command implementations: check · plan · dry-run · post.
 *
 * Everything the user can see is written through the injected `write` sink, so
 * the same code path is exercised by tests (which capture the output and assert
 * no secret can appear in it) and by the CLI.
 *
 * EXIT CODES -- a script has to be able to tell "not yet" from "broken":
 *   0  ok
 *   1  usage error (bad subcommand/flag)
 *   2  the credential store itself is broken (unreadable or invalid JSON)
 *   3  refused by one of the plan's own rules (launch gate, §8 copy rules,
 *      Reddit 9:1, Facebook group warmup)
 *   4  the channel is dark: no credential configured for it
 *   5  a live request failed, or a live path needs an input it does not have
 */

import fs from 'node:fs';

import { CHANNELS, ConfigError, loadCredentials, secretsFromEnvAndFile } from './config.mjs';
import { CHAR_LIMITS, itemsForWeek, loadCopy } from './copy.mjs';
import { evaluateItem, readLaunchGate } from './gates.mjs';
import { readLedger } from './ledger.mjs';
import { buildRequests, credentialRequirements, USER_AGENT, xAuthHeaders } from './channels.mjs';
import {
  charCount,
  fillPlaceholders,
  isSecretKey,
  maskSecret,
  placeholderNames,
  redact,
  redactText,
  repoRootFrom,
} from './util.mjs';

export const EXIT = { OK: 0, USAGE: 1, CONFIG: 2, REFUSED: 3, DARK: 4, LIVE_FAILED: 5 };

export const CONFIG_FILE_DISPLAY = '~/.aegisc/social.json';

const USAGE = `aegis publish — the credential-driven publishing layer for the AEGIS Desktop campaign

  publish check   [--explain] [--verify] [--json]
      Validate the configured credentials, per channel: live or dark.
      Never prints a secret (masked to the last 4). No network unless --verify.

  publish plan    [--week N] [--channel x|reddit|facebook|youtube] [--json]
      Read the week's copy out of the campaign docs and print exactly what
      would go out, per channel, with character counts and the target surface.

  publish dry-run [--week N] [--channel ...] [--json]
      The full pipeline with zero network writes: the exact HTTP requests
      (method, url, body) with secrets masked.

  publish post --channel <x|reddit|facebook|youtube> [--live] [--week N]
              [--media FILE] [--video FILE]
      Without --live this is a dry run for that one channel.
      With --live it sends the requests -- only if every gate is open.

The launch gate is read from docs/launch-readiness.md §1 (§6 T-7); the Reddit
comment credits and Facebook group participation from docs/marketing-log.md §5
(markers "publish-ledger:comments" / "publish-ledger:fb-groups").

Credentials come from the environment or ${CONFIG_FILE_DISPLAY} — nothing else.
See docs/social-publishing.md for where each token comes from.`;

/* --------------------------------------------------------------- output --- */

function pad(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Secrets are masked to the last 4; identifiers (ids, usernames) print raw. */
function displayValue(key, value) {
  return isSecretKey(key) ? maskSecret(value) : String(value);
}

/** A compact "k=****1234, j=****abcd" rendering of one credential set. */
function credentialLine(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${displayValue(k, v)}`)
    .join(', ');
}

/* ---------------------------------------------------------------- check --- */

/**
 * Read-only identity probes used by `check --verify`. GET-only by construction:
 * `check` must never be able to publish. Reddit and YouTube need an access
 * token first, so their probe is the two-request token exchange + identity GET
 * -- the same requests a real publish would make, minus the write.
 */
export function verifyProbes(id, values) {
  switch (id) {
    case 'x':
      return [
        {
          id: 'x-me',
          label: 'identity',
          method: 'GET',
          url: 'https://api.x.com/2/users/me',
          headers: xAuthHeaders(values, { method: 'GET', url: 'https://api.x.com/2/users/me' }),
          bodyType: 'none',
          extract: (json) => json?.data?.username,
          produces: 'username',
        },
      ];
    case 'reddit':
      return [
        {
          id: 'reddit-token',
          label: 'token exchange',
          method: 'POST',
          url: 'https://www.reddit.com/api/v1/access_token',
          headers: {
            authorization: `Basic ${Buffer.from(`${values.clientId}:${values.clientSecret}`, 'utf8').toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': USER_AGENT,
          },
          bodyType: 'form',
          body: { grant_type: 'password', username: values.username, password: values.password, scope: 'identity' },
          produces: 'access_token',
          extract: (json) => json?.access_token,
        },
        {
          id: 'reddit-me',
          label: 'identity',
          method: 'GET',
          url: 'https://oauth.reddit.com/api/v1/me',
          headers: { authorization: 'Bearer <access_token>', 'user-agent': USER_AGENT },
          bodyType: 'none',
          extract: (json) => json?.name,
          produces: 'username',
        },
      ];
    case 'facebook':
      return [
        {
          id: 'facebook-page',
          label: 'page identity',
          method: 'GET',
          url: `https://graph.facebook.com/v21.0/${values.pageId}?fields=id,name&access_token=${encodeURIComponent(values.pageAccessToken)}`,
          headers: {},
          bodyType: 'none',
          extract: (json) => json?.name,
          produces: 'page_name',
        },
      ];
    case 'youtube':
      return [
        {
          id: 'youtube-token',
          label: 'token exchange',
          method: 'POST',
          url: 'https://oauth2.googleapis.com/token',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          bodyType: 'form',
          body: {
            client_id: values.clientId,
            client_secret: values.clientSecret,
            refresh_token: values.refreshToken,
            grant_type: 'refresh_token',
          },
          produces: 'access_token',
          extract: (json) => json?.access_token,
        },
        {
          id: 'youtube-channel',
          label: 'channel identity',
          method: 'GET',
          url: 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true',
          headers: { authorization: 'Bearer <access_token>' },
          bodyType: 'none',
          extract: (json) => json?.items?.[0]?.snippet?.title,
          produces: 'channel_title',
        },
      ];
    default:
      return null;
  }
}

export async function commandCheck({
  env = process.env,
  home,
  repoRoot,
  write,
  fetchImpl = fetch,
  verify = false,
  explain = false,
  json = false,
}) {
  const creds = loadCredentials({ env, home });
  const secrets = secretsFromEnvAndFile({ env, home });
  const gate = readLaunchGate({ repoRoot });
  const lines = [];

  lines.push(`aegis publish — check (credentials + launch gate${verify ? '; --verify contacts each API with read-only calls' : '; no network'})`);
  lines.push('');
  lines.push(`credential store: ${creds.path}${creds.filePresent ? '' : '  (not present — env only, which is a valid setup)'}`);
  lines.push(`launch gate:      ${gate.open ? 'OPEN' : 'CLOSED'} — ${gate.reason}`);
  lines.push('');
  lines.push(`${pad('channel', 10)}${pad('state', 7)}${pad('source', 11)}credential`);

  for (const id of Object.keys(CHANNELS)) {
    const ch = creds.channels[id];
    const spec = CHANNELS[id];
    if (ch.live) {
      lines.push(`${pad(id, 10)}${pad('LIVE', 7)}${pad(ch.source, 11)}${ch.setName}: ${credentialLine(ch.values)}`);
    } else {
      const parts = ch.alternatives.map((a) => `${a.name} needs ${a.missing.join(', ')}`);
      lines.push(`${pad(id, 10)}${pad('DARK', 7)}${pad('—', 11)}${parts.join(' | ')}`);
    }
    for (const [name, opt] of Object.entries(ch.optional || {})) {
      const state = opt.resolved.complete ? 'LIVE' : 'DARK';
      const detail = opt.resolved.complete
        ? credentialLine(opt.resolved.values)
        : `needs ${opt.resolved.missing.map((f) => f.env).join(', ')}`;
      lines.push(`${pad('', 10)}${pad(state, 7)}${pad('—', 11)}${name} (${opt.surface}): ${detail}`);
    }
    if (explain) {
      lines.push(`${pad('', 10)}scopes: ${spec.scopes.join(', ')}`);
      lines.push(`${pad('', 10)}tokens: ${spec.credentialUrl}`);
    }
  }

  if (verify) {
    lines.push('');
    lines.push('read-only verification:');
    for (const id of Object.keys(CHANNELS)) {
      const ch = creds.channels[id];
      if (!ch.live) {
        lines.push(`  ${pad(id, 10)}skipped — dark`);
        continue;
      }
      const probes = verifyProbes(id, ch.values);
      if (!probes) {
        lines.push(`  ${pad(id, 10)}skipped — no read-only endpoint wired for this channel`);
        continue;
      }
      const vars = new Map();
      for (const probe of probes) {
        try {
          const result = await sendRequest(probe, { fetchImpl, vars });
          lines.push(`  ${pad(id, 10)}${probe.label}: ${result.status} ${result.ok ? 'ok' : redactText(result.snippet, secrets)}`);
          if (!result.ok) break;
          for (const [k, v] of Object.entries(result.vars || {})) if (!isSecretKey(k)) vars.set(k, v);
        } catch (err) {
          lines.push(`  ${pad(id, 10)}${probe.label}: FAILED — ${redactText(err.message, secrets)}`);
          break;
        }
      }
    }
    if (gate.open === false) lines.push('  note: the launch gate being CLOSED does not make a credential invalid; it blocks posting.');
  }

  if (json) {
    write(
      JSON.stringify(
        {
          path: creds.path,
          filePresent: creds.filePresent,
          gate: { open: gate.open, reason: gate.reason },
          channels: redact(creds.channels, secrets),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    write(lines.join('\n') + '\n');
  }
  return EXIT.OK;
}

/* ----------------------------------------------------- gather + plan ------ */

export function gather({ env = process.env, home, repoRoot, week = 1, channelFilter = null, now = new Date() } = {}) {
  const creds = loadCredentials({ env, home });
  const gate = readLaunchGate({ repoRoot });
  const ledger = readLedger({ repoRoot });
  const copy = loadCopy({ repoRoot });
  const items = itemsForWeek(copy, week)
    .filter((it) => !channelFilter || it.channel === channelFilter)
    .map((it) => ({ ...it, ...evaluateItem(it, { gate, ledger, now }) }));
  return { creds, gate, ledger, copy, items, week };
}

export function commandPlan({
  env = process.env,
  home,
  repoRoot,
  week = 1,
  channelFilter = null,
  write,
  json = false,
  now = new Date(),
}) {
  const { creds, gate, ledger, items } = gather({ env, home, repoRoot, week, channelFilter, now });
  const lines = [];
  lines.push(`aegis publish — plan — week ${week}`);
  lines.push(`launch gate: ${gate.open ? 'OPEN' : 'CLOSED'} — ${gate.reason}`);
  lines.push(`reddit comment ledger: ${ledger.path} — ${ledger.comments.length} comment(s) recorded`);
  lines.push(`facebook group ledger: ${ledger.path} — ${ledger.fbGroups.length} group(s) with participation`);
  lines.push('');

  if (items.length === 0) {
    lines.push(`no copy for week ${week}${channelFilter ? ` on ${channelFilter}` : ''} in the campaign docs.`);
    lines.push('The docs carry the items they carry; nothing here is generated to fill a week.');
  }

  let lastChannel = null;
  for (const item of items) {
    if (item.channel !== lastChannel) {
      lines.push(`--- ${item.channel} ---`);
      lastChannel = item.channel;
    }
    lines.push(...renderItem(item, creds));
  }

  const refused = items.filter((i) => i.status === 'refused').length;
  lines.push('');
  lines.push(`${items.length} item(s): ${items.length - refused} ready, ${refused} refused`);

  if (json) {
    write(
      JSON.stringify(
        {
          week,
          gate: { open: gate.open, reason: gate.reason },
          items: items.map((i) => ({
            id: i.id,
            channel: i.channel,
            surface: i.surface,
            label: i.label,
            chars: charCount(i.text),
            limit: i.charLimit,
            status: i.status,
            refusals: i.refusals,
            title: i.title || null,
            media: i.media || null,
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return EXIT.OK;
  }
  write(lines.join('\n') + '\n');
  return EXIT.OK;
}

function titleLimit(item) {
  return item.channel === 'youtube' ? CHAR_LIMITS['youtube-title'] : CHAR_LIMITS['reddit-title'];
}

export function renderItem(item, creds) {
  const out = [];
  const chars = charCount(item.text);
  const over = item.charLimit && chars > item.charLimit;
  out.push(`[${item.id}] ${item.label}`);
  out.push(
    `  surface: ${item.surface}   chars: ${chars}${item.charLimit ? `/${item.charLimit}${over ? '  OVER LIMIT' : ''}` : ''}   status: ${item.status.toUpperCase()}`,
  );
  if (item.title) out.push(`  title: ${item.title} (${charCount(item.title)}/${titleLimit(item)})`);
  if (item.media) out.push(`  media: ${item.media}`);
  if (item.commentLink) out.push(`  link goes in the first comment: ${item.commentLink}`);
  out.push(`  where: ${item.planRef}`);
  const req = credentialRequirements(item);
  const live = creds.channels[item.channel]?.live;
  out.push(`  credential: ${item.channel} — ${live ? 'LIVE' : 'DARK'} (${req.need})`);
  for (const r of item.refusals) out.push(`  REFUSED  ${r.rule}: ${r.detail}`);
  out.push('  ---');
  for (const line of String(item.text).split('\n')) out.push(`  ${line}`);
  out.push('  ---');
  return out;
}

/* -------------------------------------------------------------- dry-run --- */

export function commandDryRun({
  env = process.env,
  home,
  repoRoot,
  week = 1,
  channelFilter = null,
  write,
  json = false,
  media = {},
  now = new Date(),
}) {
  const { creds, gate, ledger, items } = gather({ env, home, repoRoot, week, channelFilter, now });
  const secrets = secretsFromEnvAndFile({ env, home });
  const lines = [];
  lines.push(`aegis publish — dry run (zero network writes) — week ${week}`);
  lines.push(`launch gate: ${gate.open ? 'OPEN' : 'CLOSED'} — ${gate.reason}`);
  lines.push('');

  for (const item of items) {
    lines.push(...renderItem(item, creds));
    const channelCreds = creds.channels[item.channel];
    if (item.status === 'refused') {
      lines.push('  no requests built: refused above (fail-closed).');
      continue;
    }
    if (!channelCreds.live) {
      lines.push(`  no requests built: ${item.channel} is DARK — ${credentialRequirements(item).need}`);
      continue;
    }
    const requests = buildRequests({
      item,
      credentials: channelCreds.values,
      media: mediaFor(item, media),
      optional: facebookOptional(channelCreds),
    });
    lines.push(`  ${requests.length} request(s):`);
    requests.forEach((r, i) => lines.push(...renderRequest(r, i + 1, secrets)));
  }

  const refused = items.filter((i) => i.status === 'refused').length;
  lines.push('');
  lines.push(`${items.length} item(s): ${items.length - refused} ready, ${refused} refused. Nothing was sent.`);

  if (json) {
    write(JSON.stringify({ week, items: items.map((i) => ({ id: i.id, status: i.status, refusals: i.refusals })) }, null, 2) + '\n');
  } else {
    write(lines.join('\n') + '\n');
  }
  return refused > 0 ? EXIT.REFUSED : EXIT.OK;
}

/**
 * `--media FILE` attaches to the X post that carries the doc's own
 * `<GIF: ...>` placeholder (thread post 3), not to every post in the thread.
 */
export function mediaFor(item, media = {}) {
  if (item.channel === 'x' && media.file && /<gif/i.test(item.text)) {
    return { filePath: media.file, bytes: safeSize(media.file), mediaType: media.mediaType || 'image/gif' };
  }
  if (item.channel === 'youtube' && media.video) return { videoPath: media.video };
  return {};
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function facebookOptional(channelCreds) {
  const opt = channelCreds.optional?.['group-publisher']?.resolved;
  return opt && opt.complete ? opt.values : {};
}

export function renderRequest(req, n, secrets) {
  const out = [];
  out.push(`  ${n}. ${req.method} ${req.url}`);
  out.push(`     label: ${req.label}`);
  for (const [k, v] of Object.entries(req.headers || {})) {
    out.push(`     header ${k}: ${isSecretKey(k) ? maskSecret(v) : redactText(v, secrets)}`);
  }
  if (req.bodyType === 'json') {
    out.push(`     body: ${redactText(JSON.stringify(req.body), secrets)}`);
  } else if (req.bodyType === 'form') {
    const encoded = new URLSearchParams(Object.entries(req.body).map(([k, v]) => [k, String(v)])).toString();
    out.push(`     body: ${redactText(encoded, secrets)}`);
  } else if (req.bodyType === 'multipart') {
    out.push(`     body: multipart/form-data — ${Object.keys(req.multipartValues || {}).join(', ')}`);
  } else if (req.body) {
    out.push(`     body: ${redactText(String(req.body), secrets)}`);
  }
  if (req.note) out.push(`     note: ${req.note}`);
  return out;
}

/* ----------------------------------------------------------------- post --- */

export async function commandPost({
  argv = {},
  env = process.env,
  home,
  repoRoot,
  write,
  fetchImpl = fetch,
  live = false,
  week = 1,
  media = {},
  now = new Date(),
}) {
  const channel = argv.channel;
  if (!channel) {
    write('post: --channel <x|reddit|facebook|youtube> is required.\n');
    return EXIT.USAGE;
  }
  if (!CHANNELS[channel]) {
    write(`post: unknown channel "${channel}". One of: ${Object.keys(CHANNELS).join(', ')}.\n`);
    return EXIT.USAGE;
  }

  const { creds, gate, ledger, items } = gather({ env, home, repoRoot, week, channelFilter: channel, now });
  const secrets = secretsFromEnvAndFile({ env, home });
  const lines = [];
  lines.push(`aegis publish — post ${live ? '--live' : '(dry run; add --live to send)'} — ${channel} — week ${week}`);
  lines.push(`launch gate: ${gate.open ? 'OPEN' : 'CLOSED'} — ${gate.reason}`);
  lines.push('');

  if (items.length === 0) {
    lines.push(`no copy for week ${week} on ${channel} in the campaign docs.`);
    write(lines.join('\n') + '\n');
    return EXIT.OK;
  }

  for (const item of items) lines.push(...renderItem(item, creds));

  const refused = items.filter((i) => i.status === 'refused');
  if (refused.length > 0) {
    lines.push('');
    lines.push(`REFUSED: ${refused.length} of ${items.length} item(s) are blocked by the plan's own rules:`);
    for (const item of refused) for (const r of item.refusals) lines.push(`  ${r.rule}: ${r.detail}`);
    lines.push('Nothing was sent. Fix the rule (log the comments/participation, open the launch gate) and re-run.');
    write(lines.join('\n') + '\n');
    return EXIT.REFUSED;
  }

  const channelCreds = creds.channels[channel];
  if (!channelCreds.live) {
    lines.push('');
    lines.push(`DARK: ${channel} has no complete credential set — ${credentialRequirements(items[0]).need}`);
    lines.push(`Put it in ${creds.path} (or the environment) per docs/social-publishing.md, then re-run.`);
    write(lines.join('\n') + '\n');
    return EXIT.DARK;
  }

  if (live) {
    const needsVideo = items.find((i) => i.requiresVideoFile && !media.video);
    if (needsVideo) {
      lines.push('');
      lines.push(
        `BLOCKED: ${needsVideo.id} needs a recorded cut (--video FILE). §3 of the plan: the raw captures R1–R5 ` +
          `are not recorded yet, so there is nothing to upload. The description is ready and is printed above.`,
      );
      write(lines.join('\n') + '\n');
      return EXIT.LIVE_FAILED;
    }
  }

  const vars = new Map();
  let step = 0;
  for (const item of items) {
    const requests = buildRequests({
      item,
      credentials: channelCreds.values,
      media: mediaFor(item, media),
      optional: facebookOptional(channelCreds),
    });
    if (!live) {
      lines.push('');
      lines.push(`${requests.length} request(s) for ${item.id}:`);
      requests.forEach((r, i) => lines.push(...renderRequest(r, i + 1, secrets)));
      continue;
    }
    lines.push('');
    lines.push(`sending ${requests.length} request(s) for ${item.id}:`);
    for (const request of requests) {
      step += 1;
      hydrateLocalFile(request, media);
      const unresolved = [
        ...placeholderNames(request.url),
        ...placeholderNames(request.body),
        ...placeholderNames(request.headers),
        ...placeholderNames(request.multipartValues || {}),
      ].filter((name) => !vars.has(name));
      if (unresolved.length > 0) {
        lines.push(`  ${step}. ${request.method} ${request.url} — STOPPED: unresolved ${unresolved.map((m) => `<${m}>`).join(', ')}`);
        lines.push('     This live path needs a value only a previous response can produce. Nothing further was sent.');
        write(lines.join('\n') + '\n');
        return EXIT.LIVE_FAILED;
      }
      let result;
      try {
        result = await sendRequest(request, { fetchImpl, vars });
      } catch (err) {
        lines.push(`  ${step}. ${request.method} ${request.url} — FAILED: ${redactText(err.message, secrets)}`);
        write(lines.join('\n') + '\n');
        return EXIT.LIVE_FAILED;
      }
      lines.push(`  ${step}. ${request.method} ${fillPlaceholders(request.url, Object.fromEntries(vars))} — ${result.status} ${result.ok ? 'ok' : 'ERROR'}`);
      if (!result.ok) {
        lines.push(`     response: ${redactText(result.snippet, secrets)}`);
        write(lines.join('\n') + '\n');
        return EXIT.LIVE_FAILED;
      }
      for (const [k, v] of Object.entries(result.vars || {})) {
        vars.set(k, v);
        lines.push(`     → ${k} = ${isSecretKey(k) ? maskSecret(v) : String(v)}`);
      }
    }
  }

  lines.push('');
  lines.push(live ? 'done.' : 'nothing was sent (dry run).');
  write(lines.join('\n') + '\n');
  return EXIT.OK;
}

/** Read the bytes an X media APPEND step needs; nothing else touches the disk. */
function hydrateLocalFile(request, media) {
  if (request.bodyType !== 'multipart' || !media.file) return;
  try {
    request.multipartValues = { media_data: fs.readFileSync(media.file).toString('base64') };
  } catch {
    /* the request will fail with the real file error from fetch */
  }
}

export async function sendRequest(request, { fetchImpl, vars = new Map() }) {
  const map = Object.fromEntries(vars);
  const url = fillPlaceholders(request.url, map);
  const headers = fillPlaceholders(request.headers || {}, map);
  let body;
  if (request.bodyType === 'json') body = JSON.stringify(fillPlaceholders(request.body, map));
  else if (request.bodyType === 'form') body = new URLSearchParams(Object.entries(fillPlaceholders(request.body, map)).map(([k, v]) => [k, String(v)])).toString();
  else if (request.bodyType === 'multipart') body = multipartBody(fillPlaceholders(request.multipartValues || {}, map));
  else if (request.bodyType === 'raw' && request.rawFile) body = fs.readFileSync(request.rawFile);

  const res = await fetchImpl(url, { method: request.method, headers, body, redirect: 'follow' });
  const text = typeof res.text === 'function' ? await res.text() : '';
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  const out = {};
  if (request.produces && request.extract) {
    try {
      const v = request.extract(json, res);
      if (v) out[request.produces] = v;
    } catch (err) {
      throw new Error(`could not read ${request.produces} from the response: ${err.message}`);
    }
  }
  return { ok: Boolean(res.ok), status: res.status, snippet: String(text).slice(0, 400), vars: out };
}

function multipartBody(values) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.append(k, String(v));
  return fd;
}

/* ------------------------------------------------------------------ CLI --- */

export class UsageError extends Error {}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--explain') out.explain = true;
    else if (a === '--verify') out.verify = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${key} needs a value`);
      out[key] = value;
      i += 1;
    } else out._.push(a);
  }
  return out;
}

export async function main(argv, { env = process.env, home, repoRoot, write = (s) => process.stdout.write(s), fetchImpl = fetch } = {}) {
  const args = parseArgs(argv);
  const command = args._[0] || null;
  const root = repoRoot || repoRootFrom(import.meta.url);

  if (!command || args.help) {
    return { code: args.help && !command ? EXIT.OK : command ? EXIT.OK : EXIT.USAGE, out: USAGE };
  }

  const week = args.week === undefined ? 1 : Number(args.week);
  if (!Number.isInteger(week) || week < 0) throw new UsageError(`--week must be a non-negative integer (got "${args.week}")`);
  const channelFilter = args.channel ? String(args.channel) : null;
  if (channelFilter && !CHANNELS[channelFilter]) {
    throw new UsageError(`--channel must be one of ${Object.keys(CHANNELS).join(', ')} (got "${args.channel}")`);
  }
  const media = { file: args.media, video: args.video };
  const now = env.AEGIS_SOCIAL_NOW ? new Date(env.AEGIS_SOCIAL_NOW) : new Date();
  if (Number.isNaN(now.getTime())) throw new UsageError('AEGIS_SOCIAL_NOW is not a valid date');

  switch (command) {
    case 'check':
      return {
        code: await commandCheck({
          env,
          home,
          repoRoot: root,
          write,
          fetchImpl,
          verify: Boolean(args.verify),
          explain: Boolean(args.explain),
          json: Boolean(args.json),
        }),
      };
    case 'plan':
      return { code: commandPlan({ env, home, repoRoot: root, week, channelFilter, write, json: Boolean(args.json), now }) };
    case 'dry-run':
      return { code: commandDryRun({ env, home, repoRoot: root, week, channelFilter, write, json: Boolean(args.json), media, now }) };
    case 'post':
      return {
        code: await commandPost({ argv: args, env, home, repoRoot: root, write, fetchImpl, live: Boolean(args.live), week, media, now }),
      };
    default:
      return { code: EXIT.USAGE, out: `unknown subcommand "${command}"\n\n${USAGE}` };
  }
}

export { ConfigError, USER_AGENT };
