'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('@google-cloud/firestore');
const { database, cli } = require('../test-support/backlog-cli');

const flags = { as: 'sol' };
const queued = (kind, extra = {}) => ({
  kind, number: 1, status: kind === 'feature' ? 'backlog' : 'open',
  waitingOn: 'agent', assignedTo: 'sol-agent', priority: 'medium', ...extra,
});

for (const kind of ['feature', 'bug']) {
  const collection = kind === 'feature' ? 'featureRequests' : 'bugs';
  test(`${kind}: future work stays queued while count and next select ready work`, async () => {
    const future = Timestamp.fromMillis(Date.now() + 60_000);
    const db = database({
      [`${collection}/later`]: queued(kind, { priority: 'critical', deferredUntil: future }),
      [`${collection}/ready`]: queued(kind),
    });
    const worker = cli(db, kind, null);
    await worker.count(flags);
    assert.equal(worker.output.at(-1).count, 1);
    await worker.claim(flags);
    assert.equal(worker.output.at(-1).id, 'ready');
    assert.equal(db.records.get(`${collection}/later`).waitingOn, 'agent');
    assert.equal(db.records.get(`${collection}/later`).claimedBy, undefined);
  });

  test(`${kind}: the deadline alone makes queued work claimable without a document update`, async () => {
    const originalNow = Date.now;
    const deadline = originalNow() + 60_000;
    const db = database({ [`${collection}/item`]: queued(kind, { deferredUntil: Timestamp.fromMillis(deadline) }) });
    const worker = cli(db, kind, null);
    try {
      Date.now = () => deadline - 1;
      await worker.count(flags);
      assert.equal(worker.output.at(-1).count, 0);
      await worker.claim(flags);
      assert.equal(worker.output.at(-1).none, true);
      Date.now = () => deadline;
      await worker.count(flags);
      assert.equal(worker.output.at(-1).count, 1);
      await worker.claim(flags);
      assert.equal(worker.output.at(-1).id, 'item');
    } finally { Date.now = originalNow; }
  });

  test(`${kind}: a deadline set after selection prevents the racing claim`, async () => {
    const key = `${collection}/item`;
    const db = database({ [key]: queued(kind) });
    db.beforeTransaction = () => db.put(key, { ...db.records.get(key), deferredUntil: Timestamp.fromMillis(Date.now() + 60_000) });
    const worker = cli(db, kind, null);
    await worker.claim(flags);
    assert.equal(worker.output.at(-1).none, true);
    assert.equal(db.records.get(key).claimedBy, undefined);
  });

  test(`${kind}: a large deferred queue cannot hide ready work behind the query cutoff`, async () => {
    const future = Timestamp.fromMillis(Date.now() + 60_000);
    const initial = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`${collection}/later-${i}`, queued(kind, { deferredUntil: future })]));
    initial[`${collection}/ready`] = queued(kind, { deferredUntil: null });
    const worker = cli(database(initial), kind, null);
    await worker.count(flags);
    assert.equal(worker.output.at(-1).count, 1);
    await worker.claim(flags);
    assert.equal(worker.output.at(-1).id, 'ready');
  });
}
