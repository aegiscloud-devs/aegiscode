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
 *   4  the channel is dark: no credential configured for it (`check` exits 4
 *      when zero channels are live; `post` exits 4 for the one it was asked for)
 *   5  a live request failed, or a live path needs an input it does not have;
 *      `check --verify-write` also exits 5 when a write probe proves a live
 *      channel cannot actually write (403 permissions / 402 billing / 401 auth)
 */

import fs from 'node:fs';

import { CHANNELS, ConfigError, loadCredentials, secretsFromEnvAndFile } from './config.mjs';
import { CHAR_LIMITS, itemsForWeek, loadCopy } from './copy.mjs';
import { evaluateItem, readLaunchGate } from './gates.mjs';
import { readLedger } from './ledger.mjs';
import { estimateItem, estimatePlan, formatUsd } from './rates.mjs';
import { buildRequests, credentialRequirements, USER_AGENT, xAuthHeaders } from './channels.mjs';
import {
  charCount,
  extractMediaMarkers,
  fillPlaceholders,
  isSecretKey,
  maskSecret,
  placeholderNames,
  redact,
  redactText,
  repoRootFrom,
  stripMediaMarkers,
} from './util.mjs';

export const EXIT = { OK: 0, USAGE: 1, CONFIG: 2, REFUSED: 3, DARK: 4, LIVE_FAILED: 5 };

export const CONFIG_FILE_DISPLAY = '~/.aegisc/social.json';

const USAGE = `aegis publish — the credential-driven publishing layer for the AEGIS Desktop campaign

  publish check   [--explain] [--verify] [--verify-write] [--json]
      Validate the configured credentials, per channel: live or dark.
      Never prints a secret (masked to the last 4). No network unless --verify.
      --verify-write (implies --verify) adds one non-destructive POST to X. A GET
      cannot detect a write-permission failure, so --verify alone can report
      "LIVE" for an app that cannot write a single byte. The probe body carries
      no text, so no post can be created: 400 means writable, 403 permissions,
      402 billing. A failed write probe exits 5.
      Exits 4 when no channel is live — this is the pre-publish readiness probe.

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
 * Classify the outcome of the non-destructive write probe.
 *
 * WHY THIS EXISTS: `check --verify` establishes identity with a GET, and a GET
 * succeeds on a read-only app. So the report used to say "LIVE" for an app that
 * could not write a single byte -- which is a false green on the one question
 * the operator is actually asking before a launch. X answers the two failure
 * modes at *different stages* depending on the endpoint, so the response has to
 * be read, not just checked for 2xx:
 *
 *   403 oauth1-permissions  the app is not set to Read+Write, or the access
 *                           token predates that change (portal fix).
 *   402 credits-depleted    permissions are fine; the account has no credits.
 *   400                     permissions AND billing are fine -- the probe body
 *                           is deliberately invalid, so 400 is the success case.
 */
export function classifyWriteProbe(status, body) {
  const snippet = typeof body === 'string' ? body : JSON.stringify(body || {});
  if (status === 400) {
    return { ok: true, kind: 'writable', note: 'write permission and billing are both clear (400 is expected: the probe body is invalid on purpose)' };
  }
  if (status === 402) {
    return { ok: false, kind: 'billing', note: 'read+write is active, but X refused at the billing stage — buy API credits' };
  }
  if (status === 403 && /oauth1-permissions|not configured with the appropriate/i.test(snippet)) {
    return { ok: false, kind: 'permissions', note: 'app permission is not Read+Write for this token — set Read+Write, then REGENERATE the access token' };
  }
  if (status === 401) return { ok: false, kind: 'auth', note: 'the credential did not authenticate for a write at all' };
  return { ok: false, kind: 'unknown', note: `unrecognised write outcome (${status})` };
}

/**
 * The single write probe, used by `check --verify-write`.
 *
 * WHY IT IS SEPARATE FROM `verifyProbes`: that set is GET-only by construction
 * ("check must never be able to publish"), and that promise is worth keeping --
 * so the write probe is opt-in behind its own flag and never runs as part of a
 * plain `check`.
 *
 * WHY IT IS SAFE: the body is `{}` with no `text` field. Post creation requires
 * `text`, so X rejects this request before a post can exist even when
 * permissions and credits are both fine -- the healthy outcome is a 400. There
 * is no input to this function that can produce a published post.
 */
export function writeProbes(id, values) {
  if (id !== 'x') return null;
  const url = 'https://api.x.com/2/tweets';
  return [
    {
      id: 'x-write-scope',
      label: 'write scope',
      method: 'POST',
      url,
      headers: xAuthHeaders(values, { method: 'POST', url }),
      bodyType: 'json',
      body: {},
    },
  ];
}

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
  writeVerify = false,
  explain = false,
  json = false,
}) {
  // `--verify-write` implies `--verify`: probing write scope without first
  // establishing identity would report a failure that is really just a bad
  // credential, and the read-only result is the context that makes the write
  // verdict readable. A plain `check` stays GET-only by construction.
  const doVerify = verify || writeVerify;
  const creds = loadCredentials({ env, home });
  const secrets = secretsFromEnvAndFile({ env, home });
  const gate = readLaunchGate({ repoRoot });
  const lines = [];
  const writeResults = [];
  let writeFailed = false;

  const verifyLabel = writeVerify
    ? '; --verify-write contacts each API with read-only calls, then probes X write scope with one non-destructive POST'
    : doVerify
      ? '; --verify contacts each API with read-only calls'
      : '; no network';
  lines.push(`aegis publish — check (credentials + launch gate${verifyLabel})`);
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

  const channelIds = Object.keys(CHANNELS);
  const liveCount = channelIds.filter((id) => creds.channels[id].live).length;
  lines.push('');
  lines.push(
    `${liveCount} of ${channelIds.length} channel(s) live` +
      (liveCount === 0 ? ' — nothing can be published yet (exit 4).' : ' — the launch gate below still gates posting.'),
  );

  if (doVerify) {
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

  // Opt-in write probe. A 2xx GET proved identity; it did NOT prove the app may
  // write. Only run behind the explicit flag so a plain `check` can never POST.
  if (writeVerify) {
    lines.push('');
    lines.push('write-scope verification (non-destructive POST; body carries no text, so no post can be created):');
    for (const id of Object.keys(CHANNELS)) {
      const ch = creds.channels[id];
      const probes = ch.live ? writeProbes(id, ch.values) : null;
      if (!ch.live) {
        lines.push(`  ${pad(id, 10)}skipped — dark`);
        continue;
      }
      if (!probes) {
        lines.push(`  ${pad(id, 10)}skipped — no write probe wired for this channel`);
        continue;
      }
      const vars = new Map();
      for (const probe of probes) {
        let verdict;
        try {
          const result = await sendRequest(probe, { fetchImpl, vars });
          verdict = classifyWriteProbe(result.status, result.snippet);
          const blocker = verdict.kind === 'permissions' || verdict.kind === 'billing';
          const tag = blocker ? `BLOCKER ${verdict.kind.toUpperCase()}` : verdict.ok ? 'ok' : verdict.kind;
          lines.push(`  ${pad(id, 10)}${probe.label}: ${result.status} ${tag} — ${verdict.note}`);
          if (!verdict.ok) lines.push(`  ${pad('', 10)}response: ${redactText(result.snippet, secrets)}`);
          if (!verdict.ok) writeFailed = true;
        } catch (err) {
          verdict = { ok: false, kind: 'unknown', note: 'the request itself failed' };
          lines.push(`  ${pad(id, 10)}${probe.label}: FAILED — ${redactText(err.message, secrets)}`);
          writeFailed = true;
        }
        writeResults.push({ channel: id, probe: probe.id, ok: verdict.ok, kind: verdict.kind, note: verdict.note });
      }
    }
    if (writeFailed) lines.push('  result: a live channel cannot actually write — see the BLOCKER line above.');
  }

  if (json) {
    write(
      JSON.stringify(
        {
          path: creds.path,
          filePresent: creds.filePresent,
          gate: { open: gate.open, reason: gate.reason },
          liveChannels: channelIds.filter((id) => creds.channels[id].live),
          channels: redact(creds.channels, secrets),
          ...(writeVerify ? { writeVerification: writeResults } : {}),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    write(lines.join('\n') + '\n');
  }
  // A failed write probe is a live failure, not a dark channel: the credential
  // authenticated (so it is not DARK) but the request that actually matters was
  // refused. 5, per the exit table. Only reachable behind --verify-write.
  if (writeFailed) return EXIT.LIVE_FAILED;
  // `check` is the readiness probe a script runs before a publish run, so the
  // exit code has to answer the question it was asked: with zero live channels
  // there is nothing to post to, and returning OK would only mean "the report
  // printed". DARK says "not yet" -- and stays distinct from CONFIG ("broken"),
  // which is what the exit table promises.
  return liveCount === 0 ? EXIT.DARK : EXIT.OK;
}

/* ----------------------------------------------------- gather + plan ------ */

export function gather({ env = process.env, home, repoRoot, week = 1, channelFilter = null, now = new Date() } = {}) {
  const creds = loadCredentials({ env, home });
  const gate = readLaunchGate({ repoRoot });
  const ledger = readLedger({ repoRoot });
  const copy = loadCopy({ repoRoot });
  const items = itemsForWeek(copy, week)
    .filter((it) => !channelFilter || it.channel === channelFilter)
    .map((it) => {
      // The copy bank embeds media markers (<GIF>, <GIF: R3, ...>) inline in the
      // post text. They are attach-this instructions, not text: strip them so
      // that neither the character count nor a channel's request body can carry
      // one, and surface what was stripped as the item's media note.
      const markers = extractMediaMarkers(it.text);
      const normalized = {
        ...it,
        text: stripMediaMarkers(it.text),
        title: it.title ? stripMediaMarkers(it.title) : it.title,
        media: it.media || (markers.length ? markers.join('; ') : null),
      };
      return { ...normalized, ...evaluateItem(normalized, { gate, ledger, now }) };
    });
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

  const cost = estimatePlan(items);
  lines.push('');
  lines.push(`estimated API cost: ${formatUsd(cost.totalUsd)} (pay-per-use; not a quote — the Developer Console is authoritative)`);
  for (const c of cost.byChannel) lines.push(`  ${c.channel.padEnd(9)} ${formatUsd(c.usd).padStart(7)}  — ${c.detail}`);
  if (cost.notes.length > 0) {
    lines.push('');
    for (const n of cost.notes) lines.push(`  ! ${n}`);
  }

  if (json) {
    write(
      JSON.stringify(
        {
          week,
          gate: { open: gate.open, reason: gate.reason },
          cost,
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
            costUsd: estimateItem(i).usd,
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
  const cost = estimateItem(item);
  if (cost.usd > 0) out.push(`  cost: ${formatUsd(cost.usd)} — ${cost.detail}`);
  else if (cost.billable) out.push(`  cost: $0 — ${cost.detail}`);
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
/**
 * Which media a request carries.
 *
 * The GIF request is read from the item's *media note* as well as its text.
 * `gather` strips the inline `<GIF: R3, ...>` markers out of the publishable
 * text (they are attach-instructions, not copy) and carries them on `item.media`
 * instead — so testing the text alone would silently stop attaching the file the
 * operator passed with `--media`.
 */
export function mediaFor(item, media = {}) {
  const wantsGif = /<gif/i.test(item.text || '') || /\bgif\b/i.test(item.media || '');
  if (item.channel === 'x' && media.file && wantsGif) {
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
    else if (a === '--verify-write') out.writeVerify = true;
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
          verify: Boolean(args.verify) || Boolean(args.writeVerify),
          writeVerify: Boolean(args.writeVerify),
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
