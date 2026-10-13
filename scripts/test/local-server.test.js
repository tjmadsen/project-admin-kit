'use strict';

// The local server's API over a temp local store: session, documents with
// sentinels, numbered work-item creation, attachments, change events, the
// static admin shell, and the loopback/header guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createLocalServer, sortRows } = require('../local-server');
const { createLocalStore } = require('../lib/store/local-store');
const { loadProjectConfig } = require('../lib/project-config');

const config = loadProjectConfig();
const WRITE = { 'Content-Type': 'application/json', 'X-Project-Admin': 'local' };

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-server-'));
  const publicDir = path.join(dir, 'public', 'admin');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><div id="root"></div>');
  fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'console.log(1)');
  const store = createLocalStore({ file: path.join(dir, 'store.json') });
  const server = createLocalServer({ store, config, publicDir, watchIntervalMs: 50 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); fs.rmSync(dir, { recursive: true, force: true }); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, headers = WRITE) => {
    const response = await fetch(`${origin}${route}`, { method, headers, body: body === undefined ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    return { status: response.status, body: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(), headers: response.headers };
  };
  return { store, origin, call, server };
}

test('serves the owner session and documents with server-resolved sentinels', async (t) => {
  const { call } = await start(t);
  const session = await call('GET', '/api/session');
  assert.deepEqual([session.body.role, session.body.user.email, session.body.user.emailVerified], ['admin', 'owner@example.com', true]);

  assert.equal((await call('PUT', '/api/docs/system/agentLoopConfig', { data: { deployAgent: 'opus', updatedAt: { $op: 'serverTimestamp' } }, merge: true })).status, 200);
  const doc = await call('GET', '/api/docs/system/agentLoopConfig');
  assert.equal(doc.body.exists, true);
  assert.equal(doc.body.data.deployAgent, 'opus');
  assert.match(doc.body.data.updatedAt.$ts, /^\d{4}-/);
  assert.deepEqual((await call('GET', '/api/docs/system/missing')).body, { exists: false, data: null });
  assert.equal((await call('PATCH', '/api/docs/workItems/nope', { patch: { title: 'x' } })).status, 404);
  assert.equal((await call('GET', '/api/collections/secrets')).status, 400);
});

test('creates numbered work items atomically and applies console patches', async (t) => {
  const { call, store } = await start(t);
  const created = await call('POST', '/api/work-items', { id: 'draft-item-1', counterField: 'nextFeatureNumber', data: { kind: 'feature', title: 'One', messages: [], createdAt: { $op: 'serverTimestamp' } } });
  assert.deepEqual(created.body, { id: 'draft-item-1', number: 1 });
  const second = await call('POST', '/api/work-items', { id: 'draft-item-2', counterField: 'nextFeatureNumber', data: { kind: 'feature', title: 'Two', messages: [] } });
  assert.equal(second.body.number, 2);
  assert.equal((await call('POST', '/api/work-items', { id: 'draft-item-2', counterField: 'nextFeatureNumber', data: {} })).status, 400, 'ids are never overwritten');

  const note = { author: 'Project owner', body: 'Approved', createdAt: { $ts: '2026-01-01T00:00:00.000Z' } };
  await call('PATCH', '/api/docs/workItems/draft-item-1', { patch: { waitingOn: 'agent', messages: { $op: 'arrayUnion', values: [note] }, updatedAt: { $op: 'serverTimestamp' } } });
  const item = await store.items.get('draft-item-1');
  assert.equal(item.waitingOn, 'agent');
  assert.equal(item.messages[0].createdAt.toMillis(), Date.parse('2026-01-01T00:00:00.000Z'));
  const list = await call('GET', '/api/collections/workItems?orderBy=updatedAt&direction=desc&limit=1');
  assert.deepEqual(list.body.docs.map((row) => row.id), ['draft-item-1'], 'most recently updated first');
});

test('stores, serves, and deletes attachments', async (t) => {
  const { call, origin } = await start(t);
  const uploaded = await call('POST', '/api/attachments?uploader=local-owner&kind=bug&itemId=item1&name=shot%201.png', Buffer.from([1, 2, 3]), { 'X-Project-Admin': 'local', 'Content-Type': 'application/octet-stream' });
  assert.match(uploaded.body.url, /^\/attachments\/local-owner\/bug\/item1\/[0-9a-f-]{36}-shot_1\.png$/);
  const served = await fetch(`${origin}${uploaded.body.url}`);
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), Buffer.from([1, 2, 3]));
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.equal((await call('DELETE', `/api/attachments?url=${encodeURIComponent(uploaded.body.url)}`)).status, 200);
  assert.equal((await call('GET', uploaded.body.url)).status, 404);
  assert.equal((await call('DELETE', '/api/attachments?url=/etc/passwd')).status, 400);
});

test('refuses writes without the header and requests for non-loopback hosts', async (t) => {
  const { call, server } = await start(t);
  assert.equal((await call('PUT', '/api/docs/system/x', { data: {} }, { 'Content-Type': 'application/json' })).status, 403);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/session', headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode); });
  });
  assert.equal(status, 421);
});

test('serves the admin shell for client routes and assets as files', async (t) => {
  const { call, origin } = await start(t);
  const root = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/admin/');
  assert.match((await call('GET', '/admin/features/abc')).body, /id="root"/);
  const asset = await call('GET', '/admin/assets/app.js');
  assert.equal(asset.body, 'console.log(1)');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  const escape = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: new URL(origin).port, path: '/admin/..%2f..%2fstore.json' }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; }).on('end', () => resolve(body));
    });
  });
  assert.doesNotMatch(escape, /collections/, 'paths outside the build fall back to the shell');
});

test('announces store changes from any writer over server-sent events', async (t) => {
  const { origin, store } = await start(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${origin}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (pattern) => {
    while (!pattern.test(text)) text += decoder.decode((await reader.read()).value);
  };
  await until(/event: ready/);
  // A CLI process writing the file directly, not through the API.
  await store.system.merge('counters', { nextBugNumber: 4 });
  await until(/event: change/);
  assert.match(text, /event: change\ndata: \{"version":\d+\}/);
});

test('sorts by timestamps, then values, with missing fields last', () => {
  const rows = [{ id: 'a', at: null }, { id: 'b', at: { toMillis: () => 5 } }, { id: 'c', at: { toMillis: () => 9 } }];
  assert.deepEqual(sortRows(rows, 'at', 'desc').map((row) => row.id), ['c', 'b', 'a']);
  assert.deepEqual(sortRows(rows, 'at', 'asc').map((row) => row.id), ['b', 'c', 'a']);
});
