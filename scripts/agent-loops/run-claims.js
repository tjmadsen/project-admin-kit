'use strict';

// Kept dependency-free at load time: run-loop.sh evaluates this module (via
// confirmation-handoff.js) from minimal checkouts.
const WORK_ITEMS_COLLECTION = 'workItems';
const LEGACY_COLLECTIONS = new Set(['featureRequests', 'bugs']);

// Every kind lives in workItems. Runs recorded before the migration may still
// name featureRequests/bugs; migrated documents keep their ids, so those runs
// resolve to workItems too.
function collectionForRun(run) {
  if (run.activeCollection === WORK_ITEMS_COLLECTION || LEGACY_COLLECTIONS.has(run.activeCollection)) return WORK_ITEMS_COLLECTION;
  if (run.activeItemId || /^[A-Z][A-Z0-9]*-\d+$/i.test(run.activeItem || '')) return WORK_ITEMS_COLLECTION;
  return null;
}

function runItemReference(run, item) {
  if (run.activeItem) return run.activeItem;
  const { itemReference, loadWorkKinds } = require('../lib/work-kinds');
  return itemReference(loadWorkKinds(), item);
}

function claimBelongsToRun(item, run, runId) {
  return item.claimedBy === run.agent && (!item.claimRunId || item.claimRunId === runId);
}

module.exports = { claimBelongsToRun, collectionForRun, runItemReference };
