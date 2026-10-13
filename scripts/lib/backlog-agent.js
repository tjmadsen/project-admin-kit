#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { resolveAgent } = require('./agents');
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
const { createFirestoreStore } = require('./store/firestore-store');
const { WORK_ITEMS_COLLECTION, itemReference, loadWorkKinds, requireKind } = require('./work-kinds');

const PRIORITY = { critical: 0, high: 1, medium: 2, low: 3 };

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

function isLeaseOpen(data) {
  const millis = data.leaseExpiresAt?.toMillis?.() ?? 0;
  return !data.claimedBy || millis <= Date.now();
}
function ownedBy(agent, data) { return data.assignedTo === agent.owner || (agent.claimsUnassigned && !data.assignedTo); }
function sortItems(a, b) {
  return (PRIORITY[a.priority] ?? 2) - (PRIORITY[b.priority] ?? 2)
    || (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
}
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

// Builds the backlog CLI around an injected BacklogStore (lib/store) so tests
// drive every command against any backend. Passing `db`/`FieldValue`/`Timestamp`
// instead wraps that Firestore (real or fake) in the Firestore store.
// `kindId` scopes the CLI to one kind (the feature/bug shims, --kind, or
// PROJECT_ADMIN_WORK_KIND); without it, item-scoped commands use the kind
// recorded on the document.
function createBacklogAgent({
  store = null,
  db,
  FieldValue,
  Timestamp,
  config = loadProjectConfig(),
  kinds = loadWorkKinds(config),
  kindId = null,
  env = process.env,
  uploadAttachments = null,
  log = (line) => console.log(line),
}) {
  const scopedKind = kindId ? requireKind(kinds, kindId) : null;
  store ||= createFirestoreStore({ db, FieldValue, Timestamp });
  const upload = uploadAttachments || ((paths, target) => store.attachments.upload(paths, target));
  const MACHINE_ID = env.PROJECT_ADMIN_MACHINE_ID || config.automation.defaultMachineId;
  const OWNER_NAME = config.admin.ownerName;
  const serverTimestamp = () => store.serverTimestamp();

  function json(value) {
    log(JSON.stringify(value, (_key, current) => {
      if (current && typeof current.toDate === 'function') return current.toDate().toISOString();
      return current;
    }, 2));
  }
  function machineEligible(data) { return !data.targetMachine || data.targetMachine === 'any' || data.targetMachine === MACHINE_ID; }
  function message(author, body, imageUrls = []) {
    const entry = { author, body, createdAt: store.now() };
    if (imageUrls.length > 0) entry.imageUrls = imageUrls;
    return entry;
  }
  function requireScopedKind(command) {
    if (!scopedKind) throw new Error(`${command} needs --kind <${kinds.map((kind) => kind.id).join('|')}>`);
    return scopedKind;
  }
  // Resolves an item's kind and refuses cross-kind access from a scoped CLI, so
  // feature-agent.js can never mutate a bug (the old per-collection boundary).
  function kindOf(id, data) {
    if (scopedKind && data.kind !== scopedKind.id) {
      throw new Error(`${id} is a ${data.kind || 'kindless'} item, not ${scopedKind.id}; use work-agent.js --kind ${data.kind}`);
    }
    return requireKind(kinds, data.kind);
  }
  function requireDeploys(kind) {
    if (!kind.deploys) throw new Error(`${kind.pluralLabel} never deploy; finish them with close-no-deploy`);
    return kind;
  }
  async function loadItem(id) {
    if (!id) throw new Error('Missing item id');
    const data = await store.items.get(id);
    if (!data) throw new Error(`${id} not found`);
    return { data, kind: kindOf(id, data) };
  }

  function dependencyIdsOf(list) {
    return [...new Set(list.flatMap(dependencyIds))];
  }
  async function dependencyIndexFor(list) {
    const ids = dependencyIdsOf(list);
    if (ids.length === 0) return new Map();
    return indexWorkItems(await store.items.getMany(ids));
  }
  async function dependenciesSatisfiedInTransaction(tx, item) {
    const ids = dependencyIdsOf([item]);
    if (ids.length === 0) return true;
    const itemsById = indexWorkItems(await tx.getMany(ids));
    return unmetDependencyIds(item, itemsById, kinds).length === 0;
  }

  async function attachRun(item) {
    const runId = env.PROJECT_ADMIN_AGENT_RUN_ID;
    if (!runId) return;
    await store.runs.merge(runId, {
      activeItem: itemReference(kinds, item), activeItemId: item.id,
      activeCollection: WORK_ITEMS_COLLECTION,
      heartbeatAt: serverTimestamp(),
    });
  }

  async function create(flags) {
    const kind = requireScopedKind('create');
    const agent = agentFrom(flags);
    const title = requireFlag(flags, 'title');
    const description = requireFlag(flags, 'description');
    const { id, number } = await store.items.create(kind, (nextNumber) => ({
      kind: kind.id, number: nextNumber, title, description,
      priority: flags.priority || 'medium', status: kind.statuses.initial,
      waitingOn: flags.waiting || 'agent', assignedTo: flags.owner ? resolveAgent(flags.owner).owner : resolveAgent(config.automation.defaultWorkAgent).owner,
      blockedReason: flags.waiting === 'human' ? 'triage' : null,
      thinkingEffort: flags.effort || 'xhigh', targetMachine: flags.machine || MACHINE_ID,
      deploymentTargets: [], deploymentType: 'none',
      messages: [message(agent.label, `Created ${kind.prefix}-${nextNumber}.`)],
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    }));
    json({ id, number, ref: `${kind.prefix}-${number}` });
  }

  // Build queues are per kind. The deploy queue spans every kind that deploys
  // unless the CLI is scoped to one kind.
  function kindsInQueue(deploy) {
    if (!deploy) return [requireScopedKind('next/count')];
    if (scopedKind) return [requireDeploys(scopedKind)];
    return kinds.filter((kind) => kind.deploys);
  }

  async function candidatesFor(agent, deploy) {
    const waitingOn = deploy ? 'deployer' : 'agent';
    const queueKinds = new Map(kindsInQueue(deploy).map((kind) => [kind.id, kind]));
    const rows = await store.items.list({ waitingOn, kind: queueKinds.size === 1 ? [...queueKinds.keys()][0] : null, limit: 250 });
    const candidates = rows
      .filter((data) => queueKinds.get(data.kind)?.activeStatuses.includes(data.status))
      .filter((data) => deploy || ownedBy(agent, data))
      .filter((data) => !deploy || data.deploymentApprovedAt)
      .filter(machineEligible).filter(isLeaseOpen);
    const itemsById = await dependencyIndexFor(candidates);
    return filterDependencyEligibleCandidates(candidates, itemsById, kinds).sort(sortItems);
  }

  async function claim(flags, deploy = false) {
    const agent = agentFrom(flags);
    const waitingOn = deploy ? 'deployer' : 'agent';
    const candidates = await candidatesFor(agent, deploy);
    for (const candidate of candidates) {
      // The store re-reads the item and decides again inside its claim
      // transaction, so a concurrent claimant either sees this lease or loses.
      const claimed = await store.items.claim(candidate.id, async (data, tx) => {
        if (!data) return null;
        const kind = requireKind(kinds, data.kind);
        if (data.waitingOn !== waitingOn || !kind.activeStatuses.includes(data.status) || !isLeaseOpen(data)) return null;
        if (deploy && (!kind.deploys || !data.deploymentApprovedAt)) return null;
        if (!deploy && (!ownedBy(agent, data) || !machineEligible(data))) return null;
        if (!await dependenciesSatisfiedInTransaction(tx, data)) return null;
        return {
          patch: {
            claimedBy: agent.token, leaseExpiresAt: store.fromMillis(Date.now() + 4 * 60 * 60 * 1000),
            claimRunId: env.PROJECT_ADMIN_AGENT_RUN_ID || null,
            status: deploy ? 'ready_for_deploy' : 'in_progress', blockedReason: null, updatedAt: serverTimestamp(),
          },
          result: {
            id: candidate.id, ...data, ref: itemReference(kinds, data),
            approvedGate: deploy ? null : (data.blockedReason || null), blockedReason: null, claimedBy: agent.token,
          },
        };
      });
      if (claimed) { await attachRun(claimed); json(claimed); return; }
    }
    json({ none: true });
  }

  async function count(flags, deploy = false) {
    const agent = agentFrom(flags);
    const candidates = await candidatesFor(agent, deploy);
    json({ count: candidates.length, topThinkingEffort: candidates[0]?.thinkingEffort || 'xhigh' });
  }
  async function list(flags) {
    const rows = (await store.items.list({ kind: scopedKind?.id || null, limit: 300 }))
      .filter((data) => flags.all === true || kinds.find((kind) => kind.id === data.kind)?.activeStatuses.includes(data.status))
      .sort(sortItems);
    json(rows);
  }
  async function show(id) {
    const { data } = await loadItem(id);
    json({ id, ...data });
  }
  async function mutate(id, flags, changes, body) {
    const agent = agentFrom(flags);
    const { data, kind } = await loadItem(id);
    const resolvedChanges = typeof changes === 'function' ? changes(data, kind) : changes;
    const patch = { ...resolvedChanges, claimedBy: null, claimRunId: null, leaseExpiresAt: null, updatedAt: serverTimestamp() };
    const imageUrls = await upload(flags.images, { uploader: `agent-${agent.token}`, kind: kind.id, itemId: id });
    if (imageUrls.length > 0 && !body) throw new Error('--images requires -m "message" so the attachments belong to a note');
    await store.items.update(id, patch, { messages: body ? [message(agent.label, body, imageUrls)] : [] });
    json({ ok: true, id, ref: itemReference(kinds, data), ...resolvedChanges, ...(imageUrls.length ? { imageUrls } : {}) });
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
    const result = await store.items.transact(id, (data) => {
      if (!data) throw new Error(`${id} not found`);
      requireDeploys(kindOf(id, data));
      requireDeployClaim(data, agent);
      const targets = requireApprovedTarget(data, target);
      const evidence = {
        ...(data.deploymentEvidence || {}),
        [target]: { proof, acceptance, verifiedAt: store.now(), verifiedBy: agent.token },
      };
      return {
        patch: {
          deploymentEvidence: evidence,
          deploymentResult: `${target}: ${proof}\nAcceptance: ${acceptance}`,
          deploymentInProgressTarget: null,
          updatedAt: serverTimestamp(),
        },
        messages: [message(agent.label, `Verified ${target}. ${proof} Acceptance: ${acceptance}`)],
        result: { ref: itemReference(kinds, data), targets, evidence },
      };
    });
    json({ ok: true, id, ...result });
  }

  async function markDeploymentStarted(id, flags) {
    const target = requireFlag(flags, 'target');
    const body = requireMessage(flags);
    const agent = agentFrom(flags);
    const { data, kind } = await loadItem(id);
    requireDeploys(kind);
    requireDeployClaim(data, agent);
    requireApprovedTarget(data, target);
    if (target !== 'testflight') throw new Error('deployment-started is reserved for detached TestFlight processing');
    await store.items.update(id, {
      status: 'ready_for_deploy', waitingOn: 'hold', blockedReason: null,
      deploymentInProgressTarget: target, deploymentStartedAt: serverTimestamp(),
      claimedBy: null, claimRunId: null, leaseExpiresAt: null,
      updatedAt: serverTimestamp(),
    }, { messages: [message(agent.label, body)] });
    json({ ok: true, id, ref: itemReference(kinds, data), target, waitingOn: 'hold' });
  }

  async function markVerificationPending(id, flags) {
    const result = requireMessage(flags);
    const agent = agentFrom(flags);
    const { data, kind } = await loadItem(id);
    requireDeploys(kind);
    requireApprovedTarget(data, 'testflight');
    const evidence = {
      ...(data.deploymentEvidence || {}),
      testflight: {
        proof: result,
        acceptance: `The build is available for ${OWNER_NAME} to test against the work-item acceptance context.`,
        verifiedAt: store.now(),
        verifiedBy: agent.token,
      },
    };
    await store.items.update(id, {
      status: 'in_review', waitingOn: 'human', blockedReason: 'acceptance_review',
      deployedAt: serverTimestamp(), deploymentVerifiedAt: serverTimestamp(),
      deploymentBuild: flags.build || '', deploymentResult: result, deploymentEvidence: evidence,
      deploymentInProgressTarget: null, claimedBy: null, claimRunId: null, leaseExpiresAt: null,
      updatedAt: serverTimestamp(),
    }, { messages: [message(agent.label, result)] });
    json({ ok: true, id, ref: itemReference(kinds, data), target: 'testflight', status: 'in_review' });
  }

  async function completeItem(id, flags, verb) {
    const result = requireMessage(flags);
    const agent = agentFrom(flags);
    const { data, kind } = await loadItem(id);
    if (verb !== 'complete' && verb !== kind.completeCommand) throw new Error(`Use ${kind.completeCommand} for ${kind.pluralLabel.toLowerCase()}`);
    requireDeploys(kind);
    requireDeployClaim(data, agent);
    if (!data.deploymentApprovedAt) throw new Error(`Cannot complete an item before ${OWNER_NAME} approves its deployment scope`);
    const targets = deploymentTargetsFor(data, true);
    if (targets.length === 0) throw new Error('Cannot complete an item with an ambiguous or empty approved deployment scope');
    if (targets.includes('testflight')) throw new Error(`TestFlight items require ${OWNER_NAME} hands-on acceptance and cannot be closed by the deploy loop`);
    const missing = missingDeploymentEvidence(data, targets);
    if (missing.length > 0) throw new Error(`Cannot complete deployment; missing target-specific proof and acceptance verification for: ${missing.join(', ')}`);
    return mutate(id, flags, {
      status: kind.statuses.done, waitingOn: 'done', blockedReason: null,
      [kind.completedAtField]: serverTimestamp(), deployedAt: serverTimestamp(),
      deploymentVerifiedAt: serverTimestamp(), deploymentResult: result, resolution: result,
    }, result);
  }
  // The only completion path for kinds that never deploy, and the no-release
  // path for kinds that do.
  async function closeWithoutDeployment(id, flags) {
    const note = requireMessage(flags).trim();
    if (note.length < 20) throw new Error('-m must contain at least 20 characters explaining how the item was completed without a release');
    agentFrom(flags);
    const { data, kind } = await loadItem(id);
    assertClosableWithoutDeployment(data);
    const body = `Closed without deployment: ${note}`;
    return mutate(id, flags, {
      status: kind.statuses.done, [kind.completedAtField]: serverTimestamp(),
      waitingOn: 'done', blockedReason: null, resolution: note,
    }, body);
  }
  async function setFields(id, flags) {
    const changes = {};
    if (flags.status) changes.status = flags.status;
    if (flags.waiting) changes.waitingOn = flags.waiting;
    if (flags.owner) changes.assignedTo = flags.owner === 'none' ? '' : resolveAgent(flags.owner).owner;
    if (flags.priority) changes.priority = flags.priority;
    if (flags.effort) changes.thinkingEffort = flags.effort;
    if (flags.machine) changes.targetMachine = flags.machine;
    if (Object.keys(changes).length === 0 && !flags.gate) throw new Error('No update flags supplied');
    await mutate(id, flags, (_data, kind) => {
      if (!flags.gate) return changes;
      if (flags.gate !== 'none' && !kind.gates.includes(flags.gate)) throw new Error(`Invalid --gate "${flags.gate}" for ${kind.pluralLabel.toLowerCase()}`);
      return { ...changes, blockedReason: flags.gate === 'none' ? null : flags.gate };
    }, flags.message === true ? undefined : flags.message);
  }

  async function run(argv) {
    const { command, id, flags } = parseArgs(argv);
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
      case 'plan': return mutate(id, flags, (_data, kind) => {
        if (!kind.planReview) throw new Error(`${kind.pluralLabel} have no plan-review gate; implement or ask instead`);
        return { status: 'plan_review', waitingOn: 'human', blockedReason: 'plan_review' };
      }, requireMessage(flags));
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
        return mutate(id, flags, (data, kind) => {
          requireDeploys(kind);
          return {
            status: 'ready_for_deploy', waitingOn: 'human', blockedReason: 'deploy_approval',
            deploymentTargets: targets, deploymentType: legacyDeploymentType(targets), deploymentNotes,
            deploymentNotesPrNumber: data.prNumber || null,
            deploymentNotesPrUrl: data.prUrl || '',
            deploymentNotesBranchName: data.branchName || '',
            deploymentApprovedAt: null, deploymentApprovedBy: null, deploymentApprovedTargets: [], deploymentApprovedNotes: '',
            deploymentEvidence: {}, deploymentResult: '', deploymentBuild: '', deploymentVerifiedAt: null,
          };
        }, requireMessage(flags));
      }
      case 'deploy-check': return recordDeploymentCheck(id, flags);
      case 'deployment-started': return markDeploymentStarted(id, flags);
      case 'verification-pending': return markVerificationPending(id, flags);
      case 'ship': case 'resolve': case 'complete': return completeItem(id, flags, command);
      case 'close-no-deploy': return closeWithoutDeployment(id, flags);
      case 'decline': return mutate(id, flags, (_data, kind) => ({
        status: kind.statuses.declined, waitingOn: 'done', blockedReason: null, resolution: requireMessage(flags),
      }), requireMessage(flags));
      case 'set': return setFields(id, flags);
      default: throw new Error(`Usage: work-agent.js [--kind <${kinds.map((kind) => kind.id).join('|')}>] <create|list|show|count|next|reply|ask|plan|pr|deploy-pending|deploy-next|deploy-check|deployment-started|verification-pending|ship|resolve|complete|close-no-deploy|decline|set> [id] --as <agent> [-m "note"] [--images a.png,b.png]`);
    }
  }

  return { run, kind: scopedKind };
}

// Entry point for scripts/work-agent.js and the feature/bug shims.
function runCli(argv = process.argv.slice(2)) {
  const { flags } = parseArgs(argv);
  const kindId = (typeof flags.kind === 'string' ? flags.kind : '') || process.env.PROJECT_ADMIN_WORK_KIND || null;
  return Promise.resolve().then(() => {
    const { openStore } = require('./store');
    return createBacklogAgent({ store: openStore(), kindId }).run(argv);
  }).catch((error) => {
    console.error(JSON.stringify({ error: error.message, kind: kindId, host: os.hostname() }));
    process.exitCode = 1;
  });
}

module.exports = { createBacklogAgent, parseArgs, runCli };
