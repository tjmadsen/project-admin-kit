'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  filterDependencyEligibleCandidates,
  indexWorkItems,
  unmetDependencyIds,
} = require('../lib/dependencies');

const feature = (id, status, dependsOn = []) => ({ id, kind: 'feature', status, dependsOn });
const bug = (id, status, dependsOn = []) => ({ id, kind: 'bug', status, dependsOn });

test('candidate filtering waits for feature and bug prerequisites to complete', () => {
  const itemsById = indexWorkItems([
    feature('shipped-feature', 'shipped'),
    feature('active-feature', 'in_progress'),
    bug('closed-bug', 'closed'),
    bug('open-bug', 'open'),
  ]);
  const candidates = [
    feature('unblocked-feature', 'backlog'),
    feature('after-shipped-feature', 'backlog', ['shipped-feature']),
    feature('after-closed-bug', 'backlog', ['closed-bug']),
    feature('after-active-feature', 'backlog', ['active-feature']),
    feature('after-open-bug', 'backlog', ['open-bug']),
  ];

  assert.deepEqual(
    filterDependencyEligibleCandidates(candidates, itemsById).map((item) => item.id),
    ['unblocked-feature', 'after-shipped-feature', 'after-closed-bug'],
  );
});

test('a missing prerequisite fails closed instead of making a candidate claimable', () => {
  const candidate = bug('dependent-bug', 'open', ['missing-item']);
  const itemsById = indexWorkItems([]);

  assert.deepEqual(unmetDependencyIds(candidate, itemsById), ['missing-item']);
  assert.deepEqual(filterDependencyEligibleCandidates([candidate], itemsById), []);
});

test('declined features and wont-fix bugs do not satisfy a shipping dependency', () => {
  const itemsById = indexWorkItems([
    feature('declined-feature', 'declined'),
    bug('wont-fix-bug', 'wont_fix'),
  ]);
  const candidate = feature('dependent-feature', 'backlog', ['declined-feature', 'wont-fix-bug']);

  assert.deepEqual(unmetDependencyIds(candidate, itemsById), ['declined-feature', 'wont-fix-bug']);
});
