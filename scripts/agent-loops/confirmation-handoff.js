'use strict';

const { collectionForRun, runItemReference } = require('./run-claims');

const CONFIRMATION_REQUEST_REASON = 'Worker requested confirmation instead of recording a lifecycle handoff';

const CONFIRMATION_PATTERNS = [
  /\b(?:please|kindly)\s+(?:re-?)?(?:confirm|approve|authorize)\b/i,
  /\b(?:can|could|would|will)\s+(?:you|the\s+(?:project\s+)?owner)\s+(?:please\s+)?(?:confirm|approve|authorize)\b/i,
  /\b(?:need|require|await(?:ing)?|wait(?:ing)?\s+for)\s+(?:(?:a|your|the|(?:project\s+)?owner['’]s|fresh|action-time)\s+)*(?:confirmation|approval|authorization|permission)\b/i,
  /\b(?:may|can)\s+i\s+(?:proceed|continue|upload|deploy|merge|execute|run|change|remove|delete)\b/i,
  /\b(?:confirmation|approval|authorization|permission)\b[^?\n]{0,100}\?/i,
];

function cleanOutput(output) {
  return String(output || '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/[\t ]+/g, ' ')
    .trim();
}

function confirmationRequestFrom(output) {
  const cleaned = cleanOutput(output);
  if (!cleaned) return null;
  const lines = cleaned.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-60);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/\b(?:no|not|without)\s+(?:additional\s+|further\s+|fresh\s+)?(?:confirmation|approval|authorization|permission)\b/i.test(line)) continue;
    if (CONFIRMATION_PATTERNS.some((pattern) => pattern.test(line))) return line.slice(0, 600);
  }
  return null;
}

function isConfirmationHandoffReason(reason) {
  return String(reason || '') === CONFIRMATION_REQUEST_REASON;
}

function canCreateConfirmationHandoff(item, run, runId, reason) {
  return isConfirmationHandoffReason(reason)
    && run.queue === 'deploy'
    && item.waitingOn === 'deployer'
    && item.claimedBy === run.agent
    && Boolean(item.claimRunId)
    && item.claimRunId === runId;
}

function confirmationHandoffMessage(output) {
  const request = confirmationRequestFrom(output) || 'The worker requested confirmation before continuing.';
  return [
    'Deploy loop confirmation handoff.',
    'Done: the worker stopped before recording a lifecycle handoff; any previously recorded target proof remains preserved.',
    `Requested confirmation: ${request}`,
    'Remaining: decide whether that named action is covered by the recorded deployment grant, then return the item to the deploy queue or revise the scope.',
    'Options: A) approve or confirm the named action in this thread; B) deny or revise it and state the allowed next step.',
  ].join(' ');
}

async function handoffConfirmationRequest(runId, rawReason, rawOutput, dependencies) {
  const { store, agentLabelFor } = dependencies;
  const run = await store.runs.get(runId);
  if (!run) throw new Error(`Loop run ${runId} not found`);
  const collection = collectionForRun(run);
  if (!run.activeItemId || !collection) {
    return { asked: false, runId, reason: 'run has no active item' };
  }

  let result = { asked: false, runId, itemId: run.activeItemId, reason: 'claim is not an active deploy claim owned by this run' };
  await store.items.transact(run.activeItemId, (item) => {
    if (!item) {
      result = { asked: false, runId, itemId: run.activeItemId, reason: 'active item no longer exists' };
      return null;
    }
    if (!canCreateConfirmationHandoff(item, run, runId, rawReason)) return null;
    result = { asked: true, runId, itemId: run.activeItemId, reference: runItemReference(run, item) };
    return {
      patch: {
        status: 'blocked',
        waitingOn: 'human',
        blockedReason: 'question',
        claimedBy: null,
        claimRunId: null,
        leaseExpiresAt: null,
        updatedAt: store.serverTimestamp(),
      },
      messages: [{
        author: agentLabelFor(run.agent),
        body: confirmationHandoffMessage(rawOutput),
        createdAt: store.now(),
      }],
    };
  });
  return result;
}

module.exports = {
  CONFIRMATION_REQUEST_REASON,
  canCreateConfirmationHandoff,
  confirmationHandoffMessage,
  confirmationRequestFrom,
  handoffConfirmationRequest,
  isConfirmationHandoffReason,
};
