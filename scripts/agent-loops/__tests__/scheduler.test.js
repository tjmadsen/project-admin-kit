'use strict';

// scheduler.js (`npm run loops`) against a fake loop-wrapper that records each
// fire, so the job set, interval re-runs, per-job locks, and signal handling
// are checked as executed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SCHEDULER = path.join(__dirname, '..', 'scheduler.js');
const REPO = path.join(__dirname, '..', '..', '..');
const SLUG = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8')).project.slug;

function sandbox(roster = { machines: [{ id: 'ci', agents: ['sol', 'opus'], queues: ['feature', 'deploy'] }] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-scheduler-'));
  const record = path.join(root, 'record.txt');
  const wrapper = path.join(root, 'loop-wrapper.sh');
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash
echo "START $1 $2 $PROJECT_ADMIN_MACHINE_ID" >> '${record}'
echo "wrapper output for $1 $2"
trap 'echo "TERM $1 $2" >> '"'${record}'"'; exit 143' TERM
sleep "\${FAKE_WRAPPER_SLEEP:-0}" & wait
echo "END $1 $2" >> '${record}'
exit "\${FAKE_WRAPPER_EXIT:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'roster.json'), JSON.stringify(roster));
  const env = {
    ...process.env,
    PROJECT_ADMIN_MACHINE_ID: 'ci',
    PROJECT_ADMIN_MACHINE_ROSTER: path.join(root, 'roster.json'),
    PROJECT_ADMIN_LOOP_WRAPPER: wrapper,
    PROJECT_ADMIN_LOOP_STATE_DIR: path.join(root, 'state'),
    PROJECT_ADMIN_LOOP_LOG_DIR: path.join(root, 'logs'),
  };
  const lines = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { root, env, lines, lockDir: path.join(root, 'state', 'scheduler') };
}

function runScheduler(box, args, env = {}) {
  return spawnSync(process.execPath, [SCHEDULER, ...args], { encoding: 'utf8', env: { ...box.env, ...env }, timeout: 30000 });
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for the scheduler');
}

test('a dry run lists one job per entitlement with deploy collapsed and staggered starts', () => {
  const box = sandbox();
  const { status, stdout, stderr } = runScheduler(box, ['--dry-run', '--stagger', '2']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /^3 loop jobs for ci/);
  assert.match(stdout, /^sol-feature\tsol feature\tevery 300s\tfirst start \+0s$/m);
  assert.match(stdout, /^opus-feature\topus feature\tevery 300s\tfirst start \+2s$/m);
  assert.match(stdout, /^configured-deploy\tconfigured deploy\tevery 900s\tfirst start \+4s$/m);
  assert.deepEqual(box.lines(), []);

  // The sample roster: seven agents x three kinds plus one deploy dispatcher.
  const sample = spawnSync(process.execPath, [SCHEDULER, '--dry-run'], { encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_MACHINE_ID: 'local-mac' } });
  assert.equal(sample.status, 0, sample.stderr);
  assert.match(sample.stdout, /^22 loop jobs for local-mac/);
  assert.equal((sample.stdout.match(/^configured-deploy\t/gm) || []).length, 1);
  assert.equal((sample.stdout.match(/\tconfigured deploy\t/g) || []).length, 1);
});

test('--once fires every entitled loop through the wrapper once, logs it, and releases the locks', () => {
  const box = sandbox();
  const { status, stdout, stderr } = runScheduler(box, ['--once', '--stagger', '0']);
  assert.equal(status, 0, stderr);
  const starts = box.lines().filter((line) => line.startsWith('START')).map((line) => line.split(' ').slice(1, 4).join(' ')).sort();
  assert.deepEqual(starts, ['configured deploy ci', 'opus feature ci', 'sol feature ci']);
  assert.match(stdout, /all jobs finished/);
  assert.match(fs.readFileSync(path.join(box.root, 'logs', `${SLUG}-sol-feature.log`), 'utf8'), /wrapper output for sol feature/);
  assert.deepEqual(fs.readdirSync(box.lockDir), [], 'locks are released on exit');
});

test('--once exits non-zero when a loop fails and --only narrows the job set', () => {
  const box = sandbox();
  const failed = runScheduler(box, ['--once', '--stagger', '0', '--only', 'sol-feature'], { FAKE_WRAPPER_EXIT: '3' });
  assert.equal(failed.status, 1);
  assert.deepEqual(box.lines().filter((line) => line.startsWith('START')).map((line) => line.split(' ')[1]), ['sol']);
  const unknown = runScheduler(box, ['--once', '--only', 'grok-bug']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /not entitled to: grok-bug/);
});

test('a job held by another live scheduler is skipped; a stale lock is taken over', () => {
  const box = sandbox();
  fs.mkdirSync(box.lockDir, { recursive: true });
  // This test process is alive, so its pid holds sol-feature.
  fs.writeFileSync(path.join(box.lockDir, `${SLUG}-sol-feature.lock`), `${process.pid}\n`);
  // A pid that cannot exist marks opus-feature's lock as abandoned.
  fs.writeFileSync(path.join(box.lockDir, `${SLUG}-opus-feature.lock`), '999999999\n');
  // Another project's lock for the same job id does not block this project.
  fs.writeFileSync(path.join(box.lockDir, 'other-app-configured-deploy.lock'), `${process.pid}\n`);
  const { status, stdout, stderr } = runScheduler(box, ['--once', '--stagger', '0']);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /skip sol-feature: another scheduler holds/);
  const starts = box.lines().filter((line) => line.startsWith('START')).map((line) => line.split(' ')[1]).sort();
  assert.deepEqual(starts, ['configured', 'opus']);
  assert.equal(fs.readFileSync(path.join(box.lockDir, `${SLUG}-sol-feature.lock`), 'utf8'), `${process.pid}\n`, 'a lock this run never owned is left alone');
  assert.equal(fs.existsSync(path.join(box.lockDir, `${SLUG}-opus-feature.lock`)), false);
  assert.ok(fs.existsSync(path.join(box.lockDir, 'other-app-configured-deploy.lock')));
});

test('a job re-runs on its interval without overlapping itself', async () => {
  const box = sandbox({ machines: [{ id: 'ci', agents: ['quick'], queues: ['feature'] }] });
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
  delete config.agentAliases;
  config.agents = [{ token: 'quick', label: 'Quick', runner: 'claude', model: 'sonnet', pollSeconds: 1 }];
  config.automation = { ...config.automation, defaultWorkAgent: 'quick', defaultDeployAgent: 'quick' };
  const configFile = path.join(box.root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  const child = spawn(process.execPath, [SCHEDULER, '--stagger', '0', '--grace', '2'], {
    env: { ...box.env, PROJECT_ADMIN_CONFIG: configFile, FAKE_WRAPPER_SLEEP: '0.3' },
    stdio: 'ignore',
  });
  const launched = Date.now();
  try {
    await waitFor(() => box.lines().filter((line) => line.startsWith('END')).length >= 3);
    // Three runs of a 0.3s job on a 1s interval: starts at ~0s, ~1s, ~2s.
    assert.ok(Date.now() - launched >= 1800, `the third run waited for its interval (${Date.now() - launched}ms)`);
  } finally {
    child.kill('SIGTERM');
  }
  await new Promise((resolve) => child.on('exit', resolve));
  const events = box.lines().filter((line) => /^(START|END)/.test(line)).map((line) => line.split(' ')[0]);
  events.forEach((event, index) => assert.equal(event, index % 2 === 0 ? 'START' : 'END', `a run never starts before the previous one ended: ${events}`));
  assert.ok(events.filter((event) => event === 'START').length >= 3);
});

test('SIGTERM stops scheduling, terminates running jobs, and releases the locks', async () => {
  const box = sandbox();
  const child = spawn(process.execPath, [SCHEDULER, '--stagger', '0', '--grace', '5'], {
    env: { ...box.env, FAKE_WRAPPER_SLEEP: '60' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  await waitFor(() => box.lines().filter((line) => line.startsWith('START')).length === 3);
  assert.deepEqual(fs.readdirSync(box.lockDir).sort(), [`${SLUG}-configured-deploy.lock`, `${SLUG}-opus-feature.lock`, `${SLUG}-sol-feature.lock`], 'each running job holds its namespaced lock');
  const started = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5000, 'jobs that honor SIGTERM do not wait out the grace period');
  assert.equal(box.lines().filter((line) => line.startsWith('TERM')).length, 3, 'every running wrapper received SIGTERM');
  assert.match(output, /SIGTERM: stopping/);
  assert.match(output, /scheduler stopped/);
  assert.deepEqual(fs.readdirSync(box.lockDir), []);
});
