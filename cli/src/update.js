'use strict';

/**
 * The CLI's view of the shared npm update checker (client/update.js).
 *
 * It lives at the repo root rather than here because the desktop host needs
 * the same thing for `aegis-desktop`: two hosts, two package names, one
 * checker. Resolved through deps.js so the in-repo and published-vendor
 * layouts both work.
 *
 * On top of the shared checker this module carries the three pieces /upgrade
 * needs — `compareVersions`, `upgradeAdvice` and `latestPublishedVersion` —
 * ported from the reference (`aegiscodex-dev/src/session.js`). They belong
 * here, next to `isNewer`/`updateLine`, so the CLI has ONE idea of "is there a
 * newer published version": the welcome-box notice and /upgrade now answer
 * from the same place and compare versions the same way. The shared module's
 * own functions are spread through unchanged, keeping the identity the
 * update-channel test pins (the shim and the shared file must be the SAME
 * code, not a copy).
 */

const { execFileSync } = require('node:child_process');

const { resolveShared } = require('./deps.js');

const shared = require(resolveShared('client/update.js'));

const VERSION = require('../package.json').version;
/** Both hosts publish from npm; the CLI is `aegiscode`. */
const PKG = shared.PKG || 'aegiscode';

// ── /upgrade ─────────────────────────────────────────────────────────────────

/** Compare two dotted version strings: -1 | 0 | 1 (prerelease tags ignored). */
function compareVersions(a, b) {
  const pa = String(a || '0').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '0').split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** What /upgrade should say, given the local and published versions. */
function upgradeAdvice({ current = VERSION, latest = null, packageName = PKG } = {}) {
  if (!latest) {
    return {
      upToDate: null,
      lines: [`  Could not read the npm registry — local version is ${current}.`],
    };
  }
  const cmp = compareVersions(latest, current);
  if (cmp > 0) {
    return {
      upToDate: false,
      lines: [
        `  Installed: ${current}`,
        `  Published: ${latest}`,
        `  Upgrade:   npm i -g ${packageName}@latest`,
      ],
    };
  }
  return {
    upToDate: true,
    lines: [`  Installed ${current} is the published ${latest} — nothing to upgrade.`],
  };
}

/** Best-effort registry lookup (5s cap). Returns a version string or null. */
function latestPublishedVersion({ packageName = PKG, timeoutMs = 5000 } = {}) {
  try {
    const out = execFileSync('npm', ['view', packageName, 'version'], {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = String(out).trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch { return null; }
}

module.exports = {
  ...shared,
  VERSION,
  compareVersions,
  upgradeAdvice,
  latestPublishedVersion,
};
