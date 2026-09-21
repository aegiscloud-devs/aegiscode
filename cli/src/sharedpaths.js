'use strict';

/**
 * WHERE the CLI's shared modules are, with no side effects.
 *
 * This is `deps.js`'s path resolution split into its own module, and the split
 * is load-bearing rather than cosmetic. `deps.js` eagerly requires everything
 * it resolves — the engine, the tool registry, the client — so a module that
 * only needs to *locate* one shared file cannot require deps.js: doing so
 * from inside something deps.js itself requires would be a require cycle,
 * handing one side a half-built exports object at load time.
 *
 * So: paths here, code in deps.js.
 *
 * Two layouts must work, exactly as deps.js documents:
 *
 *   in-repo   <repo>/cli/src/sharedpaths.js -> <repo>/desktop/lib/local/...
 *   npm       <pkg>/src/sharedpaths.js      -> <pkg>/vendor/desktop/lib/...
 *
 * Resolution is by existence, and a missing module is a loud error rather than
 * a silent fallback to a second copy: duplicate implementations are how the
 * desktop and the terminal would drift apart.
 */

const fs = require('node:fs');
const path = require('node:path');

function roots() {
  const srcDir = __dirname; // <root>/cli/src
  const cliDir = path.join(srcDir, '..');
  return [
    path.join(srcDir, '..', '..'), // repo root (in-repo layout)
    path.join(cliDir, 'vendor'), // staged tree (published layout)
  ];
}

/** Resolve a repo-relative module path against whichever root has it. */
function resolveShared(relPath) {
  for (const root of roots()) {
    const candidate = path.join(root, relPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `aegiscode: cannot find ${relPath}. Expected it beside cli/ (in the repo) or ` +
      'under cli/vendor/ (installed package). Reinstall the package, or run ' +
      '`node scripts/predist.mjs` from cli/ if this is a source checkout.'
  );
}

module.exports = { roots, resolveShared };
