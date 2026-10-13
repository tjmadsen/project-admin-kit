'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  itemReference,
  kindForReference,
  queueNames,
  resolveWorkKinds,
  syncDerivedFiles,
} = require('../lib/work-kinds');
const { dependencyIsComplete } = require('../lib/dependencies');

const repoRoot = path.resolve(__dirname, '..', '..');

test('absent workKinds falls back to exactly the built-in feature and bug lifecycle', () => {
  const kinds = resolveWorkKinds(undefined);
  assert.deepEqual(kinds.map((kind) => kind.id), ['feature', 'bug']);
  const [feature, bug] = kinds;
  assert.equal(feature.prefix, 'FR');
  assert.equal(feature.route, 'features');
  assert.equal(feature.counterField, 'nextFeatureNumber');
  assert.deepEqual(feature.activeStatuses, ['backlog', 'in_progress', 'blocked', 'in_review', 'ready_for_deploy']);
  assert.deepEqual(feature.terminalStatuses, ['shipped', 'declined']);
  assert.equal(feature.completeCommand, 'ship');
  assert.equal(feature.completedAtField, 'shippedAt');
  assert.ok(!feature.gates.includes('plan_review'));
  assert.equal(bug.prefix, 'BUG');
  assert.equal(bug.counterField, 'nextBugNumber');
  assert.deepEqual(bug.activeStatuses, ['open', 'investigating', 'plan_review', 'in_progress', 'blocked', 'in_review', 'ready_for_deploy']);
  assert.deepEqual(bug.terminalStatuses, ['closed', 'wont_fix']);
  assert.equal(bug.completeCommand, 'resolve');
  assert.equal(bug.completedAtField, 'resolvedAt');
  assert.ok(bug.gates.includes('plan_review'));
});

test('configured kinds merge built-in fields by id and default new kinds generically', () => {
  const kinds = resolveWorkKinds({
    feature: { prefix: 'FEAT' },
    task: { label: 'Task', prefix: 'TASK', deploys: false },
  });
  const [feature, task] = kinds;
  assert.equal(feature.prefix, 'FEAT');
  assert.equal(feature.label, 'Feature request');
  assert.equal(feature.copy.eyebrow, 'Product backlog');
  assert.equal(task.route, 'tasks');
  assert.equal(task.pluralLabel, 'Tasks');
  assert.equal(task.runbook, '.claude/commands/task-loop.md');
  assert.equal(task.counterField, 'nextTaskNumber');
  assert.deepEqual(task.activeStatuses, ['open', 'in_progress', 'blocked', 'in_review']);
  assert.deepEqual(task.terminalStatuses, ['closed', 'declined']);
  assert.ok(!task.gates.includes('deploy_approval'));
  assert.equal(resolveWorkKinds({ 'tech-debt': { label: 'Debt', prefix: 'TD' } })[0].counterField, 'nextTechDebtNumber');
});

test('invalid kind configuration fails loudly', () => {
  assert.throws(() => resolveWorkKinds({}), /at least one kind/);
  assert.throws(() => resolveWorkKinds({ Task: { label: 'Task', prefix: 'T' } }), /\^\[a-z\]/);
  assert.throws(() => resolveWorkKinds({ deploy: { label: 'Deploy', prefix: 'D' } }), /reserved for the deploy queue/);
  assert.throws(() => resolveWorkKinds({ task: { label: 'Task' } }), /task\.prefix/);
  assert.throws(() => resolveWorkKinds({ task: { label: 'Task', prefix: 'fr' } }), /uppercase/);
  assert.throws(() => resolveWorkKinds({ feature: {}, task: { label: 'Task', prefix: 'FR' } }), /task\.prefix: duplicates feature/);
  assert.throws(() => resolveWorkKinds({ task: { label: 'Task', prefix: 'T', route: 'loops' } }), /route/);
  assert.throws(() => resolveWorkKinds({ task: { label: 'Task', prefix: 'T', statuses: { done: 'finished' } } }), /statuses\.done/);
  assert.throws(() => resolveWorkKinds({ task: { label: 'Task', prefix: 'T', deploys: 'no' } }), /deploys/);
});

test('the config loader rejects an invalid workKinds block', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-kinds-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'project-admin.config.json'), 'utf8'));
  config.workKinds = { deploy: { label: 'Deploy', prefix: 'DEP' } };
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/lib/work-kinds.js'), 'queues'], {
    encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: file },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reserved for the deploy queue/);
});

test('references resolve through configured prefixes', () => {
  const kinds = resolveWorkKinds({ feature: {}, bug: {}, task: { label: 'Task', prefix: 'TASK', deploys: false } });
  assert.equal(itemReference(kinds, { kind: 'task', number: 4 }), 'TASK-4');
  assert.equal(itemReference(kinds, { kind: 'bug', number: 9 }), 'BUG-9');
  assert.equal(kindForReference(kinds, 'task-4').id, 'task');
  assert.equal(kindForReference(kinds, 'NOPE-1'), null);
  assert.deepEqual(queueNames(kinds), ['feature', 'bug', 'task', 'deploy']);
  assert.equal(dependencyIsComplete({ kind: 'task', status: 'closed' }, kinds), true);
  assert.equal(dependencyIsComplete({ kind: 'task', status: 'declined' }, kinds), false);
  assert.equal(dependencyIsComplete({ kind: 'unknown', status: 'closed' }, kinds), false);
});

test('the queues helper prints every configured kind plus deploy for run-loop.sh', () => {
  const output = execFileSync(process.execPath, [path.join(repoRoot, 'scripts/lib/work-kinds.js'), 'queues'], { encoding: 'utf8' });
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'project-admin.config.json'), 'utf8'));
  assert.deepEqual(output.trim().split('\n'), [...Object.keys(config.workKinds || { feature: 1, bug: 1 }), 'deploy']);
});

test('generated rules, Functions, and iOS config are in sync with project-admin.config.json', () => {
  assert.deepEqual(syncDerivedFiles({ root: repoRoot, write: false }), [], 'run `npm run sync:work-kinds` and commit the result');
});

test('sync rewrites only the generated rule block', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-rules-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of ['firestore.rules', 'storage.rules']) fs.copyFileSync(path.join(repoRoot, file), path.join(dir, file));
  const kinds = resolveWorkKinds({ feature: {}, chore: { label: 'Chore', prefix: 'CH', deploys: false } });
  assert.deepEqual(syncDerivedFiles({ root: dir, kinds }), ['firestore.rules', 'storage.rules']);
  const firestoreRules = fs.readFileSync(path.join(dir, 'firestore.rules'), 'utf8');
  assert.match(firestoreRules, /\{'feature': 'nextFeatureNumber', 'chore': 'nextChoreNumber'\}/);
  assert.doesNotMatch(firestoreRules, /nextBugNumber/);
  assert.match(firestoreRules, /match \/workItems\/\{itemId\}/, 'hand-written rules survive');
  assert.match(fs.readFileSync(path.join(dir, 'storage.rules'), 'utf8'), /kind in \['feature', 'chore'\]/);
  assert.deepEqual(syncDerivedFiles({ root: dir, kinds, write: false }), [], 'a second sync is a no-op');
});
