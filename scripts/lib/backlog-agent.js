#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { FieldValue, Timestamp } = require('@google-cloud/firestore');
const db = require('./firestore');
const { resolveAgent } = require('./agents');
const { uploadAttachments } = require('./attachments');
const {
  assertClosableWithoutDeployment,
  deploymentTargetsFor,
  legacyDeploymentType,
  missingDeploymentEvidence,
  normalizeDeploymentTargets,
  resetDeploymentForPrChange,
  validateDeploymentNotes,
} = require('./deployment-contract');
const {
  dependencyIds,
  filterDependencyEligibleCandidates,
  indexWorkItems,
  unmetDependencyIds,
} = require('./dependencies');
const { loadProjectConfig } = require('./project-config');

const config = loadProjectConfig();
const kind = process.env.PROJECT_ADMIN_WORK_KIND;
if (kind !== 'feature' && kind !== 'bug') throw new Error('PROJECT_ADMIN_WORK_KIND must be feature or bug');

const COLLECTION = kind === 'feature' ? 'featureRequests' : 'bugs';
const COUNTER_FIELD = kind === 'feature' ? 'nextFeatureNumber' : 'nextBugNumber';
const NUMBER_LABEL = kind === 'feature' ? 'FR' : 'BUG';
const MACHINE_ID = process.env.PROJECT_ADMIN_MACHINE_ID || config.automation.defaultMachineId;
const OWNER_NAME = config.admin.ownerName;
const ACTIVE = kind === 'feature'
  ? ['backlog', 'in_progress', 'blocked', 'in_review', 'ready_for_deploy']
  : ['open', 'investigating', 'plan_review', 'in_progress', 'blocked', 'in_review', 'ready_for_deploy'];
const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };
const REVIEW_GATES = new Set(['triage', 'question', 'plan_review', 'pr_review', 'deploy_approval', 'acceptance_review']);

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === '-m') { flags.message = argv[++i]; continue; }
    if (part.startsWith('--')) {
      const name = part.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true;
      flags[name] = value;
    } else positionals.push(part);
  }
  return { command: positionals[0], id: positionals[1], flags };
}

function json(value) {
  console.log(JSON.stringify(value, (_key, current) => {
    if (current && typeof current.toDate === 'function') return current.toDate().toISOString();
    return current;
  }, 2));
}

function isLeaseOpen(data) {
  const millis = data.leaseExpiresAt?.toMillis?.() ?? 0;
  return !data.claimedBy || millis <= Date.now();
}
function isDeferred(data) { return (data.deferredUntil?.toMillis?.() ?? 0) > Date.now(); }
function ownedBy(agent, data) { return data.assignedTo === agent.owner || (agent.claimsUnassigned && !data.assignedTo); }
function machineEligible(data) { return !data.targetMachine || data.targetMachine === 'any' || data.targetMachine === MACHINE_ID; }
function sortItems(a, b) {
  return (PRIORITY[a.priority] ?? 2) - (PRIORITY[b.priority] ?? 2)
    || (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
}
function itemReference(data) { return `${NUMBER_LABEL}-${data.number ?? '?'}`; }
function requireFlag(flags, name) {
  const value = flags[name];
  if (!value || value === true) throw new Error(`Missing --${name} <value>`);
  return value;
}
function requireMessage(flags) {
  if (!flags.message || flags.message === true) throw new Error('Missing -m "message"');
  return flags.message;
}
function requireDeployTargets(flags) {
  const raw = flags.targets || flags.type;
  if (!raw || raw === true) throw new Error('Missing --targets <comma-separated-targets>');
  if (raw === 'mixed') throw new Error('Replace legacy --type mixed with explicit --targets target_one,target_two');
  const targets = normalizeDeploymentTargets(raw);
  if (targets.length === 0) throw new Error('At least one deployment target is required; use --targets none for verification-only work');
  return targets;
}
function requireDeploymentNotes(flags) {
  if (!flags.notes || flags.notes === true) throw new Error('Missing --notes "Scope: ...\\nCommands: ...\\nVerification: ...\\nAcceptance: ..."');
  return validateDeploymentNotes(flags.notes);
}
function requireMeaningfulFlag(flags, name) {
  const value = requireFlag(flags, name).trim();
  if (value.length < 20) throw new Error(`--${name} must contain at least 20 characters of concrete evidence`);
  return value;
}
function agentFrom(flags) { return resolveAgent(requireFlag(flags, 'as')); }
function message(author, body, imageUrls = []) {
  const entry = { author, body, createdAt: Timestamp.now() };
  if (imageUrls.length > 0) entry.imageUrls = imageUrls;
  return entry;
}

function dependencyDocumentRefs(items) {
  const ids = [...new Set(items.flatMap(dependencyIds))];
  return ids.flatMap((id) => [
    db.collection('featureRequests').doc(id),
    db.collection('bugs').doc(id),
  ]);
}

function workItemsFromSnapshots(snapshots) {
  return snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
}

async function dependencyIndexFor(items) {
  const refs = dependencyDocumentRefs(items);
  if (refs.length === 0) return new Map();
  return indexWorkItems(workItemsFromSnapshots(await db.getAll(...refs)));
}

async function dependenciesSatisfiedInTransaction(transaction, item) {
  const refs = dependencyDocumentRefs([item]);
  if (refs.length === 0) return true;
  const itemsById = indexWorkItems(workItemsFromSnapshots(await transaction.getAll(...refs)));
  return unmetDependencyIds(item, itemsById).length === 0;
}

async function attachRun(item, data) {
  const runId = process.env.PROJECT_ADMIN_AGENT_RUN_ID;
  if (!runId) return;
  await db.collection('agentLoopRuns').doc(runId).set({
    activeItem: itemReference(data), activeItemId: item.id,
    activeCollection: COLLECTION,
    heartbeatAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function create(flags) {
  const agent = agentFrom(flags);
  const title = requireFlag(flags, 'title');
  const description = requireFlag(flags, 'description');
  const ref = db.collection(COLLECTION).doc();
  const number = await db.runTransaction(async (transaction) => {
    const counterRef = db.collection('system').doc('counters');
    const counter = await transaction.get(counterRef);
    const nextNumber = Number(counter.data()?.[COUNTER_FIELD] ?? 0) + 1;
    transaction.set(counterRef, { [COUNTER_FIELD]: nextNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(ref, {
      kind, number: nextNumber, title, description,
      priority: flags.priority || 'medium', status: kind === 'feature' ? 'backlog' : 'open',
      waitingOn: flags.waiting || 'agent', assignedTo: flags.owner ? resolveAgent(flags.owner).owner : resolveAgent(config.automation.defaultWorkAgent).owner,
      blockedReason: flags.waiting === 'human' ? 'triage' : null,
      thinkingEffort: flags.effort || 'xhigh', targetMachine: flags.machine || MACHINE_ID,
      deploymentTargets: [], deploymentType: 'none',
      messages: [message(agent.label, `Created ${NUMBER_LABEL}-${nextNumber}.`)],
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    return nextNumber;
  });
  json({ id: ref.id, number, ref: `${NUMBER_LABEL}-${number}` });
}

async function candidatesFor(agent, waitingOn = 'agent') {
  const query = db.collection(COLLECTION).where('waitingOn', '==', waitingOn);
  // Deferred items must not hide ready work beyond an arbitrary query cutoff.
  const snapshot = await (waitingOn === 'agent' ? query : query.limit(250)).get();
  const candidates = snapshot.docs.map((document) => ({ id: document.id, documentRef: document.ref, ...document.data() }))
    .filter((data) => ACTIVE.includes(data.status))
    .filter((data) => waitingOn === 'deployer' || ownedBy(agent, data))
    .filter((data) => waitingOn !== 'deployer' || data.deploymentApprovedAt)
    .filter((data) => waitingOn !== 'agent' || !isDeferred(data))
    .filter(machineEligible).filter(isLeaseOpen);
  const itemsById = await dependencyIndexFor(candidates);
  return filterDependencyEligibleCandidates(candidates, itemsById).sort(sortItems);
}

async function claim(flags, deploy = false) {
  const agent = agentFrom(flags);
  const waitingOn = deploy ? 'deployer' : 'agent';
  const candidates = await candidatesFor(agent, waitingOn);
  for (const candidate of candidates) {
    const claimed = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(candidate.documentRef);
      if (!snapshot.exists) return null;
      const data = snapshot.data();
      if (data.waitingOn !== waitingOn || !ACTIVE.includes(data.status) || !isLeaseOpen(data)) return null;
      if (!deploy && isDeferred(data)) return null;
      if (deploy && !data.deploymentApprovedAt) return null;
      if (!deploy && (!ownedBy(agent, data) || !machineEligible(data))) return null;
      if (!await dependenciesSatisfiedInTransaction(transaction, data)) return null;
      transaction.update(candidate.documentRef, {
        claimedBy: agent.token, leaseExpiresAt: Timestamp.fromMillis(Date.now() + 4 * 60 * 60 * 1000),
        claimRunId: process.env.PROJECT_ADMIN_AGENT_RUN_ID || null,
        status: deploy ? 'ready_for_deploy' : 'in_progress', blockedReason: null, updatedAt: FieldValue.serverTimestamp(),
      });
      return { id: candidate.id, ...data, approvedGate: deploy ? null : (data.blockedReason || null), blockedReason: null, claimedBy: agent.token };
    });
    if (claimed) { await attachRun(claimed, claimed); json(claimed); return; }
  }
  json({ none: true });
}

async function count(flags, deploy = false) {
  const agent = agentFrom(flags);
  const candidates = await candidatesFor(agent, deploy ? 'deployer' : 'agent');
  json({ count: candidates.length, topThinkingEffort: candidates[0]?.thinkingEffort || 'xhigh' });
}
async function list(flags) {
  const snapshot = await db.collection(COLLECTION).limit(300).get();
  const rows = snapshot.docs.map((document) => ({ id: document.id, ...document.data() }))
    .filter((data) => flags.all === true || ACTIVE.includes(data.status)).sort(sortItems);
  json(rows);
}
async function show(id) {
  if (!id) throw new Error('Missing item id');
  const snapshot = await db.collection(COLLECTION).doc(id).get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  json({ id: snapshot.id, ...snapshot.data() });
}
async function mutate(id, flags, changes, body) {
  if (!id) throw new Error('Missing item id');
  const agent = agentFrom(flags);
  const ref = db.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  const resolvedChanges = typeof changes === 'function' ? changes(snapshot.data()) : changes;
  const patch = { ...resolvedChanges, claimedBy: null, claimRunId: null, leaseExpiresAt: null, updatedAt: FieldValue.serverTimestamp() };
  const imageUrls = await uploadAttachments(flags.images, { uploader: `agent-${agent.token}`, kind, itemId: id });
  if (imageUrls.length > 0 && !body) throw new Error('--images requires -m "message" so the attachments belong to a note');
  if (body) patch.messages = FieldValue.arrayUnion(message(agent.label, body, imageUrls));
  await ref.update(patch);
  json({ ok: true, id, ref: itemReference(snapshot.data()), ...resolvedChanges, ...(imageUrls.length ? { imageUrls } : {}) });
}

function requireApprovedTarget(data, target) {
  if (!data.deploymentApprovedAt) throw new Error(`Deployment has not been approved by ${OWNER_NAME}`);
  const targets = deploymentTargetsFor(data, true);
  if (targets.length === 0) throw new Error(`Approved deployment scope has no explicit targets; return it to ${OWNER_NAME} to itemize the release`);
  if (!targets.includes(target)) throw new Error(`Target "${target}" is outside the approved deployment scope: ${targets.join(', ')}`);
  return targets;
}

function requireDeployClaim(data, agent) {
  if (data.claimedBy !== agent.token) {
    throw new Error(`Deployment item must be claimed by ${agent.token} before recording evidence or completion`);
  }
}

async function recordDeploymentCheck(id, flags) {
  if (!id) throw new Error('Missing item id');
  const agent = agentFrom(flags);
  const target = requireFlag(flags, 'target');
  normalizeDeploymentTargets([target]);
  const proof = requireMeaningfulFlag(flags, 'proof');
  const acceptance = requireMeaningfulFlag(flags, 'acceptance');
  const ref = db.collection(COLLECTION).doc(id);
  const result = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) throw new Error(`${id} not found`);
    const data = snapshot.data();
    requireDeployClaim(data, agent);
    const targets = requireApprovedTarget(data, target);
    const evidence = {
      ...(data.deploymentEvidence || {}),
      [target]: { proof, acceptance, verifiedAt: Timestamp.now(), verifiedBy: agent.token },
    };
    transaction.update(ref, {
      deploymentEvidence: evidence,
      deploymentResult: `${target}: ${proof}\nAcceptance: ${acceptance}`,
      deploymentInProgressTarget: null,
      messages: FieldValue.arrayUnion(message(agent.label, `Verified ${target}. ${proof} Acceptance: ${acceptance}`)),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { ref: itemReference(data), targets, evidence };
  });
  json({ ok: true, id, ...result });
}

async function markDeploymentStarted(id, flags) {
  if (!id) throw new Error('Missing item id');
  const target = requireFlag(flags, 'target');
  const body = requireMessage(flags);
  const agent = agentFrom(flags);
  const ref = db.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  const data = snapshot.data();
  requireDeployClaim(data, agent);
  requireApprovedTarget(data, target);
  if (target !== 'testflight') throw new Error('deployment-started is reserved for detached TestFlight processing');
  await ref.update({
    status: 'ready_for_deploy', waitingOn: 'hold', blockedReason: null,
    deploymentInProgressTarget: target, deploymentStartedAt: FieldValue.serverTimestamp(),
    claimedBy: null, claimRunId: null, leaseExpiresAt: null,
    messages: FieldValue.arrayUnion(message(agent.label, body)), updatedAt: FieldValue.serverTimestamp(),
  });
  json({ ok: true, id, ref: itemReference(data), target, waitingOn: 'hold' });
}

async function markVerificationPending(id, flags) {
  if (!id) throw new Error('Missing item id');
  const result = requireMessage(flags);
  const agent = agentFrom(flags);
  const ref = db.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  const data = snapshot.data();
  requireApprovedTarget(data, 'testflight');
  const evidence = {
    ...(data.deploymentEvidence || {}),
    testflight: {
      proof: result,
      acceptance: `The build is available for ${OWNER_NAME} to test against the work-item acceptance context.`,
      verifiedAt: Timestamp.now(),
      verifiedBy: agent.token,
    },
  };
  await ref.update({
    status: 'in_review', waitingOn: 'human', blockedReason: 'acceptance_review',
    deployedAt: FieldValue.serverTimestamp(), deploymentVerifiedAt: FieldValue.serverTimestamp(),
    deploymentBuild: flags.build || '', deploymentResult: result, deploymentEvidence: evidence,
    deploymentInProgressTarget: null, claimedBy: null, claimRunId: null, leaseExpiresAt: null,
    messages: FieldValue.arrayUnion(message(agent.label, result)), updatedAt: FieldValue.serverTimestamp(),
  });
  json({ ok: true, id, ref: itemReference(data), target: 'testflight', status: 'in_review' });
}

async function completeItem(id, flags) {
  if (!id) throw new Error('Missing item id');
  const result = requireMessage(flags);
  const agent = agentFrom(flags);
  const ref = db.collection(COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  const data = snapshot.data();
  requireDeployClaim(data, agent);
  if (!data.deploymentApprovedAt) throw new Error(`Cannot complete an item before ${OWNER_NAME} approves its deployment scope`);
  const targets = deploymentTargetsFor(data, true);
  if (targets.length === 0) throw new Error('Cannot complete an item with an ambiguous or empty approved deployment scope');
  if (targets.includes('testflight')) throw new Error(`TestFlight items require ${OWNER_NAME} hands-on acceptance and cannot be closed by the deploy loop`);
  const missing = missingDeploymentEvidence(data, targets);
  if (missing.length > 0) throw new Error(`Cannot complete deployment; missing target-specific proof and acceptance verification for: ${missing.join(', ')}`);
  if (kind === 'feature') {
    return mutate(id, flags, {
      status: 'shipped', waitingOn: 'done', blockedReason: null,
      shippedAt: FieldValue.serverTimestamp(), deployedAt: FieldValue.serverTimestamp(),
      deploymentVerifiedAt: FieldValue.serverTimestamp(), deploymentResult: result, resolution: result,
    }, result);
  }
  return mutate(id, flags, {
    status: 'closed', waitingOn: 'done', blockedReason: null,
    resolvedAt: FieldValue.serverTimestamp(), deployedAt: FieldValue.serverTimestamp(),
    deploymentVerifiedAt: FieldValue.serverTimestamp(), deploymentResult: result, resolution: result,
  }, result);
}
async function closeWithoutDeployment(id, flags) {
  if (!id) throw new Error('Missing item id');
  const note = requireMessage(flags).trim();
  if (note.length < 20) throw new Error('-m must contain at least 20 characters explaining how the item was completed without a release');
  agentFrom(flags);
  const snapshot = await db.collection(COLLECTION).doc(id).get();
  if (!snapshot.exists) throw new Error(`${id} not found`);
  assertClosableWithoutDeployment(snapshot.data());
  const body = `Closed without deployment: ${note}`;
  const completion = kind === 'feature'
    ? { status: 'shipped', shippedAt: FieldValue.serverTimestamp() }
    : { status: 'closed', resolvedAt: FieldValue.serverTimestamp() };
  return mutate(id, flags, { ...completion, waitingOn: 'done', blockedReason: null, resolution: note }, body);
}
async function setFields(id, flags) {
  const changes = {};
  if (flags.status) changes.status = flags.status;
  if (flags.waiting) changes.waitingOn = flags.waiting;
  if (flags.owner) changes.assignedTo = flags.owner === 'none' ? '' : resolveAgent(flags.owner).owner;
  if (flags.priority) changes.priority = flags.priority;
  if (flags.effort) changes.thinkingEffort = flags.effort;
  if (flags.machine) changes.targetMachine = flags.machine;
  if (flags.gate) {
    if (flags.gate !== 'none' && !REVIEW_GATES.has(flags.gate)) throw new Error(`Invalid --gate "${flags.gate}"`);
    changes.blockedReason = flags.gate === 'none' ? null : flags.gate;
  }
  if (Object.keys(changes).length === 0) throw new Error('No update flags supplied');
  await mutate(id, flags, changes, flags.message === true ? undefined : flags.message);
}

async function main() {
  const { command, id, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'create': return create(flags);
    case 'list': return list(flags);
    case 'show': return show(id);
    case 'count': return count(flags, false);
    case 'deploy-count': return count(flags, true);
    case 'next': return claim(flags, false);
    case 'deploy-next': return claim(flags, true);
    case 'reply': case 'note': return mutate(id, flags, {}, requireMessage(flags));
    case 'ask': return mutate(id, flags, { status: 'blocked', waitingOn: 'human', blockedReason: 'question' }, requireMessage(flags));
    case 'plan': return mutate(id, flags, { status: 'plan_review', waitingOn: 'human', blockedReason: 'plan_review' }, requireMessage(flags));
    case 'pr': {
      const nextPr = {
        prUrl: requireFlag(flags, 'url'),
        prNumber: Number(requireFlag(flags, 'number')),
        branchName: requireFlag(flags, 'branch'),
      };
      return mutate(id, flags, (data) => ({
        ...resetDeploymentForPrChange(data, nextPr),
        status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', ...nextPr,
      }), requireMessage(flags));
    }
    case 'deploy-pending': {
      const targets = requireDeployTargets(flags);
      const deploymentNotes = requireDeploymentNotes(flags);
      return mutate(id, flags, (data) => ({
        status: 'ready_for_deploy', waitingOn: 'human', blockedReason: 'deploy_approval',
        deploymentTargets: targets, deploymentType: legacyDeploymentType(targets), deploymentNotes,
        deploymentNotesPrNumber: data.prNumber || null,
        deploymentNotesPrUrl: data.prUrl || '',
        deploymentNotesBranchName: data.branchName || '',
        deploymentApprovedAt: null, deploymentApprovedBy: null, deploymentApprovedTargets: [], deploymentApprovedNotes: '',
        deploymentEvidence: {}, deploymentResult: '', deploymentBuild: '', deploymentVerifiedAt: null,
      }), requireMessage(flags));
    }
    case 'deploy-check': return recordDeploymentCheck(id, flags);
    case 'deployment-started': return markDeploymentStarted(id, flags);
    case 'verification-pending': return markVerificationPending(id, flags);
    case 'ship':
      if (kind !== 'feature') throw new Error('Use resolve for bugs');
      return completeItem(id, flags);
    case 'resolve':
      if (kind !== 'bug') throw new Error('Use ship for feature requests');
      return completeItem(id, flags);
    case 'close-no-deploy': return closeWithoutDeployment(id, flags);
    case 'decline': return mutate(id, flags, { status: kind === 'feature' ? 'declined' : 'wont_fix', waitingOn: 'done', blockedReason: null, resolution: requireMessage(flags) }, requireMessage(flags));
    case 'set': return setFields(id, flags);
    default: throw new Error(`Usage: ${kind}-agent.js <create|list|show|count|next|reply|ask|plan|pr|deploy-pending|deploy-next|deploy-check|deployment-started|verification-pending|ship|resolve|close-no-deploy|decline|set> [id] --as <sol|terra|luna|opus|sonnet|fable|grok> [-m "note"] [--images a.png,b.png]`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, kind, host: os.hostname() }));
  process.exitCode = 1;
});
