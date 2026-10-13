'use strict';

// Scheduler unit generation (launchd, systemd, cron) and provision-machine.sh's
// per-scheduler dispatch. The provisioner runs for real against fake
// launchctl/systemctl/crontab binaries on a private PATH and a throwaway HOME,
// so nothing here touches this machine's scheduler.
//
// Snapshots live in __snapshots__/schedulers; regenerate them with
// UPDATE_SNAPSHOTS=1 npm test after an intentional template change.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  cronBegin,
  cronEnd,
  cronSchedule,
  loopJobs,
  mergeCrontab,
  renderCronBlock,
  renderLaunchd,
  renderSystemd,
  stripCrontab,
} = require('../schedulers');

const AGENT_LOOPS = path.join(__dirname, '..');
const REPO = path.join(AGENT_LOOPS, '..', '..');
const SNAPSHOTS = path.join(__dirname, '__snapshots__', 'schedulers');
const CONFIG = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
const ROSTER = { machines: [{ id: 'ci-box', agents: ['sol', 'grok', 'ghost'], queues: ['feature', 'deploy', 'release'] }] };
const SLUG = CONFIG.project.slug;
const CTX = { repoRoot: '/srv/my app', slug: 'rocket', machineId: 'ci-box', logDir: '/var/log/pa loops', path: '/usr/local/bin:/usr/bin:/bin' };

function matchSnapshot(name, actual) {
  const file = path.join(SNAPSHOTS, name);
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(file)) {
    fs.mkdirSync(SNAPSHOTS, { recursive: true });
    fs.writeFileSync(file, actual);
  }
  assert.equal(actual, fs.readFileSync(file, 'utf8'), `${name} differs from its snapshot`);
}

test('one job per roster entitlement, with every deploy entitlement collapsed into one dispatcher', () => {
  const jobs = loopJobs({ config: CONFIG, roster: ROSTER, machineId: 'ci-box' });
  assert.deepEqual(jobs, [
    { id: 'sol-feature', agent: 'sol', queue: 'feature', interval: 300 },
    { id: 'grok-feature', agent: 'grok', queue: 'feature', interval: 1800 },
    { id: 'configured-deploy', agent: 'configured', queue: 'deploy', interval: 900 },
  ], 'unknown agents (ghost) and queues (release) entitle nothing');
  assert.deepEqual(loopJobs({ config: CONFIG, roster: ROSTER, machineId: 'elsewhere' }), []);
});

test('systemd units match their snapshots', () => {
  const jobs = loopJobs({ config: CONFIG, roster: ROSTER, machineId: 'ci-box' });
  const rendered = Object.assign({}, ...jobs.map((job, index) => renderSystemd(job, CTX, index)));
  assert.deepEqual(Object.keys(rendered), [
    'projectadmin-rocket-loop-sol-feature.service', 'projectadmin-rocket-loop-sol-feature.timer',
    'projectadmin-rocket-loop-grok-feature.service', 'projectadmin-rocket-loop-grok-feature.timer',
    'projectadmin-rocket-loop-configured-deploy.service', 'projectadmin-rocket-loop-configured-deploy.timer',
  ]);
  matchSnapshot('systemd-sol-feature.service', rendered['projectadmin-rocket-loop-sol-feature.service']);
  matchSnapshot('systemd-grok-feature.timer', rendered['projectadmin-rocket-loop-grok-feature.timer']);
  matchSnapshot('systemd-configured-deploy.timer', rendered['projectadmin-rocket-loop-configured-deploy.timer']);
  assert.match(rendered['projectadmin-rocket-loop-sol-feature.service'], /^StandardOutput=append:\/var\/log\/pa loops\/rocket-sol-feature\.log$/m);
  assert.match(rendered['projectadmin-rocket-loop-sol-feature.service'], /^ExecStart="\/srv\/my app\/scripts\/agent-loops\/loop-wrapper\.sh" sol feature$/m);
  assert.match(renderSystemd(jobs[0], { ...CTX, path: '/opt/100%/bin' })['projectadmin-rocket-loop-sol-feature.service'], /PATH=\/opt\/100%%\/bin/, 'systemd specifiers are escaped');
});

test('the cron block matches its snapshot and staggers sub-hour schedules', () => {
  const jobs = loopJobs({ config: CONFIG, roster: ROSTER, machineId: 'ci-box' });
  matchSnapshot('cron-block.txt', `${renderCronBlock(jobs, CTX)}\n`);
  assert.equal(cronSchedule(300, 0), '0-59/5 * * * *');
  assert.equal(cronSchedule(300, 7), '2-59/5 * * * *');
  assert.equal(cronSchedule(1800, 1), '1-59/30 * * * *');
  assert.equal(cronSchedule(45, 0), '* * * * *');
  assert.equal(cronSchedule(420, 0), '*/7 * * * *', 'an interval that does not divide the hour cannot be offset');
  assert.equal(cronSchedule(3600, 3), '3 * * * *');
  assert.equal(cronSchedule(7200, 3), '3 */2 * * *');
  assert.equal(cronSchedule(86400, 3), '3 0 * * *');
  assert.match(renderCronBlock(jobs, { ...CTX, path: '/opt/50%' }), /PATH='\/opt\/50\\%'/, 'cron would end the command at a bare %');
});

test('the launchd plist keeps the existing label, wrapper, and RunAtLoad contract', () => {
  const [job] = loopJobs({ config: CONFIG, roster: ROSTER, machineId: 'ci-box' });
  const files = renderLaunchd(job, { ...CTX, repoRoot: '/srv/a&b' });
  assert.deepEqual(Object.keys(files), ['com.projectadmin.rocket.loop.sol-feature.plist']);
  const plist = files['com.projectadmin.rocket.loop.sol-feature.plist'];
  assert.match(plist, /<key>Label<\/key><string>com\.projectadmin\.rocket\.loop\.sol-feature<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/var\/log\/pa loops\/rocket-sol-feature\.log<\/string>/);
  assert.match(plist, /<string>\/srv\/a&amp;b\/scripts\/agent-loops\/loop-wrapper\.sh<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>PROJECT_ADMIN_MACHINE_ID<\/key><string>ci-box<\/string>/);
});

test('merging the cron block is idempotent and leaves other lines and other projects alone', () => {
  const block = `${cronBegin('rocket')}\n* * * * * echo loop\n${cronEnd('rocket')}`;
  const other = `${cronBegin('other-app')}\n* * * * * echo other\n${cronEnd('other-app')}`;
  const user = `MAILTO=me@example.com\n15 3 * * * /usr/bin/backup\n${other}`;
  const once = mergeCrontab(user, block, 'rocket');
  assert.equal(once, `${user}\n${block}\n`);
  assert.equal(mergeCrontab(once, block, 'rocket'), once);
  const replaced = mergeCrontab(`${once}0 4 * * * /usr/bin/later\n`, `${cronBegin('rocket')}\n*/5 * * * * echo new\n${cronEnd('rocket')}`, 'rocket');
  assert.equal(replaced, `${user}\n0 4 * * * /usr/bin/later\n${cronBegin('rocket')}\n*/5 * * * * echo new\n${cronEnd('rocket')}\n`);
  assert.equal(stripCrontab(replaced, 'rocket'), `${user}\n0 4 * * * /usr/bin/later`);
  assert.equal(stripCrontab(replaced, 'other-app'), `MAILTO=me@example.com\n15 3 * * * /usr/bin/backup\n0 4 * * * /usr/bin/later\n${cronBegin('rocket')}\n*/5 * * * * echo new\n${cronEnd('rocket')}`);
  assert.equal(mergeCrontab('', block, 'rocket'), `${block}\n`);
});

// --- provision-machine.sh ----------------------------------------------------

function fakeHost() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-provision-'));
  const bin = path.join(root, 'bin');
  const record = path.join(root, 'record.txt');
  const crontabFile = path.join(root, 'crontab.txt');
  const roster = path.join(root, 'roster.json');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(roster, JSON.stringify(ROSTER));
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  stub('crontab', `echo "crontab $*" >> '${record}'
if [[ "$1" == "-l" ]]; then [[ -f '${crontabFile}' ]] || { echo "no crontab for test" >&2; exit 1; }; cat '${crontabFile}'; exit 0; fi
if [[ "$1" == "-" ]]; then cat > '${crontabFile}'; exit 0; fi
exit 2`);
  stub('systemctl', `echo "systemctl $*" >> '${record}'
[[ "$*" == *list-timers* ]] && echo "NEXT LEFT UNIT projectadmin-loop-sol-feature.timer"
exit 0`);
  stub('launchctl', `echo "launchctl $*" >> '${record}'`);
  stub('node', `exec '${process.execPath}' "$@"`);
  return { root, bin, record, crontabFile, roster };
}

function provision(host, scheduler, args, env = {}) {
  const result = spawnSync(path.join(AGENT_LOOPS, 'provision-machine.sh'), args, {
    encoding: 'utf8',
    env: {
      PATH: `${host.bin}:/usr/bin:/bin`,
      HOME: host.root,
      XDG_CONFIG_HOME: path.join(host.root, 'config'),
      PROJECT_ADMIN_LOOP_LOG_DIR: path.join(host.root, 'logs'),
      PROJECT_ADMIN_SCHEDULER: scheduler,
      PROJECT_ADMIN_MACHINE_ID: 'ci-box',
      PROJECT_ADMIN_MACHINE_ROSTER: host.roster,
      PROJECT_ADMIN_PROVISION_OFFLINE: '1',
      ...env,
    },
  });
  const record = fs.existsSync(host.record) ? fs.readFileSync(host.record, 'utf8') : '';
  return { ...result, record };
}

test('cron install writes one managed block idempotently, and uninstall removes only it', () => {
  const host = fakeHost();
  fs.writeFileSync(host.crontabFile, 'MAILTO=me@example.com\n15 3 * * * /usr/bin/backup\n');
  const first = provision(host, 'cron', ['install']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Installed 3 cron entries/);
  assert.match(first.stdout, /3 Project Admin loop jobs are scheduled with cron for ci-box/);
  const installed = fs.readFileSync(host.crontabFile, 'utf8');
  assert.ok(installed.startsWith(`MAILTO=me@example.com\n15 3 * * * /usr/bin/backup\n# BEGIN project-admin agent loops: ${SLUG} `), installed);
  assert.equal((installed.match(/loop-wrapper\.sh/g) || []).length, 3);
  assert.match(installed, new RegExp(`'${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/scripts/agent-loops/loop-wrapper\\.sh' configured deploy >>'${host.root}/logs/${SLUG}-configured-deploy\\.log'`));
  assert.ok(fs.existsSync(path.join(host.root, 'logs')), 'install creates the log directory');

  assert.equal(provision(host, 'cron', ['install']).status, 0);
  assert.equal(fs.readFileSync(host.crontabFile, 'utf8'), installed, 'a second install changes nothing');

  const status = provision(host, 'cron', ['status']);
  assert.equal(status.stdout.trim().split('\n').length, 6, 'status prints just the managed block');

  assert.equal(provision(host, 'cron', ['uninstall']).status, 0);
  assert.equal(fs.readFileSync(host.crontabFile, 'utf8'), 'MAILTO=me@example.com\n15 3 * * * /usr/bin/backup\n');
});

test('cron install works for a user with no crontab yet', () => {
  const host = fakeHost();
  const { status, stderr } = provision(host, 'cron', ['install']);
  assert.equal(status, 0, stderr);
  assert.match(fs.readFileSync(host.crontabFile, 'utf8'), new RegExp(`^# BEGIN project-admin agent loops: ${SLUG} `));
});

test('systemd install writes user units, replaces stale ones, and enables every timer', () => {
  const host = fakeHost();
  const unitDir = path.join(host.root, 'config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  fs.writeFileSync(path.join(unitDir, `projectadmin-${SLUG}-loop-old-bug.timer`), '[Timer]\n');
  fs.writeFileSync(path.join(unitDir, `projectadmin-${SLUG}-loop-old-bug.service`), '[Service]\n');
  fs.writeFileSync(path.join(unitDir, 'projectadmin-other-app-loop-sol-bug.timer'), '[Timer]\n');
  fs.writeFileSync(path.join(unitDir, 'unrelated.service'), '[Service]\n');
  const { status, stderr, record } = provision(host, 'systemd', ['install']);
  assert.equal(status, 0, stderr);
  assert.deepEqual(fs.readdirSync(unitDir).sort(), [
    'projectadmin-other-app-loop-sol-bug.timer',
    `projectadmin-${SLUG}-loop-configured-deploy.service`, `projectadmin-${SLUG}-loop-configured-deploy.timer`,
    `projectadmin-${SLUG}-loop-grok-feature.service`, `projectadmin-${SLUG}-loop-grok-feature.timer`,
    `projectadmin-${SLUG}-loop-sol-feature.service`, `projectadmin-${SLUG}-loop-sol-feature.timer`,
    'unrelated.service',
  ].sort());
  assert.match(record, new RegExp(`systemctl --user disable --now projectadmin-${SLUG}-loop-old-bug\\.timer`));
  assert.doesNotMatch(record, /other-app/, 'another project\'s units are untouched');
  assert.match(record, /systemctl --user daemon-reload/);
  for (const job of ['sol-feature', 'grok-feature', 'configured-deploy']) {
    assert.match(record, new RegExp(`systemctl --user enable --now projectadmin-${SLUG}-loop-${job}\\.timer`));
  }
  assert.match(fs.readFileSync(path.join(unitDir, `projectadmin-${SLUG}-loop-sol-feature.service`), 'utf8'), /Environment="PROJECT_ADMIN_MACHINE_ID=ci-box"/);
  assert.match(provision(host, 'systemd', ['status']).record, new RegExp(`list-timers projectadmin-${SLUG}-loop-\\*`));

  assert.equal(provision(host, 'systemd', ['uninstall']).status, 0);
  assert.deepEqual(fs.readdirSync(unitDir).sort(), ['projectadmin-other-app-loop-sol-bug.timer', 'unrelated.service']);
});

test('launchd install bootstraps one namespaced plist per job and migrates this checkout\'s legacy labels', () => {
  const host = fakeHost();
  const agentsDir = path.join(host.root, 'Library/LaunchAgents');
  fs.mkdirSync(agentsDir, { recursive: true });
  // Pre-namespacing labels: one from this checkout, one from another project.
  fs.writeFileSync(path.join(agentsDir, 'com.projectadmin.loop.sol-bug.plist'), `<string>${REPO}/scripts/agent-loops/loop-wrapper.sh</string>`);
  fs.writeFileSync(path.join(agentsDir, 'com.projectadmin.loop.opus-bug.plist'), '<string>/elsewhere/scripts/agent-loops/loop-wrapper.sh</string>');
  fs.writeFileSync(path.join(agentsDir, 'com.projectadmin.other-app.loop.sol-bug.plist'), '<string>/elsewhere</string>');
  const { status, stderr, record } = provision(host, 'launchd', ['install']);
  assert.equal(status, 0, stderr);
  assert.deepEqual(fs.readdirSync(agentsDir).sort(), [
    'com.projectadmin.loop.opus-bug.plist',
    `com.projectadmin.${SLUG}.loop.configured-deploy.plist`, `com.projectadmin.${SLUG}.loop.grok-feature.plist`, `com.projectadmin.${SLUG}.loop.sol-feature.plist`,
    'com.projectadmin.other-app.loop.sol-bug.plist',
  ].sort());
  assert.match(record, /launchctl bootout gui\/\d+\/com\.projectadmin\.loop\.sol-bug$/m, 'the legacy job is unloaded');
  assert.doesNotMatch(record, /opus-bug|other-app/, 'other checkouts\' jobs are untouched');
  assert.equal((record.match(/^launchctl bootstrap gui\/\d+ /gm) || []).length, 3);
  assert.equal(provision(host, 'launchd', ['uninstall']).status, 0);
  assert.deepEqual(fs.readdirSync(agentsDir).sort(), ['com.projectadmin.loop.opus-bug.plist', 'com.projectadmin.other-app.loop.sol-bug.plist']);
});

test('a dry run prints the units without touching any scheduler', () => {
  const host = fakeHost();
  for (const scheduler of ['launchd', 'systemd', 'cron', 'foreground']) {
    const { status, stdout, stderr } = provision(host, scheduler, ['install', '--dry-run'], { PROJECT_ADMIN_PROVISION_OFFLINE: '' });
    assert.equal(status, 0, `${scheduler}: ${stderr}`);
    assert.match(stdout, new RegExp(`Dry run: ${scheduler} jobs for ci-box`));
    assert.match(stdout, /configured/);
  }
  assert.equal(fs.existsSync(host.record), false, 'no launchctl, systemctl, or crontab call was made');
  assert.equal(fs.existsSync(host.crontabFile), false);
});

test('foreground installs nothing and an unknown scheduler is refused', () => {
  const host = fakeHost();
  const foreground = provision(host, 'foreground', ['install']);
  assert.equal(foreground.status, 0, foreground.stderr);
  assert.match(foreground.stdout, /npm run loops/);
  assert.equal(foreground.record, '');
  const bogus = provision(host, 'anacron', ['status']);
  assert.equal(bogus.status, 2);
  assert.match(bogus.stderr, /Unknown scheduler "anacron"/);
});
