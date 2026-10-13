'use strict';

// docs/UPGRADING.md: a project copied from the kit pulls upstream fixes with a
// 3-way merge against the base recorded in .project-admin/kit-lock.json. These
// tests build a tiny upstream kit in a temp git repository, install it, edit
// both sides, and run the real scripts/kit-upgrade.js against it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { LOCK, globToRegExp, installKit, readLock } = require('../lib/kit-files');

const SCRIPTS = path.resolve(__dirname, '..');
const KIT = path.resolve(SCRIPTS, '..');

function tempDir(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=kit@example.com', '-c', 'user.name=Kit', ...args], { cwd, encoding: 'utf8' });

const LINES = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
const text = (lines) => `${lines.join('\n')}\n`;

// v1 and v2 of a minimal upstream kit, tagged.
function makeUpstream(t) {
  const root = tempDir(t, 'project-admin-upstream-');
  git(root, 'init', '-q', '-b', 'main');
  write(path.join(root, 'kit-manifest.json'), JSON.stringify({
    name: 'project-admin-kit', version: '0.2.0',
    kitOwned: ['kit-manifest.json', 'scripts/**', 'docs/**'],
    projectOwned: ['project-admin.config.json', 'README.md'],
    exclude: ['**/node_modules/**'],
  }));
  write(path.join(root, 'project-admin.config.json'), JSON.stringify({ project: { name: 'Template', adminPath: '/admin' } }));
  write(path.join(root, 'README.md'), 'template readme\n');
  write(path.join(root, 'scripts/tool.js'), text(LINES));
  write(path.join(root, 'docs/old.md'), 'retired in v2\n');
  write(path.join(root, 'docs/guide.md'), 'guide v1\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'v1');
  git(root, 'tag', 'v1');

  const v2 = [...LINES];
  v2[0] = 'line 1 (upstream fix)';
  write(path.join(root, 'scripts/tool.js'), text(v2));
  write(path.join(root, 'scripts/new.js'), 'added in v2\n');
  fs.rmSync(path.join(root, 'docs/old.md'));
  write(path.join(root, 'project-admin.config.json'), JSON.stringify({ project: { name: 'Template v2', adminPath: '/admin' } }));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'kit-manifest.json'), 'utf8'));
  write(path.join(root, 'kit-manifest.json'), JSON.stringify({ ...manifest, version: '0.3.0' }));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'v2');
  git(root, 'tag', 'v2');
  git(root, 'checkout', '-q', 'v1');
  return root;
}

// A project installed from upstream v1 (checked out in place).
function makeProject(t, upstream, { embedded = false } = {}) {
  const product = tempDir(t, 'project-admin-project-');
  const kit = embedded ? path.join(product, 'ops') : product;
  installKit(upstream, kit, { source: upstream, ref: 'v1', productRoot: embedded ? '..' : '.' });
  return { product, kit };
}

function upgrade(kit, ...args) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'kit-upgrade.js'), '--kit', kit, ...args], { encoding: 'utf8' });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

function snapshot(root) {
  const out = {};
  const visit = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else out[child] = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, child))).digest('hex');
    }
  };
  visit('');
  return out;
}

test('globs: ** spans directories, * stays in one segment', () => {
  assert.ok(globToRegExp('scripts/**').test('scripts/lib/a.js'));
  assert.ok(globToRegExp('**/node_modules/**').test('admin-app/node_modules/x/y.js'));
  assert.ok(globToRegExp('**/node_modules/**').test('node_modules/x.js'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/deploy-targets/fly.md'));
  assert.ok(globToRegExp('extras/native-ios/*.xcodeproj/**').test('extras/native-ios/App.xcodeproj/project.pbxproj'));
});

test('the installer records a lock of kit-owned files only', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  const lock = readLock(kit);
  assert.equal(lock.kitVersion, '0.2.0');
  assert.equal(lock.source, upstream);
  assert.equal(lock.commit, git(upstream, 'rev-parse', 'v1').trim());
  assert.deepEqual(Object.keys(lock.files).sort(), ['docs/guide.md', 'docs/old.md', 'kit-manifest.json', 'scripts/tool.js']);
});

test('an upgrade with no local edits applies cleanly: updates, adds, removes, and rewrites the lock', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(status, 0, output);
  assert.match(fs.readFileSync(path.join(kit, 'scripts/tool.js'), 'utf8'), /^line 1 \(upstream fix\)$/m);
  assert.equal(fs.readFileSync(path.join(kit, 'scripts/new.js'), 'utf8'), 'added in v2\n');
  assert.ok(!fs.existsSync(path.join(kit, 'docs/old.md')));
  assert.match(output, /0\.2\.0 -> 0\.3\.0/);
  assert.match(output, /added\s+scripts\/new\.js/);
  assert.match(output, /removed\s+docs\/old\.md/);
  const lock = readLock(kit);
  assert.equal(lock.kitVersion, '0.3.0');
  assert.equal(lock.commit, git(upstream, 'rev-parse', 'v2').trim());
  assert.ok(!('docs/old.md' in lock.files) && 'scripts/new.js' in lock.files);
});

test('non-overlapping local edits are merged with the upstream change', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  const local = [...LINES];
  local[11] = 'line 12 (local tweak)';
  fs.writeFileSync(path.join(kit, 'scripts/tool.js'), text(local));
  fs.appendFileSync(path.join(kit, 'docs/guide.md'), 'local note\n');
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(status, 0, output);
  const merged = fs.readFileSync(path.join(kit, 'scripts/tool.js'), 'utf8');
  assert.match(merged, /^line 1 \(upstream fix\)$/m);
  assert.match(merged, /^line 12 \(local tweak\)$/m);
  assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
  assert.match(output, /merged\s+scripts\/tool\.js/);
  assert.equal(fs.readFileSync(path.join(kit, 'docs/guide.md'), 'utf8'), 'guide v1\nlocal note\n', 'an edit to a file upstream left alone is kept');
});

test('a conflicting edit is written with markers, listed, and fails the run', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  const local = [...LINES];
  local[0] = 'line 1 (local rewrite)';
  fs.writeFileSync(path.join(kit, 'scripts/tool.js'), text(local));
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(status, 1, output);
  const conflicted = fs.readFileSync(path.join(kit, 'scripts/tool.js'), 'utf8');
  assert.match(conflicted, /^<<<<<<< local\nline 1 \(local rewrite\)\n=======\nline 1 \(upstream fix\)\n>>>>>>> upstream$/m);
  assert.match(output, /CONFLICT\s+scripts\/tool\.js/);
  assert.match(output, /need.? manual resolution:\n\s+scripts\/tool\.js/);
  assert.equal(fs.readFileSync(path.join(kit, 'scripts/new.js'), 'utf8'), 'added in v2\n', 'the rest of the upgrade still applies');
});

test('project-owned files are never touched, even when upstream changes them', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  const config = JSON.stringify({ project: { name: 'My App', adminPath: '/ops' } });
  fs.writeFileSync(path.join(kit, 'project-admin.config.json'), config);
  fs.writeFileSync(path.join(kit, 'README.md'), 'my product\n');
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(status, 0, output);
  assert.equal(fs.readFileSync(path.join(kit, 'project-admin.config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(path.join(kit, 'README.md'), 'utf8'), 'my product\n');
  assert.doesNotMatch(output, /project-admin\.config\.json|README\.md/);
});

test('a dry run prints the plan and changes nothing', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  fs.appendFileSync(path.join(kit, 'scripts/tool.js'), 'local tail\n');
  const before = snapshot(kit);
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2', '--dry-run');
  assert.equal(status, 0, output);
  assert.match(output, /^Dry run: /m);
  assert.match(output, /merged\s+scripts\/tool\.js/);
  assert.match(output, /Nothing was written\./);
  assert.deepEqual(snapshot(kit), before);
});

test('an embedded kit upgrades in its subdirectory and a dirty checkout is refused', (t) => {
  const upstream = makeUpstream(t);
  const { product, kit } = makeProject(t, upstream, { embedded: true });
  git(product, 'init', '-q', '-b', 'main');
  write(path.join(product, 'app.txt'), 'product code\n');
  git(product, 'add', '-A');
  git(product, 'commit', '-qm', 'product with embedded kit');

  fs.appendFileSync(path.join(kit, 'docs/guide.md'), 'uncommitted\n');
  const refused = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(refused.status, 2);
  assert.match(refused.output, /uncommitted changes/);
  git(product, 'checkout', '--', '.');

  write(path.join(product, 'scratch.txt'), 'outside the kit is not our business\n');
  const { status, output } = upgrade(kit, '--from', upstream, '--ref', 'v2');
  assert.equal(status, 0, output);
  assert.ok(fs.existsSync(path.join(kit, 'scripts/new.js')));
  assert.ok(!fs.existsSync(path.join(product, 'scripts')), 'nothing is written at the product root');
  assert.equal(JSON.parse(fs.readFileSync(path.join(kit, 'project-admin.config.json'), 'utf8')).layout.productRoot, '..');
});

test('an upgrade from a local path without --ref reads the working tree in place', (t) => {
  const upstream = makeUpstream(t);
  const { kit } = makeProject(t, upstream);
  git(upstream, 'checkout', '-q', 'v2');
  fs.appendFileSync(path.join(upstream, 'docs/guide.md'), 'uncommitted upstream line\n');
  const { status, output } = upgrade(kit, '--from', upstream);
  assert.equal(status, 0, output);
  assert.match(fs.readFileSync(path.join(kit, 'docs/guide.md'), 'utf8'), /uncommitted upstream line/);
});

// --- scaffolder and installer against the real kit ---------------------------

test('create-project-admin copies the kit, writes the lock, and runs configure', (t) => {
  const dest = path.join(tempDir(t, 'project-admin-scaffold-'), 'rocket');
  const { PROJECT_ADMIN_CONFIG, PROJECT_ADMIN_PRODUCT_ROOT, ...env } = process.env;
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'create-project-admin.js'), dest,
    '--no-git', '--name', 'Rocket Notes', '--backend', 'local', '--owner-email', 'Owner@Example.com', '--repo', 'example/rocket'], { encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Configured Rocket Notes \(local backend\)/);
  const config = JSON.parse(fs.readFileSync(path.join(dest, 'project-admin.config.json'), 'utf8'));
  assert.equal(config.project.slug, 'rocket-notes');
  assert.equal(config.admin.ownerEmail, 'owner@example.com');
  assert.deepEqual(config.backend, { type: 'local' });
  assert.equal(config.layout, undefined, 'a scaffolded kit is the product repository');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dest, 'scripts/agent-loops/machine-roster.json'), 'utf8')).machines[0].repoRoot, dest);
  assert.ok(fs.existsSync(path.join(dest, 'extras/functions/package.json')), 'extras are included by default');
  assert.ok(!fs.existsSync(path.join(dest, 'public/admin')), 'the generated admin bundle is not copied');
  assert.ok(!fs.existsSync(path.join(dest, 'scripts/node_modules')));

  const lock = JSON.parse(fs.readFileSync(path.join(dest, LOCK), 'utf8'));
  assert.equal(lock.kitVersion, JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8')).version);
  assert.ok(lock.files['scripts/kit-upgrade.js'] && !lock.files['project-admin.config.json']);

  const run = (...args) => spawnSync(process.execPath, args, { cwd: dest, encoding: 'utf8', env });
  assert.equal(run('scripts/lib/work-kinds.js', 'check').status, 0, 'derived files are in sync');
  assert.equal(JSON.parse(run('scripts/project-env.js').stdout).PRODUCT_ROOT, dest);
});

test('install-into embeds the kit in a product repository without extras', (t) => {
  const product = tempDir(t, 'project-admin-install-');
  git(product, 'init', '-q', '-b', 'main');
  write(path.join(product, '.gitignore'), 'dist/\n');
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, 'install-into.js'), product, '--dir', '.project-admin-kit'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const kit = path.join(product, '.project-admin-kit');
  assert.equal(JSON.parse(fs.readFileSync(path.join(kit, 'project-admin.config.json'), 'utf8')).layout.productRoot, '..');
  assert.ok(!fs.existsSync(path.join(kit, 'extras')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(kit, 'firebase.json'), 'utf8')).functions, undefined, 'no Functions source without the extra');
  assert.match(fs.readFileSync(path.join(product, '.gitignore'), 'utf8'), /^dist\/\n# Project Admin agent worktrees.*\n\.agent-worktrees\/\n$/);
  assert.equal(readLock(kit).withExtras, false);
  const env = JSON.parse(execFileSync(process.execPath, [path.join(kit, 'scripts/project-env.js')], { encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: '', PROJECT_ADMIN_PRODUCT_ROOT: '' } }));
  assert.deepEqual([env.LAYOUT, env.PRODUCT_ROOT, env.KIT_SUBDIR], ['embedded', product, '.project-admin-kit']);

  const again = spawnSync(process.execPath, [path.join(SCRIPTS, 'install-into.js'), product, '--dir', '.project-admin-kit'], { encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /not empty/);
  assert.equal(spawnSync(process.execPath, [path.join(SCRIPTS, 'install-into.js'), product, '--mode', 'separate', '--dir', path.join(product, 'inner')], { encoding: 'utf8' }).status, 2, 'a separate kit must live outside the product');
});

test('the kit version is recorded once: package.json matches kit-manifest.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(KIT, 'package.json'), 'utf8'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(KIT, 'kit-manifest.json'), 'utf8')).version, pkg.version);
  assert.equal(pkg.bin['create-project-admin'], 'scripts/create-project-admin.js');
});
