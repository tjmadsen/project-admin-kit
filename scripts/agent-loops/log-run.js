#!/usr/bin/env node
'use strict';

const os = require('node:os');
const { AGENTS, resolveAgent } = require('../lib/agents');
const { TOKEN_PATTERN } = require('../lib/agent-roster');
const { openStore } = require('../lib/store');
const { claimBelongsToRun, collectionForRun, runItemReference } = require('./run-claims');
const { handoffConfirmationRequest } = require('./confirmation-handoff');
const { reapAbandonedRuns } = require('./reap-runs');
const { loadProjectConfig } = require('../lib/project-config');
const projectConfig = loadProjectConfig();
// Opened lazily so `--help`-style usage errors need no credentials.
let openedStore;
const store = () => (openedStore ||= openStore({ config: projectConfig }));

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
  await store().machines.merge(machineId, {
    label: machineId === projectConfig.automation.defaultMachineId ? projectConfig.automation.defaultMachineLabel : machineId, hostname: os.hostname(),
    status: 'online', repoRoot: process.cwd(), agents: Object.keys(AGENTS), lastSeenAt: store().serverTimestamp(),
  });
}

async function releaseRunClaim(runId, rawReason) {
  const run = await store().runs.get(runId);
  if (!run) throw new Error(`Loop run ${runId} not found`);
  const collection = collectionForRun(run);
  if (!run.activeItemId || !collection) return { released: false, runId, reason: 'run has no active item' };

  const agent = resolveAgent(run.agent);
  const reason = String(rawReason || 'Worker exited before the lifecycle handoff completed').replace(/[\r\n]+/g, ' ').slice(0, 280);
  let result = { released: false, runId, itemId: run.activeItemId, reason: 'claim no longer belongs to this run agent' };
  await store().items.transact(run.activeItemId, (item) => {
    if (!item) {
      result = { released: false, runId, itemId: run.activeItemId, reason: 'active item no longer exists' };
      return null;
    }
    if (!claimBelongsToRun(item, run, runId)) return null;
    const reference = runItemReference(run, item);
    const destination = run.queue === 'deploy' ? 'deploy queue' : `${agent.label} queue`;
    result = { released: true, runId, itemId: run.activeItemId, reference };
    return {
      patch: { claimedBy: null, claimRunId: null, leaseExpiresAt: null, updatedAt: store().serverTimestamp() },
      messages: [{
        author: agent.label,
        body: `Loop interrupted before lifecycle handoff: ${reason}. Any existing worktree was preserved; ${reference} was returned to the ${destination}.`,
        createdAt: store().now(),
      }],
    };
  });
  return result;
}

async function handoffStatus(runId) {
  const run = await store().runs.get(runId);
  if (!run) throw new Error(`Loop run ${runId} not found`);
  const collection = collectionForRun(run);
  if (!run.activeItemId || !collection) return { complete: true };
  const item = await store().items.get(run.activeItemId);
  if (!item) return { complete: true };
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
    // Providers are named by the agent's usage hook (claude, codex, or a custom
    // capture script's own name), so accept any token-shaped key.
    if (!TOKEN_PATTERN.test(provider || '') || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      throw new Error('Usage: log-run.js usage --provider <provider> --used-percent 0..100');
    }
    const resetsAt = options['resets-at'] ? new Date(options['resets-at']) : null;
    await store().system.merge('agentLoopUsage', {
      [provider]: {
        usedPercent,
        resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : null,
        resetsLabel: options['resets-label'] || null,
        capturedAt: store().serverTimestamp(),
        lastAttemptAt: store().serverTimestamp(),
        captureStatus: 'available',
        captureError: null,
        captureCliVersion: options['cli-version']?.slice(0, 80) || null,
      },
    });
    console.log('ok'); return;
  }
  if (command === 'usage-unavailable') {
    const provider = options.provider;
    const allowedReasons = new Set([
      'cli_missing', 'expect_missing', 'startup_timeout', 'startup_exit',
      'trust_prompt', 'usage_timeout', 'usage_exit', 'pty_error',
      'missing_label', 'parse_error',
    ]);
    if (!TOKEN_PATTERN.test(provider || '')) throw new Error('Missing or invalid usage provider');
    const captureError = allowedReasons.has(options.reason) ? options.reason : 'pty_error';
    await store().system.merge('agentLoopUsage', {
      [provider]: {
        lastAttemptAt: store().serverTimestamp(),
        captureStatus: 'unavailable',
        captureError,
        captureCliVersion: options['cli-version']?.slice(0, 80) || null,
      },
    });
    console.log('ok'); return;
  }
  if (command === 'configured-agent') {
    const queue = options.queue || 'deploy';
    if (queue !== 'deploy') throw new Error('Only the shared deploy queue has a configured agent');
    const loopConfig = await store().system.get('agentLoopConfig');
    const token = loopConfig?.deployAgent || projectConfig.automation.defaultDeployAgent;
    process.stdout.write(resolveAgent(token).token);
    return;
  }
  if (command === 'machine-heartbeat') { await heartbeatMachine(machineId); console.log('ok'); return; }
  if (command === 'start') {
    await heartbeatMachine(machineId);
    // The runner pid is what lets `reap` tell a killed run from a sleeping
    // machine: a paused Mac keeps its pid, a booted-out process tree does not.
    const runnerPid = Number.parseInt(options.pid, 10);
    const id = await store().runs.create({
      agent: options.agent, queue: options.queue, machineId, status: 'running',
      runnerPid: Number.isInteger(runnerPid) && runnerPid > 0 ? runnerPid : null,
      thinkingEffort: options.effort || null,
      model: options.model || null,
      startedAt: store().serverTimestamp(), heartbeatAt: store().serverTimestamp(),
    });
    process.stdout.write(id);
    return;
  }
  if (command === 'reap') {
    const result = await reapAbandonedRuns({
      store: store(),
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
      store: store(),
      agentLabelFor: (token) => resolveAgent(token).label,
    });
    process.stdout.write(result.asked ? 'asked' : 'not_applicable');
    return;
  }
  if (command === 'model') {
    if (!options.model) throw new Error('Missing --model');
    await store().runs.merge(runId, { model: options.model });
    return;
  }
  if (command === 'heartbeat') {
    await Promise.all([heartbeatMachine(machineId), store().runs.merge(runId, { heartbeatAt: store().serverTimestamp() })]);
    console.log('ok'); return;
  }
  if (command === 'progress') {
    const summary = String(options.summary || '').slice(-4000);
    await Promise.all([heartbeatMachine(machineId), store().runs.merge(runId, {
      heartbeatAt: store().serverTimestamp(), progressAt: store().serverTimestamp(), progressSummary: summary,
    })]);
    console.log('ok'); return;
  }
  if (command === 'finish') {
    const run = await store().runs.get(runId);
    const started = run?.startedAt?.toMillis?.() ?? Date.now();
    const exitCode = Number(options.code || 0);
    await Promise.all([heartbeatMachine(machineId), store().runs.merge(runId, {
      status: exitCode === 0 ? 'completed' : 'failed', exitCode, summary: options.summary || '',
      finishedAt: store().serverTimestamp(), heartbeatAt: store().serverTimestamp(),
      durationSeconds: Math.max(0, Math.round((Date.now() - started) / 1000)),
    })]);
    console.log('ok'); return;
  }
  throw new Error('Usage: log-run.js <configured-agent|usage|usage-unavailable|start|model|heartbeat|progress|finish|handoff-status|confirmation-handoff|release-claim|reap|machine-heartbeat>');
}
if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
