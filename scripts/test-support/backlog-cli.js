'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

// Execute the real CLI selection and transaction paths against an optimistic
// store. Transactions retry when any read changes, and reject reads after a
// write, matching the Firestore invariants relevant to claim admission.
function database(initial) {
  const records = new Map(Object.entries(initial));
  const versions = new Map();
  const snapshot = (ref) => ({ id: ref.id, ref, exists: records.has(ref.key), data: () => records.get(ref.key) });
  const doc = (key) => ({ key, id: key.split('/').at(-1), get: async () => snapshot(doc(key)),
    collection: (name) => collection(`${key}/${name}`) });
  const collection = (name, filters = [], max = Infinity) => ({
    doc: (id) => doc(`${name}/${id}`),
    where: (field, _op, value) => collection(name, [...filters, [field, value]], max),
    limit(size) { return collection(name, filters, size); },
    get: async () => ({ docs: [...records.entries()].filter(([key, value]) => key.startsWith(`${name}/`)
      && key.split('/').length === name.split('/').length + 1
      && filters.every(([field, expected]) => value[field] === expected)).slice(0, max).map(([key]) => snapshot(doc(key))) }),
  });
  const db = {
    records, beforeTransaction: null, collection,
    getAll: async (...refs) => refs.map(snapshot),
    put(key, value) { records.set(key, value); versions.set(key, (versions.get(key) || 0) + 1); },
    async runTransaction(callback) {
      if (db.beforeTransaction) { const hook = db.beforeTransaction; db.beforeTransaction = null; hook(); }
      for (let attempt = 0; attempt < 10; attempt++) {
        const reads = new Map(); const writes = [];
        const get = async (ref) => {
          assert.equal(writes.length, 0, 'all transaction reads precede writes');
          reads.set(ref.key, versions.get(ref.key) || 0);
          return snapshot(ref);
        };
        const result = await callback({ get, getAll: async (...refs) => Promise.all(refs.map(get)),
          set: (ref, patch) => writes.push([ref.key, patch]), update: (ref, patch) => writes.push([ref.key, patch]) });
        if ([...reads].some(([key, version]) => version !== (versions.get(key) || 0))) continue;
        for (const [key, patch] of writes) db.put(key, { ...records.get(key), ...patch });
        return result;
      }
      throw new Error('transaction retries exhausted');
    },
  };
  return db;
}

function cli(db, kind = 'feature', runId = 'run1', env = {}) {
  const filename = path.resolve(__dirname, '../lib/backlog-agent.js');
  const localRequire = createRequire(filename);
  const output = [];
  const module = { exports: {} };
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('main().catch')) + '\nmodule.exports = { claim, count, mutate };', {
    module, Date, console: { log: (value) => output.push(JSON.parse(value)) },
    process: { env: { PROJECT_ADMIN_WORK_KIND: kind, PROJECT_ADMIN_AGENT_RUN_ID: runId, PROJECT_ADMIN_MACHINE_ID: 'local-mac', ...env } },
    require: (name) => name === './firestore' ? db : name === './attachments'
      ? { uploadAttachments: async () => [] } : localRequire(name),
  }, { filename });
  return { ...module.exports, output };
}

module.exports = { database, cli };
