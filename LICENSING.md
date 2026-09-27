# Licensing

**Aegiscode is licensed under the GNU Affero General Public License, version 3
or later (`AGPL-3.0-or-later`).** The verbatim licence text is in
[LICENSE](LICENSE). This document is the plain-language summary and the record
of the licence change; where it and `LICENSE` disagree, `LICENSE` governs.

Every Aegiscode manifest carries the same licence: the published `aegiscode`
CLI, the `aegis-desktop` app and the `online` web surface. The first-party
avatar packs carry it too. Vendored third-party code keeps its own licence —
see [desktop/renderer/vendor/NOTICE.md](desktop/renderer/vendor/NOTICE.md).

## Notice to apply to the program

```
Copyright (C) 2026 Niklas Borneklint

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option) any
later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.
```

## What you may do

Everything MIT let you do: run it, read and study the source, modify it,
redistribute it, bundle it into your own product, and **sell it** — the AGPL is
not a non-commercial licence. It adds an express patent grant that MIT never
had, which matters here for the transport, provider and tool-calling code.

## The obligation MIT did not have

- **§5 — distributing a modified version.** Conveying a modified copy (an npm
  tarball, a rebuilt AppImage or `.deb`, a published fork) means the recipients
  get the corresponding source under this same licence. Private local
  modification triggers nothing.
- **§13 — Remote Network Interaction.** Operating a modified version as a
  network service means the users of that service must be offered the
  corresponding source. This is what stops a third party from taking this code,
  standing up a competing hosted drain, and publishing nothing.

The desktop app is where this is most visible in practice: the thin-shell guard
already keeps cloud routing and brain logic out of `desktop/`, and that boundary
is what makes it possible for this repo to be AGPL while the hosted service
behind it stays a separate, proprietary product.

## Why this changed

Versions released before 2026-09-27 (npm `aegiscode` up to and including
`6.8.11`, `aegis-desktop` up to and including `0.8.12`) shipped under the MIT
License. MIT grants the right to "sublicense" and to "sell copies" and imposes
no obligation to give anything back: a third party could host a competing drain,
ship a closed fork, or resell the app, and owe this project nothing. AGPL keeps
the code public and free while making reuse carry a legal consequence.

This also keeps the SignPath Foundation signing grant eligible — that grant
requires an OSI-approved open-source licence against a public repo, which AGPL
is and a proprietary licence would not be.

## What this change does not reach

- **Already-published copies stay MIT, permanently.** The MIT grant is
  irrevocable for what is already out there: npm tarballs published before this
  change, installers attached to releases before this change, and forks made
  from pre-change commits. Only releases published from this commit onward are
  AGPL.
- **`aegiscloud/aegiscode-desktop` is a separate repo.** It is the
  `git subtree split` mirror of `desktop/`, and it still ships the MIT
  `LICENSE`. It has **not** been converted. Until it is, that mirror is MIT and
  the "Source (MIT)" line in the promo copy is true *of the mirror* and false
  *of this repo* — which is exactly why the promo copy and the launch-readiness
  record are annotated rather than left as-is.
- **Third-party code keeps its own licence** — notably `marked`
  (MIT / MPL-2.0 dual) under `desktop/renderer/vendor/`.

## Commercial licence

If the AGPL's obligations do not fit your use — shipping a closed product,
running a hosted service without publishing modifications, or needing contract
terms, an indemnity or a support SLA — a commercial licence that waives them is
available. Contact **licensing@aegiscloud.org**. Note what this does *not* buy:
the paid cloud drain is a service, and paying for it has never required a
commercial licence, only AGPL compliance for any modified code you distribute
or host.

## Trademarks

The AGPL grants a copyright and a patent licence to the code. It grants **no**
right to the names *Aegiscode*, *AEGIS Code*, *Aegiscodex* or *Aegiscloud*, to
the logo, or to the npm package identities `aegiscode` / `aegis-desktop`. A fork
must use its own name and package name, and must not imply endorsement.
Nominative use — "a fork of Aegiscode" — is fine.

## Contributions

Dual licensing only works if the maintainer holds enough rights to license every
contribution under both the AGPL and the commercial terms, so contributions are
accepted under a contributor agreement (CLA), not by inbound-equals-outbound
default. This replaces the earlier "no CLA, no contributor agreement to sign"
position recorded in the campaign drafts. Until a contribution
carries that grant, treat it as needing explicit written permission before it is
merged; a pull request alone is not that permission.

## Scope note

This document records what the licence is and why. It is not legal advice. The
two places a lawyer's read matters most: the contribution/CLA paragraph above,
and whether the AGPL client and the proprietary `aegis1` backend are ever
distributed or operated together in a way §5 or §13 reaches.
