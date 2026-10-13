'use strict';

// notify.js routing: desktop alerts per platform (fake osascript/notify-send on
// a private PATH) and webhook delivery to a local HTTP server in each format.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { desktopCommand, notify, webhookRequest } = require('../notify');
const { resolveNotifications } = require('../../lib/automation');

const NOTIFY = path.join(__dirname, '..', 'notify.js');
const REPO = path.join(__dirname, '..', '..', '..');
const ALERT = { title: 'Project Admin loops: auth expired', message: 'Run "claude setup-token".', level: 'error' };

function fakeBin(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-notify-'));
  const record = path.join(root, 'record.txt');
  for (const name of names) {
    fs.writeFileSync(path.join(root, name), `#!/usr/bin/env bash\n{ echo "${name}"; for arg in "$@"; do echo "ARG: $arg"; done; } >> '${record}'\n`, { mode: 0o755 });
  }
  return { root, record, read: () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8') : '') };
}

// A local webhook receiver that records each request.
async function receiver(status = 200) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(status).end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('notification settings default to a desktop alert and validate the webhook shape', () => {
  assert.deepEqual(resolveNotifications(undefined), { desktop: true, webhook: null });
  assert.deepEqual(resolveNotifications({ desktop: false, webhook: {} }), { desktop: false, webhook: { urlEnv: 'PROJECT_ADMIN_NOTIFY_WEBHOOK_URL', format: 'json' } });
  assert.deepEqual(resolveNotifications({ webhook: { urlEnv: 'NTFY_URL', format: 'ntfy' } }).webhook, { urlEnv: 'NTFY_URL', format: 'ntfy' });
  assert.throws(() => resolveNotifications({ webhook: { url: 'https://hooks.example' } }), /webhook\.url: not a known field/);
  assert.throws(() => resolveNotifications({ webhook: { urlEnv: 'https://hooks.example' } }), /environment variable name/);
  assert.throws(() => resolveNotifications({ webhook: { format: 'teams' } }), /format "teams"/);
  assert.throws(() => resolveNotifications({ email: true }), /notifications\.email/);
});

test('desktop alerts use osascript on macOS and notify-send on Linux, and skip when neither exists', () => {
  const bin = fakeBin(['osascript', 'notify-send']);
  const mac = desktopCommand(ALERT, { platform: 'darwin', envPath: bin.root });
  assert.equal(mac[0], path.join(bin.root, 'osascript'));
  assert.deepEqual(mac[1], ['-e', 'display notification "Run \\"claude setup-token\\"." with title "Project Admin loops: auth expired" sound name "Basso"']);
  const linux = desktopCommand(ALERT, { platform: 'linux', envPath: bin.root });
  assert.deepEqual(linux, [path.join(bin.root, 'notify-send'), ['--urgency', 'critical', '--app-name', 'Project Admin', ALERT.title, ALERT.message]]);
  assert.equal(desktopCommand(ALERT, { platform: 'linux', envPath: '/nonexistent' }), null);
  assert.equal(desktopCommand(ALERT, { platform: 'win32', envPath: bin.root }), null);
});

test('a desktop alert runs the platform notifier and reports a missing one as skipped', async () => {
  const bin = fakeBin(['notify-send']);
  const sent = await notify(ALERT, { settings: { desktop: true, webhook: null }, platform: 'linux', env: { PATH: bin.root } });
  assert.deepEqual(sent, { desktop: 'sent via notify-send' });
  assert.match(bin.read(), /^notify-send\nARG: --urgency\nARG: critical\n/);
  const skipped = await notify(ALERT, { settings: { desktop: true, webhook: null }, platform: 'linux', env: { PATH: '/nonexistent' } });
  assert.match(skipped.desktop, /^skipped/);
  const disabled = await notify(ALERT, { settings: { desktop: false, webhook: null }, platform: 'linux', env: { PATH: bin.root } });
  assert.deepEqual(disabled, { desktop: 'disabled' });
});

test('the webhook posts {title, message, level} JSON to the URL named by its env var', async () => {
  const hook = await receiver();
  try {
    const results = await notify(ALERT, {
      settings: { desktop: false, webhook: { urlEnv: 'TEST_HOOK_URL', format: 'json' } },
      env: { PATH: '', TEST_HOOK_URL: hook.url },
    });
    assert.equal(results.webhook, 'sent (json, HTTP 200)');
    assert.equal(hook.requests.length, 1);
    assert.equal(hook.requests[0].method, 'POST');
    assert.equal(hook.requests[0].headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(hook.requests[0].body), ALERT);

    const unset = await notify(ALERT, { settings: { desktop: false, webhook: { urlEnv: 'TEST_HOOK_URL', format: 'json' } }, env: {} });
    assert.equal(unset.webhook, 'skipped (TEST_HOOK_URL is not set)');
    assert.equal(hook.requests.length, 1, 'nothing is sent without a URL');
  } finally {
    await hook.close();
  }
});

test('Slack and ntfy formats shape the request for those services', async () => {
  assert.deepEqual(JSON.parse(webhookRequest(ALERT, 'slack').body), { text: `:rotating_light: *${ALERT.title}*\n${ALERT.message}` });
  const ntfy = webhookRequest({ ...ALERT, title: 'Loops — auth' }, 'ntfy');
  assert.equal(ntfy.body, ALERT.message);
  assert.deepEqual(ntfy.headers, { 'content-type': 'text/plain', title: 'Loops ? auth', priority: '5', tags: 'error' });

  const hook = await receiver();
  try {
    await notify({ ...ALERT, level: 'warning' }, { settings: { desktop: false, webhook: { urlEnv: 'HOOK', format: 'ntfy' } }, env: { HOOK: hook.url } });
    assert.equal(hook.requests[0].body, ALERT.message);
    assert.equal(hook.requests[0].headers.priority, '4');
    assert.equal(hook.requests[0].headers.title, ALERT.title);
  } finally {
    await hook.close();
  }
});

test('a failing webhook is reported, never thrown', async () => {
  const hook = await receiver(500);
  try {
    const results = await notify(ALERT, { settings: { desktop: false, webhook: { urlEnv: 'HOOK', format: 'json' } }, env: { HOOK: hook.url } });
    assert.equal(results.webhook, 'failed: HTTP 500');
  } finally {
    await hook.close();
  }
  const unreachable = await notify(ALERT, { settings: { desktop: false, webhook: { urlEnv: 'HOOK', format: 'json' } }, env: { HOOK: 'http://127.0.0.1:1/hook' } });
  assert.match(unreachable.webhook, /^failed: /);
});

test('the CLI reads notifications from config, posts the webhook, and always exits 0', async () => {
  const hook = await receiver();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-notify-config-'));
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
  config.notifications = { desktop: false, webhook: { urlEnv: 'PROJECT_ADMIN_NOTIFY_WEBHOOK_URL', format: 'slack' } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  try {
    const run = (env) => new Promise((resolve) => {
      const child = spawn(process.execPath, [NOTIFY, '--title', ALERT.title, '--message', ALERT.message, '--level', 'error'], {
        env: { ...process.env, PROJECT_ADMIN_CONFIG: path.join(dir, 'config.json'), ...env },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.on('exit', (code) => resolve({ code, stdout }));
    });
    const sent = await run({ PROJECT_ADMIN_NOTIFY_WEBHOOK_URL: hook.url });
    assert.equal(sent.code, 0);
    assert.match(sent.stdout, /notify: desktop disabled\nnotify: webhook sent \(slack, HTTP 200\)/);
    assert.match(JSON.parse(hook.requests[0].body).text, /auth expired/);

    fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
    const broken = await run({ PATH: '/nonexistent' });
    assert.equal(broken.code, 0, 'a broken config still exits 0 and falls back to a desktop alert');
  } finally {
    await hook.close();
  }
});
