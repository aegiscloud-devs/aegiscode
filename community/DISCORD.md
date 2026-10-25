# Discord — blueprint, status, and the honest trade

**Status: not open.** There is no AEGIS Discord server yet. This file is the
build sheet, committed before the server exists so the decision is reviewable
in the open and so the automation is not written in a hurry afterwards.

Discussions remains the primary surface. Discord is a **mirror plus a chat
room**, not a second place to file bugs. The reason is in
[COMMUNITY.md](../COMMUNITY.md): one person reads this, and every additional
surface divides the same attention.

---

## 1. What the automation does today

Three workflows, all committed and all no-ops until a webhook secret exists:

| Workflow | Trigger | Effect when configured |
|---|---|---|
| [`discord-relay-release.yml`](../.github/workflows/discord-relay-release.yml) | a release is published | posts the release name, link and notes to the announcements channel |
| [`discord-relay-discussions.yml`](../.github/workflows/discord-relay-discussions.yml) | a Discussion or a reply is created | mirrors it into the matching channel |
| [`community-digest.yml`](../.github/workflows/community-digest.yml) | Mondays 07:00 UTC, or manual | appends weekly counts to [`status.md`](status.md) and commits them |

The relay (`scripts/discord-relay.mjs`) posts through a **channel webhook** —
no bot process, no gateway connection, no token to rotate, nothing to keep
running at 3am. It sets `allowed_mentions: { parse: [] }`, so a release note
that says "@everyone" cannot ping the server.

**It exits 0 when no webhook is set.** That is deliberate: these workflows are
committed before the server exists, and a red X on every discussion because a
server has not been opened yet is noise that trains you to ignore the tab.

## 2. What is not automated, and will not be

- **Nothing in Discord writes back to GitHub.** A message in Discord is not a
  bug report. If it needs tracking, someone copies it into Discussions. This is
  the trade for having no bot: one direction, no second source of truth.
- **Replies to people are not auto-posted.** The relay moves GitHub content
  into Discord. It never speaks as a community manager, because a wrong
  auto-reply under your name is worse than a slow real one.
- **No auto-moderation, no auto-close, no triage bot.** See §5.

## 3. Server layout (four channels at launch, not more)

More channels at launch means more places for a message to go unanswered.

| Channel | Contents | Who can post |
|---|---|---|
| `#announcements` | Releases, breaking changes, incident notes — relayed from GitHub | maintainers only |
| `#help` | Install problems and questions — relayed from Q&A | everyone |
| `#general` | Everything else — relayed from General / Ideas / Show and tell | everyone |
| `#mod-log` | Actions taken, kept visible so moderation is auditable | maintainers only |

Roles: `@maintainer`, and everyone else. No tiered status roles — they imply a
community large enough to rank, which this is not.

## 4. To open it — the exact steps, once the decision is made

1. Create the server, add the four channels above.
2. Per channel that receives relays: **Channel → Integrations → Webhooks → New
   Webhook**, copy the URL.
3. In this repository: **Settings → Secrets and variables → Actions**, add
   `DISCORD_WEBHOOK_ANNOUNCEMENTS` (from `#announcements`) and
   `DISCORD_WEBHOOK_COMMUNITY` (from `#help` or `#general`).
4. Test without waiting for a real event: **Actions → Relay releases to
   Discord → Run workflow** is not the path (releases have no manual trigger);
   instead create a throwaway Discussion in Q&A, confirm the mirror appears,
   then delete it.
5. Only then add the invite link to the README and COMMUNITY.md — a link to an
   empty server is worse than no link.

`"discord"` must also be added to `SIGNUP_SOURCES` (`aegis1/app.py`) in the same
change that publishes the invite, or every click from that invite attributes to
`direct` and the channel measures nothing. That is the mistake already recorded
against Bluesky, Mastodon and Nostr in `docs/marketing-log.md`.

## 5. Moderation, described honestly

- **One person. No 24/7 coverage.** There is no night shift, no ticket queue.
- **Expected response time is days, not hours.** Stated in the server, not
  discovered by newcomers.
- **No bots.** No auto-roles, no auto-ban, no "post an intro or be kicked".
  Moderation is a human reading and acting.
- **Deletion is visible.** Anything deleted gets a note in `#mod-log`, because
  silent deletions in a small community are indistinguishable from censorship.

## 6. Kill criteria

Decided before launch, so it cannot be argued after:

- **45 days after opening**, if fewer than **10 distinct people** have posted in
  any non-maintainer channel, move everyone to GitHub Discussions and close the
  server with a redirect thread.
- **If relayed threads consistently get no Discord replies**, the mirror is
  costing attention and returning nothing — turn the webhook secrets off. The
  workflows return to no-op, and no code has to be reverted.
- **If maintaining two surfaces means Q&A threads go unanswered on GitHub**,
  Discord is the one that goes. Discussions is the surface that search indexes
  and that the next person with the same problem can find.

These are triggers, not predictions. Nothing here claims the community will
grow; §1 of `docs/marketing-log.md` records what actually happened, weekly.
