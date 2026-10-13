#!/usr/bin/env node
'use strict';

// One job set, four schedulers. machine-roster.json entitles this host to
// agent x queue loops; every scheduler gets exactly one job per entitlement,
// except that all deploy entitlements collapse into the single `configured`
// deploy dispatcher (the dashboard picks the deploy model at poll time).
//
//   launchd     ~/Library/LaunchAgents/com.projectadmin.loop.<agent>-<queue>.plist
//   systemd     ~/.config/systemd/user/projectadmin-loop-<agent>-<queue>.{service,timer}
//   cron        one marked block in the user's crontab
//   foreground  scheduler.js (`npm run loops`), which reads loopJobs() directly
//
// provision-machine.sh applies what this renders; nothing here touches the
// system, so the output can be tested and previewed with `install --dry-run`.
//
//   index.js jobs                          <id> <agent> <queue> <interval> per line
//   index.js render <launchd|systemd> DIR  write unit files into DIR
//   index.js render cron                   print the crontab block
//   index.js crontab-merge | crontab-strip existing crontab on stdin, result on stdout

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEPLOY_INTERVAL_SECONDS = 900;
const LAUNCHD_PREFIX = 'com.projectadmin.loop.';
const SYSTEMD_PREFIX = 'projectadmin-loop-';
const CRON_BEGIN = '# BEGIN project-admin agent loops (managed by provision-machine.sh; edits are replaced)';
const CRON_END = '# END project-admin agent loops';

function loopJobs({ config, roster, machineId }) {
  const { entitlements } = require('../roster-check');
  const { normalizeRoster } = require('../../lib/agent-roster');
  const agents = normalizeRoster(config).agents;
  const jobs = [];
  let deployAdded = false;
  for (const { queue, agent } of entitlements(roster, machineId, Object.keys(agents))) {
    if (queue === 'deploy') {
      if (deployAdded) continue;
      deployAdded = true;
      jobs.push({ id: 'configured-deploy', agent: 'configured', queue, interval: DEPLOY_INTERVAL_SECONDS });
    } else {
      jobs.push({ id: `${agent}-${queue}`, agent, queue, interval: agents[agent].pollSeconds });
    }
  }
  return jobs;
}

function template(name) {
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

function fill(text, values) {
  return text.replace(/__([A-Z]+)__/g, (match, key) => (key in values ? values[key] : match));
}

function escapeXml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// systemd expands `%` specifiers and unescapes `\` and `"` inside quotes.
function escapeSystemd(value) {
  return String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// cron passes the line to /bin/sh, except that an unescaped `%` ends the command.
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`).replace(/%/g, '\\%')}'`;
}

function renderLaunchd(job, ctx) {
  const values = { LABEL: `${LAUNCHD_PREFIX}${job.id}`, REPO: ctx.repoRoot, AGENT: job.agent, QUEUE: job.queue, INTERVAL: job.interval, LOGDIR: ctx.logDir, MACHINE: ctx.machineId, PATH: ctx.path };
  const escaped = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, escapeXml(value)]));
  return { [`${LAUNCHD_PREFIX}${job.id}.plist`]: fill(template('launchd.plist.template'), escaped) };
}

function renderSystemd(job, ctx, index = 0) {
  const unit = `${SYSTEMD_PREFIX}${job.id}`;
  const values = {
    UNIT: unit, REPO: escapeSystemd(ctx.repoRoot), AGENT: job.agent, QUEUE: job.queue, INTERVAL: job.interval,
    LOGDIR: ctx.logDir.replace(/%/g, '%%'), MACHINE: escapeSystemd(ctx.machineId), PATH: escapeSystemd(ctx.path),
    // Stagger first fires three seconds apart so twenty loops do not all start
    // their git fetch in the same instant.
    DELAY: 5 + index * 3,
  };
  return {
    [`${unit}.service`]: fill(template('systemd.service.template'), values),
    [`${unit}.timer`]: fill(template('systemd.timer.template'), values),
  };
}

// cron is minute-granular. Sub-hour intervals that divide the hour get an
// offset (`2-59/5`) so loops are staggered; others round to `*/N`, which
// restarts at each hour boundary. Hour-scale intervals fire hourly at an offset.
function cronSchedule(intervalSeconds, index = 0) {
  const minutes = Math.max(1, Math.round(intervalSeconds / 60));
  if (minutes === 1) return '* * * * *';
  if (minutes < 60) return 60 % minutes === 0 ? `${index % minutes}-59/${minutes} * * * *` : `*/${minutes} * * * *`;
  const hours = Math.round(minutes / 60);
  if (hours >= 24) return `${index % 60} 0 * * *`;
  return `${index % 60} ${hours === 1 ? '*' : `*/${hours}`} * * *`;
}

function renderCronBlock(jobs, ctx) {
  const line = template('cron.line.template').trim();
  const lines = jobs.map((job, index) => fill(line, {
    SCHEDULE: cronSchedule(job.interval, index),
    PATH: shellQuote(ctx.path),
    MACHINE: shellQuote(ctx.machineId),
    WRAPPER: shellQuote(path.join(ctx.repoRoot, 'scripts/agent-loops/loop-wrapper.sh')),
    AGENT: job.agent,
    QUEUE: job.queue,
    LOG: shellQuote(path.join(ctx.logDir, `${job.agent}-${job.queue}.log`)),
    ERRLOG: shellQuote(path.join(ctx.logDir, `${job.agent}-${job.queue}.error.log`)),
  }));
  return [CRON_BEGIN, `# repo: ${ctx.repoRoot} machine: ${ctx.machineId}`, ...lines, CRON_END].join('\n');
}

// Drops the managed block (and only it) from a crontab, keeping every other
// line in place.
function stripCrontab(existing) {
  const out = [];
  let inside = false;
  for (const line of String(existing || '').split('\n')) {
    if (line === CRON_BEGIN) { inside = true; continue; }
    if (inside) { if (line === CRON_END) inside = false; continue; }
    out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

// Replaces the managed block wherever it was, appending it on first install.
// Running it twice yields the same crontab.
function mergeCrontab(existing, block) {
  const kept = stripCrontab(existing);
  return `${kept ? `${kept}\n` : ''}${block}\n`;
}

function contextFromEnv() {
  const { loadProjectConfig } = require('../../lib/project-config');
  const { loadRoster, logDirectory, machineIdFor } = require('../../lib/automation');
  const config = loadProjectConfig();
  const roster = loadRoster();
  const machineId = machineIdFor({ config, roster });
  return {
    jobs: loopJobs({ config, roster, machineId }),
    ctx: { repoRoot: REPO_ROOT, machineId, logDir: logDirectory(config), path: process.env.PATH || '/usr/bin:/bin' },
  };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function writeFiles(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
}

function main(argv = process.argv.slice(2)) {
  const [command, kind, dir] = argv;
  if (command === 'crontab-strip') {
    const stripped = stripCrontab(readStdin());
    process.stdout.write(stripped ? `${stripped}\n` : '');
    return;
  }
  const { jobs, ctx } = contextFromEnv();
  if (command === 'jobs') {
    for (const job of jobs) console.log(`${job.id} ${job.agent} ${job.queue} ${job.interval}`);
  } else if (command === 'crontab-merge') {
    process.stdout.write(mergeCrontab(readStdin(), renderCronBlock(jobs, ctx)));
  } else if (command === 'render' && kind === 'cron') {
    console.log(renderCronBlock(jobs, ctx));
  } else if (command === 'render' && (kind === 'launchd' || kind === 'systemd') && dir) {
    jobs.forEach((job, index) => writeFiles(dir, kind === 'launchd' ? renderLaunchd(job, ctx) : renderSystemd(job, ctx, index)));
  } else {
    console.error('Usage: index.js <jobs|render launchd DIR|render systemd DIR|render cron|crontab-merge|crontab-strip>');
    process.exitCode = 2;
  }
}

module.exports = {
  CRON_BEGIN,
  CRON_END,
  DEPLOY_INTERVAL_SECONDS,
  LAUNCHD_PREFIX,
  SYSTEMD_PREFIX,
  cronSchedule,
  loopJobs,
  mergeCrontab,
  renderCronBlock,
  renderLaunchd,
  renderSystemd,
  stripCrontab,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
