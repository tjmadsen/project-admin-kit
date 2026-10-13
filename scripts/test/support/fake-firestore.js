'use strict';

// Minimal in-memory Firestore for CLI and migration tests: collections, docs,
// equality where(), limit(), getAll(), transactions applied immediately, and
// the two FieldValue sentinels the backlog CLI writes.

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
  let autoId = 0;

  function snapshot(ref) {
    const data = store.get(ref.path);
    return { id: ref.id, ref, exists: data !== undefined, data: () => (data === undefined ? undefined : clone(data)) };
  }
  function write(ref, data, merge) {
    const base = merge ? { ...(store.get(ref.path) || {}) } : {};
    for (const [key, value] of Object.entries(data)) base[key] = resolveValue(base[key], value, now);
    store.set(ref.path, base);
  }
  function update(ref, patch) {
    if (!store.has(ref.path)) throw new Error(`No document to update: ${ref.path}`);
    write(ref, patch, true);
  }
  function docRef(collection, id = `auto-${(autoId += 1)}`) {
    const ref = {
      id,
      path: `${collection}/${id}`,
      get: async () => snapshot(ref),
      set: async (data, options = {}) => write(ref, data, Boolean(options.merge)),
      update: async (patch) => update(ref, patch),
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

  const db = {
    collection: (name) => ({ ...query(name), doc: (id) => docRef(name, id) }),
    getAll: async (...refs) => refs.map(snapshot),
    runTransaction: async (operation) => operation({
      get: async (ref) => snapshot(ref),
      getAll: async (...refs) => refs.map(snapshot),
      set: (ref, data, options = {}) => write(ref, data, Boolean(options.merge)),
      update: (ref, patch) => update(ref, patch),
    }),
    // Test helpers.
    seed: (path, data) => store.set(path, clone(data)),
    read: (path) => clone(store.get(path)),
    paths: () => [...store.keys()].sort(),
  };
  return db;
}

module.exports = { FieldValue, createFakeFirestore };
