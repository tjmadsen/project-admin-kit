'use strict';

// One behavioural contract, three stores: the in-memory Firestore, the local
// JSON store in a temp dir, and the github store over a fake transport. Each
// scenario drives the real backlog CLI (createBacklogAgent) and the loop
// helpers through the BacklogStore interface only. Human gates are acted out
// the way each backend's human performs them: the console's patch for
// firestore/local, a slash command on the issue for github.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Timestamp } = require('@google-cloud/firestore');
const { createBacklogAgent } = require('../lib/backlog-agent');
const { resolveAgent } = require('../lib/agents');
const { loadProjectConfig } = require('../lib/project-config');
const { resolveWorkKinds } = require('../lib/work-kinds');
const { createFirestoreStore } = require('../lib/store/firestore-store');
const { createLocalStore } = require('../lib/store/local-store');
const { createGitHubStore } = require('../lib/store/github-store');
const { timestampMillis } = require('../lib/store/values');
const { CONFIRMATION_REQUEST_REASON, handoffConfirmationRequest } = require('../agent-loops/confirmation-handoff');
const { FieldValue, createFakeFirestore } = require('./support/fake-firestore');
const { createFakeGitHub } = require('./support/fake-github');

const config = loadProjectConfig();
const kinds = resolveWorkKinds({
  feature: {},
  bug: {},
  task: { label: 'Task', prefix: 'TASK', deploys: false, statuses: { initial: 'open', done: 'closed', declined: 'declined' } },
});
const approvedNotes = 'Scope: release PR #5.\nCommands: deploy hosting.\nVerification: open the admin route.\nAcceptance: the page renders the change.';
const APPROVAL_NOTE = '✅ Approved — please continue.';

function tempFile(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, name);
}

// Console-equivalent gate actions for the stores that have a dashboard.
function consoleHuman(store) {
  return {
    async approve(id) {
      await store.items.update(id, {
        waitingOn: 'agent', status: 'in_progress', blockedReason: null, leaseExpiresAt: null, claimedBy: null, updatedAt: store.serverTimestamp(),
      }, { messages: [{ author: 'Project owner', authorEmail: 'owner@example.com', body: APPROVAL_NOTE, imageUrls: [], createdAt: store.now() }] });
    },
    async approveDeploy(id) {
      const item = await store.items.get(id);
      await store.items.update(id, {
        waitingOn: 'deployer', status: 'ready_for_deploy', blockedReason: null,
        deploymentApprovedTargets: item.deploymentTargets, deploymentApprovedNotes: item.deploymentNotes,
        deploymentApprovedAt: store.serverTimestamp(), deploymentApprovedBy: 'owner@example.com',
        deploymentEvidence: {}, deploymentResult: '', deploymentVerifiedAt: null, leaseExpiresAt: null, claimedBy: null,
      });
    },
  };
}

const BACKENDS = {
  firestore() {
    const db = createFakeFirestore();
    const store = createFirestoreStore({ db, FieldValue, Timestamp, uploadAttachments: async () => [] });
    return { store, twin: () => store, human: consoleHuman(store), numbering: 'per-kind' };
  },
  local(t) {
    const file = tempFile(t, 'store.json');
    const store = createLocalStore({ file });
    // A second handle on the same file stands in for a second process.
    return { store, twin: () => createLocalStore({ file }), human: consoleHuman(store), numbering: 'per-kind' };
  },
  github(t) {
    const github = createFakeGitHub({ permissions: { owner: 'admin', viewer: 'read' } });
    const telemetryFile = tempFile(t, 'github-telemetry.json');
    const open = () => createGitHubStore({
      repository: 'acme/app', transport: github, telemetry: createLocalStore({ file: telemetryFile }), kinds,
      defaultOwner: resolveAgent(config.automation.defaultWorkAgent).owner, resolveOwner: (token) => resolveAgent(token).owner, settleMs: 0,
    });
    const store = open();
    const command = async (id, body) => { github.human.comment(id, 'owner', body); await store.sync(); };
    return {
      store, twin: open, github, numbering: 'issue',
      human: { approve: (id) => command(id, '/approve'), approveDeploy: (id) => command(id, '/approve deploy') },
    };
  },
};

function harness(t, backend) {
  const setup = BACKENDS[backend](t);
  const cli = (store, kindId, env = {}) => {
    const outputs = [];
    const agent = createBacklogAgent({
      store, config, kinds, kindId, env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac', ...env }, log: (line) => outputs.push(JSON.parse(line)),
    });
    return async (...argv) => { await agent.run(argv); return outputs.at(-1); };
  };
  const run = (kindId, ...argv) => cli(setup.store, kindId)(...argv);
  return { ...setup, cli, run };
}

for (const backend of Object.keys(BACKENDS)) {
  test(`[${backend}] create numbers items and show returns the thread`, async (t) => {
    const { run, numbering } = harness(t, backend);
    const first = await run('feature', 'create', '--as', 'sol', '--title', 'One', '--description', 'Feature body');
    const second = await run('bug', 'create', '--as', 'sol', '--title', 'Two', '--description', 'Bug body');
    const third = await run('feature', 'create', '--as', 'sol', '--title', 'Three', '--description', 'Another');
    if (numbering === 'per-kind') assert.deepEqual([first.ref, second.ref, third.ref], ['FR-1', 'BUG-1', 'FR-2']);
    else assert.deepEqual([first.ref, second.ref, third.ref], ['FR-1', 'BUG-2', 'FR-3'], 'github numbers every kind from the issue number');
    const shown = await run(null, 'show', first.id);
    assert.equal(shown.kind, 'feature');
    assert.equal(shown.title, 'One');
    assert.equal(shown.description, 'Feature body');
    assert.equal(shown.status, 'backlog');
    assert.equal(shown.waitingOn, 'agent');
    assert.equal(shown.assignedTo, 'sol-agent');
    assert.deepEqual(shown.messages.map((message) => message.body), ['Created FR-1.']);
    assert.equal((await run('feature', 'list', '--as', 'sol')).length, 2);
  });

  test(`[${backend}] two concurrent claims of one item: exactly one wins`, async (t) => {
    const { store, twin, cli, run } = harness(t, backend);
    const created = await run('task', 'create', '--as', 'sol', '--title', 'Race', '--description', 'Only one agent may hold this');
    const results = await Promise.all([
      cli(store, 'task')('next', '--as', 'sol'),
      cli(twin(), 'task')('next', '--as', 'sol'),
    ]);
    const winners = results.filter((result) => result.id === created.id);
    assert.equal(winners.length, 1, JSON.stringify(results));
    assert.deepEqual(results.filter((result) => result.none), [{ none: true }]);
    const stored = await store.items.get(created.id);
    assert.equal(stored.claimedBy, 'sol');
    assert.equal(stored.status, 'in_progress');
    assert.ok(stored.leaseExpiresAt.toMillis() > Date.now());
    assert.deepEqual(await run('task', 'next', '--as', 'sol'), { none: true }, 'a held lease is not claimable');
  });

  test(`[${backend}] plan gate: plan review waits for a human, approval returns it to the agent`, async (t) => {
    const { run, human } = harness(t, backend);
    const bug = await run('bug', 'create', '--as', 'sol', '--title', 'Crash', '--description', 'It crashes on launch');
    assert.equal((await run('bug', 'next', '--as', 'sol')).id, bug.id);
    const planned = await run(null, 'plan', bug.id, '--as', 'sol', '-m', 'Root cause: null config. Plan: guard it.');
    assert.equal(planned.blockedReason, 'plan_review');
    assert.equal((await run('bug', 'count', '--as', 'sol')).count, 0, 'waiting on a human is not agent work');
    await human.approve(bug.id);
    const claimed = await run('bug', 'next', '--as', 'sol');
    assert.equal(claimed.id, bug.id);
    assert.ok(claimed.messages.some((message) => message.body.startsWith(APPROVAL_NOTE)), 'the approval is in the thread');
  });

  test(`[${backend}] messages append in order with authors`, async (t) => {
    const { run } = harness(t, backend);
    const item = await run('task', 'create', '--as', 'sol', '--title', 'Chat', '--description', 'Talk it through');
    await run(null, 'reply', item.id, '--as', 'sol', '-m', 'First note');
    await run(null, 'ask', item.id, '--as', 'terra', '-m', 'Which option?');
    const shown = await run(null, 'show', item.id);
    assert.deepEqual(shown.messages.map((message) => [message.author, message.body]), [
      ['Codex Sol', 'Created TASK-1.'],
      ['Codex Sol', 'First note'],
      ['Codex Terra', 'Which option?'],
    ]);
    assert.equal(shown.status, 'blocked');
    assert.equal(shown.blockedReason, 'question');
    assert.ok(shown.messages.every((message) => !Number.isNaN(Date.parse(message.createdAt))), 'the CLI prints timestamps as ISO strings');
  });

  test(`[${backend}] deploy flow: PR review, approved target set, evidence, completion`, async (t) => {
    const { store, run, cli, human, github } = harness(t, backend);
    const feature = await run('feature', 'create', '--as', 'sol', '--title', 'Dark mode', '--description', 'Add a dark theme');
    await run('feature', 'next', '--as', 'sol');
    const pr = await run(null, 'pr', feature.id, '--as', 'sol', '--url', 'https://github.com/acme/app/pull/5', '--number', '5', '--branch', 'feature/dark', '-m', 'PR #5 is ready');
    assert.equal(pr.blockedReason, 'pr_review');
    await human.approve(feature.id);
    await run('feature', 'next', '--as', 'sol');
    const pending = await run(null, 'deploy-pending', feature.id, '--as', 'sol', '--targets', 'none', '--notes', approvedNotes, '-m', 'Ready to release');
    assert.equal(pending.blockedReason, 'deploy_approval');
    assert.equal((await run(null, 'deploy-count', '--as', 'sonnet')).count, 0, 'nothing deploys before approval');
    await human.approveDeploy(feature.id);

    const deployer = cli(store, null, { PROJECT_ADMIN_AGENT_RUN_ID: 'run-deploy-1' });
    const claimed = await deployer('deploy-next', '--as', 'sonnet');
    assert.equal(claimed.id, feature.id);
    assert.deepEqual((await store.items.get(feature.id)).deploymentApprovedTargets, ['none']);
    assert.equal((await store.runs.get('run-deploy-1')).activeItemId, feature.id, 'the claim is attached to the loop run');
    await assert.rejects(run(null, 'ship', feature.id, '--as', 'sonnet', '-m', 'done'), /missing target-specific proof/);
    await run(null, 'deploy-check', feature.id, '--as', 'sonnet', '--target', 'none', '--proof', 'Merged commit abc is on origin/main.', '--acceptance', 'Focused tests prove the change on main.');
    const shipped = await run(null, 'ship', feature.id, '--as', 'sonnet', '-m', 'Shipped after merge');
    assert.equal(shipped.status, 'shipped');
    const stored = await store.items.get(feature.id);
    assert.equal(stored.waitingOn, 'done');
    assert.equal(stored.claimedBy, null);
    assert.equal(stored.deploymentEvidence.none.verifiedBy, 'sonnet');
    assert.ok(stored.messages.some((message) => message.body.startsWith('Verified none.')));
    if (github) {
      const issue = github.issue(feature.id);
      assert.equal(issue.state, 'closed');
      assert.equal(issue.state_reason, 'completed');
    }
  });

  test(`[${backend}] a confirmation request hands the deploy claim back to a human`, async (t) => {
    const { store, run, cli, human } = harness(t, backend);
    const bug = await run('bug', 'create', '--as', 'sol', '--title', 'Push', '--description', 'Upload the key');
    await run('bug', 'next', '--as', 'sol');
    await run(null, 'deploy-pending', bug.id, '--as', 'sol', '--targets', 'none', '--notes', approvedNotes, '-m', 'Ready');
    await human.approveDeploy(bug.id);
    const runId = await store.runs.create({ agent: 'sonnet', queue: 'deploy', status: 'running' });
    await cli(store, null, { PROJECT_ADMIN_AGENT_RUN_ID: runId })('deploy-next', '--as', 'sonnet');
    const result = await handoffConfirmationRequest(runId, CONFIRMATION_REQUEST_REASON, 'Please confirm that I may upload the APNs key.', {
      store, agentLabelFor: (token) => resolveAgent(token).label,
    });
    assert.equal(result.asked, true);
    const stored = await store.items.get(bug.id);
    assert.deepEqual([stored.status, stored.waitingOn, stored.blockedReason, stored.claimedBy], ['blocked', 'human', 'question', null]);
    assert.match(stored.messages.at(-1).body, /Requested confirmation: Please confirm that I may upload the APNs key\./);
  });

  test(`[${backend}] telemetry: runs, machines, and merged system documents`, async (t) => {
    const { store } = harness(t, backend);
    const runId = await store.runs.create({ agent: 'sol', queue: 'feature', status: 'running', startedAt: store.serverTimestamp() });
    await store.runs.merge(runId, { progressSummary: 'halfway' });
    assert.equal((await store.runs.get(runId)).progressSummary, 'halfway');
    assert.ok(timestampMillis((await store.runs.get(runId)).startedAt) > 0, 'server timestamps resolve on write');
    assert.deepEqual((await store.runs.listByStatus('running')).map((entry) => entry.id), [runId]);
    await store.machines.merge('local-mac', { status: 'online' });
    await store.system.merge('agentLoopUsage', { claude: { usedPercent: 40, captureStatus: 'available' } });
    await store.system.merge('agentLoopUsage', { claude: { captureStatus: 'unavailable' } });
    assert.deepEqual((await store.system.get('agentLoopUsage')).claude, { usedPercent: 40, captureStatus: 'unavailable' }, 'set-merge merges nested maps');
    await store.system.merge('agentLoopConfig', { deployAgent: 'opus' });
    assert.equal((await store.system.get('agentLoopConfig')).deployAgent, 'opus');
  });
}

for (const backend of ['firestore', 'local']) {
  test(`[${backend}] counters continue from existing values and users round-trip`, async (t) => {
    const { store, run } = harness(t, backend);
    await store.system.merge('counters', { nextFeatureNumber: 41 });
    assert.equal((await run('feature', 'create', '--as', 'sol', '--title', 'Next', '--description', 'Continues numbering')).ref, 'FR-42');
    assert.equal((await store.system.get('counters')).nextFeatureNumber, 42);
    await store.users.merge('owner@example.com', { email: 'owner@example.com', role: 'admin', active: true });
    await store.users.merge('owner@example.com', { active: false });
    assert.deepEqual((await store.users.list()).map((user) => [user.id, user.role, user.active]), [['owner@example.com', 'admin', false]]);
    await store.users.remove('owner@example.com');
    assert.equal(await store.users.get('owner@example.com'), null);
  });
}
