# Community

AEGIS Code is built by a very small team. This page explains where to talk to
us, what to expect back, and what is genuinely in scope — so nobody waits three
days for a reply that was never coming.

## Where to go

Everything happens in **[Discussions](https://github.com/aegiscloud-devs/aegiscode/discussions)**.

| You want to… | Go to | Answerable? |
|---|---|---|
| Report a broken install, a `401`, a crash | [Q&A](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/q-a) | Yes — mark the reply that fixed it |
| Ask for a feature | [Ideas](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/ideas) | No — upvote existing threads |
| Hear about releases and breaking changes | [Announcements](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/announcements) | No |
| Share a workflow, config, or thing you built | [Show and tell](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/show-and-tell) | No |
| Anything else | [General](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/general) | No |

**Not** for security problems ([SECURITY.md](SECURITY.md)), billing disputes, or
account deletion — those go to the address in the product, because they need
private handling.

## What to expect

- **No SLA and no 24/7.** This is not a support desk. Discussions are read in
  batches, most often at the end of the week.
- **Q&A answers come from a person**, sometimes with community help. If a
  thread goes quiet for more than a week, reply to it — a bump is fine and is
  not rude.
- **No bot triage.** Nothing here is auto-closed, auto-labeled, or auto-answered.

## Discord

There is no open AEGIS Discord server. If one is opened, it will be a **mirror
of this Discussions board plus a chat room** — not a second place to file bugs,
and not a faster support line. The layout, the exact steps to connect it, the
moderation model ("one person, no 24/7"), and the kill criteria decided in
advance are in [community/DISCORD.md](community/DISCORD.md).

The relay automation is already committed: a release or a new Discussion can be
mirrored into a Discord channel through a webhook, with no bot to run. It does
nothing until webhook secrets exist, and it exits cleanly rather than failing.
- **Ideas are not promises.** A popular idea is a signal, not a commitment.
  Things get built when they fit the product, not when they get upvotes.

## Scope: what this repository is

This repository is **documentation and licensing only**. It contains the
READMEs you are reading, `LICENSE`, `LICENSING.md`, and this community surface.
It does **not** contain the source of the Claude Code plugin, the `aegiscode`
CLI, the MCP server, or AEGIS Desktop — those live in private repositories.

That has practical consequences for what a thread here can resolve:

| In scope here | Out of scope here |
|---|---|
| Doc errors, typos, unclear instructions | Source-code changes and pull requests |
| Install and configuration problems | The AEGIS backend, routing, model catalogue |
| Bug reports with reproduction steps | Account, billing, and key management |
| Feature ideas and design discussion | Anything needing a private repo |

A bug report is still useful even though the fix lands elsewhere — it gets
carried over. A pull request against this repo is only actionable if it changes
documentation.

## Before you post

1. **Search first** — install failures repeat, and the answer is usually
   already marked in an old Q&A thread.
2. **Say which surface** you are using: Claude Code plugin, `aegiscode` CLI,
   AEGIS Desktop, or a direct MCP/HTTP integration.
3. **Include versions** — `node -v`, the `aegiscode` version, your OS.
4. **Paste the exact error**, not a paraphrase. Redact your key: it is a
   credential, and a full `aegis_…` string in a public thread is a leaked key.
   Replace it with `aegis_REDACTED`.
5. **One problem per thread.** Two problems in one thread means one of them
   gets lost.

## Conduct

Short version: be decent, assume good faith, and argue about the software
rather than the person.

- No harassment, discrimination, or personal attacks.
- No spam, unsolicited recruiting, or link-dropping unrelated projects.
- No sharing other people's private information, keys, or logs containing them.
- Keep criticism specific and actionable — "the installer fails on Node 16 with
  this error" is useful; "this is garbage" is not.
- English is the working language, but imperfect English is genuinely fine.

Publish your own AEGIS key, and it is compromised — rotate it immediately. It
is not recoverable from a public thread, and moderators will redact it rather
than leave it up.

Moderation is **one person, part time.** Threads are hidden or locked for spam,
harassment, or leaked credentials. There is no appeal process beyond replying.

## How this list grows

This community starts **here and only here.** Discussions on, Discord off. If
the volume justifies a chat server, it gets built then — with a real
moderation answer — rather than being launched empty and abandoned. If a new
surface appears, it will be announced in
[Announcements](https://github.com/aegiscloud-devs/aegiscode/discussions/categories/announcements)
first.

## License note

Contributions to the documentation in this repository are accepted under
**AGPL-3.0-or-later**, the license this repository already carries — see
[LICENSE](LICENSE). A commercial license that waives the AGPL terms is
described in [LICENSING.md](LICENSING.md).
