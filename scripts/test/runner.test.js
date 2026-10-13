'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyRunResult } = require('../agent-loops/classify-run-result');
const {
  CONFIRMATION_REQUEST_REASON,
  canCreateConfirmationHandoff,
  confirmationHandoffMessage,
  confirmationRequestFrom,
  handoffConfirmationRequest,
} = require('../agent-loops/confirmation-handoff');
const { claimBelongsToRun, collectionForRun } = require('../agent-loops/run-claims');
const { reapAbandonedRuns } = require('../agent-loops/reap-runs');
const { createFirestoreStore } = require('../lib/store/firestore-store');

function fakeDatabase(run, item) {
  const updates = [];
  const runRef = { kind: 'run' };
  const itemRef = { kind: 'item' };
  return {
    updates,
    collection(name) {
      return {
        doc() {
          return name === 'agentLoopRuns' ? runRef : itemRef;
        },
      };
    },
    async runTransaction(operation) {
      await operation({
        async get(ref) {
          return ref === itemRef ? { exists: true, data: () => item } : { exists: false };
        },
        update(ref, patch) {
          updates.push({ ref, patch });
        },
      });
    },
    runSnapshot: { exists: true, data: () => run },
    runRef,
    itemRef,
  };
}

function withRunSnapshot(database) {
  const collection = database.collection.bind(database);
  database.collection = (name) => {
    if (name === 'agentLoopRuns') return { doc: () => ({ get: async () => database.runSnapshot }) };
    return collection(name);
  };
  return database;
}

const handoffDependencies = (database) => ({
  store: createFirestoreStore({
    db: database,
    FieldValue: {
      serverTimestamp: () => 'server-timestamp',
      arrayUnion: (value) => ({ arrayUnion: value }),
    },
    Timestamp: { now: () => 'timestamp-now' },
  }),
  agentLabelFor: (token) => `Agent ${token}`,
});

test('turns Claude background-task termination into a failed run', () => {
  const result = classifyRunResult(0, 'Background tasks still running after 600s; terminating.\nWaiting on simulator runs.');
  assert.equal(result.exitCode, 70);
  assert.match(result.reason, /background tasks/i);
});

test('keeps a clean zero exit successful and describes outer timeouts', () => {
  assert.deepEqual(classifyRunResult(0, 'PR recorded and claim released.'), { exitCode: 0, reason: '' });
  assert.deepEqual(classifyRunResult(124, ''), { exitCode: 124, reason: 'Worker exceeded the four-hour loop timeout' });
});

test('flags a successful run that ends by requesting confirmation', () => {
  const output = 'I staged the APNs key upload. Please confirm that I may upload it now.';
  assert.equal(confirmationRequestFrom(output), output);
  assert.deepEqual(classifyRunResult(0, output), {
    exitCode: 0,
    reason: '',
    confirmationRequested: true,
  });
  assert.deepEqual(
    classifyRunResult(0, 'The recorded grant requires no additional confirmation. Deployment completed and proof was recorded.'),
    { exitCode: 0, reason: '' },
  );
  const staleRequest = ['Please confirm an action mentioned in old claim output.', ...Array(60).fill('ordinary completion output')].join('\n');
  assert.equal(confirmationRequestFrom(staleRequest), null);
});

test('confirmation handoff requires an exact deploy claim still waiting on the deployer', () => {
  const run = { agent: 'sol', queue: 'deploy' };
  const item = { claimedBy: 'sol', claimRunId: 'run-1', waitingOn: 'deployer' };
  assert.equal(canCreateConfirmationHandoff(item, run, 'run-1', CONFIRMATION_REQUEST_REASON), true);
  assert.equal(canCreateConfirmationHandoff({ ...item, claimRunId: 'newer-run' }, run, 'run-1', CONFIRMATION_REQUEST_REASON), false);
  assert.equal(canCreateConfirmationHandoff({ ...item, claimRunId: null }, run, 'run-1', CONFIRMATION_REQUEST_REASON), false);
  assert.equal(canCreateConfirmationHandoff({ ...item, waitingOn: 'human' }, run, 'run-1', CONFIRMATION_REQUEST_REASON), false);
  assert.equal(canCreateConfirmationHandoff(item, { ...run, queue: 'bug' }, 'run-1', CONFIRMATION_REQUEST_REASON), false);
  assert.equal(canCreateConfirmationHandoff(item, run, 'run-1', 'ordinary failure'), false);
});

test('confirmation handoff exposes completed work, remaining work, and A/B choices', () => {
  const message = confirmationHandoffMessage('Can you confirm I may upload the APNs key?');
  assert.match(message, /Done:/);
  assert.match(message, /Requested confirmation:/);
  assert.match(message, /Remaining:/);
  assert.match(message, /Options: A\).+B\)/);
});

test('confirmation handoff transaction moves only the exact active deploy claim to question review', async () => {
  const run = { agent: 'sol', queue: 'deploy', activeItem: 'BUG-3', activeItemId: 'bug-3', activeCollection: 'workItems' };
  const item = { number: 3, claimedBy: 'sol', claimRunId: 'run-1', waitingOn: 'deployer' };
  const database = withRunSnapshot(fakeDatabase(run, item));
  const result = await handoffConfirmationRequest(
    'run-1',
    CONFIRMATION_REQUEST_REASON,
    'Please confirm that I may upload the APNs key.',
    handoffDependencies(database),
  );

  assert.equal(result.asked, true);
  assert.equal(database.updates.length, 1);
  assert.equal(database.updates[0].ref, database.itemRef);
  assert.deepEqual(
    {
      status: database.updates[0].patch.status,
      waitingOn: database.updates[0].patch.waitingOn,
      blockedReason: database.updates[0].patch.blockedReason,
      claimedBy: database.updates[0].patch.claimedBy,
      claimRunId: database.updates[0].patch.claimRunId,
      leaseExpiresAt: database.updates[0].patch.leaseExpiresAt,
    },
    { status: 'blocked', waitingOn: 'human', blockedReason: 'question', claimedBy: null, claimRunId: null, leaseExpiresAt: null },
  );
});

test('confirmation handoff transaction refuses a newer claim', async () => {
  const run = { agent: 'sol', queue: 'deploy', activeItem: 'BUG-3', activeItemId: 'bug-3', activeCollection: 'bugs' };
  const item = { number: 3, claimedBy: 'sol', claimRunId: 'run-2', waitingOn: 'deployer' };
  const database = withRunSnapshot(fakeDatabase(run, item));
  const result = await handoffConfirmationRequest(
    'run-1',
    CONFIRMATION_REQUEST_REASON,
    'Please confirm.',
    handoffDependencies(database),
  );

  assert.equal(result.asked, false);
  assert.equal(database.updates.length, 0);
});

test('releases only the claim belonging to the interrupted run', () => {
  const run = { agent: 'fable', queue: 'feature', activeItem: 'FR-7' };
  assert.equal(collectionForRun(run), 'workItems');
  assert.equal(collectionForRun({ agent: 'terra', queue: 'deploy', activeItem: 'BUG-2' }), 'workItems');
  assert.equal(collectionForRun({ agent: 'terra', queue: 'deploy', activeItemId: 'x', activeCollection: 'bugs' }), 'workItems');
  assert.equal(collectionForRun({ agent: 'terra', queue: 'task' }), null);
  assert.equal(claimBelongsToRun({ claimedBy: 'fable', claimRunId: 'run-1' }, run, 'run-1'), true);
  assert.equal(claimBelongsToRun({ claimedBy: 'fable', claimRunId: 'newer-run' }, run, 'run-1'), false);
  assert.equal(claimBelongsToRun({ claimedBy: 'sol', claimRunId: 'run-1' }, run, 'run-1'), false);
  assert.equal(claimBelongsToRun({ claimedBy: 'fable' }, run, 'legacy-run'), true);
});

test('Claude has no hidden wait cap while the runner keeps a bounded outer timeout', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'run-loop.sh'), 'utf8');
  const backlog = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backlog-agent.js'), 'utf8');
  const runLog = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'log-run.js'), 'utf8');
  assert.match(runner, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-0/);
  assert.match(runner, /PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS:-14400/);
  assert.match(runner, /PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS:-21600/);
  assert.match(runner, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-5400000/);
  assert.match(runner, /--kill-after=30s/);
  assert.match(runner, /classify-run-result\.js/);
  assert.match(runner, /handoff-status/);
  assert.match(runner, /log-run\.js" release-claim/);
  assert.match(runner, /confirmation-handoff/);
  assert.match(runner, /confirmation-handoff[^\n]+--output "\$summary"/);
  assert.match(backlog, /claimRunId: env\.PROJECT_ADMIN_AGENT_RUN_ID/);
  assert.match(runLog, /claimBelongsToRun/);
});

// agentLoopRuns as the reaper sees it: one `where('status','==','running')`
// query plus per-document merge writes.
function fakeRunsDatabase(runs) {
  const writes = [];
  return {
    writes,
    collection(name) {
      if (name !== 'agentLoopRuns') throw new Error(`unexpected collection ${name}`);
      return {
        where: (field, operator, value) => ({
          get: async () => ({ docs: runs.filter((run) => run[field] === value).map((run) => ({ id: run.id, data: () => run })) }),
        }),
        doc: (id) => ({ set: async (patch) => { writes.push({ id, patch }); } }),
      };
    },
  };
}

const reapDependencies = (database, overrides = {}) => ({
  store: createFirestoreStore({ db: database, Timestamp: { fromMillis: (millis) => ({ millis }) } }),
  machineId: 'local-mac',
  now: Date.parse('2026-09-04T05:00:00Z'),
  isProcessAlive: (pid) => pid === 4242,
  ...overrides,
});

const runningRun = (extra) => ({
  id: 'run-1', status: 'running', machineId: 'local-mac', agent: 'sol', queue: 'feature', activeItem: 'FR-29',
  startedAt: new Date('2026-09-04T03:00:00Z'), heartbeatAt: new Date('2026-09-04T04:00:00Z'), runnerPid: 9191,
  ...extra,
});

test('reaps a run whose runner pid is gone, hands the item back, and freezes the duration at the last heartbeat', async () => {
  const database = fakeRunsDatabase([runningRun()]);
  const released = [];
  const result = await reapAbandonedRuns(reapDependencies(database, {
    releaseClaim: async (runId, reason) => { released.push({ runId, reason }); return { released: true, runId, itemId: 'fr-29' }; },
  }));

  assert.equal(result.reaped.length, 1);
  assert.deepEqual(
    { runId: result.reaped[0].runId, activeItem: result.reaped[0].activeItem, released: result.reaped[0].released, itemId: result.reaped[0].itemId, durationSeconds: result.reaped[0].durationSeconds },
    { runId: 'run-1', activeItem: 'FR-29', released: true, itemId: 'fr-29', durationSeconds: 3600 },
  );
  assert.match(result.reaped[0].reason, /pid 9191 is gone/);
  assert.equal(released.length, 1);
  assert.equal(database.writes.length, 1);
  assert.deepEqual(
    { status: database.writes[0].patch.status, exitCode: database.writes[0].patch.exitCode, durationSeconds: database.writes[0].patch.durationSeconds, finishedAt: database.writes[0].patch.finishedAt },
    { status: 'interrupted', exitCode: 137, durationSeconds: 3600, finishedAt: { millis: Date.parse('2026-09-04T04:00:00Z') } },
  );
});

test('a live runner pid keeps its claim no matter how long the machine slept', async () => {
  const database = fakeRunsDatabase([runningRun({ runnerPid: 4242 })]);
  const result = await reapAbandonedRuns(reapDependencies(database, { releaseClaim: async () => { throw new Error('must not release a live run'); } }));
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(database.writes, []);
});

test('a run that is still heartbeating is never reaped', async () => {
  const database = fakeRunsDatabase([runningRun({ heartbeatAt: new Date('2026-09-04T04:59:30Z') })]);
  const result = await reapAbandonedRuns(reapDependencies(database, { releaseClaim: async () => { throw new Error('must not release a live run'); } }));
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(database.writes, []);
});

test('another machine\'s runs and rows without a recorded pid are reported, not reaped', async () => {
  const database = fakeRunsDatabase([
    runningRun({ id: 'other-machine', machineId: 'macbook' }),
    runningRun({ id: 'legacy', runnerPid: undefined }),
    { id: 'finished', status: 'completed', machineId: 'local-mac', runnerPid: 9191 },
  ]);
  const result = await reapAbandonedRuns(reapDependencies(database, { releaseClaim: async () => ({ released: true }) }));
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(database.writes, []);
  assert.deepEqual(result.skipped.map((entry) => entry.runId), ['legacy']);
});

test('a dry run reports what it would reap without writing anything', async () => {
  const database = fakeRunsDatabase([runningRun()]);
  const result = await reapAbandonedRuns(reapDependencies(database, {
    dryRun: true,
    releaseClaim: async () => { throw new Error('a dry run must not release claims'); },
  }));
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.reaped.map((entry) => entry.runId), ['run-1']);
  assert.deepEqual(database.writes, []);
});

test('the runner records its pid and sweeps abandoned runs before it counts work', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'run-loop.sh'), 'utf8');
  const provisioner = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'provision-machine.sh'), 'utf8');
  assert.match(runner, /log-run\.js" start [^\n]*--pid \$\$/);
  const sweep = runner.indexOf('log-run.js" reap');
  assert.ok(sweep !== -1 && sweep < runner.indexOf('count_json="$(count_queue)"'), 'run_once must reap before it counts work');
  assert.match(provisioner, /log-run\.js" reap --machine "\$MACHINE_ID" --stale-minutes 0/);
});
