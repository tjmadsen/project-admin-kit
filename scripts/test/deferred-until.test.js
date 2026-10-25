'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('@google-cloud/firestore');
const { createBacklogAgent } = require('../lib/backlog-agent');
const { loadProjectConfig } = require('../lib/project-config');
const { resolveWorkKinds } = require('../lib/work-kinds');
const { FieldValue, createFakeFirestore } = require('./support/fake-firestore');

// Runs the real CLI selection and claim paths against the optimistic fake:
// transactions retry when any document they read changed meanwhile.
const config = loadProjectConfig();
const kinds = resolveWorkKinds({ feature: {}, bug: {} });

function setup(kind) {
  const db = createFakeFirestore();
  const outputs = [];
  const run = async (...argv) => {
    await createBacklogAgent({
      db, FieldValue, Timestamp, config, kinds, kindId: kind,
      env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac' },
      uploadAttachments: async () => [],
      log: (line) => outputs.push(JSON.parse(line)),
    }).run(argv);
    return outputs.at(-1);
  };
  const queued = (id, extra = {}) => db.seed(`workItems/${id}`, {
    kind, number: 1, status: kind === 'feature' ? 'backlog' : 'open', waitingOn: 'agent',
    assignedTo: 'sol-agent', priority: 'medium', targetMachine: 'local-mac', messages: [], ...extra,
  });
  return { db, run, queued };
}

for (const kind of ['feature', 'bug']) {
  test(`${kind}: future work stays queued while count and next select ready work`, async () => {
    const { db, run, queued } = setup(kind);
    queued('later', { priority: 'critical', deferredUntil: Timestamp.fromMillis(Date.now() + 60_000) });
    queued('ready');
    assert.equal((await run('count', '--as', 'sol')).count, 1);
    assert.equal((await run('next', '--as', 'sol')).id, 'ready');
    assert.equal(db.read('workItems/later').waitingOn, 'agent');
    assert.equal(db.read('workItems/later').claimedBy, undefined);
  });

  test(`${kind}: the deadline alone makes queued work claimable without a document update`, async () => {
    const { run, queued } = setup(kind);
    const originalNow = Date.now;
    const deadline = originalNow() + 60_000;
    queued('item', { deferredUntil: Timestamp.fromMillis(deadline) });
    try {
      Date.now = () => deadline - 1;
      assert.equal((await run('count', '--as', 'sol')).count, 0);
      assert.deepEqual(await run('next', '--as', 'sol'), { none: true });
      Date.now = () => deadline;
      assert.equal((await run('count', '--as', 'sol')).count, 1);
      assert.equal((await run('next', '--as', 'sol')).id, 'item');
    } finally { Date.now = originalNow; }
  });

  test(`${kind}: a deadline set after selection prevents the racing claim`, async () => {
    const { db, run, queued } = setup(kind);
    queued('item');
    // A human defers the item between candidate selection and the claim
    // transaction; the transaction re-reads it and must refuse.
    const runTransaction = db.runTransaction;
    db.runTransaction = async (...args) => {
      db.runTransaction = runTransaction;
      db.seed('workItems/item', { ...db.read('workItems/item'), deferredUntil: Timestamp.fromMillis(Date.now() + 60_000) });
      return runTransaction(...args);
    };
    assert.deepEqual(await run('next', '--as', 'sol'), { none: true });
    assert.equal(db.read('workItems/item').claimedBy, undefined);
  });

  test(`${kind}: a large deferred queue cannot hide ready work behind the query cutoff`, async () => {
    const { run, queued } = setup(kind);
    const future = Timestamp.fromMillis(Date.now() + 60_000);
    for (let i = 0; i < 250; i += 1) queued(`later-${i}`, { deferredUntil: future });
    queued('ready', { deferredUntil: null });
    assert.equal((await run('count', '--as', 'sol')).count, 1);
    assert.equal((await run('next', '--as', 'sol')).id, 'ready');
  });
}
