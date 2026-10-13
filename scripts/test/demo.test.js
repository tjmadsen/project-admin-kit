'use strict';

// `npm run demo`: the screenshot fixtures seed a local store that the CLI store
// and the local server both read. The console build itself is covered by
// `npm run build`; here a stub index.html stands in for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { demoConfig, loadFixtures, parseArgs, seedDemoStore } = require('../demo');
const { createLocalServer } = require('../local-server');
const { createLocalStore } = require('../lib/store/local-store');
const { ROOT } = require('../lib/project-config');

const hasConsoleDeps = (() => {
  try { require.resolve('esbuild', { paths: [path.join(ROOT, 'admin-app')] }); return true; } catch { return false; }
})();
const skip = hasConsoleDeps ? false : 'admin-app dependencies are not installed';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-demo-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('parses demo options and points the store into the demo directory', () => {
  assert.deepEqual(parseArgs(['--port', '0', '--dir', '/tmp/x', '--no-build']), { port: 0, dir: path.resolve('/tmp/x'), build: false, serve: true });
  assert.equal(parseArgs(['--seed-only']).serve, false);
  assert.throws(() => parseArgs(['--port', 'nope']), /Invalid --port/);
  assert.throws(() => parseArgs(['--bogus']), /Unknown option/);
  const config = demoConfig('/tmp/demo', { schemaVersion: 1, backend: { type: 'firestore' }, project: { name: 'X' } });
  assert.deepEqual(config.backend, { type: 'local', path: path.join('/tmp/demo', 'store.json') });
});

test('seeds the fixtures into a local store the CLI store reads', { skip }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'store.json');
  const config = demoConfig(dir);
  const fixtures = loadFixtures();
  const counts = await seedDemoStore({ file, config, fixtures });
  assert.equal(counts.workItems, fixtures.features.length + fixtures.bugs.length + fixtures.tasks.length);
  assert.equal(counts.agentLoopRuns, fixtures.runs.length);
  assert.equal(counts.agentMachines, fixtures.machines.length);

  const store = createLocalStore({ file });
  const items = await store.items.list();
  assert.deepEqual([...new Set(items.map((item) => item.kind))].sort(), ['bug', 'feature', 'task']);
  assert.ok(new Set(items.map((item) => item.blockedReason).filter(Boolean)).size >= 4, 'items sit at several gates');
  const detail = await store.items.get('fr-25');
  assert.equal(typeof detail.updatedAt.toMillis(), 'number');
  assert.equal(typeof detail.messages[0].createdAt.toMillis(), 'number');
  const counters = await store.system.get('counters');
  assert.equal(counters.nextFeatureNumber, Math.max(...fixtures.features.map((item) => item.number)));
  assert.equal((await store.system.get('agentLoopConfig')).deployAgent, fixtures.loopConfig.deployAgent);
  assert.equal((await store.users.get(config.admin.ownerEmail.toLowerCase())).role, 'admin');

  // Reseeding replaces rather than appends.
  await store.items.update('fr-25', { title: 'edited' });
  await seedDemoStore({ file, config, fixtures });
  assert.equal((await store.items.get('fr-25')).title, fixtures.features[0].title);
});

test('the local server answers over the seeded store', { skip }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'store.json');
  const config = demoConfig(dir);
  await seedDemoStore({ file, config });
  const publicDir = path.join(dir, 'admin');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><div id="root"></div>');
  const server = createLocalServer({ store: createLocalStore({ file }), config, publicDir, watchIntervalMs: 50 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const items = await (await fetch(`${origin}/api/collections/workItems?orderBy=updatedAt&direction=desc`)).json();
  assert.ok(items.docs.length > 10);
  assert.match(items.docs[0].updatedAt.$ts, /^\d{4}-/);
  const runs = await (await fetch(`${origin}/api/collections/agentLoopRuns`)).json();
  assert.ok(runs.docs.some((run) => run.status === 'running'));
  const usage = await (await fetch(`${origin}/api/docs/system/agentLoopUsage`)).json();
  assert.equal(usage.exists, true);
  const shell = await fetch(`${origin}${config.project.adminPath}/features`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /id="root"/);
});
