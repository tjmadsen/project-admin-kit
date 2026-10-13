#!/usr/bin/env node
'use strict';

// `npm run local`: serves the built admin console and a small JSON API over the
// local store (backend.type "local") on 127.0.0.1 only.
//
// Single-user and unauthenticated by design: whoever can reach the port is the
// configured owner (admin.ownerEmail) with full admin rights. Never expose it
// beyond loopback (no port forwarding, tunnels, or 0.0.0.0). Requests whose Host
// is not loopback are refused (DNS rebinding), and every write needs the
// X-Project-Admin header, which a cross-site form or image cannot send.
//
// API (JSON; timestamps as {"$ts": ISO}; patches may contain
// {"$op":"serverTimestamp"} and {"$op":"arrayUnion","values":[...]}):
//   GET    /api/session                     the local owner session
//   GET    /api/collections/:name           ?orderBy=field&direction=desc&limit=n
//   GET    /api/docs/:name/:id              { exists, data }
//   PUT    /api/docs/:name/:id              { data, merge }
//   PATCH  /api/docs/:name/:id              { patch }      (update; must exist)
//   DELETE /api/docs/:name/:id
//   POST   /api/work-items                  { id, counterField, data } -> { id, number }
//   POST   /api/attachments?uploader&kind&itemId&name   raw bytes -> { url }
//   DELETE /api/attachments?url=/attachments/...
//   GET    /api/events                      server-sent "change" events
//   GET    /attachments/...                 stored attachment files

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ROOT, loadProjectConfig, resolveBackend } = require('./lib/project-config');
const { attachmentFileFor, saveAttachment } = require('./lib/store/local-store');
const { decode, encode, timestampMillis } = require('./lib/store/values');

const DEFAULT_PORT = 4317;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(encode(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  try { return decode(JSON.parse(body.toString('utf8') || '{}')); } catch { throw new HttpError(400, 'Invalid JSON body'); }
}

function sendFile(response, file, { cache = false } = {}) {
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  response.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache ? 'public, max-age=31536000, immutable' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(response);
}

function sortRows(rows, field, direction) {
  if (!field) return rows;
  const value = (row) => timestampMillis(row[field]) ?? row[field] ?? null;
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    if (left === right) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left < right ? -1 : 1) * sign;
  });
}

function createLocalServer({ store, config, publicDir, adminPath = config.project.adminPath, watchIntervalMs = 500 }) {
  const base = `/${adminPath.replace(/^\/+|\/+$/g, '')}`;
  const session = {
    backend: 'local',
    role: 'admin',
    user: { uid: 'local-owner', email: config.admin.ownerEmail.toLowerCase(), emailVerified: true, displayName: config.admin.ownerName, photoURL: null },
  };
  const listeners = new Set();
  let version = 0;
  const notify = () => {
    version += 1;
    for (const response of listeners) response.write(`event: change\ndata: {"version":${version}}\n\n`);
  };
  // Polling the file's mtime sees writes from every process (CLI, loops),
  // survives the atomic rename, and needs no platform-specific watcher.
  const onFileChange = (current, previous) => { if (current.mtimeMs !== previous.mtimeMs) notify(); };
  fs.watchFile(store.file, { interval: watchIntervalMs }, onFileChange);

  async function api(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
    const method = request.method;
    if (method !== 'GET' && method !== 'HEAD' && request.headers['x-project-admin'] !== 'local') {
      throw new HttpError(403, 'Writes need the X-Project-Admin: local header');
    }
    const [resource, name, id] = segments;
    if (resource === 'session' && method === 'GET') return sendJson(response, 200, session);
    if (resource === 'events' && method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      response.write(`event: ready\ndata: {"version":${version}}\n\n`);
      listeners.add(response);
      request.on('close', () => listeners.delete(response));
      return undefined;
    }
    if (resource === 'collections' && name && method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 1000);
      const rows = sortRows(store.docs.list(name), url.searchParams.get('orderBy'), url.searchParams.get('direction'));
      return sendJson(response, 200, { docs: rows.slice(0, limit) });
    }
    if (resource === 'docs' && name && id) {
      if (method === 'GET') {
        const data = store.docs.get(name, id);
        return sendJson(response, 200, { exists: data !== null, data });
      }
      if (method === 'PUT') {
        const body = await readJson(request);
        await store.docs.set(name, id, body.data || {}, { merge: Boolean(body.merge) });
        notify();
        return sendJson(response, 200, { ok: true });
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        await store.docs.update(name, id, body.patch || {});
        notify();
        return sendJson(response, 200, { ok: true });
      }
      if (method === 'DELETE') {
        await store.docs.remove(name, id);
        notify();
        return sendJson(response, 200, { ok: true });
      }
    }
    if (resource === 'work-items' && !name && method === 'POST') {
      const body = await readJson(request);
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(body.id || '')) throw new HttpError(400, 'A work item id of 6-64 URL-safe characters is required');
      if (!/^next[A-Z][A-Za-z0-9]*Number$/.test(body.counterField || '')) throw new HttpError(400, 'Invalid counterField');
      const number = await store.docs.createWorkItem(body.id, body.counterField, (next) => ({ ...body.data, number: next }));
      notify();
      return sendJson(response, 200, { id: body.id, number });
    }
    if (resource === 'attachments' && !name) {
      if (method === 'POST') {
        const target = Object.fromEntries(['uploader', 'kind', 'itemId', 'name'].map((key) => [key, url.searchParams.get(key) || '']));
        if (!target.kind || !target.itemId || !target.name) throw new HttpError(400, 'kind, itemId, and name are required');
        const bytes = await readBody(request, MAX_ATTACHMENT_BYTES);
        const saved = saveAttachment(store.attachmentsDir, { uploader: target.uploader || 'local-owner', kind: target.kind, itemId: target.itemId }, target.name, bytes);
        return sendJson(response, 200, { url: saved });
      }
      if (method === 'DELETE') {
        const file = attachmentFileFor(store.attachmentsDir, url.searchParams.get('url') || '');
        if (!file) throw new HttpError(400, 'Not an attachment url');
        fs.rmSync(file, { force: true });
        return sendJson(response, 200, { ok: true });
      }
    }
    throw new HttpError(404, `No API route for ${method} ${url.pathname}`);
  }

  function serveStatic(response, pathname) {
    const relative = decodeURIComponent(pathname.slice(base.length)).replace(/^\/+/, '');
    const root = path.resolve(publicDir);
    const candidate = path.resolve(root, relative);
    if (candidate.startsWith(`${root}${path.sep}`) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return sendFile(response, candidate, { cache: relative.startsWith('assets/') });
    }
    const index = path.join(root, 'index.html');
    if (!fs.existsSync(index)) throw new HttpError(503, `No admin build at ${root}. Run \`npm run build\` with backend.type "local" first.`);
    // Single-page app: every other path renders the shell.
    return sendFile(response, index);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const hostname = String(request.headers.host || '').replace(/:\d+$/, '');
      if (!LOOPBACK_HOSTS.has(hostname)) throw new HttpError(421, 'The local server only answers loopback hosts');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return await api(request, response, url);
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      if (url.pathname.startsWith('/attachments/')) {
        const file = attachmentFileFor(store.attachmentsDir, url.pathname);
        if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Attachment not found');
        return sendFile(response, file);
      }
      if (url.pathname === '/' || url.pathname === '') {
        response.writeHead(302, { Location: `${base}/` });
        return response.end();
      }
      if (url.pathname === base || url.pathname.startsWith(`${base}/`)) return serveStatic(response, url.pathname);
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const status = error.status || (/not found|No document/i.test(error.message) ? 404 : /Unknown collection|already exists/.test(error.message) ? 400 : 500);
      if (!response.headersSent) sendJson(response, status, { error: error.message });
      else response.end();
    }
  });
  server.on('close', () => {
    fs.unwatchFile(store.file, onFileChange);
    for (const response of listeners) response.end();
    listeners.clear();
  });
  return server;
}

function parsePort(argv, env) {
  const index = argv.indexOf('--port');
  const raw = index === -1 ? env.PROJECT_ADMIN_LOCAL_PORT : argv[index + 1];
  const port = raw === undefined ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid --port ${raw}`);
  return port;
}

function main(argv = process.argv.slice(2), env = process.env) {
  const config = loadProjectConfig();
  const backend = resolveBackend(config);
  if (backend.type !== 'local') {
    throw new Error(`npm run local serves the local backend; this project uses "${backend.type}". Set backend.type to "local" (npm run configure -- --backend local) or see docs/BACKENDS.md.`);
  }
  const { openStore } = require('./lib/store');
  const store = openStore({ config, env });
  const publicDir = path.join(ROOT, 'public', config.project.adminPath.replace(/^\/+|\/+$/g, ''));
  const server = createLocalServer({ store, config, publicDir });
  server.listen(parsePort(argv, env), '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`Project Admin (local backend) on http://127.0.0.1:${port}${config.project.adminPath.replace(/\/$/, '')}/`);
    console.log(`Store: ${store.file}`);
    console.log('Single-user and unauthenticated: it listens on 127.0.0.1 only. Do not expose this port.');
    if (!fs.existsSync(path.join(publicDir, 'index.html'))) console.log('No admin build found yet; run `npm run build` first.');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { DEFAULT_PORT, createLocalServer, sortRows };
