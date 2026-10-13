'use strict';

// Minimal in-memory Firestore for CLI and migration tests: collections, docs,
// equality where(), orderBy() (ignored), limit(), add(), delete(), getAll(),
// the two FieldValue sentinels the backlog CLI writes, and transactions with
// Firestore's optimistic concurrency: writes are buffered and committed only
// if no document the transaction read changed meanwhile, else it retries.

const SERVER_TIMESTAMP = Symbol('serverTimestamp');
const ARRAY_UNION = Symbol('arrayUnion');

const FieldValue = {
  serverTimestamp: () => ({ [SERVER_TIMESTAMP]: true }),
  arrayUnion: (...values) => ({ [ARRAY_UNION]: values }),
};

function resolveValue(current, value, now) {
  if (value && value[SERVER_TIMESTAMP]) return now();
  if (value && value[ARRAY_UNION]) return [...(Array.isArray(current) ? current : []), ...value[ARRAY_UNION]];
  return value;
}

// Copies plain objects and arrays but keeps class instances (Timestamp, Date)
// so their methods survive a round trip, as they do in the real SDK.
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
  }
  return value;
}

function createFakeFirestore({ now = () => new Date() } = {}) {
  const store = new Map(); // "collection/id" -> data
  const versions = new Map(); // "collection/id" -> write count
  let autoId = 0;

  function snapshot(ref) {
    const data = store.get(ref.path);
    return { id: ref.id, ref, exists: data !== undefined, data: () => (data === undefined ? undefined : clone(data)) };
  }
  // set(..., { merge: true }) merges nested maps key by key, as Firestore does.
  function mergeInto(base, data) {
    for (const [key, value] of Object.entries(data)) {
      const isMap = value && Object.getPrototypeOf(value) === Object.prototype && !value[SERVER_TIMESTAMP] && !value[ARRAY_UNION];
      if (isMap && base[key] && Object.getPrototypeOf(base[key]) === Object.prototype) base[key] = mergeInto({ ...base[key] }, value);
      else base[key] = resolveValue(base[key], value, now);
    }
    return base;
  }
  function write(ref, data, merge) {
    const base = merge ? { ...(store.get(ref.path) || {}) } : {};
    mergeInto(base, data);
    store.set(ref.path, base);
    versions.set(ref.path, (versions.get(ref.path) || 0) + 1);
  }
  function update(ref, patch) {
    if (!store.has(ref.path)) throw new Error(`No document to update: ${ref.path}`);
    // update() replaces each top-level field, maps included.
    const base = { ...store.get(ref.path) };
    for (const [key, value] of Object.entries(patch)) base[key] = resolveValue(base[key], value, now);
    store.set(ref.path, base);
    versions.set(ref.path, (versions.get(ref.path) || 0) + 1);
  }
  function docRef(collection, id = `auto-${(autoId += 1)}`) {
    const ref = {
      id,
      path: `${collection}/${id}`,
      get: async () => snapshot(ref),
      set: async (data, options = {}) => write(ref, data, Boolean(options.merge)),
      update: async (patch) => update(ref, patch),
      delete: async () => { store.delete(ref.path); versions.set(ref.path, (versions.get(ref.path) || 0) + 1); },
    };
    return ref;
  }
  function query(collection, filters = [], max = Infinity) {
    return {
      where: (field, op, value) => {
        if (op !== '==') throw new Error(`fake firestore supports only == filters, got ${op}`);
        return query(collection, [...filters, [field, value]], max);
      },
      limit: (count) => query(collection, filters, count),
      orderBy: () => query(collection, filters, max),
      get: async () => {
        const docs = [...store.keys()]
          .filter((key) => key.startsWith(`${collection}/`))
          .map((key) => snapshot(docRef(collection, key.slice(collection.length + 1))))
          .filter((document) => filters.every(([field, value]) => document.data()[field] === value))
          .slice(0, max);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }

  async function runTransaction(operation, attempts = 5) {
    for (let attempt = 1; ; attempt += 1) {
      const reads = new Map();
      const writes = [];
      const read = (ref) => { reads.set(ref.path, versions.get(ref.path) || 0); return snapshot(ref); };
      const result = await operation({
        get: async (ref) => read(ref),
        getAll: async (...refs) => refs.map(read),
        set: (ref, data, options = {}) => { writes.push(() => write(ref, data, Boolean(options.merge))); },
        update: (ref, patch) => { writes.push(() => update(ref, patch)); },
      });
      if ([...reads].every(([path, version]) => (versions.get(path) || 0) === version)) {
        for (const apply of writes) apply();
        return result;
      }
      if (attempt >= attempts) throw new Error('fake firestore: transaction contention');
    }
  }

  const db = {
    collection: (name) => ({
      ...query(name),
      doc: (id) => docRef(name, id),
      add: async (data) => { const ref = docRef(name); write(ref, data, false); return ref; },
    }),
    getAll: async (...refs) => refs.map(snapshot),
    runTransaction,
    // Test helpers.
    seed: (path, data) => store.set(path, clone(data)),
    read: (path) => clone(store.get(path)),
    paths: () => [...store.keys()].sort(),
  };
  return db;
}

module.exports = { FieldValue, createFakeFirestore };
