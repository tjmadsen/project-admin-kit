#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { FieldValue, Timestamp } = require('@google-cloud/firestore');
const db = require('../lib/firestore');
const { AGENTS, resolveAgent } = require('../lib/agents');
const { claimBelongsToRun, collectionForRun } = require('./run-claims');
const { handoffConfirmationRequest } = require('./confirmation-handoff');
const { reapAbandonedRuns } = require('./reap-runs');
const { loadProjectConfig } = require('../lib/project-config');
const projectConfig = loadProjectConfig();

// Value flags consume the next argument, which is why the boolean ones have to
// be declared: `--summary` is free-form log tail that may itself start with a
// dash, so the parser cannot infer the difference from the argument's shape.
const BOOLEAN_FLAGS = new Set(['dry-run']);

function flags(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (BOOLEAN_FLAGS.has(name)) result[name] = true;
    else result[name] = argv[++i];
  }
  return result;
}
async function heartbeatMachine(machineId) {
  await db.collection('agentMachines').doc(machineId).set({
    label: machineId === projectConfig.automation.defaultMachineId ? projectConfig.automation.defaultMachineLabel : machineId, hostname: os.hostname(),
    status: 'online', repoRoot: process.cwd(), agents: Object.keys(AGENTS), lastSeenAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

async function releaseRunClaim(runId, rawReason) {
  const runSnapshot = await db.collection('agentLoopRuns').doc(runId).get();
  if (!runSnapshot.exists) throw new Error(`Loop run ${runId} not found`);
  const run = runSnapshot.data();
  const collection = collectionForRun(run);
  if (!run.activeItemId || !collection) return { released: false, runId, reason: 'run has no active item' };

  const agent = resolveAgent(run.agent);
  const reason = String(rawReason || 'Worker exited before the lifecycle handoff completed').replace(/[\r\n]+/g, ' ').slice(0, 280);
  const itemRef = db.collection(collection).doc(run.activeItemId);
  let result = { released: false, runId, itemId: run.activeItemId, reason: 'claim no longer belongs to this run agent' };
  await db.runTransaction(async (transaction) => {
    const itemSnapshot = await transaction.get(itemRef);
    if (!itemSnapshot.exists) {
      result = { released: false, runId, itemId: run.activeItemId, reason: 'active item no longer exists' };
      return;
    }
    const item = itemSnapshot.data();
    if (!claimBelongsToRun(item, run, runId)) return;
    const reference = run.activeItem || `${collection === 'featureRequests' ? 'FR' : 'BUG'}-${item.number ?? '?'}`;
    const destination = run.queue === 'deploy' ? 'deploy queue' : `${agent.label} queue`;
    transaction.update(itemRef, {
      claimedBy: null,
      claimRunId: null,
      leaseExpiresAt: null,
      updatedAt: FieldValue.serverTimestamp(),
      messages: FieldValue.arrayUnion({
        author: agent.label,
        body: `Loop interrupted before lifecycle handoff: ${reason}. Any existing worktree was preserved; ${reference} was returned to the ${destination}.`,
        createdAt: Timestamp.now(),
      }),
    });
    result = { released: true, runId, itemId: run.activeItemId, reference };
  });
  return result;
}

async function handoffStatus(runId) {
  const runSnapshot = await db.collection('agentLoopRuns').doc(runId).get();
  if (!runSnapshot.exists) throw new Error(`Loop run ${runId} not found`);
  const run = runSnapshot.data();
  const collection = collectionForRun(run);
  if (!run.activeItemId || !collection) return { complete: true };
  const itemSnapshot = await db.collection(collection).doc(run.activeItemId).get();
  if (!itemSnapshot.exists) return { complete: true };
  const item = itemSnapshot.data();
  const stillOwnedByRun = claimBelongsToRun(item, run, runId);
  return stillOwnedByRun
    ? { complete: false, reason: 'Worker exited without recording a lifecycle handoff or releasing its claim' }
    : { complete: true };
}

async function main() {
  const command = process.argv[2];
  const options = flags(process.argv.slice(3));
  const machineId = options.machine || process.env.PROJECT_ADMIN_MACHINE_ID || projectConfig.automation.defaultMachineId;
  if (command === 'usage') {
    const provider = options.provider;
    const usedPercent = Number(options['used-percent']);
    if (!['claude', 'codex'].includes(provider) || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      throw new Error('Usage: log-run.js usage --provider claude|codex --used-percent 0..100');
    }
    const resetsAt = options['resets-at'] ? new Date(options['resets-at']) : null;
    await db.collection('system').doc('agentLoopUsage').set({
      [provider]: {
        usedPercent,
        resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
        resetsLabel: options['resets-label'] || null,
        capturedAt: FieldValue.serverTimestamp(),
        lastAttemptAt: FieldValue.serverTimestamp(),
        captureStatus: 'available',
        captureError: null,
        captureCliVersion: options['cli-version']?.slice(0, 80) || null,
      },
    }, { merge: true });
    console.log('ok'); return;
  }
  if (command === 'usage-unavailable') {
    const provider = options.provider;
    const allowedReasons = new Set([
      'cli_missing', 'expect_missing', 'startup_timeout', 'startup_exit',
      'trust_prompt', 'usage_timeout', 'usage_exit', 'pty_error',
      'missing_label', 'parse_error',
    ]);
    if (!['claude', 'codex'].includes(provider)) throw new Error('Missing or invalid usage provider');
    const captureError = allowedReasons.has(options.reason) ? options.reason : 'pty_error';
    await db.collection('system').doc('agentLoopUsage').set({
      [provider]: {
        lastAttemptAt: FieldValue.serverTimestamp(),
        captureStatus: 'unavailable',
        captureError,
        captureCliVersion: options['cli-version']?.slice(0, 80) || null,
      },
    }, { merge: true });
    console.log('ok'); return;
  }
  if (command === 'configured-agent') {
    const queue = options.queue || 'deploy';
    if (queue !== 'deploy') throw new Error('Only the shared deploy queue has a configured agent');
    const snapshot = await db.collection('system').doc('agentLoopConfig').get();
    const token = snapshot.data()?.deployAgent || projectConfig.automation.defaultDeployAgent;
    process.stdout.write(resolveAgent(token).token);
    return;
  }
  if (command === 'machine-heartbeat') { await heartbeatMachine(machineId); console.log('ok'); return; }
  if (command === 'start') {
    await heartbeatMachine(machineId);
    // The runner pid is what lets `reap` tell a killed run from a sleeping
    // machine: a paused Mac keeps its pid, a booted-out process tree does not.
    const runnerPid = Number.parseInt(options.pid, 10);
    const ref = await db.collection('agentLoopRuns').add({
      agent: options.agent, queue: options.queue, machineId, status: 'running',
      runnerPid: Number.isInteger(runnerPid) && runnerPid > 0 ? runnerPid : null,
      thinkingEffort: options.effort || null,
      model: options.model || null,
      startedAt: FieldValue.serverTimestamp(), heartbeatAt: FieldValue.serverTimestamp(),
    });
    process.stdout.write(ref.id);
    return;
  }
  if (command === 'reap') {
    const result = await reapAbandonedRuns({
      database: db,
      timestamp: Timestamp,
      machineId,
      releaseClaim: releaseRunClaim,
      dryRun: Boolean(options['dry-run']),
      ...(options['stale-minutes'] === undefined ? {} : { staleMinutes: Number(options['stale-minutes']) }),
    });
    console.log(JSON.stringify(result));
    return;
  }
  const runId = options.run;
  if (!runId) throw new Error('Missing --run');
  if (command === 'handoff-status') {
    const result = await handoffStatus(runId);
    process.stdout.write(result.complete ? 'ok' : result.reason);
    return;
  }
  if (command === 'release-claim') {
    console.log(JSON.stringify(await releaseRunClaim(runId, options.reason)));
    return;
  }
  if (command === 'confirmation-handoff') {
    const result = await handoffConfirmationRequest(runId, options.reason, options.output, {
      database: db,
      fieldValue: FieldValue,
      timestamp: Timestamp,
      agentLabelFor: (token) => resolveAgent(token).label,
    });
    process.stdout.write(result.asked ? 'asked' : 'not_applicable');
    return;
  }
  if (command === 'model') {
    if (!options.model) throw new Error('Missing --model');
    await db.collection('agentLoopRuns').doc(runId).set({ model: options.model }, { merge: true });
    return;
  }
  if (command === 'heartbeat') {
    await Promise.all([heartbeatMachine(machineId), db.collection('agentLoopRuns').doc(runId).set({ heartbeatAt: FieldValue.serverTimestamp() }, { merge: true })]);
    console.log('ok'); return;
  }
  if (command === 'progress') {
    const summary = String(options.summary || '').slice(-4000);
    await Promise.all([heartbeatMachine(machineId), db.collection('agentLoopRuns').doc(runId).set({
      heartbeatAt: FieldValue.serverTimestamp(), progressAt: FieldValue.serverTimestamp(), progressSummary: summary,
    }, { merge: true })]);
    console.log('ok'); return;
  }
  if (command === 'finish') {
    const ref = db.collection('agentLoopRuns').doc(runId);
    const snapshot = await ref.get();
    const started = snapshot.data()?.startedAt?.toMillis?.() ?? Date.now();
    const exitCode = Number(options.code || 0);
    await Promise.all([heartbeatMachine(machineId), ref.set({
      status: exitCode === 0 ? 'completed' : 'failed', exitCode, summary: options.summary || '',
      finishedAt: FieldValue.serverTimestamp(), heartbeatAt: FieldValue.serverTimestamp(),
      durationSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
    }, { merge: true })]);
    console.log('ok'); return;
  }
  throw new Error('Usage: log-run.js <configured-agent|usage|usage-unavailable|start|model|heartbeat|progress|finish|handoff-status|confirmation-handoff|release-claim|reap|machine-heartbeat>');
}
if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
