#!/usr/bin/env node
// Relay a GitHub event (release / discussion / discussion comment) into Discord
// through a channel webhook. No bot, no gateway connection, no tokens to rotate.
//
// Deliberately no-ops (exit 0) when the webhook secret is not configured: the
// workflows are committed before the server exists, and a red X on every
// discussion because a server was not opened yet is noise, not a signal.

import { readFileSync } from "node:fs";

const MAX = 3800; // Discord's embed description ceiling is 4096; leave headroom.

const trunc = (s, n = MAX) => {
  const t = (s ?? "").toString().trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const webhookFor = (kind) => {
  if (kind === "announcement") return process.env.DISCORD_WEBHOOK_ANNOUNCEMENTS;
  return process.env.DISCORD_WEBHOOK_COMMUNITY;
};

// A Discussion in the Announcements category belongs in the announcement
// channel; everything else is conversation.
const isAnnouncement = (name) => /announce/i.test(name ?? "");

function build(eventName, p) {
  if (eventName === "release") {
    return {
      kind: "announcement",
      embed: {
        title: trunc(`${p.release.name || p.release.tag_name}`, 250),
        url: p.release.html_url,
        description: trunc(p.release.body),
        color: 0x2dd4bf,
        footer: { text: `release ${p.release.tag_name}` },
      },
    };
  }

  if (eventName === "discussion") {
    const d = p.discussion;
    return {
      kind: isAnnouncement(d.category?.name) ? "announcement" : "community",
      embed: {
        title: trunc(d.title, 250),
        url: d.html_url,
        description: trunc(d.body),
        color: isAnnouncement(d.category?.name) ? 0x2dd4bf : 0x5865f2,
        footer: {
          text: `${d.category?.name ?? "Discussion"} · opened by ${d.user?.login ?? "someone"}`,
        },
      },
    };
  }

  if (eventName === "discussion_comment") {
    const d = p.discussion;
    return {
      kind: isAnnouncement(d.category?.name) ? "announcement" : "community",
      embed: {
        title: trunc(`Reply in: ${d.title}`, 250),
        url: p.comment.html_url,
        description: trunc(p.comment.body),
        color: 0x5865f2,
        footer: { text: `by ${p.comment.user?.login ?? "someone"}` },
      },
    };
  }

  return null;
}

async function post(url, embed) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "AEGIS",
      embeds: [embed],
      allowed_mentions: { parse: [] }, // never ping @everyone from a relay
    }),
  });
  if (!res.ok) {
    throw new Error(`webhook POST failed: ${res.status} ${await res.text()}`);
  }
}

const eventName = process.env.EVENT_NAME;
const payloadPath = process.env.EVENT_PATH;

if (!eventName || !payloadPath) {
  console.error("EVENT_NAME and EVENT_PATH are required");
  process.exit(1);
}

const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const message = build(eventName, payload);

if (!message) {
  console.log(`no relay rule for '${eventName}' — nothing to do`);
  process.exit(0);
}

const hook = webhookFor(message.kind);
if (!hook) {
  console.log(
    `DISCORD_WEBHOOK_${message.kind === "announcement" ? "ANNOUNCEMENTS" : "COMMUNITY"} is not set — ` +
      "no Discord server is connected yet, skipping (this is expected until the server opens)",
  );
  process.exit(0);
}

await post(hook, message.embed);
console.log(`relayed ${eventName} to the ${message.kind} channel`);
