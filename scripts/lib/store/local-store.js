'use strict';

// The `local` BacklogStore: everything in one JSON file on this machine (see
// json-file.js), attachments as plain files in an `attachments/` directory
// beside it. Single-user by design: there is no authentication, and the local
// server that exposes it to the admin console binds to 127.0.0.1 only.
//
// Collections mirror Firestore's names (workItems, system, agentLoopRuns,
// agentMachines, adminUsers) so the console and the CLIs speak one schema.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WORK_ITEMS_COLLECTION } = require('../work-kinds');
const { createJsonFileDatabase } = require('./json-file');
const { StoreTimestamp, applyMerge, applyUpdate, autoId, serverTimestamp } = require('./values');

const COLLECTIONS = Object.freeze([WORK_ITEMS_COLLECTION, 'system', 'agentLoopRuns', 'agentMachines', 'adminUsers']);
const ATTACHMENT_ROUTE = '/attachments/';

function createLocalStore({ file, now = () => StoreTimestamp.now(), readAttachment = require('../attachments').readAttachment } = {}) {
  if (!file) throw new Error('The local store needs a file path');
  const db = createJsonFileDatabase(file);
  const attachmentsDir = path.join(path.dirname(file), 'attachments');
  const rows = (collection) => Object.entries(collection).map(([id, data]) => ({ id, ...data }));
  const knownCollection = (name) => {
    if (!COLLECTIONS.includes(name)) throw new Error(`Unknown collection ${name}`);
    return name;
  };

  // Generic document operations (also the local server's API surface).
  const docs = {
    list(name) { return rows(db.read().collections[knownCollection(name)] || {}); },
    get(name, id) { return db.read().collections[knownCollection(name)]?.[id] ?? null; },
    set(name, id, data, { merge = false } = {}) {
      return db.transaction((state) => {
        const collection = db.collection(state, knownCollection(name));
        collection[id] = merge ? applyMerge(collection[id], data, now()) : applyMerge({}, data, now());
        state.dirty = true;
      });
    },
    update(name, id, patch) {
      return db.transaction((state) => {
        const collection = db.collection(state, knownCollection(name));
        if (!collection[id]) throw new Error(`No document to update: ${name}/${id}`);
        collection[id] = applyUpdate(collection[id], patch, now());
        state.dirty = true;
      });
    },
    remove(name, id) {
      return db.transaction((state) => {
        delete db.collection(state, knownCollection(name))[id];
        state.dirty = true;
      });
    },
    // Allocates the kind's next number and writes the item in one locked
    // transaction, as the Firestore counter transaction does.
    createWorkItem(id, counterField, build) {
      return db.transaction((state) => {
        const system = db.collection(state, 'system');
        const number = Number(system.counters?.[counterField] ?? 0) + 1;
        system.counters = applyMerge(system.counters, { [counterField]: number, updatedAt: serverTimestamp() }, now());
        const items = db.collection(state, WORK_ITEMS_COLLECTION);
        if (items[id]) throw new Error(`${id} already exists`);
        items[id] = applyMerge({}, build(number), now());
        state.dirty = true;
        return number;
      });
    },
  };

  const withMessages = (patch, messages) => (messages?.length ? { ...patch, messages: { $op: 'arrayUnion', values: messages } } : patch);

  // The whole decide-and-write runs under the file lock, so two concurrent
  // claims serialize and the second sees the first one's lease.
  function transact(id, decide) {
    return db.transaction(async (state) => {
      const items = db.collection(state, WORK_ITEMS_COLLECTION);
      const tx = { getMany: async (ids) => ids.filter((entry) => items[entry]).map((entry) => ({ id: entry, ...items[entry] })) };
      const outcome = await decide(items[id] ? { ...items[id] } : null, tx);
      if (!outcome) return null;
      if (outcome.patch) {
        if (!items[id]) throw new Error(`No document to update: ${WORK_ITEMS_COLLECTION}/${id}`);
        items[id] = applyUpdate(items[id], withMessages(outcome.patch, outcome.messages), now());
        state.dirty = true;
      }
      return outcome.result ?? null;
    });
  }

  return {
    backend: 'local',
    capabilities: { atomicClaims: true, dashboard: true, attachments: 'files', users: true },
    file,
    attachmentsDir,
    docs,
    now,
    fromMillis: (millis) => StoreTimestamp.fromMillis(millis),
    serverTimestamp,

    items: {
      async create(kind, build) {
        const id = autoId();
        const number = await docs.createWorkItem(id, kind.counterField, build);
        return { id, number };
      },
      async get(id) { return docs.get(WORK_ITEMS_COLLECTION, id); },
      async getMany(ids) {
        const items = db.read().collections[WORK_ITEMS_COLLECTION] || {};
        return ids.filter((id) => items[id]).map((id) => ({ id, ...items[id] }));
      },
      async list({ kind = null, waitingOn = null, limit = 300 } = {}) {
        return docs.list(WORK_ITEMS_COLLECTION)
          .filter((item) => (!kind || item.kind === kind) && (!waitingOn || item.waitingOn === waitingOn))
          .slice(0, limit);
      },
      async update(id, patch, { messages = [] } = {}) { await docs.update(WORK_ITEMS_COLLECTION, id, withMessages(patch, messages)); },
      transact,
      claim: transact,
    },
    runs: {
      async create(data) {
        const id = autoId();
        await docs.set('agentLoopRuns', id, data);
        return id;
      },
      async get(id) { return docs.get('agentLoopRuns', id); },
      async merge(id, data) { await docs.set('agentLoopRuns', id, data, { merge: true }); },
      async listByStatus(status) { return docs.list('agentLoopRuns').filter((run) => run.status === status); },
    },
    machines: {
      async merge(id, data) { await docs.set('agentMachines', id, data, { merge: true }); },
    },
    system: {
      async get(name) { return docs.get('system', name); },
      async merge(name, data) { await docs.set('system', name, data, { merge: true }); },
    },
    users: {
      async get(email) { return docs.get('adminUsers', email); },
      async list() { return docs.list('adminUsers').sort((a, b) => String(a.email).localeCompare(String(b.email))); },
      async merge(email, data) { await docs.set('adminUsers', email, data, { merge: true }); },
      async remove(email) { await docs.remove('adminUsers', email); },
    },
    attachments: {
      // Copies each file under attachments/<uploader>/<kind>/<item>/ and returns
      // the path the local server serves it from.
      async upload(paths, target) {
        const { parseAttachmentPaths, safeFileName } = require('../attachments');
        const files = parseAttachmentPaths(paths).map(readAttachment);
        return files.map((attachment) => saveAttachment(attachmentsDir, target, attachment.fileName, attachment.bytes, safeFileName));
      },
    },
  };
}

function saveAttachment(attachmentsDir, { uploader, kind, itemId }, fileName, bytes, safeFileName = require('../attachments').safeFileName) {
  const relative = [uploader, kind, itemId, `${crypto.randomUUID()}-${safeFileName(fileName)}`].map((part) => String(part).replace(/[^A-Za-z0-9._@-]+/g, '_')).join('/');
  const target = path.join(attachmentsDir, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return `${ATTACHMENT_ROUTE}${relative}`;
}

// Maps an attachment URL back to its file, refusing anything that escapes the
// attachments directory.
function attachmentFileFor(attachmentsDir, url) {
  if (!url.startsWith(ATTACHMENT_ROUTE)) return null;
  const relative = decodeURIComponent(url.slice(ATTACHMENT_ROUTE.length).split('?')[0]);
  const target = path.resolve(attachmentsDir, relative);
  return target.startsWith(`${path.resolve(attachmentsDir)}${path.sep}`) ? target : null;
}

module.exports = { ATTACHMENT_ROUTE, COLLECTIONS, attachmentFileFor, createLocalStore, saveAttachment };
