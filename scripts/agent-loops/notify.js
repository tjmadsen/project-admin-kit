#!/usr/bin/env node
'use strict';

// Loop alerts (today: an expired headless CLI session) go through here so the
// channel is configuration rather than a hardcoded osascript call.
//
//   notify.js --title "..." --message "..." [--level info|warning|error]
//
// `notifications` in project-admin.config.json picks the channels:
//   desktop  osascript on macOS, notify-send on Linux when installed, otherwise
//            skipped (default true)
//   webhook  { urlEnv?: "PROJECT_ADMIN_NOTIFY_WEBHOOK_URL", format?: json|slack|ntfy }
//            POSTs to the URL held in that environment variable; nothing is
//            sent while the variable is unset
//
// A notification must never fail a loop: every channel error is reported on
// stderr and the exit code stays 0. Each channel's outcome is printed on stdout.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { resolveNotifications } = require('../lib/automation');

const LEVELS = ['info', 'warning', 'error'];
const WEBHOOK_TIMEOUT_MS = 10000;

function which(binary, envPath = process.env.PATH || '') {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The command a desktop alert runs on this platform, or null when there is none.
function desktopCommand({ title, message, level }, { platform = process.platform, envPath } = {}) {
  if (platform === 'darwin') {
    const osascript = which('osascript', envPath);
    if (!osascript) return null;
    const sound = level === 'error' ? ' sound name "Basso"' : '';
    return [osascript, ['-e', `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}${sound}`]];
  }
  if (platform === 'linux') {
    const notifySend = which('notify-send', envPath);
    if (!notifySend) return null;
    const urgency = level === 'error' ? 'critical' : level === 'warning' ? 'normal' : 'low';
    return [notifySend, ['--urgency', urgency, '--app-name', 'Project Admin', title, message]];
  }
  return null;
}

// Body and headers for each webhook flavor. `json` is the generic contract;
// Slack incoming webhooks need `text`; ntfy topics take a plain body plus
// Title/Priority/Tags headers.
function webhookRequest({ title, message, level }, format) {
  if (format === 'slack') {
    const icon = level === 'error' ? ':rotating_light:' : level === 'warning' ? ':warning:' : ':information_source:';
    return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${icon} *${title}*\n${message}` }) };
  }
  if (format === 'ntfy') {
    const priority = level === 'error' ? '5' : level === 'warning' ? '4' : '3';
    // HTTP header values must be Latin-1; keep the title ASCII.
    return { headers: { 'content-type': 'text/plain', title: title.replace(/[^\x20-\x7e]/g, '?'), priority, tags: level }, body: message };
  }
  return { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, message, level }) };
}

function run([command, args]) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10000 }, (error) => (error ? reject(error) : resolve()));
  });
}

async function notify(alert, { settings, env = process.env, platform = process.platform, exec = run, fetchImpl = globalThis.fetch } = {}) {
  const level = LEVELS.includes(alert.level) ? alert.level : 'info';
  const payload = { title: String(alert.title || 'Project Admin loops'), message: String(alert.message || ''), level };
  const results = {};

  if (settings.desktop) {
    const command = desktopCommand(payload, { platform, envPath: env.PATH });
    if (!command) {
      results.desktop = `skipped (no desktop notifier on ${platform})`;
    } else {
      try {
        await exec(command);
        results.desktop = `sent via ${path.basename(command[0])}`;
      } catch (error) {
        results.desktop = `failed: ${error.message}`;
      }
    }
  } else {
    results.desktop = 'disabled';
  }

  if (settings.webhook) {
    const url = env[settings.webhook.urlEnv];
    if (!url) {
      results.webhook = `skipped (${settings.webhook.urlEnv} is not set)`;
    } else {
      try {
        const request = webhookRequest(payload, settings.webhook.format);
        const response = await fetchImpl(url, { method: 'POST', ...request, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
        results.webhook = response.ok ? `sent (${settings.webhook.format}, HTTP ${response.status})` : `failed: HTTP ${response.status}`;
      } catch (error) {
        results.webhook = `failed: ${error.message}`;
      }
    }
  }
  return results;
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--(title|message|level)$/.exec(argv[index]);
    if (!match) throw new Error(`Unknown argument ${argv[index]}`);
    flags[match[1]] = argv[index + 1] ?? '';
    index += 1;
  }
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const alert = parseArgs(argv);
  let settings;
  try {
    const { loadProjectConfig } = require('../lib/project-config');
    settings = resolveNotifications(loadProjectConfig().notifications);
  } catch (error) {
    // A broken config must not swallow the alert that may be reporting it.
    console.error(`notify: ${error.message}; falling back to a desktop alert`);
    settings = { desktop: true, webhook: null };
  }
  const results = await notify(alert, { settings });
  for (const [channel, outcome] of Object.entries(results)) {
    (outcome.startsWith('failed') ? console.error : console.log)(`notify: ${channel} ${outcome}`);
  }
}

module.exports = { desktopCommand, notify, webhookRequest, which };

if (require.main === module) {
  main().catch((error) => {
    console.error(`notify: ${error.message}`);
  });
}
