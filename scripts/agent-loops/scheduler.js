#!/usr/bin/env node
'use strict';

// Portable foreground scheduler (`npm run loops`): runs every loop this machine
// is entitled to on its interval through loop-wrapper.sh, exactly like the
// launchd/systemd/cron jobs provision-machine.sh installs, but as one ordinary
// process. Use it where there is no service manager to lean on: Docker, CI, a
// dev shell, tmux, or Windows via WSL.
//
//   node scripts/agent-loops/scheduler.js [--once] [--dry-run] [--only id,id]
//                                         [--stagger seconds] [--grace seconds]
//
//   --once     run each job a single time, then exit (non-zero if any failed)
//   --dry-run  print the job table and exit
//   --only     restrict to job ids such as sol-feature,configured-deploy
//   --stagger  delay between first starts (default 5s), so loops do not all
//              fetch at once
//   --grace    seconds a job gets after SIGTERM before SIGKILL (default 30)
//
// Each job holds a lock file (<state>/scheduler/<id>.lock, containing the pid)
// for as long as this process runs, so two schedulers on one host never drive
// the same loop; a lock whose pid is gone is taken over. A job never overlaps
// itself: the next run starts `interval` seconds after the previous one
// started, or immediately if it ran longer. SIGINT/SIGTERM stop scheduling,
// send SIGTERM to each running job's process group, escalate to SIGKILL after
// the grace period, release the locks, and exit; a second signal kills at once.
// Runs a signal interrupts are swept by the next iteration's reap, as with
// `launchctl bootout`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WRAPPER = path.join(__dirname, 'loop-wrapper.sh');

function parseArgs(argv) {
  const options = { once: false, dryRun: false, only: null, stagger: 5, grace: 30 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--once') options.once = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--only') options.only = String(argv[++index] || '').split(',').filter(Boolean);
    else if (arg === '--stagger' || arg === '--grace') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${arg} needs a non-negative number of seconds`);
      options[arg.slice(2)] = value;
    } else throw new Error(`Unknown argument ${arg}`);
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// true when this process now owns the lock.
function acquireLock(file) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number.parseInt(fs.readFileSync(file, 'utf8'), 10);
      if (holder === process.pid) return true;
      if (pidAlive(holder)) return false;
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}

function releaseLock(file) {
  try {
    if (Number.parseInt(fs.readFileSync(file, 'utf8'), 10) === process.pid) fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
}

function loadPlan() {
  const { loadProjectConfig } = require('../lib/project-config');
  const { loadRoster, logDirectory, machineIdFor } = require('../lib/automation');
  const { loopJobs } = require('./schedulers');
  const config = loadProjectConfig();
  const roster = loadRoster();
  const machineId = machineIdFor({ config, roster });
  return {
    machineId,
    jobs: loopJobs({ config, roster, machineId }),
    logDir: logDirectory(config),
    stateDir: process.env.PROJECT_ADMIN_LOOP_STATE_DIR || path.join(os.homedir(), config.automation.stateDirectory || '.project-admin'),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const plan = loadPlan();
  let jobs = plan.jobs;
  if (options.only) {
    const unknown = options.only.filter((id) => !jobs.some((job) => job.id === id));
    if (unknown.length) throw new Error(`--only names jobs this machine is not entitled to: ${unknown.join(', ')}`);
    jobs = jobs.filter((job) => options.only.includes(job.id));
  }
  if (jobs.length === 0) throw new Error(`machine-roster.json entitles ${plan.machineId} to nothing`);

  if (options.dryRun) {
    console.log(`${jobs.length} loop jobs for ${plan.machineId} (logs: ${plan.logDir})`);
    jobs.forEach((job, index) => console.log(`${job.id}\t${job.agent} ${job.queue}\tevery ${job.interval}s\tfirst start +${index * options.stagger}s`));
    return;
  }

  const wrapper = process.env.PROJECT_ADMIN_LOOP_WRAPPER || WRAPPER;
  const lockDir = path.join(plan.stateDir, 'scheduler');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.mkdirSync(plan.logDir, { recursive: true });

  const state = new Map(); // id -> { job, lock, child, timer, done }
  let stopping = false;
  let failures = 0;

  function finishIfIdle() {
    const busy = [...state.values()].some((entry) => entry.child || (!stopping && !entry.done));
    if (busy) return;
    for (const entry of state.values()) releaseLock(entry.lock);
    log(stopping ? 'scheduler stopped' : 'all jobs finished');
    process.exit(options.once && failures > 0 ? 1 : 0);
  }

  function start(entry) {
    entry.timer = null;
    if (stopping) return;
    const { job } = entry;
    const out = fs.openSync(path.join(plan.logDir, `${job.agent}-${job.queue}.log`), 'a');
    const err = fs.openSync(path.join(plan.logDir, `${job.agent}-${job.queue}.error.log`), 'a');
    const startedAt = Date.now();
    // Its own process group, so a stop reaches run-loop.sh and the agent CLI too.
    const child = spawn(wrapper, [job.agent, job.queue], {
      detached: true,
      stdio: ['ignore', out, err],
      env: { ...process.env, PROJECT_ADMIN_MACHINE_ID: plan.machineId },
    });
    fs.closeSync(out);
    fs.closeSync(err);
    entry.child = child;
    log(`start ${job.id} (pid ${child.pid})`);
    const settle = (code, signal) => {
      if (entry.child !== child) return;
      entry.child = null;
      if (code !== 0) failures += 1;
      log(`finish ${job.id} (${signal ? `signal ${signal}` : `exit ${code}`}, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
      if (options.once || stopping) {
        entry.done = true;
        finishIfIdle();
        return;
      }
      const wait = Math.max(0, job.interval * 1000 - (Date.now() - startedAt));
      entry.timer = setTimeout(() => start(entry), wait);
    };
    child.on('exit', settle);
    child.on('error', (error) => {
      log(`error ${job.id}: ${error.message}`);
      settle(127, null);
    });
  }

  function killGroup(child, signal) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      try { child.kill(signal); } catch { /* already exited */ }
    }
  }

  function stop(signal) {
    if (stopping) {
      log(`${signal} again: killing running jobs`);
      for (const entry of state.values()) if (entry.child) killGroup(entry.child, 'SIGKILL');
      return;
    }
    stopping = true;
    log(`${signal}: stopping; running jobs get ${options.grace}s to exit`);
    for (const entry of state.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.done = true;
      if (entry.child) killGroup(entry.child, 'SIGTERM');
    }
    setTimeout(() => {
      for (const entry of state.values()) if (entry.child) killGroup(entry.child, 'SIGKILL');
    }, options.grace * 1000).unref();
    finishIfIdle();
  }

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('exit', () => {
    for (const entry of state.values()) releaseLock(entry.lock);
  });

  log(`scheduling ${jobs.length} loop jobs for ${plan.machineId}${options.once ? ' (once)' : ''}; logs in ${plan.logDir}`);
  let slot = 0;
  for (const job of jobs) {
    const lock = path.join(lockDir, `${job.id}.lock`);
    if (!acquireLock(lock)) {
      log(`skip ${job.id}: another scheduler holds ${lock}`);
      continue;
    }
    const entry = { job, lock, child: null, timer: null, done: false };
    state.set(job.id, entry);
    entry.timer = setTimeout(() => start(entry), slot * options.stagger * 1000);
    slot += 1;
  }
  if (state.size === 0) {
    log('every job is held by another scheduler; nothing to do');
    process.exit(0);
  }
}

module.exports = { acquireLock, parseArgs, releaseLock };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`scheduler: ${error.message}`);
    process.exit(2);
  }
}
