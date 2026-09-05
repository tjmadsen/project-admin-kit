'use strict';

function collectionForRun(run) {
  if (run.activeCollection === 'featureRequests' || run.activeCollection === 'bugs') return run.activeCollection;
  if (/^FR-/i.test(run.activeItem || '') || run.queue === 'feature') return 'featureRequests';
  if (/^BUG-/i.test(run.activeItem || '') || run.queue === 'bug') return 'bugs';
  return null;
}

function claimBelongsToRun(item, run, runId) {
  return item.claimedBy === run.agent && (!item.claimRunId || item.claimRunId === runId);
}

module.exports = { claimBelongsToRun, collectionForRun };
