'use strict';

const { RESERVED_TARGET, loadDeployTargets } = require('./deploy-targets');

// Deploy targets come from project-admin.config.json `deployments` (see
// deploy-targets.js), resolved once per process. Order is the configured order
// with `none` last; normalized scopes follow it so labels and release matrices
// list targets consistently.
let cachedTargets = null;
function deployTargetDefinitions() {
  if (!cachedTargets) cachedTargets = loadDeployTargets();
  return cachedTargets;
}
function deployTargetIds() {
  return deployTargetDefinitions().map((target) => target.id);
}
const REQUIRED_NOTE_SECTIONS = ['Scope', 'Commands', 'Verification', 'Acceptance'];

// `allowDisabled` is for scopes already recorded on an item: disabling a target
// in config stops new selections without making existing history unreadable.
function normalizeDeploymentTargets(value, { allowDisabled = false } = {}) {
  const definitions = deployTargetDefinitions();
  const byId = new Map(definitions.map((target) => [target.id, target]));
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const normalized = [...new Set(raw.map((target) => String(target).trim()).filter(Boolean))];
  for (const target of normalized) {
    const definition = byId.get(target);
    if (!definition) {
      throw new Error(`Invalid deployment target "${target}". One of: ${definitions.filter((entry) => entry.enabled).map((entry) => entry.id).join(', ')}`);
    }
    if (!definition.enabled && !allowDisabled) {
      throw new Error(`Deployment target "${target}" is disabled in project-admin.config.json deployments.targets`);
    }
  }
  if (normalized.includes(RESERVED_TARGET) && normalized.length > 1) {
    throw new Error('Deployment target "none" cannot be combined with another target');
  }
  return definitions.map((target) => target.id).filter((target) => normalized.includes(target));
}

// Targets whose definition sets `requiresHumanAcceptance` (TestFlight by
// default): the deploy loop records their proof but never closes the item.
function targetsRequiringHumanAcceptance(targets) {
  const definitions = new Map(deployTargetDefinitions().map((target) => [target.id, target]));
  return targets.filter((target) => definitions.get(target)?.requiresHumanAcceptance);
}

function deployTargetLabel(target) {
  return deployTargetDefinitions().find((entry) => entry.id === target)?.label || target;
}

function deploymentTargetsFor(item, approved = false) {
  const approvedTargets = approved ? item?.deploymentApprovedTargets : null;
  const recorded = { allowDisabled: true };
  if (Array.isArray(approvedTargets) && approvedTargets.length > 0) return normalizeDeploymentTargets(approvedTargets, recorded);
  if (Array.isArray(item?.deploymentTargets) && item.deploymentTargets.length > 0) return normalizeDeploymentTargets(item.deploymentTargets, recorded);
  const legacy = item?.deploymentType;
  if (legacy && legacy !== 'mixed') return normalizeDeploymentTargets([legacy], recorded);
  return [];
}

function legacyDeploymentType(targets) {
  const normalized = normalizeDeploymentTargets(targets, { allowDisabled: true });
  if (normalized.length === 0) return 'none';
  return normalized.length === 1 ? normalized[0] : 'mixed';
}

function validateDeploymentNotes(notes) {
  const value = typeof notes === 'string' ? notes.trim() : '';
  if (value.length < 80) {
    throw new Error('Deployment notes must be at least 80 characters and include scope, commands, verification, and acceptance');
  }
  const missing = REQUIRED_NOTE_SECTIONS.filter((section) => !new RegExp(`(^|\\n)${section}:\\s*\\S`, 'i').test(value));
  if (missing.length > 0) throw new Error(`Deployment notes are missing: ${missing.map((section) => `${section}:`).join(', ')}`);
  return value;
}

function missingDeploymentEvidence(item, targets = deploymentTargetsFor(item, true)) {
  const evidence = item?.deploymentEvidence && typeof item.deploymentEvidence === 'object' ? item.deploymentEvidence : {};
  return targets.filter((target) => {
    const entry = evidence[target];
    return !entry || typeof entry.proof !== 'string' || entry.proof.trim().length < 20
      || typeof entry.acceptance !== 'string' || entry.acceptance.trim().length < 20;
  });
}

function resetDeploymentForPrChange(item, nextPr) {
  const hasPrIdentity = Boolean(item?.prNumber || item?.prUrl || item?.branchName);
  const identityChanged = hasPrIdentity && (
    Number(item?.prNumber || 0) !== Number(nextPr.prNumber || 0)
    || String(item?.prUrl || '') !== String(nextPr.prUrl || '')
    || String(item?.branchName || '') !== String(nextPr.branchName || '')
  );
  const hasDeploymentState = Boolean(
    item?.deploymentNotes
    || item?.deploymentApprovedAt
    || item?.deploymentApprovedNotes
    || item?.deploymentTargets?.length
    || item?.deploymentApprovedTargets?.length
  );
  if (!identityChanged || !hasDeploymentState) return {};
  return {
    deploymentNotes: '',
    deploymentNotesPrNumber: null,
    deploymentNotesPrUrl: '',
    deploymentNotesBranchName: '',
    deploymentApprovedAt: null,
    deploymentApprovedBy: null,
    deploymentApprovedTargets: [],
    deploymentApprovedNotes: '',
    deploymentEvidence: {},
    deploymentResult: '',
    deploymentBuild: '',
    deploymentVerifiedAt: null,
  };
}

const TERMINAL_STATUSES = new Set(['shipped', 'declined', 'closed', 'wont_fix']);

function pendingDeploymentScope(item) {
  const approved = deploymentTargetsFor(item, true).filter((target) => target !== 'none');
  if (item?.deploymentApprovedAt && approved.length > 0) return approved;
  return [];
}

function assertClosableWithoutDeployment(item) {
  if (!item || typeof item !== 'object') throw new Error('Work item is required');
  if (TERMINAL_STATUSES.has(item.status)) throw new Error(`Item is already ${item.status}; reopen it before closing again`);
  const approved = pendingDeploymentScope(item);
  if (approved.length > 0) {
    throw new Error(`Cannot close without deployment; an administrator approved a release for: ${approved.join(', ')}. Use the deploy loop or ask an administrator to withdraw the approval`);
  }
  if (item.waitingOn === 'deployer') throw new Error('Cannot close without deployment while the item is queued for the deploy loop');
  if (item.deploymentInProgressTarget) throw new Error(`Cannot close without deployment while ${item.deploymentInProgressTarget} is being released`);
  const planned = deploymentTargetsFor(item, false).filter((target) => target !== 'none');
  if (planned.length > 0) {
    throw new Error(`Cannot close without deployment; the item still lists release targets: ${planned.join(', ')}. Clear them (or set --targets none) first`);
  }
  return true;
}

module.exports = {
  assertClosableWithoutDeployment,
  deployTargetDefinitions,
  deployTargetIds,
  deployTargetLabel,
  REQUIRED_NOTE_SECTIONS,
  deploymentTargetsFor,
  legacyDeploymentType,
  missingDeploymentEvidence,
  normalizeDeploymentTargets,
  resetDeploymentForPrChange,
  targetsRequiringHumanAcceptance,
  validateDeploymentNotes,
};
// Kept for callers of the old constant; now the configured target ids.
Object.defineProperty(module.exports, 'DEPLOY_TARGETS', { enumerable: true, get: deployTargetIds });
