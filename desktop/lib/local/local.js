'use strict';

/**
 * local.js — the local-model transport: run a model on hardware you own.
 *
 * This is the third class, alongside `aegis` (pooled, metered) and `byok`
 * (relayed, handling fee). It is also the one class that bills NOTHING, which
 * is exactly why it is fenced the way it is.
 *
 * The fee argument, restated because every rule below follows from it. A
 * transport that dials a user-supplied URL has no pooled margin to take, no
 * handling fee to charge and no account key attached, so a REMOTE call there is
 * an unpaid turn: the relay accepts a fixed catalog of provider ids
 * (aegis1 services/nexus_provider/catalog.py, upstream key from
 * `X-Provider-Key`), so an arbitrary remote URL has nothing to be billed
 * against even if a client wanted to invoice it. That is why remote direct
 * dialing is gone from this codebase and stays gone — there is deliberately no
 * flag or env var that re-opens it, because such a flag would be a billing
 * bypass.
 *
 * A model on YOUR OWN MACHINE is the case that argument never covered. There is
 * no vendor to pay, so there is nothing to bill and nobody being denied a
 * payment: the compute was already bought and is sitting idle. `aegis` and
 * `byok` are lanes to somebody else's GPU; this is the lane to your own.
 *
 * So the fence is the whole feature: `isLocalEndpoint()` is checked before any
 * byte goes out, and it FAILS CLOSED — anything that does not parse, carries no
 * host, or resolves to a public address is remote, i.e. refused. A false
 * "local" is an unpaid turn; a false "remote" is a refusal the user fixes by
 * pointing at a local address. In a tie, refuse.
 *
 * Wire-wise this speaks Ollama's OpenAI-compatible surface
 * (`POST /v1/chat/completions`, keyless) plus its native `GET /api/tags` for
 * the model list. Anything that serves an OpenAI-compatible endpoint on the
 * same box — llama.cpp, LM Studio, vLLM — works by pointing `baseURL` at it;
 * only the model LIST is Ollama-specific, and that failure is recoverable
 * (see listTags) rather than fatal.
 */

/** Where a local daemon listens by default (Ollama's stock port). */
const DEFAULT_BASE = 'http://localhost:11434';

/**
 * How long a local turn tolerates a silent stream before failing. Local
 * inference is SLOW to first token — a cold 7B model on a laptop CPU can think
 * for a minute before emitting anything, and a warm one still loads weights on
 * the first call after a restart — so this is generous where the cloud client's
 * 60s default would abort a perfectly healthy turn.
 */
const SSE_IDLE_TIMEOUT_MS = 300000;

/** How long the daemon probe waits. Short: this runs behind a UI spinner, and
 *  "no daemon" must read as an answer rather than as a hang. */
const PROBE_TIMEOUT_MS = 1500;

/** Trim trailing slashes so `${base}/v1/...` never doubles one. */
function baseOf(baseURL) {
  return String(baseURL || DEFAULT_BASE).replace(/\/+$/, '');
}

/**
 * Whether a base URL addresses hardware on this machine (or on this private
 * network) — the gate that decides whether the free lane exists at all.
 *
 * True for: loopback (localhost, `*.localhost`, 127.0.0.0/8, `::1`), RFC1918
 * private ranges (10/8, 172.16/12, 192.168/16), IPv6 unique-local fc00::/7,
 * link-local (169.254/16, fe80::/10), the reserved local suffixes `.local`,
 * `.internal`, `.lan`, and a bare dotless hostname (`ollama`, `gpu-box` — it
 * can only resolve through this machine's own resolver).
 *
 * Private ranges are included on purpose: a box on the user's own LAN is still
 * hardware they already own, so the "no vendor to pay" argument holds there
 * too. What is excluded is anything routable to a third party.
 *
 * FAIL CLOSED: an unparseable value, a value with no host, a non-http(s)
 * scheme, or a public address is NOT local. See the file header for why the
 * tie breaks that way.
 */
function isLocalEndpoint(url) {
  let host = '';
  let scheme = '';
  try {
    const parsed = new URL(String(url == null ? '' : url));
    host = parsed.hostname.toLowerCase();
    scheme = parsed.protocol.toLowerCase();
  } catch {
    return false;
  }
  // Only a base URL a transport can actually dial — checked BEFORE the host, so
  // `ftp://box.local` cannot ride the local suffix to a pass.
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  if (!host) return false;
  // WHATWG keeps the brackets on an IPv6 hostname; strip them so one spelling
  // covers both `[::1]` and a bare `::1`.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || /[\s/\\@]/.test(host)) return false;

  // Loopback by name, plus the mDNS / split-DNS names an on-box service
  // answers to. The suffix must END the name: `example.local.evil.com` is
  // somebody else's host.
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|internal|lan)$/.test(host)) return true;

  // IPv6 literals.
  if (host.includes(':')) {
    if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true; // loopback
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    return false;
  }

  // IPv4 literals.
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (quad) {
    const o = quad.slice(1).map(Number);
    if (o.some((n) => n > 255)) return false; // not an address, and not local
    const [a, b] = o;
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    return false; // a real, routable address — remote, and not this lane
  }

  // A dotless name can only come from this machine's own resolver / hosts file.
  if (!host.includes('.')) return true;
  return false;
}

/**
 * Refuse a base URL that is not local, in the hosts' own voice.
 *
 * Returns null when the URL is usable. The returned error carries `status 400`
 * so every existing caller (the CLI's error painter, the desktop turn guard)
 * treats it as a user-fixable configuration problem rather than a crash.
 */
function remoteRefusal(url) {
  if (isLocalEndpoint(url)) return null;
  const err = new Error(
    `local: ${JSON.stringify(String(url || ''))} is not on this machine, so it is not the local ` +
      'class. Running a model you own is free because there is no vendor to pay — a remote URL ' +
      'here would be an unpaid turn instead. Use the aegis or byok class for remote models.'
  );
  err.status = 400;
  return err;
}

/** Probe the local daemon. Never throws — a missing daemon is a state, not an
 *  error, because the UI has to say "start it" rather than "it failed". */
async function probe(baseURL = DEFAULT_BASE) {
  const base = baseOf(baseURL);
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { running: res.ok, baseURL: base };
  } catch {
    return { running: false, baseURL: base };
  }
}

/**
 * List installed model tags (`GET /api/tags` → [{ id, details }]).
 *
 * Ollama-specific: a non-Ollama local server will 404 here. The caller renders
 * that as "no models listed — type one", because the transport itself does not
 * need this call at all. Losing the list must not cost the class its usability.
 */
async function listTags(baseURL = DEFAULT_BASE) {
  const res = await fetch(`${baseOf(baseURL)}/api/tags`);
  if (!res.ok) {
    const err = new Error(`local: /api/tags answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const models = (data && data.models) || [];
  return models.map((m) => ({
    id: m && m.name,
    ...(m && m.details ? { details: m.details } : {}),
  })).filter((m) => m.id);
}

/** Normalize one history row into an OpenAI-compatible message. Tool rows and
 *  assistant rows carrying `tool_calls` must survive intact: dropping either
 *  leaves the model seeing a tool call it never got a result for. */
function normalizeRow(m) {
  if (!m || typeof m !== 'object') return null;
  const row = { role: m.role || 'user' };
  if (m.content != null) row.content = m.content;
  if (m.name) row.name = m.name;
  if (m.tool_call_id) row.tool_call_id = m.tool_call_id;
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) row.tool_calls = m.tool_calls;
  return row;
}

/** One SSE event's fields, or null for a keep-alive/comment frame (which
 *  carries no payload and so must not count as progress). */
function parseEvent(raw) {
  const lines = String(raw).split('\n');
  let data = '';
  let sawField = false;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // '' separator, ':' keep-alive
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'data') {
      data += value;
      sawField = true;
    } else if (field === 'event' || field === 'id' || field === 'retry') {
      sawField = true;
    }
  }
  if (!sawField || !data) return null;
  if (data === '[DONE]') return { done: true };
  try {
    return { json: JSON.parse(data) };
  } catch {
    return null;
  }
}

/**
 * Read an SSE body, calling onEvent per parsed frame.
 *
 * The stall watchdog is armed PER PAYLOAD, not per socket read. That
 * distinction is the point: a server that keeps the connection warm with
 * keep-alive comments while the model produces nothing would otherwise reset
 * the deadline forever, and the turn would hang with no error at all. Progress
 * means a parsed payload — text, tool call, or usage — and nothing else.
 */
async function readSSE(res, onEvent, { idleTimeoutMs = SSE_IDLE_TIMEOUT_MS } = {}) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let stallTimer = null;
  let stallReject = () => {};
  const stall = new Promise((_, reject) => {
    stallReject = reject;
  });
  const arm = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stallReject(
        new Error(`local: the model stopped responding — no output for ${Math.round(idleTimeoutMs / 1000)}s`)
      );
    }, idleTimeoutMs);
  };
  arm();
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), stall]);
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });
      // Normalize CRLF so one separator check covers both spellings.
      buf = buf.replace(/\r\n/g, '\n');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseEvent(raw);
        if (!ev) continue; // keep-alive — deliberately does NOT re-arm
        if (ev.done) return;
        if (ev.json) {
          arm();
          onEvent(ev.json);
        }
      }
    }
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/**
 * One streaming turn against a local model. Keyless by construction — there is
 * no credential to send, which is a second reason a remote URL here could never
 * be billed.
 *
 * Returns the OpenAI shape the engine reads: `choices[0].message.content` and
 * `choices[0].message.tool_calls`.
 */
async function chat({
  baseURL = DEFAULT_BASE,
  model,
  messages,
  system,
  prompt,
  maxTokens,
  temperature,
  tools,
  toolChoice,
  signal,
  onDelta,
} = {}) {
  const base = baseOf(baseURL);
  const refusal = remoteRefusal(base);
  if (refusal) throw refusal;
  if (!model || !String(model).trim()) {
    const err = new Error('local: no model selected — pick one from the model list, or type a tag');
    err.status = 400;
    throw err;
  }

  const rows = [];
  if (system) rows.push({ role: 'system', content: system });
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.role === 'system') continue; // never two system rows
    const row = normalizeRow(m);
    if (row) rows.push(row);
  }
  // The engine passes the user's own text as `prompt` alongside the history.
  // Append it only if the history does not already end with it, so a caller
  // that includes it cannot send the same turn twice.
  const p = typeof prompt === 'string' ? prompt : '';
  if (p) {
    const last = rows[rows.length - 1];
    if (!(last && last.role === 'user' && last.content === p)) {
      rows.push({ role: 'user', content: p });
    }
  }
  if (!rows.length) {
    const err = new Error('local: nothing to send — no prompt and no messages');
    err.status = 400;
    throw err;
  }

  const body = {
    model: String(model),
    messages: rows,
    stream: true,
    // Ask for usage even on a stream: Ollama's shim reports it when asked, and
    // without the ask a local turn's token count is invisible in the UI.
    stream_options: { include_usage: true },
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(temperature != null ? { temperature } : {}),
    ...(tools && tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // Body text, not just the status: a local daemon's 400 says which field it
    // disliked (commonly `tools` on an older build), and the engine retries
    // without tool schemas on exactly that signal.
    let text = '';
    try {
      text = await res.text();
    } catch {
      /* body already gone */
    }
    const err = new Error(`local: chat/completions ${res.status}${text ? ` — ${text.slice(0, 400)}` : ''}`);
    err.status = res.status;
    throw err;
  }

  let content = '';
  let usage = null;
  const toolCalls = [];
  const byIndex = new Map();

  await readSSE(
    res,
    (json) => {
      if (json && json.usage) usage = json.usage;
      const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        if (typeof onDelta === 'function') onDelta({ text: delta.content });
      }
      const frags = delta.tool_calls || [];
      for (const f of frags) {
        const i = Number.isInteger(f.index) ? f.index : toolCalls.length;
        let acc = byIndex.get(i);
        if (!acc) {
          acc = { id: '', type: 'function', function: { name: '', arguments: '' } };
          byIndex.set(i, acc);
        }
        if (f.id) acc.id = f.id;
        if (f.type) acc.type = f.type;
        const fn = f.function || {};
        if (fn.name) acc.function.name = fn.name;
        if (fn.arguments) acc.function.arguments += fn.arguments;
      }
    },
    { idleTimeoutMs: SSE_IDLE_TIMEOUT_MS }
  );

  for (const [i, acc] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    if (!acc.function.name && !acc.function.arguments) continue;
    // Ollama does not always mint an id; the engine's tool loop keys results
    // by it, so an absent one is filled rather than left to collapse every
    // call in the turn onto a single empty key.
    if (!acc.id) acc.id = `call_${i}`;
    toolCalls.push(acc);
  }

  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    id: 'local',
    model: String(model),
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

module.exports = {
  DEFAULT_BASE,
  SSE_IDLE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  baseOf,
  isLocalEndpoint,
  remoteRefusal,
  probe,
  listTags,
  readSSE,
  chat,
};
