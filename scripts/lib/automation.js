#!/usr/bin/env node
'use strict';

// Host-level automation settings shared by the provisioner, the foreground
// scheduler, and the notifier, so each platform difference is decided once:
//
//   automation.scheduler   launchd | systemd | cron | foreground
//                          (default: launchd on macOS, systemd on Linux,
//                          foreground anywhere else)
//   notifications          { desktop?: boolean, webhook?: { urlEnv?, format? } }
//
// plus where loop logs go and which machine-roster entry this host is.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCHEDULERS = Object.freeze(['launchd', 'systemd', 'cron', 'foreground']);
const WEBHOOK_FORMATS = Object.freeze(['json', 'slack', 'ntfy']);
const DEFAULT_WEBHOOK_ENV = 'PROJECT_ADMIN_NOTIFY_WEBHOOK_URL';
const ROSTER_PATH = path.resolve(__dirname, '..', 'agent-loops', 'machine-roster.json');

function defaultScheduler(platform = process.platform) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return 'foreground';
}

function resolveScheduler(automation = {}, platform = process.platform) {
  const value = automation.scheduler;
  if (value === undefined) return defaultScheduler(platform);
  if (!SCHEDULERS.includes(value)) throw new Error(`Invalid automation.scheduler "${value}". One of: ${SCHEDULERS.join(', ')}`);
  return value;
}

// Absent `notifications` keeps the old behavior: a desktop alert only.
function resolveNotifications(raw) {
  if (raw === undefined) return { desktop: true, webhook: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid notifications: must be an object');
  for (const key of Object.keys(raw)) {
    if (!['desktop', 'webhook'].includes(key)) throw new Error(`Invalid notifications.${key}: not a known field`);
  }
  if (raw.desktop !== undefined && typeof raw.desktop !== 'boolean') throw new Error('Invalid notifications.desktop: must be true or false');
  let webhook = null;
  if (raw.webhook !== undefined && raw.webhook !== false) {
    const entry = raw.webhook === true ? {} : raw.webhook;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid notifications.webhook: must be an object or true');
    for (const key of Object.keys(entry)) {
      if (!['urlEnv', 'format'].includes(key)) throw new Error(`Invalid notifications.webhook.${key}: not a known field`);
    }
    const urlEnv = entry.urlEnv ?? DEFAULT_WEBHOOK_ENV;
    // The URL is a secret (Slack and ntfy URLs grant posting rights), so config
    // only names the environment variable that holds it.
    if (typeof urlEnv !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(urlEnv)) throw new Error('Invalid notifications.webhook.urlEnv: must be an environment variable name');
    const format = entry.format ?? 'json';
    if (!WEBHOOK_FORMATS.includes(format)) throw new Error(`Invalid notifications.webhook.format "${format}". One of: ${WEBHOOK_FORMATS.join(', ')}`);
    webhook = { urlEnv, format };
  }
  return { desktop: raw.desktop !== false, webhook };
}

// macOS: the LocalHostName (stable, no `.local` suffix games) by absolute path,
// because launchd's PATH omits /usr/sbin. Elsewhere: the kernel hostname.
function hostName({ platform = process.platform, exec = execFileSync } = {}) {
  if (platform === 'darwin') {
    try {
      const name = String(exec('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
      if (name) return name;
    } catch { /* fall through */ }
  }
  const name = os.hostname() || '';
  if (name) return name;
  try {
    return fs.readFileSync('/etc/hostname', 'utf8').trim();
  } catch {
    return 'localhost';
  }
}

function sameHost(a, b) {
  const clean = (value) => String(value || '').toLowerCase().replace(/\.local$/, '').split('.')[0];
  return clean(a) !== '' && clean(a) === clean(b);
}

function loadRoster(rosterPath = process.env.PROJECT_ADMIN_MACHINE_ROSTER || ROSTER_PATH) {
  try {
    return JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
  } catch {
    return { machines: [] };
  }
}

// PROJECT_ADMIN_MACHINE_ID wins; otherwise the roster entry whose optional
// `hostnames` list names this host; otherwise automation.defaultMachineId.
function machineIdFor({ env = process.env, config, roster = loadRoster(), host = hostName() } = {}) {
  if (env.PROJECT_ADMIN_MACHINE_ID) return env.PROJECT_ADMIN_MACHINE_ID;
  const match = (roster.machines || []).find((machine) => Array.isArray(machine?.hostnames)
    && machine.hostnames.some((name) => sameHost(name, host)));
  return match ? match.id : config.automation.defaultMachineId;
}

// launchd/Console.app convention on macOS, XDG state directory elsewhere.
function logDirectory(config, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (env.PROJECT_ADMIN_LOOP_LOG_DIR) return env.PROJECT_ADMIN_LOOP_LOG_DIR;
  const name = config.automation.logDirectoryName || 'ProjectAdminAgentLoops';
  if (platform === 'darwin') return path.join(home, 'Library', 'Logs', name);
  return path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), name);
}

function main(argv = process.argv.slice(2)) {
  const { loadProjectConfig } = require('./project-config');
  const config = loadProjectConfig();
  const values = {
    scheduler: () => resolveScheduler(config.automation),
    'machine-id': () => machineIdFor({ config }),
    hostname: () => hostName(),
    'log-dir': () => logDirectory(config),
    notifications: () => JSON.stringify(resolveNotifications(config.notifications)),
  };
  const getter = values[argv[0]];
  if (!getter) {
    console.error(`Usage: automation.js <${Object.keys(values).join('|')}>`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${getter()}\n`);
}

module.exports = {
  DEFAULT_WEBHOOK_ENV,
  SCHEDULERS,
  WEBHOOK_FORMATS,
  defaultScheduler,
  hostName,
  loadRoster,
  logDirectory,
  machineIdFor,
  resolveNotifications,
  resolveScheduler,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
