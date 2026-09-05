'use strict';

// A loop run that dies by signal never reaches run-loop.sh's finish path.
// `provision-machine.sh install` boots out every com.projectadmin.loop.* label, and
// launchctl ends each job's whole process tree — including the deploy run that
// issued the command — so `finish` and `release-claim` are simply never
// reached. The agentLoopRuns row then stays status "running" with a frozen
// heartbeat forever (the dashboard reports it as live for hours) and the item
// it claimed stays locked until its four-hour lease lapses, which leaves that
// agent's queue polling with nothing to do. This module closes those rows.
//
// The guard against closing a live run is a conjunction, not a timer: the row
// belongs to this machine, its heartbeat is stale, and the runner pid it
// recorded no longer exists. A paused or sleeping Mac keeps its runner pid, so
// heartbeat age alone can never cost a genuinely live run its claim, and runs
// owned by another machine are that machine's to reap. Rows written before
// run-loop.sh recorded a pid cannot be judged this way, so they are reported
// and left alone.

const DEFAULT_STALE_MINUTES = 2;
const INTERRUPTED_EXIT_CODE = 137;

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to somebody else.
    return error.code === 'EPERM';
  }
}

function toMillis(value) {
  if (!value) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return null;
}

function runnerPidOf(run) {
  const pid = Number(run.runnerPid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function lastSignMillis(run) {
  return toMillis(run.heartbeatAt) ?? toMillis(run.startedAt);
}

// Returns why the run is abandoned, or null when it must be left alone.
function abandonedReason(run, { machineId, nowMs, staleMs, isProcessAlive = processIsAlive }) {
  if (run.status !== 'running') return null;
  if (machineId && run.machineId !== machineId) return null;
  const lastSign = lastSignMillis(run);
  if (lastSign == null || nowMs - lastSign < staleMs) return null;
  const pid = runnerPidOf(run);
  if (pid == null || isProcessAlive(pid)) return null;
  const staleMinutes = Math.max(0, Math.round((nowMs - lastSign) / 60_000));
  return `runner pid ${pid} is gone and the run last reported ${staleMinutes}m ago`;
}

async function reapAbandonedRuns(options) {
  const {
    database,
    timestamp,
    machineId,
    releaseClaim,
    staleMinutes = DEFAULT_STALE_MINUTES,
    dryRun = false,
    now = Date.now(),
    isProcessAlive = processIsAlive,
  } = options;
  const staleMs = Math.max(0, Number(staleMinutes) || 0) * 60_000;
  const snapshot = await database.collection('agentLoopRuns').where('status', '==', 'running').get();
  const reaped = [];
  const skipped = [];

  for (const doc of snapshot.docs) {
    const run = doc.data();
    if (machineId && run.machineId !== machineId) continue;
    const reason = abandonedReason(run, { machineId, nowMs: now, staleMs, isProcessAlive });
    const lastSign = lastSignMillis(run);
    if (!reason) {
      if (runnerPidOf(run) == null && lastSign != null && now - lastSign >= staleMs) {
        skipped.push({ runId: doc.id, activeItem: run.activeItem || null, reason: 'the run recorded no runner pid, so it cannot be judged dead' });
      }
      continue;
    }
    const startedAt = toMillis(run.startedAt) ?? lastSign;
    const entry = {
      runId: doc.id,
      agent: run.agent || null,
      queue: run.queue || null,
      activeItem: run.activeItem || null,
      reason,
      durationSeconds: Math.max(0, Math.round((lastSign - startedAt) / 1000)),
      released: false,
      itemId: null,
    };
    if (!dryRun) {
      // Hand the item back first: if this process dies in between, the row is
      // still "running" and the next sweep repeats the whole step.
      if (releaseClaim) {
        const release = await releaseClaim(doc.id, `Loop run ended by signal: ${reason}`);
        entry.released = Boolean(release && release.released);
        entry.itemId = (release && release.itemId) || null;
      }
      await database.collection('agentLoopRuns').doc(doc.id).set({
        status: 'interrupted',
        exitCode: INTERRUPTED_EXIT_CODE,
        finishedAt: timestamp.fromMillis(lastSign),
        durationSeconds: entry.durationSeconds,
        summary: `Run ended by signal without recording a result: ${reason}. Duration is measured to the last heartbeat.`,
      }, { merge: true });
    }
    reaped.push(entry);
  }

  return { machineId: machineId || null, staleMinutes: Number(staleMinutes) || 0, dryRun: Boolean(dryRun), scanned: snapshot.docs.length, reaped, skipped };
}

module.exports = { DEFAULT_STALE_MINUTES, INTERRUPTED_EXIT_CODE, abandonedReason, processIsAlive, reapAbandonedRuns };
