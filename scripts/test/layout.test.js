'use strict';

// docs/LAYOUTS.md: the kit is the product repository (self), a subdirectory of
// it (embedded), or a repository beside it (separate). These pin how
// layout.productRoot resolves and what project-env.js exports in each mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { kitIn, resolveLayout, validateLayout } = require('../lib/layout');
const { validateProjectConfig } = require('../lib/project-config');

const sourceRoot = path.resolve(__dirname, '..', '..');
const baseConfig = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'project-admin.config.json'), 'utf8'));

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-layout-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('an absent layout or productRoot "." is the kit itself', (t) => {
  const kit = tempRoot(t);
  for (const config of [{}, { layout: {} }, { layout: { productRoot: '.' } }]) {
    const layout = resolveLayout(config, { kitRoot: kit, env: {} });
    assert.deepEqual({ ...layout, configured: undefined }, { mode: 'self', kitRoot: kit, productRoot: kit, kitSubdir: '.', configured: undefined });
    assert.equal(kitIn('/srv/wt', layout), '/srv/wt');
  }
});

test('productRoot ".." embeds the kit in a subdirectory of the product', (t) => {
  const product = tempRoot(t);
  const kit = path.join(product, 'ops');
  fs.mkdirSync(kit);
  const layout = resolveLayout({ layout: { productRoot: '..' } }, { kitRoot: kit, env: {} });
  assert.equal(layout.mode, 'embedded');
  assert.equal(layout.productRoot, product);
  assert.equal(layout.kitSubdir, 'ops');
  assert.equal(kitIn('/srv/wt', layout), path.join('/srv/wt', 'ops'), 'a product worktree carries its own copy of the kit');

  const nested = path.join(product, 'tools', '.project-admin');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveLayout({ layout: { productRoot: '../..' } }, { kitRoot: nested, env: {} }).kitSubdir, 'tools/.project-admin');
});

test('a productRoot outside the kit makes it separate, relative or absolute', (t) => {
  const root = tempRoot(t);
  const kit = path.join(root, 'app-admin');
  const product = path.join(root, 'app');
  fs.mkdirSync(kit);
  fs.mkdirSync(product);
  for (const productRoot of ['../app', product]) {
    const layout = resolveLayout({ layout: { productRoot } }, { kitRoot: kit, env: {} });
    assert.equal(layout.mode, 'separate');
    assert.equal(layout.productRoot, product);
    assert.equal(layout.kitSubdir, '');
    assert.equal(kitIn('/srv/wt', layout), kit, 'a separate kit always runs from its own checkout');
  }
  // The kit's parent directory contains it, so the same kit there is embedded.
  assert.equal(resolveLayout({ layout: { productRoot: '..' } }, { kitRoot: kit, env: {} }).mode, 'embedded');
  // A sibling whose name merely starts with ".." is still outside the kit.
  fs.mkdirSync(path.join(root, '..app'));
  assert.equal(resolveLayout({ layout: { productRoot: path.join(root, '..app') } }, { kitRoot: kit, env: {} }).mode, 'separate');
  // ...and a kit directory named like that is still inside its parent.
  const dotted = path.join(root, '..admin');
  fs.mkdirSync(dotted);
  assert.equal(resolveLayout({ layout: { productRoot: '..' } }, { kitRoot: dotted, env: {} }).kitSubdir, '..admin');
});

test('PROJECT_ADMIN_PRODUCT_ROOT points one process at another checkout of the product', (t) => {
  const root = tempRoot(t);
  const kit = path.join(root, 'app-admin');
  const worktree = path.join(root, 'app', '.agent-worktrees', 'loop-feature-sol');
  fs.mkdirSync(kit);
  fs.mkdirSync(worktree, { recursive: true });
  const layout = resolveLayout({ layout: { productRoot: '../app' } }, { kitRoot: kit, env: { PROJECT_ADMIN_PRODUCT_ROOT: worktree } });
  assert.equal(layout.productRoot, worktree);
  assert.equal(layout.mode, 'separate');

  // Inside an embedded loop worktree the kit copy resolves to the worktree.
  const embeddedKit = path.join(worktree, 'ops');
  fs.mkdirSync(embeddedKit);
  const embedded = resolveLayout({ layout: { productRoot: '..' } }, { kitRoot: embeddedKit, env: { PROJECT_ADMIN_PRODUCT_ROOT: worktree } });
  assert.deepEqual([embedded.mode, embedded.kitSubdir], ['embedded', 'ops']);
});

test('the config loader rejects a malformed layout', () => {
  assert.throws(() => validateLayout('..'), /layout must be an object/);
  assert.throws(() => validateLayout({ productRoot: '' }), /layout\.productRoot must be a non-empty path/);
  assert.throws(() => validateLayout({ root: '..' }), /layout\.root is not a layout option/);
  assert.throws(() => validateProjectConfig({ ...baseConfig, layout: { productRoot: 3 } }, 'test.json'), /layout\.productRoot .*\(test\.json\)/);
  assert.equal(validateProjectConfig({ ...baseConfig, layout: { productRoot: '..' } }, 'test.json').layout.productRoot, '..');
});

// project-env.js is what runbooks and shell scripts read, so check it end to
// end against a kit copied into each layout.
function copyKitTo(dir, layoutConfig) {
  for (const relative of [
    'scripts/project-env.js', 'scripts/lib/project-config.js', 'scripts/lib/layout.js',
    'scripts/lib/agent-roster.js', 'scripts/lib/agent-defaults.json',
    'scripts/lib/work-kinds.js', 'scripts/lib/work-kinds.defaults.json',
    'scripts/lib/deploy-targets.js', 'scripts/lib/deploy-targets.defaults.json', 'scripts/lib/automation.js',
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, relative), path.join(dir, relative));
  }
  fs.writeFileSync(path.join(dir, 'project-admin.config.json'), JSON.stringify({ ...baseConfig, ...(layoutConfig ? { layout: layoutConfig } : {}) }));
}

function projectEnv(kit, env = {}) {
  const { PROJECT_ADMIN_CONFIG, PROJECT_ADMIN_PRODUCT_ROOT, ...rest } = process.env;
  return JSON.parse(execFileSync(process.execPath, [path.join(kit, 'scripts/project-env.js')], { encoding: 'utf8', env: { ...rest, ...env } }));
}

test('project-env.js exports KIT_ROOT, PRODUCT_ROOT, KIT_SUBDIR, and LAYOUT for every mode', (t) => {
  const root = tempRoot(t);
  const self = path.join(root, 'self');
  copyKitTo(self);
  assert.deepEqual(pick(projectEnv(self)), { LAYOUT: 'self', KIT_ROOT: self, PRODUCT_ROOT: self, KIT_SUBDIR: '.' });

  const product = path.join(root, 'product');
  copyKitTo(path.join(product, 'ops'), { productRoot: '..' });
  assert.deepEqual(pick(projectEnv(path.join(product, 'ops'))), { LAYOUT: 'embedded', KIT_ROOT: path.join(product, 'ops'), PRODUCT_ROOT: product, KIT_SUBDIR: 'ops' });

  const separate = path.join(root, 'admin');
  copyKitTo(separate, { productRoot: '../product' });
  assert.deepEqual(pick(projectEnv(separate)), { LAYOUT: 'separate', KIT_ROOT: separate, PRODUCT_ROOT: product, KIT_SUBDIR: '' });
  assert.equal(projectEnv(separate, { PROJECT_ADMIN_PRODUCT_ROOT: path.join(product, 'ops') }).PRODUCT_ROOT, path.join(product, 'ops'));

  const shell = execFileSync(process.execPath, [path.join(separate, 'scripts/project-env.js'), 'shell'], { encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: '', PROJECT_ADMIN_PRODUCT_ROOT: '' } });
  assert.match(shell, new RegExp(`^export PRODUCT_ROOT='${product}'$`, 'm'));
  assert.match(shell, /^export KIT_SUBDIR=''$/m);
});

function pick(env) {
  return { LAYOUT: env.LAYOUT, KIT_ROOT: env.KIT_ROOT, PRODUCT_ROOT: env.PRODUCT_ROOT, KIT_SUBDIR: env.KIT_SUBDIR };
}
