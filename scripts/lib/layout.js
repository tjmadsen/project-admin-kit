'use strict';

// Where the kit sits relative to the product repository its loops work on
// (docs/LAYOUTS.md). `layout.productRoot` in project-admin.config.json is the
// product checkout, relative to the kit directory (where the kit's
// project-admin.config.json lives) or absolute:
//
//   "."   self      the kit is the product repository (the default)
//   ".."  embedded  the kit is a subdirectory (ops/, .project-admin/, ...) of it
//   other separate  the kit is its own repository beside the product checkout
//
// Agent worktrees, branches, PRs, and .agent-worktrees/ belong to the product
// root; kit scripts are found at <product checkout>/<kitSubdir> (self,
// embedded) or in the kit checkout itself (separate).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KIT_ROOT = path.resolve(__dirname, '../..');
const LAYOUT_MODES = Object.freeze(['self', 'embedded', 'separate']);

function expandHome(value) {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

// Compare real paths: macOS /tmp and /var are symlinks, and bash's `pwd` keeps
// the logical spelling that Node's __dirname resolves away.
function real(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

function validateLayout(raw) {
  if (raw === undefined) return { productRoot: '.' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('layout must be an object such as { "productRoot": ".." }');
  const unknown = Object.keys(raw).filter((key) => key !== 'productRoot');
  if (unknown.length > 0) throw new Error(`layout.${unknown[0]} is not a layout option (allowed: productRoot)`);
  if (raw.productRoot !== undefined && (typeof raw.productRoot !== 'string' || !raw.productRoot.trim())) throw new Error('layout.productRoot must be a non-empty path');
  return { productRoot: raw.productRoot?.trim() || '.' };
}

// PROJECT_ADMIN_PRODUCT_ROOT overrides the configured root for one process:
// loop-wrapper.sh points a separate kit at a loop worktree of the product, and
// the TestFlight upload at a release worktree.
function resolveLayout(config = {}, { kitRoot: kitRootOption = KIT_ROOT, env = process.env } = {}) {
  const { productRoot: configured } = validateLayout(config.layout);
  const kitRoot = real(kitRootOption);
  const override = env.PROJECT_ADMIN_PRODUCT_ROOT;
  const productRoot = real(override ? path.resolve(expandHome(override)) : path.resolve(kitRoot, expandHome(configured)));
  const relative = path.relative(productRoot, kitRoot);
  if (relative === '') return { mode: 'self', kitRoot, productRoot, kitSubdir: '.', configured };
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return { mode: 'embedded', kitRoot, productRoot, kitSubdir: relative.split(path.sep).join('/'), configured };
  }
  return { mode: 'separate', kitRoot, productRoot, kitSubdir: '', configured };
}

// The kit inside a checkout (primary, loop, or release worktree) of the
// product, or the kit checkout itself when the kit is a separate repository.
function kitIn(checkout, layout) {
  if (layout.mode === 'separate') return layout.kitRoot;
  return layout.kitSubdir === '.' ? checkout : path.join(checkout, layout.kitSubdir);
}

module.exports = { KIT_ROOT, LAYOUT_MODES, expandHome, kitIn, resolveLayout, validateLayout };

if (require.main === module) {
  // node scripts/lib/layout.js  -> the resolved layout as JSON
  const { loadProjectConfig } = require('./project-config');
  console.log(JSON.stringify(resolveLayout(loadProjectConfig()), null, 2));
}
