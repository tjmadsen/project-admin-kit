'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Timestamp } = require('@google-cloud/firestore');
const { createBacklogAgent } = require('../lib/backlog-agent');
const { loadProjectConfig } = require('../lib/project-config');
const { resolveWorkKinds } = require('../lib/work-kinds');
const { FieldValue, createFakeFirestore } = require('./support/fake-firestore');

const config = loadProjectConfig();
const kinds = resolveWorkKinds({
  feature: {},
  bug: {},
  task: { label: 'Task', prefix: 'TASK', deploys: false, statuses: { initial: 'open', done: 'closed', declined: 'declined' } },
});
const approvedNotes = 'Scope: release PR #5.\nCommands: deploy hosting.\nVerification: open the admin route.\nAcceptance: the page renders the change.';

function setup() {
  const db = createFakeFirestore();
  const outputs = [];
  const cli = (kindId) => createBacklogAgent({
    db, FieldValue, Timestamp, config, kinds, kindId,
    env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac' },
    uploadAttachments: async () => [],
    log: (line) => outputs.push(JSON.parse(line)),
  });
  const run = async (kindId, ...argv) => { await cli(kindId).run(argv); return outputs.at(-1); };
  const item = (id, data) => db.seed(`workItems/${id}`, {
    priority: 'medium', waitingOn: 'agent', assignedTo: 'sol-agent', targetMachine: 'local-mac', messages: [], ...data,
  });
  return { db, run, item };
}

test('create numbers each kind from its own counter, continuing legacy feature/bug fields', async () => {
  const { db, run } = setup();
  db.seed('system/counters', { nextFeatureNumber: 41, nextBugNumber: 7 });
  assert.equal((await run('feature', 'create', '--as', 'sol', '--title', 'One', '--description', 'Feature body')).ref, 'FR-42');
  assert.equal((await run('bug', 'create', '--as', 'sol', '--title', 'Two', '--description', 'Bug body')).ref, 'BUG-8');
  const task = await run('task', 'create', '--as', 'sol', '--title', 'Three', '--description', 'Task body');
  assert.equal(task.ref, 'TASK-1');
  assert.deepEqual(db.read('system/counters').nextTaskNumber, 1);
  const stored = db.read(`workItems/${task.id}`);
  assert.equal(stored.kind, 'task');
  assert.equal(stored.status, 'open');
  assert.equal(stored.messages[0].body, 'Created TASK-1.');
  assert.deepEqual(db.paths().filter((entry) => !entry.startsWith('workItems/') && entry !== 'system/counters'), []);
});

test('build queues are per kind and a scoped CLI cannot touch another kind', async () => {
  const { run, item } = setup();
  item('feature-1', { kind: 'feature', number: 1, status: 'backlog' });
  item('task-1', { kind: 'task', number: 1, status: 'open' });
  item('bug-1', { kind: 'bug', number: 1, status: 'open' });
  const claimed = await run('task', 'next', '--as', 'sol');
  assert.equal(claimed.id, 'task-1');
  assert.equal(claimed.ref, 'TASK-1');
  assert.deepEqual(await run('task', 'next', '--as', 'sol'), { none: true });
  await assert.rejects(run('feature', 'show', 'bug-1'), /bug-1 is a bug item, not feature/);
  await assert.rejects(run(null, 'next', '--as', 'sol'), /needs --kind <feature\|bug\|task>/);
  assert.equal((await run(null, 'show', 'bug-1')).kind, 'bug', 'item-scoped commands need no kind');
  assert.throws(() => createBacklogAgent({ db: {}, FieldValue, Timestamp, config, kinds, kindId: 'epic' }), /Unknown work kind "epic"/);
});

test('lifecycle gates follow the kind: plan review, deploy, and completion verbs', async () => {
  const { db, run, item } = setup();
  item('feature-2', { kind: 'feature', number: 2, status: 'in_progress' });
  item('bug-2', { kind: 'bug', number: 2, status: 'investigating' });
  item('task-2', { kind: 'task', number: 2, status: 'in_progress' });
  await assert.rejects(run(null, 'plan', 'feature-2', '--as', 'sol', '-m', 'plan'), /no plan-review gate/);
  await assert.rejects(run(null, 'plan', 'task-2', '--as', 'sol', '-m', 'plan'), /no plan-review gate/);
  assert.equal((await run('bug', 'plan', 'bug-2', '--as', 'sol', '-m', 'Root cause: x')).blockedReason, 'plan_review');
  await assert.rejects(run(null, 'set', 'task-2', '--as', 'sol', '--gate', 'deploy_approval'), /Invalid --gate "deploy_approval" for tasks/);
  await assert.rejects(
    run(null, 'deploy-pending', 'task-2', '--as', 'sol', '--targets', 'none', '--notes', approvedNotes, '-m', 'ready'),
    /Tasks never deploy; finish them with close-no-deploy/,
  );
  await assert.rejects(run(null, 'ship', 'bug-2', '--as', 'sol', '-m', 'done'), /Use resolve for bugs/);
  await assert.rejects(run(null, 'resolve', 'feature-2', '--as', 'sol', '-m', 'done'), /Use ship for feature requests/);

  const closed = await run('task', 'close-no-deploy', 'task-2', '--as', 'sol', '-m', 'Merged PR #9 after review; nothing to release.');
  assert.equal(closed.status, 'closed');
  const stored = db.read('workItems/task-2');
  assert.equal(stored.waitingOn, 'done');
  assert.ok(stored.resolvedAt instanceof Date);
  assert.equal(stored.shippedAt, undefined);
  assert.match(stored.messages.at(-1).body, /^Closed without deployment: Merged PR #9/);
  assert.equal((await run(null, 'decline', 'feature-2', '--as', 'sol', '-m', 'Not now')).status, 'declined');
});

test('the deploy queue spans every deploying kind and never claims a non-deploying kind', async () => {
  const { db, run, item } = setup();
  const approved = { status: 'ready_for_deploy', waitingOn: 'deployer', deploymentApprovedAt: Timestamp.now(), deploymentApprovedTargets: ['none'] };
  item('task-3', { kind: 'task', number: 3, ...approved, priority: 'critical' });
  item('bug-3', { kind: 'bug', number: 3, ...approved, priority: 'high' });
  item('feature-3', { kind: 'feature', number: 3, ...approved, priority: 'low' });
  assert.equal((await run(null, 'deploy-count', '--as', 'sonnet')).count, 2);
  assert.equal((await run('feature', 'deploy-count', '--as', 'sonnet')).count, 1, 'shims keep their per-kind deploy queue');
  await assert.rejects(run('task', 'deploy-next', '--as', 'sonnet'), /Tasks never deploy/);
  const first = await run(null, 'deploy-next', '--as', 'sonnet');
  assert.equal(first.ref, 'BUG-3');
  await run(null, 'deploy-check', 'bug-3', '--as', 'sonnet', '--target', 'none', '--proof', 'Merged commit abc is on origin/main.', '--acceptance', 'Focused tests prove the fix on main.');
  assert.equal((await run(null, 'complete', 'bug-3', '--as', 'sonnet', '-m', 'Resolved after merge')).status, 'closed');
  assert.equal((await run(null, 'deploy-next', '--as', 'sonnet')).ref, 'FR-3');
  assert.deepEqual(await run(null, 'deploy-next', '--as', 'sonnet'), { none: true });
  assert.equal(db.read('workItems/task-3').claimedBy, undefined);
});

test('a target disabled after approval still completes its approved release; new scopes stay strict', async () => {
  // The sample config lists testflight with enabled: false.
  const { db, run, item } = setup();
  item('feature-7', {
    kind: 'feature', number: 7, status: 'ready_for_deploy', waitingOn: 'deployer', claimedBy: 'sonnet',
    deploymentApprovedAt: Timestamp.now(), deploymentApprovedTargets: ['testflight', 'firebase_hosting'],
  });
  await run(null, 'deploy-check', 'feature-7', '--as', 'sonnet', '--target', 'firebase_hosting', '--proof', 'Hosting release 42 serves the new bundle.', '--acceptance', 'The admin route renders the requested change.');
  // Before the fix, the disabled target was rejected here and stranded the release.
  await run(null, 'deploy-check', 'feature-7', '--as', 'sonnet', '--target', 'testflight', '--proof', 'Archive for build 2610120101 uploaded.', '--acceptance', 'The owner will test the feature in TestFlight.');
  await assert.rejects(run(null, 'complete', 'feature-7', '--as', 'sonnet', '-m', 'done'), /TestFlight items require .* hands-on acceptance/);
  await run(null, 'deployment-started', 'feature-7', '--as', 'sonnet', '--target', 'testflight', '-m', 'TestFlight upload launched');
  await assert.rejects(run(null, 'verification-pending', 'feature-7', '--as', 'sonnet', '--target', 'firebase_hosting', '-m', 'Hosting is live'), /only for targets with requiresHumanAcceptance/);
  const handed = await run(null, 'verification-pending', 'feature-7', '--as', 'sonnet', '--build', '2610120101', '-m', 'TestFlight build 2610120101 is VALID.');
  assert.deepEqual([handed.target, handed.status], ['testflight', 'in_review']);
  const saved = db.read('workItems/feature-7');
  assert.equal(saved.blockedReason, 'acceptance_review');
  assert.equal(saved.deploymentEvidence.testflight.proof, 'TestFlight build 2610120101 is VALID.');

  item('feature-8', { kind: 'feature', number: 8, status: 'in_review', waitingOn: 'agent' });
  await assert.rejects(run(null, 'deploy-pending', 'feature-8', '--as', 'sonnet', '--targets', 'testflight', '--notes', approvedNotes, '-m', 'ready'), /"testflight" is disabled/);
});

test('verification-pending hands any requiresHumanAcceptance target to acceptance review', () => {
  // The contract resolves targets from config once per process, so use a child.
  const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'project-admin-acceptance-'));
  const custom = { ...config, deployments: { targets: { store_review: { label: 'Store review', runbook: 'docs/store.md', requiresHumanAcceptance: true }, firebase_hosting: {} } } };
  const file = path.join(dir, 'config.json');
  require('node:fs').writeFileSync(file, JSON.stringify(custom));
  const script = `
    const { Timestamp } = require('@google-cloud/firestore');
    const { createBacklogAgent } = require(${JSON.stringify(path.join(__dirname, '../lib/backlog-agent'))});
    const { loadProjectConfig } = require(${JSON.stringify(path.join(__dirname, '../lib/project-config'))});
    const { resolveWorkKinds } = require(${JSON.stringify(path.join(__dirname, '../lib/work-kinds'))});
    const { FieldValue, createFakeFirestore } = require(${JSON.stringify(path.join(__dirname, 'support/fake-firestore'))});
    const db = createFakeFirestore();
    const outputs = [];
    const cli = createBacklogAgent({ db, FieldValue, Timestamp, config: loadProjectConfig(), kinds: resolveWorkKinds({ feature: {} }), kindId: null,
      env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac' }, uploadAttachments: async () => [], log: (line) => outputs.push(JSON.parse(line)) });
    db.seed('workItems/f1', { kind: 'feature', number: 1, priority: 'medium', messages: [], status: 'ready_for_deploy', waitingOn: 'deployer',
      claimedBy: 'sonnet', deploymentApprovedAt: Timestamp.now(), deploymentApprovedTargets: ['store_review'] });
    (async () => {
      let refused = '';
      try { await cli.run(['complete', 'f1', '--as', 'sonnet', '-m', 'done']); } catch (error) { refused = error.message; }
      await cli.run(['verification-pending', 'f1', '--as', 'sonnet', '--target', 'store_review', '-m', 'Submitted build 9 is in review.']);
      const saved = db.read('workItems/f1');
      console.log(JSON.stringify({ refused, out: outputs.at(-1), gate: saved.blockedReason, proof: saved.deploymentEvidence.store_review.proof }));
    })().catch((error) => { console.error(error); process.exit(1); });`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: path.join(__dirname, '..'), env: { ...process.env, PROJECT_ADMIN_CONFIG: file } });
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.match(outcome.refused, /Store review items require .* hands-on acceptance/);
  assert.deepEqual([outcome.out.target, outcome.out.status, outcome.gate], ['store_review', 'in_review', 'acceptance_review']);
  assert.equal(outcome.proof, 'Submitted build 9 is in review.');
});

test('dependencies resolve across kinds inside workItems', async () => {
  const { run, item } = setup();
  item('bug-4', { kind: 'bug', number: 4, status: 'in_review', waitingOn: 'human' });
  item('task-4', { kind: 'task', number: 4, status: 'open', dependsOn: ['bug-4'] });
  assert.equal((await run('task', 'count', '--as', 'sol')).count, 0);
  item('bug-4', { kind: 'bug', number: 4, status: 'closed', waitingOn: 'done' });
  assert.equal((await run('task', 'next', '--as', 'sol')).id, 'task-4');
});

test('work-agent.js reports an unknown --kind as a JSON error', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'work-agent.js'), '--kind', 'epic', 'count', '--as', 'sol'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).kind, 'epic');
  assert.match(JSON.parse(result.stderr).error, /Unknown work kind "epic"/);
});
