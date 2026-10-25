# Security Policy

## Reporting a vulnerability

If you discover a security issue in this repository, please **do not** open a
public issue. Report it privately so it can be addressed before disclosure:

- GitHub: **Security → Report a vulnerability** (private security advisory) on
  [aegiscloud-devs/aegiscode](https://github.com/aegiscloud-devs/aegiscode/security/advisories/new)
- Email: security@aegiscloud.org

Please include:

1. A description of the issue and its impact.
2. Steps to reproduce (or a proof of concept).
3. The affected component and version.

You should receive an initial response within **72 hours**. We will keep you
informed of progress and credit you in the fix unless you ask to remain
anonymous.

## Scope

This repository is **documentation and licensing only** — it ships no code, and
no exploit can originate from it. Report nevertheless if the problem concerns
one of the shipped products the documentation describes:

| Component | What it is |
|---|---|
| `aegiscode` (npm) | The terminal host |
| `aegis-desktop` (npm) | The Electron desktop app |
| Claude Code plugin | Slash commands + MCP server |
| MCP server / editor-host installer | Zero-dependency stdio server, config writer |

Out of scope here (still welcome, routed internally):

- `aegiscloud.org` and its server-side services
- The AEGIS engine, routing and orchestration
- Account, billing, and key-management endpoints

If a report concerns code in a private repository, say so in the advisory —
it is forwarded to the right owner rather than closed.

## What this repository does **not** contain

- **No source code.** Documentation and licensing only.
- **No secrets, keys, or credentials** are stored in this repository.
- Your `AEGIS_API_KEY` (`aegis_...`) lives only in your own shell environment,
  written by `install.sh` to your shell rc file. It is never committed and
  never shipped in the plugin.
- The memory token is **derived from your `AEGIS_API_KEY`** at runtime
  (`client/aegis.js` exchanges the key via `POST /api/verify-api-key`) and is
  cached in memory only. It is never a credential you hold, supply, or store.
- No model weights, no orchestration logic, no server-side code.

If you believe a secret has been committed, report it via the private channel
above immediately.
