'use strict';

// Local-only behaviour: two real CLI processes racing for one claim on the
// same file, crash recovery of the lockfile, attachments as files, the JSON
// encoding on disk, and bootstrap-admin for the local and github backends.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const { createLocalStore, attachmentFileFor } = require('../lib/store/local-store');
const { localStorePath } = require('../lib/store');
const { resolveBackend } = require('../lib/project-config');

const SCRIPTS = path.join(__dirname, '..');
const run = promisify(execFile);

function workspace(t, backend = { type: 'local' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(SCRIPTS, '..', 'project-admin.config.json'), 'utf8'));
  config.backend = backend;
  delete config.firebase;
  const configPath = path.join(dir, 'project-admin.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  const file = path.join(dir, 'state', 'store.json');
  const env = { ...process.env, PROJECT_ADMIN_CONFIG: configPath, PROJECT_ADMIN_LOCAL_STORE: file, PROJECT_ADMIN_MACHINE_ID: 'local-mac', HOME: dir };
  const cli = async (...argv) => JSON.parse((await run(process.execPath, [path.join(SCRIPTS, 'work-agent.js'), ...argv], { env })).stdout);
  return { dir, file, env, cli };
}

test('two CLI processes racing for the same item: exactly one claims it', async (t) => {
  const { file, cli } = workspace(t);
  const created = await cli('--kind', 'task', 'create', '--as', 'sol', '--title', 'Race', '--description', 'One winner');
  assert.equal(created.ref, 'TASK-1');
  const results = await Promise.all([cli('--kind', 'task', 'next', '--as', 'sol'), cli('--kind', 'task', 'next', '--as', 'sol')]);
  assert.equal(results.filter((result) => result.id === created.id).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.none).length, 1);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.collections.workItems[created.id].claimedBy, 'sol');
  assert.match(raw.collections.workItems[created.id].leaseExpiresAt.$ts, /^\d{4}-\d\d-\d\dT/, 'timestamps are ISO on disk');
  assert.equal(raw.collections.system.counters.nextTaskNumber, 1);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('a lock left by a dead process is broken; a live one is waited for', async (t) => {
  const { file } = workspace(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.lock`, '999999 0');
  const store = createLocalStore({ file });
  await store.system.merge('counters', { nextFeatureNumber: 3 });
  assert.equal((await store.system.get('counters')).nextFeatureNumber, 3);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('attachments are copied beside the store and resolve back to files only inside it', async (t) => {
  const { dir, file } = workspace(t);
  const source = path.join(dir, 'shot.png');
  fs.writeFileSync(source, Buffer.from([0x89, 0x50]));
  const store = createLocalStore({ file });
  const [url] = await store.attachments.upload(source, { uploader: 'agent-sol', kind: 'bug', itemId: 'abc' });
  assert.match(url, /^\/attachments\/agent-sol\/bug\/abc\/[0-9a-f-]{36}-shot\.png$/);
  const stored = attachmentFileFor(store.attachmentsDir, url);
  assert.deepEqual(fs.readFileSync(stored), Buffer.from([0x89, 0x50]));
  assert.equal(attachmentFileFor(store.attachmentsDir, '/attachments/../store.json'), null);
  assert.equal(attachmentFileFor(store.attachmentsDir, '/attachments/%2e%2e/store.json'), null);
});

test('the default local path is shared by every worktree: ~/<stateDirectory>/<slug>/store.json', () => {
  const config = { project: { slug: 'rocket' }, automation: { stateDirectory: '.project-admin' }, backend: { type: 'local' } };
  assert.equal(localStorePath(config, { env: {}, home: '/home/me' }), '/home/me/.project-admin/rocket/store.json');
  assert.equal(localStorePath({ ...config, backend: { type: 'local', path: '~/data/pa.json' } }, { env: {}, home: '/home/me' }), '/home/me/data/pa.json');
  assert.equal(localStorePath({ ...config, backend: { type: 'local', path: '/srv/pa.json' } }, { env: {}, home: '/home/me' }), '/srv/pa.json');
  assert.throws(() => resolveBackend({ backend: { type: 'sqlite' } }), /backend.type must be one of firestore, local, github/);
  assert.throws(() => resolveBackend({ backend: { type: 'local', repository: 'a/b' } }), /backend.repository is not a local backend option/);
  assert.deepEqual(resolveBackend({ repository: { slug: 'acme/app' }, backend: { type: 'github' } }), { type: 'github', repository: 'acme/app', labelPrefix: 'pa:' });
  assert.deepEqual(resolveBackend({}), { type: 'firestore' });
});

test('bootstrap-admin writes the owner and counters locally and is a no-op for github', async (t) => {
  const local = workspace(t);
  const output = JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, 'admin-users.js'), 'add'], { env: local.env, encoding: 'utf8' }));
  assert.deepEqual([output.ok, output.email, output.backend], [true, 'owner@example.com', 'local']);
  const store = createLocalStore({ file: local.file });
  assert.equal((await store.users.get('owner@example.com')).role, 'admin');
  assert.equal((await store.system.get('counters')).nextFeatureNumber, 0);
  assert.equal((await store.system.get('agentLoopConfig')).deployAgent, 'sonnet');

  const github = workspace(t, { type: 'github', repository: 'acme/app' });
  const skipped = JSON.parse(execFileSync(process.execPath, [path.join(SCRIPTS, 'admin-users.js'), 'add'], { env: github.env, encoding: 'utf8' }));
  assert.equal(skipped.skipped, true);
  assert.match(skipped.message, /write, maintain, or admin permission on acme\/app/);
});
