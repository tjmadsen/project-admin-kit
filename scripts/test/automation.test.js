'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  defaultScheduler,
  hostName,
  logDirectory,
  machineIdFor,
  resolveScheduler,
} = require('../lib/automation');

const CONFIG = { automation: { defaultMachineId: 'local-mac', logDirectoryName: 'ProjectAdminAgentLoops' } };

test('the scheduler defaults by platform and accepts only known schedulers', () => {
  assert.equal(defaultScheduler('darwin'), 'launchd');
  assert.equal(defaultScheduler('linux'), 'systemd');
  assert.equal(defaultScheduler('win32'), 'foreground');
  assert.equal(resolveScheduler({}, 'linux'), 'systemd');
  assert.equal(resolveScheduler({ scheduler: 'cron' }, 'darwin'), 'cron');
  assert.throws(() => resolveScheduler({ scheduler: 'anacron' }), /Invalid automation\.scheduler "anacron"/);
});

test('the machine id comes from the environment, then a roster hostname match, then the default', () => {
  const roster = { machines: [{ id: 'build-box', hostnames: ['build-01', 'Build-02.local'] }, { id: 'local-mac' }] };
  assert.equal(machineIdFor({ env: { PROJECT_ADMIN_MACHINE_ID: 'pinned' }, config: CONFIG, roster, host: 'build-01' }), 'pinned');
  assert.equal(machineIdFor({ env: {}, config: CONFIG, roster, host: 'build-01.example.internal' }), 'build-box');
  assert.equal(machineIdFor({ env: {}, config: CONFIG, roster, host: 'build-02' }), 'build-box');
  assert.equal(machineIdFor({ env: {}, config: CONFIG, roster, host: 'laptop' }), 'local-mac');
});

test('the hostname uses scutil on macOS and the kernel hostname elsewhere', () => {
  const calls = [];
  const exec = (file, args) => { calls.push([file, ...args]); return 'Studio\n'; };
  assert.equal(hostName({ platform: 'darwin', exec }), 'Studio');
  assert.deepEqual(calls, [['/usr/sbin/scutil', '--get', 'LocalHostName']]);
  const failing = () => { throw new Error('no scutil'); };
  assert.ok(hostName({ platform: 'darwin', exec: failing }).length > 0, 'falls back when scutil fails');
  calls.length = 0;
  assert.ok(hostName({ platform: 'linux', exec }).length > 0);
  assert.deepEqual(calls, [], 'scutil is never called off macOS');
});

test('loop logs go to ~/Library/Logs on macOS and the XDG state directory elsewhere', () => {
  assert.equal(logDirectory(CONFIG, { env: {}, platform: 'darwin', home: '/Users/me' }), '/Users/me/Library/Logs/ProjectAdminAgentLoops');
  assert.equal(logDirectory(CONFIG, { env: {}, platform: 'linux', home: '/home/me' }), path.join('/home/me', '.local', 'state', 'ProjectAdminAgentLoops'));
  assert.equal(logDirectory(CONFIG, { env: { XDG_STATE_HOME: '/state' }, platform: 'linux', home: '/home/me' }), '/state/ProjectAdminAgentLoops');
  assert.equal(logDirectory(CONFIG, { env: { PROJECT_ADMIN_LOOP_LOG_DIR: '/var/log/loops' }, platform: 'linux' }), '/var/log/loops');
});
