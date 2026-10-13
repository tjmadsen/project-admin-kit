'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const script = path.join(repoRoot, 'scripts', 'agent-loops', 'provision-worktree.sh');
const primaryRoot = path.resolve(
  execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim(),
  '..'
);

function run(args, env = {}) {
  try {
    return { status: 0, stdout: execFileSync(script, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }), stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}

// "<action> <path>" per line, with the parenthetical reason dropped.
function plan(stdout) {
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [action, ...rest] = line.split(' ');
        return [rest.join(' ').split(' (')[0], action];
      })
  );
}

function temporaryWorktree(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'project-admin-provision-'));
  fs.rmSync(directory, { recursive: true, force: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--detach', directory, 'HEAD'], { stdio: 'ignore' });
  t.after(() => {
    try {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', directory], { stdio: 'ignore' });
    } catch {
      // Drop only this worktree's admin entry; other loop agents share the repo,
      // so never reach for a repo-wide `git worktree prune` here.
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(path.join(primaryRoot, '.git', 'worktrees', path.basename(directory)), { recursive: true, force: true });
    }
  });
  return directory;
}

test('a dry run lists the gitignored state a fresh worktree is missing and changes nothing', (t) => {
  const worktree = temporaryWorktree(t);
  const dryRun = run([worktree, '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const actions = plan(dryRun.stdout);
  for (const target of ['scripts/node_modules', 'admin-app/node_modules', 'extras/functions/node_modules']) {
    assert.ok(['symlink', 'npm-ci'].includes(actions[target]), `${target} must be provisioned, saw ${actions[target]}`);
  }
  assert.ok(['symlink', 'skip'].includes(actions['auth.env']), 'auth.env must be linked when the primary checkout has it');
  const flutterStep = actions['.'] || actions['pubspec.yaml'] || actions['flutter pub get'];
  assert.ok(['flutter-pub-get', 'present', 'skip'].includes(flutterStep), 'the Flutter package must be resolved or explicitly skipped');

  assert.equal(fs.existsSync(path.join(worktree, 'scripts', 'node_modules')), false, 'a dry run must not touch the worktree');
  assert.equal(fs.existsSync(path.join(worktree, 'auth.env')), false, 'a dry run must not touch the worktree');
});

test('a dry run keys npm installs by the node_modules target they provision', (t) => {
  const worktree = temporaryWorktree(t);
  fs.appendFileSync(path.join(worktree, 'admin-app', 'package-lock.json'), '\n');

  const dryRun = run([worktree, '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);

  const actions = plan(dryRun.stdout);
  assert.equal(actions['admin-app/node_modules'], 'npm-ci');
});

test('PROJECT_ADMIN_PRIMARY_ROOT makes lockfile comparison independent of the shared checkout', (t) => {
  const worktree = temporaryWorktree(t);
  const fixture = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'project-admin-primary-fixture-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  for (const rel of ['scripts', 'admin-app', 'extras/functions']) {
    fs.mkdirSync(path.join(fixture, rel, 'node_modules'), { recursive: true });
    fs.copyFileSync(path.join(worktree, rel, 'package-lock.json'), path.join(fixture, rel, 'package-lock.json'));
  }
  fs.appendFileSync(path.join(fixture, 'admin-app', 'package-lock.json'), '\nfixture drift\n');

  const dryRun = run([worktree, '--dry-run'], { PROJECT_ADMIN_PRIMARY_ROOT: fixture });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const actions = plan(dryRun.stdout);
  assert.equal(actions['scripts/node_modules'], 'symlink');
  assert.equal(actions['admin-app/node_modules'], 'npm-ci');
  assert.equal(actions['extras/functions/node_modules'], 'symlink');
});

test('provisioning makes the backlog CLI runnable in the worktree and is idempotent', (t) => {
  const worktree = temporaryWorktree(t);
  const first = run([worktree]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    fs.existsSync(path.join(worktree, 'scripts', 'node_modules', '@google-cloud', 'firestore')),
    true,
    'the backlog CLI must resolve its dependencies from the worktree'
  );

  const untracked = execFileSync('git', ['-C', worktree, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('??'));
  assert.deepEqual(untracked, [], 'provisioned state must stay ignored so it cannot ride along in a commit');

  const second = run([worktree]);
  assert.equal(second.status, 0, second.stderr);
  const actions = plan(second.stdout);
  assert.equal(actions['scripts/node_modules'], 'present');
  assert.equal(actions['admin-app/node_modules'], 'present');
  assert.equal(actions['extras/functions/node_modules'], 'present');
});

test('refuses the shared primary checkout and anything that is not a worktree', () => {
  const primary = run([primaryRoot, '--dry-run']);
  assert.equal(primary.status, 1);
  assert.match(primary.stderr, /primary checkout/);

  const plain = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'project-admin-not-a-worktree-'));
  const notAWorktree = run([plain, '--dry-run']);
  fs.rmSync(plain, { recursive: true, force: true });
  assert.equal(notAWorktree.status, 1);
  assert.match(notAWorktree.stderr, /Not a git worktree/);

  assert.equal(run(['/nonexistent/worktree', '--dry-run']).status, 1);
  assert.equal(run([]).status, 2);
  assert.equal(run([primaryRoot, '--wet-run']).status, 2);
});

test('a separate kit (empty KIT_SUBDIR) provisions only product state; an embedded one looks under its subdirectory', (t) => {
  const worktree = temporaryWorktree(t);
  const separate = plan(run([worktree, '--dry-run'], { PROJECT_ADMIN_KIT_SUBDIR: '' }).stdout);
  assert.equal(separate['kit packages'], 'skip');
  assert.equal(separate['scripts/node_modules'], undefined, 'a separate kit runs from its own checkout');
  assert.equal(separate['auth.env'], undefined);

  const embedded = plan(run([worktree, '--dry-run'], { PROJECT_ADMIN_KIT_SUBDIR: 'ops' }).stdout);
  assert.equal(embedded['ops/scripts'], 'skip', 'kit packages are looked up under the kit subdirectory');
  assert.equal(embedded['ops/auth.env'], 'skip');
});
