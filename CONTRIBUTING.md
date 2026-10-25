# Contributing

Thanks for helping improve AEGIS Code — in this repository, that means the
**documentation**.

## What this repo is (and is not)

This repository is **documentation and licensing only**:

```
README.md              product overview + install paths
cli/README.md          the aegiscode terminal host
desktop/README.md      AEGIS Desktop (Electron)
COMMUNITY.md           where to ask, what to expect
CONTRIBUTING.md        this file
SECURITY.md            how to report a vulnerability
LICENSE, LICENSING.md  AGPL-3.0-or-later + commercial option
```

It does **not** contain source code. The Claude Code plugin, the MCP server, the
`aegiscode` CLI and AEGIS Desktop are developed in private repositories. There
is no `package.json` to install, no test suite to run here, and no build step.

That shapes what a contribution can be:

| Welcome | Not actionable here |
|---|---|
| Fixing wrong, stale, or dead instructions | Source-code fixes and features |
| Clarifying a confusing section | Changes to the private repositories |
| New troubleshooting entries with a real symptom and fix | Speculative restructuring |
| Screenshots or recordings of a working setup | Marketing campaign assets |

If your goal is a code change, open a
[Q&A or Ideas discussion](https://github.com/aegiscloud-devs/aegiscode/discussions)
first — the fix will land in the private repo, and a maintainer can carry it
over.

## Ground rules

- **Documentation must be true.** Never document a command that has not been
  run, a URL that has not been fetched, or a feature that has not shipped. An
  install path that 404s is worse than no install path.
- **Never commit secrets, keys, or customer data** — not in prose, not in
  screenshots, not in logs.
- **Keep the voice.** Direct, concrete, no marketing adjectives. Say what the
  user types and what they see.
- **Don't invent version numbers, benchmarks, or dates.**

## Submitting a change

1. Open an issue or a discussion describing the problem, unless it is a trivial
   typo fix.
2. Fork, branch, and make the smallest change that fixes the actual problem.
3. Check your links actually resolve, and your commands actually run.
4. Open a pull request explaining **what was wrong** and **how you verified the
   fix**. "Updated docs" is not a description.

Pull requests are reviewed in batches; there is no guaranteed turnaround. See
[COMMUNITY.md](COMMUNITY.md) for what to expect from response times.

## Style

- One sentence per line where it helps review readability.
- Wrap at ~80 columns to match the existing files.
- Code blocks: `bash` for shell, `text` for terminal output.
- Prefer a table over a bulleted list when the content is genuinely tabular.
- Links: relative for files in this repo, absolute for anything external.

## Reporting problems

- **Bugs and feature requests** → [Discussions](https://github.com/aegiscloud-devs/aegiscode/discussions)
  (Q&A and Ideas), not issues. Issues are not enabled as a support channel
  here.
- **Documentation errors** → a pull request, or a Q&A thread if you would
  rather just report it.
- **Security vulnerabilities** → [SECURITY.md](SECURITY.md). Never a public
  thread.

## Licensing of contributions

By contributing you agree that your contribution is licensed under
**AGPL-3.0-or-later**, the license this repository carries — see
[LICENSE](LICENSE). A commercial license that waives the AGPL terms is
available separately; see [LICENSING.md](LICENSING.md).
