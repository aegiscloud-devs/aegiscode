#!/usr/bin/env node
/**
 * Publish the `desktop/` directory to the standalone mirror repo.
 *
 * `aegiscloud/aegiscode-desktop` is the install-facing repo: `desktop/README.md`
 * sends downloads to its releases page, and the campaign copy calls it
 * "Source (MIT)". It is NOT a byte-for-byte subtree of `desktop/` — it has
 * always carried a transform, reconstructed from its own history:
 *
 *   - `test/` is dropped            (the mirror has never shipped tests)
 *   - `vendor/` is added            (gitignored here, shipped there, so a
 *                                    mirror clone is standalone-runnable)
 *   - `.gitignore`, `LICENSE` and `docs/screenshot.png` are added
 *   - `package.json` gains `private: true` and a `repository` pointing at the
 *     mirror itself, and drops the monorepo `repository`
 *   - `README.md` gains the screenshot embed plus a standalone-clone footer
 *
 * Until now that transform lived in `/tmp` and read `docs/screenshot.png` out of
 * a throwaway mirror clone, so it was not reproducible from this repo — which is
 * why the mirror kept drifting a release behind (launch-readiness E5 failed,
 * was fixed by 35f8dda, and drifted again by 0.8.0). It is a committed script
 * now, and every input it reads is in-repo.
 *
 * Usage:
 *   node tools/sync-desktop-mirror.mjs            # dry run: build, diff, verify
 *   node tools/sync-desktop-mirror.mjs --push     # commit + fast-forward push
 *
 * Options:
 *   --sha <ref>     source revision to archive (default: HEAD). The mirror
 *                   commit message names it, matching the existing convention.
 *   --mirror <dir>  mirror clone to reuse/create
 *                   (default: $TMPDIR/aegiscode-desktop-mirror)
 *   --push          commit in the mirror clone and push to `main`
 *   --allow-dirty   proceed even though tracked files under `desktop/`/`client/`
 *                   are modified (those edits will NOT reach the mirror)
 *   --skip-predist  do not re-stage `desktop/vendor/` first
 *   --keep          keep the temp content directory for inspection
 *
 * Safety: the push is refused unless it is a fast-forward. This script never
 * force-pushes and never rewrites mirror history.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_REPO = path.resolve(HERE, '..');
const DESKTOP = path.join(SRC_REPO, 'desktop');

const MIRROR_SLUG = 'aegiscloud/aegiscode-desktop';
const MIRROR_URL = `https://github.com/${MIRROR_SLUG}.git`;
const MIRROR_BRANCH = 'main';

// Byte-identical to the mirror's existing .gitignore.
const MIRROR_GITIGNORE = 'node_modules/\nrelease/\n*.log\n.DS_Store\n';

// README.md anchors. Both are load-bearing: if desktop/README.md is restructured
// these throw rather than silently shipping a mirror with no screenshot or a
// footer that still talks about the monorepo.
const SCREENSHOT_ANCHOR =
  'delegate whole sub-tasks to subagents. It does **not** require Claude Code.';
const FOOTER_ANCHOR = 'This directory is part of the';
const FOOTER = [
  'This repo is a `git subtree split` of the `desktop/` directory of the',
  '[aegiscode-plugin](https://github.com/aegisinfo/aegiscode-plugin) monorepo,',
  'which also ships a Claude Code plugin and the shared transport client over the',
  'same AEGIS backend. That monorepo is the source of truth: edits land there and',
  'are synced here, nothing is authored in this repo. Architecture notes, tests,',
  'and the terminal host',
  '([cli/README.md](https://github.com/aegisinfo/aegiscode-plugin/blob/main/cli/README.md))',
  'live there. The npm package',
  '[`aegis-desktop`](https://www.npmjs.com/package/aegis-desktop) is built from',
  'this repo.',
  '',
];

// ---------------------------------------------------------------- utilities

const log = (msg) => console.log(msg);
const die = (msg) => {
  console.error(`\nsync-desktop-mirror: ${msg}\n`);
  process.exit(1);
};

function git(argv, { cwd = SRC_REPO, quiet = true, allowFail = false } = {}) {
  try {
    // With `stdio: 'inherit'` there is no captured output to return, so the
    // result is null — coerce before trimming rather than throwing on it.
    const out = execFileSync('git', argv, {
      cwd,
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return (out ?? '').toString().trim();
  } catch (err) {
    if (allowFail) return null;
    const stderr = (err.stderr || '').toString().trim();
    die(`git ${argv.join(' ')} failed${stderr ? `:\n${stderr}` : ''}`);
  }
}

function parseArgs(argv) {
  const opts = {
    sha: 'HEAD',
    mirror: path.join(os.tmpdir(), 'aegiscode-desktop-mirror'),
    push: false,
    allowDirty: false,
    skipPredist: false,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--push') opts.push = true;
    else if (arg === '--allow-dirty') opts.allowDirty = true;
    else if (arg === '--skip-predist') opts.skipPredist = true;
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--sha') opts.sha = argv[++i] ?? die('--sha needs a value');
    else if (arg === '--mirror') opts.mirror = argv[++i] ?? die('--mirror needs a value');
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else die(`unknown argument ${arg}`);
  }
  return opts;
}

// ------------------------------------------------------- integrity checking

/**
 * Drop comments so a `require(...)` shown in documentation is not read as code.
 * Only ever removes text, so it can miss a real require but never invent one.
 */
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    let kept = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          i = line.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (line.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (line.startsWith('//', i)) break;
      kept += line[i];
      i += 1;
    }
    out.push(kept);
  }
  return out.join('\n');
}

/**
 * Every relative `require('./x')` in the built tree must be loadable *from that
 * tree*. This is the check that would have caught the 0.8.0 near-miss: the CLI
 * vendored an `engine.js` that required `./local.js`, and a mirror or tarball
 * missing that file throws MODULE_NOT_FOUND at start-up rather than at build.
 *
 * The tree sits outside the monorepo, so a repo-relative require such as
 * `main.js -> ../client/aegis.js` cannot resolve. That is by design: the repo's
 * convention is `try { require(repo-relative) } catch { require(vendor copy) }`,
 * and `vendor/` is staged into the tree precisely so the fallback lands. So a
 * spec that does not resolve is accepted **iff** the same basename is present in
 * the tree's `vendor/`. Anything else is a real break.
 */
function assertRelativeRequiresResolve(root) {
  const missing = [];
  const viaVendor = [];
  const vendorDir = path.join(root, 'vendor');

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(m?js)$/.test(entry.name)) continue;

      const src = stripComments(fs.readFileSync(full, 'utf8'));
      for (const m of src.matchAll(/require\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g)) {
        const spec = m[2];
        const base = path.resolve(path.dirname(full), spec);
        const candidates = [base, `${base}.js`, `${base}.mjs`, path.join(base, 'index.js')];
        if (candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) continue;

        const fallback = path.join(vendorDir, path.basename(spec));
        if (fs.existsSync(fallback)) {
          viaVendor.push(`${path.relative(root, full)} -> ${spec} (via vendor/${path.basename(spec)})`);
          continue;
        }
        missing.push(`${path.relative(root, full)} -> ${spec}`);
      }
    }
  };
  walk(root);
  return { missing, viaVendor };
}

function countTree(root) {
  let files = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files += 1;
    }
  };
  walk(root);
  return files;
}

// -------------------------------------------------------------- the transform

function buildContent(contentDir, { shortSha, version }) {
  // 1. drop test/ — the mirror has never shipped tests.
  fs.rmSync(path.join(contentDir, 'test'), { recursive: true, force: true });

  // 2. vendor/ — gitignored in the monorepo, shipped in the mirror so a clone is
  //    runnable without the repo around it.
  const vendorSrc = path.join(DESKTOP, 'vendor');
  if (!fs.existsSync(vendorSrc)) {
    die('desktop/vendor/ is missing — run `npm run predist` in desktop/ first');
  }
  fs.cpSync(vendorSrc, path.join(contentDir, 'vendor'), { recursive: true });

  // 3. .gitignore
  fs.writeFileSync(path.join(contentDir, '.gitignore'), MIRROR_GITIGNORE);

  // 4. docs/screenshot.png + LICENSE, both sourced from this repo.
  const shot = path.join(DESKTOP, 'docs', 'screenshot.png');
  if (!fs.existsSync(shot)) die('desktop/docs/screenshot.png is missing');
  fs.mkdirSync(path.join(contentDir, 'docs'), { recursive: true });
  fs.copyFileSync(shot, path.join(contentDir, 'docs', 'screenshot.png'));
  fs.copyFileSync(path.join(SRC_REPO, 'LICENSE'), path.join(contentDir, 'LICENSE'));

  // 5. package.json — private:true after `license`, `repository` after
  //    `homepage` pointing at the mirror. Key order is reproduced so the mirror
  //    diff stays minimal.
  const pkgPath = path.join(contentDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const ordered = {};
  for (const [key, value] of Object.entries(pkg)) {
    if (key === 'repository' || key === 'private') continue;
    ordered[key] = value;
    if (key === 'license') ordered.private = true;
    if (key === 'homepage') {
      ordered.repository = { type: 'git', url: `${MIRROR_URL.replace('.git', '')}.git` };
    }
  }
  if (!('private' in ordered)) ordered.private = true;
  if (!('repository' in ordered)) {
    ordered.repository = { type: 'git', url: `${MIRROR_URL.replace('.git', '')}.git` };
    log('  note: package.json had no `homepage`; `repository` appended');
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(ordered, null, 2)}\n`);

  // 6. README.md — screenshot embed + standalone-clone footer.
  const readmePath = path.join(contentDir, 'README.md');
  let lines = fs.readFileSync(readmePath, 'utf8').split('\n');
  const shotAt = lines.findIndex((l) => l.includes(SCREENSHOT_ANCHOR));
  if (shotAt === -1) {
    die(`README screenshot anchor not found — desktop/README.md changed shape:\n  "${SCREENSHOT_ANCHOR}"`);
  }
  lines.splice(shotAt + 1, 0, '', '![AEGIS Desktop](docs/screenshot.png)');
  const footerAt = lines.findIndex((l) => l.startsWith(FOOTER_ANCHOR));
  if (footerAt === -1) {
    die(`README footer anchor not found — desktop/README.md changed shape:\n  "${FOOTER_ANCHOR}"`);
  }
  lines = [...lines.slice(0, footerAt), ...FOOTER];
  fs.writeFileSync(readmePath, lines.join('\n'));

  log(`  built mirror tree for v${version} @ ${shortSha}`);
}

// ------------------------------------------------------------------- mirror

function prepareMirror(mirrorDir) {
  if (!fs.existsSync(path.join(mirrorDir, '.git'))) {
    log(`cloning ${MIRROR_SLUG} -> ${mirrorDir}`);
    fs.rmSync(mirrorDir, { recursive: true, force: true });
    git(['clone', '--branch', MIRROR_BRANCH, MIRROR_URL, mirrorDir], { cwd: os.tmpdir(), quiet: false });
  } else {
    log(`fetching ${MIRROR_SLUG} in ${mirrorDir}`);
    git(['fetch', 'origin', '--prune'], { cwd: mirrorDir });
  }
  const dirty = git(['status', '--porcelain'], { cwd: mirrorDir });
  if (dirty) {
    die(`mirror clone at ${mirrorDir} has uncommitted changes:\n${dirty}\n\n` +
      'Commit, stash or discard them, or point --mirror at a fresh directory.');
  }
  const head = git(['rev-parse', 'HEAD'], { cwd: mirrorDir });
  const remote = git(['rev-parse', `origin/${MIRROR_BRANCH}`], { cwd: mirrorDir });
  if (head !== remote) {
    die(`mirror clone is not level with origin/${MIRROR_BRANCH} ` +
      `(HEAD ${head.slice(0, 7)} vs ${remote.slice(0, 7)}). Refusing to build on top of it.`);
  }
  return head;
}

function verifyMirror(expected, attempts = 12) {
  log(`\nverifying ${MIRROR_SLUG} serves v${expected} …`);
  // The git-backed contents API, not raw.githubusercontent: the raw CDN can
  // serve a stale package.json for minutes after a push (recorded in E5).
  for (let i = 0; i < attempts; i += 1) {
    let got = null;
    try {
      const b64 = execFileSync(
        'gh',
        ['api', `repos/${MIRROR_SLUG}/contents/package.json`, '--jq', '.content'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
      got = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).version;
    } catch {
      // gh missing or unauthenticated — fall back to the raw CDN with a cache-buster.
      try {
        got = JSON.parse(
          execFileSync('curl', ['-fsSL', `https://raw.githubusercontent.com/${MIRROR_SLUG}/${MIRROR_BRANCH}/package.json?cb=${Date.now()}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ).version;
      } catch {
        got = null;
      }
    }
    if (got === expected) {
      log(`  OK — mirror package.json version is ${got}`);
      return true;
    }
    log(`  attempt ${i + 1}/${attempts}: mirror reports ${got ?? 'unreachable'}, waiting for ${expected}`);
    execFileSync('sleep', ['5']);
  }
  log('  WARNING — could not confirm the mirror version (CDN lag or API failure)');
  return false;
}

// --------------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(DESKTOP)) die(`no desktop/ directory at ${DESKTOP}`);

  // A dirty tree means the mirror would silently miss those edits: the archive
  // is taken from a committed revision, while vendor/ is read from the worktree.
  const dirtyTracked = git(['status', '--porcelain', '--', 'desktop', 'client', 'LICENSE'])
    .split('\n')
    .filter(Boolean);
  if (dirtyTracked.length && !opts.allowDirty) {
    die(
      'tracked files are modified and would NOT reach the mirror ' +
        '(the tree is archived from a committed revision):\n' +
        dirtyTracked.map((l) => `  ${l}`).join('\n') +
        '\n\nCommit them, or pass --allow-dirty to sync the committed state anyway.',
    );
  }

  const fullSha = git(['rev-parse', opts.sha]);
  const shortSha = fullSha.slice(0, 7);

  // vendor/ is produced from the worktree; with a clean tree this makes the
  // mirror content a pure function of the source revision.
  if (!opts.skipPredist) {
    log('re-staging desktop/vendor/ (desktop/scripts/predist.mjs)');
    execFileSync(process.execPath, [path.join(DESKTOP, 'scripts', 'predist.mjs')], { stdio: 'inherit' });
  }

  const version = JSON.parse(git(['show', `${fullSha}:desktop/package.json`])).version;
  log(`\nsource: ${SRC_REPO}\nsha:    ${shortSha} (v${version})\nmirror: ${opts.mirror}`);

  const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegiscode-mirror-content-'));
  try {
    log('\nexporting desktop/ from the source revision');
    const tarPath = path.join(os.tmpdir(), `aegiscode-desktop-${shortSha}-${process.pid}.tar`);
    fs.writeFileSync(
      tarPath,
      execFileSync('git', ['archive', '--format=tar', `${fullSha}:desktop`], {
        cwd: SRC_REPO,
        maxBuffer: 512 * 1024 * 1024,
      }),
    );
    execFileSync('tar', ['-xf', tarPath, '-C', contentDir], { stdio: 'inherit' });
    fs.rmSync(tarPath, { force: true });

    log('applying the mirror transform');
    buildContent(contentDir, { shortSha, version });

    log('checking relative requires resolve');
    const { missing, viaVendor } = assertRelativeRequiresResolve(contentDir);
    if (missing.length) {
      die(
        'built mirror tree has relative requires that resolve nowhere in it, ' +
          'and have no vendor/ fallback:\n' +
          missing.map((l) => `  ${l}`).join('\n') +
          '\n\nAdd the module to desktop/scripts/predist.mjs, or the mirror will ' +
          'throw MODULE_NOT_FOUND at start-up.',
      );
    }
    log(`  OK — ${countTree(contentDir)} files, ${viaVendor.length} require(s) served by vendor/ fallback`);
    for (const line of viaVendor) log(`       ${line}`);

    const mirrorHead = prepareMirror(opts.mirror);
    log(`mirror HEAD ${mirrorHead.slice(0, 7)}`);

    log('syncing the tree into the mirror clone');
    execFileSync('rsync', ['-a', '--delete', '--exclude', '.git', `${contentDir}/`, `${opts.mirror}/`], {
      stdio: 'inherit',
    });

    const changes = git(['status', '--porcelain'], { cwd: opts.mirror });
    if (!changes) {
      log(`\nmirror is already in sync with ${shortSha} (v${version}) — nothing to commit`);
      return;
    }
    log(`\nchanges:\n${git(['diff', '--stat', 'HEAD'], { cwd: opts.mirror })}\n`);
    log(git(['status', '--short'], { cwd: opts.mirror }));

    if (!opts.push) {
      log('\ndry run — nothing committed. Re-run with --push to publish.');
      log(`inspect: less ${opts.mirror}`);
      git(['reset', '--hard', 'HEAD'], { cwd: opts.mirror });
      git(['clean', '-fd'], { cwd: opts.mirror });
      return;
    }

    const message = `Sync desktop/ from aegiscode-plugin @ ${shortSha} (v${version})`;
    git(['add', '-A'], { cwd: opts.mirror });
    git(['commit', '-m', message], { cwd: opts.mirror, quiet: false });

    // Fast-forward guard: origin/main must be an ancestor of what we are about
    // to push. Never force.
    const isAncestor =
      git(['merge-base', '--is-ancestor', `origin/${MIRROR_BRANCH}`, 'HEAD'], {
        cwd: opts.mirror,
        allowFail: true,
      }) !== null;
    if (!isAncestor) {
      git(['reset', '--hard', 'origin/main'], { cwd: opts.mirror });
      die(
        'the sync commit does not descend from origin/main — the mirror has commits ' +
          'this tree would drop. Refusing to force-push; reconcile by hand.',
      );
    }

    log(`\npushing to ${MIRROR_SLUG} ${MIRROR_BRANCH} (fast-forward)`);
    git(['push', 'origin', `HEAD:${MIRROR_BRANCH}`], { cwd: opts.mirror, quiet: false });
    log(`  pushed ${message}`);

    verifyMirror(version);
  } finally {
    if (opts.keep) log(`\nkept content dir: ${contentDir}`);
    else fs.rmSync(contentDir, { recursive: true, force: true });
  }
}

main();
