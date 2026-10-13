'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Timestamp } = require('@google-cloud/firestore');
const { migrateWorkItems } = require('../migrate-work-items');
const { resolveWorkKinds } = require('../lib/work-kinds');
const { FieldValue, createFakeFirestore } = require('./support/fake-firestore');

const kinds = resolveWorkKinds(undefined);

function legacyDatabase() {
  const db = createFakeFirestore();
  const createdAt = Timestamp.fromMillis(1_700_000_000_000);
  db.seed('featureRequests/fr-a', { kind: 'feature', number: 1, title: 'Feature A', status: 'shipped', createdAt, messages: [{ body: 'hi' }] });
  db.seed('featureRequests/fr-b', { number: 2, title: 'Feature B without kind', status: 'backlog', dependsOn: ['bug-a'] });
  db.seed('bugs/bug-a', { kind: 'bug', number: 1, title: 'Bug A', status: 'open' });
  db.seed('bugs/clash', { kind: 'bug', number: 2, title: 'Bug sharing an id', status: 'open' });
  db.seed('workItems/clash', { kind: 'task', number: 1, title: 'Newer task' });
  return db;
}

test('a dry run reports the copy plan without writing', async () => {
  const db = legacyDatabase();
  const before = db.paths();
  const report = await migrateWorkItems({ db, FieldValue, kinds });
  assert.equal(report.apply, false);
  assert.deepEqual(report.copied.map((entry) => entry.id), ['fr-a', 'fr-b', 'bug-a']);
  assert.deepEqual(report.conflicts.map((entry) => entry.id), ['clash']);
  assert.deepEqual(db.paths(), before);
});

test('--apply copies documents with their ids, kind, and data, and is idempotent', async () => {
  const db = legacyDatabase();
  const first = await migrateWorkItems({ db, FieldValue, kinds, apply: true });
  assert.equal(first.copied.length, 3);
  const feature = db.read('workItems/fr-a');
  assert.equal(feature.kind, 'feature');
  assert.equal(feature.migratedFrom, 'featureRequests');
  assert.equal(feature.createdAt.toMillis(), 1_700_000_000_000, 'timestamps survive the copy');
  assert.deepEqual(feature.messages, [{ body: 'hi' }]);
  assert.equal(db.read('workItems/fr-b').kind, 'feature', 'documents without a kind get one from their collection');
  assert.deepEqual(db.read('workItems/fr-b').dependsOn, ['bug-a'], 'dependency ids still resolve in workItems');
  assert.equal(db.read('workItems/bug-a').kind, 'bug');
  assert.equal(db.read('workItems/clash').kind, 'task', 'an existing document is never overwritten');
  assert.ok(db.read('featureRequests/fr-a'), 'legacy collections are left for rollback');

  const second = await migrateWorkItems({ db, FieldValue, kinds, apply: true });
  assert.equal(second.copied.length, 0);
  assert.equal(second.alreadyMigrated.length, 3);
  assert.equal(second.conflicts.length, 1);
});

test('legacy documents of an unconfigured kind are skipped, not invented', async () => {
  const db = legacyDatabase();
  const report = await migrateWorkItems({ db, FieldValue, kinds: resolveWorkKinds({ feature: {} }), apply: true });
  assert.deepEqual(report.skipped.map((entry) => entry.id), ['bug-a', 'clash']);
  assert.equal(db.read('workItems/bug-a'), undefined);
});
