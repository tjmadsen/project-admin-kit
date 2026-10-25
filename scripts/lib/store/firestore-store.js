'use strict';

// The default BacklogStore: Firestore through the Admin SDK (or any object
// with the same surface, such as test/support/fake-firestore.js). Every
// operation issues exactly the reads and writes the CLIs issued before the
// store existed, so Firestore data, rules, and Functions see no change.

const { WORK_ITEMS_COLLECTION } = require('../work-kinds');

function createFirestoreStore({ db, FieldValue, Timestamp, uploadAttachments = null }) {
  const items = () => db.collection(WORK_ITEMS_COLLECTION);
  const snapshotsToRows = (snapshots) => snapshots.filter((snapshot) => snapshot.exists).map((snapshot) => ({ id: snapshot.id, ...snapshot.data() }));
  const withMessages = (patch, messages) => (messages?.length ? { ...patch, messages: FieldValue.arrayUnion(...messages) } : patch);

  // Runs `decide` inside a Firestore transaction. Firestore retries the whole
  // function on contention, which is what makes claims atomic.
  async function transact(id, decide) {
    const ref = items().doc(id);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const tx = { getMany: async (ids) => (ids.length ? snapshotsToRows(await transaction.getAll(...ids.map((entry) => items().doc(entry)))) : []) };
      const outcome = await decide(snapshot.exists ? snapshot.data() : null, tx);
      if (!outcome) return null;
      if (outcome.patch) transaction.update(ref, withMessages(outcome.patch, outcome.messages));
      return outcome.result ?? null;
    });
  }

  return {
    backend: 'firestore',
    capabilities: { atomicClaims: true, dashboard: true, attachments: 'storage', users: true },
    now: () => Timestamp.now(),
    fromMillis: (millis) => Timestamp.fromMillis(millis),
    serverTimestamp: () => FieldValue.serverTimestamp(),

    items: {
      async create(kind, build) {
        const ref = items().doc();
        const number = await db.runTransaction(async (transaction) => {
          const counterRef = db.collection('system').doc('counters');
          const counter = await transaction.get(counterRef);
          const nextNumber = Number(counter.data()?.[kind.counterField] ?? 0) + 1;
          transaction.set(counterRef, { [kind.counterField]: nextNumber, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
          transaction.set(ref, build(nextNumber));
          return nextNumber;
        });
        return { id: ref.id, number };
      },
      async get(id) {
        const snapshot = await items().doc(id).get();
        return snapshot.exists ? snapshot.data() : null;
      },
      async getMany(ids) {
        if (ids.length === 0) return [];
        return snapshotsToRows(await db.getAll(...ids.map((id) => items().doc(id))));
      },
      async list({ kind = null, waitingOn = null, limit = 300 } = {}) {
        let query = items();
        if (waitingOn) query = query.where('waitingOn', '==', waitingOn);
        if (kind) query = query.where('kind', '==', kind);
        // limit: null reads every match.
        const snapshot = await (limit == null ? query : query.limit(limit)).get();
        return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
      },
      async update(id, patch, { messages = [] } = {}) {
        await items().doc(id).update(withMessages(patch, messages));
      },
      transact,
      claim: transact,
    },

    runs: {
      async create(data) { return (await db.collection('agentLoopRuns').add(data)).id; },
      async get(id) {
        const snapshot = await db.collection('agentLoopRuns').doc(id).get();
        return snapshot.exists ? snapshot.data() : null;
      },
      async merge(id, data) { await db.collection('agentLoopRuns').doc(id).set(data, { merge: true }); },
      async listByStatus(status) {
        const snapshot = await db.collection('agentLoopRuns').where('status', '==', status).get();
        return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
      },
    },
    machines: {
      async merge(id, data) { await db.collection('agentMachines').doc(id).set(data, { merge: true }); },
    },
    system: {
      async get(name) { return (await db.collection('system').doc(name).get()).data() || null; },
      async merge(name, data) { await db.collection('system').doc(name).set(data, { merge: true }); },
    },
    users: {
      async get(email) {
        const snapshot = await db.collection('adminUsers').doc(email).get();
        return snapshot.exists ? snapshot.data() : null;
      },
      async list() {
        const snapshot = await db.collection('adminUsers').orderBy('email').get();
        return snapshot.docs.map((document) => ({ id: document.id, ...document.data() }));
      },
      async merge(email, data) { await db.collection('adminUsers').doc(email).set(data, { merge: true }); },
      async remove(email) { await db.collection('adminUsers').doc(email).delete(); },
    },
    attachments: {
      async upload(paths, target) {
        const upload = uploadAttachments || require('../attachments').uploadAttachments;
        return upload(paths, target);
      },
    },
  };
}

module.exports = { createFirestoreStore };
