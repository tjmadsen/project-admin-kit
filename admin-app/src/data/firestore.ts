// The default adapter: Firebase Auth (Google, plus the native shell's injected
// credential), Firestore listeners and writes, and Storage attachments. This
// module, and with it the Firebase SDK, is only loaded by firestore builds.

import { onAuthStateChanged } from 'firebase/auth'
import {
  Timestamp, arrayUnion as firestoreArrayUnion, collection, deleteDoc, doc, limit, onSnapshot, orderBy, query,
  runTransaction, serverTimestamp as firestoreServerTimestamp, setDoc, updateDoc, type QueryConstraint,
} from 'firebase/firestore'
import { deleteObject, getDownloadURL, ref as storageRef, uploadBytes, type StorageReference } from 'firebase/storage'
import { auth, db, signInWithGoogle, storage } from '../lib/firebase'
import { accessRoleFor, normalizeEmail } from '../lib/auth'
import { attachmentContentType, safeAttachmentName } from '../lib/attachments'
import { initNativeBridge, signOutAdmin } from '../lib/native-bridge'
import type { DataAdapter } from './types'
import { NOW, isArrayUnion, isNow, isServerTimestamp, mapValues } from './values'

// Sentinels become Firestore's own field values at write time.
function toFirestore(data: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown | undefined => {
    if (isServerTimestamp(value)) return firestoreServerTimestamp()
    if (isNow(value)) return Timestamp.fromMillis(value[NOW])
    if (isArrayUnion(value)) return firestoreArrayUnion(...(Object.values(value)[0] as unknown[]).map((entry) => mapValues(entry, convert)))
    return undefined
  }
  return mapValues(data, convert) as Record<string, unknown>
}

export function createFirestoreAdapter(): DataAdapter {
  return {
    backend: 'firestore',
    // The native shell injects a Google credential; exchange it before the
    // first auth subscription so the web login screen never flashes.
    ready: () => initNativeBridge(auth).authReady,
    onAuthChanged: (listener) => onAuthStateChanged(auth, listener),
    signIn: () => signInWithGoogle(),
    signOut: () => signOutAdmin(auth),
    subscribeAccessRole(user, listener) {
      const email = normalizeEmail(user.email)
      if (!email || !user.emailVerified) {
        listener(null)
        return () => undefined
      }
      return onSnapshot(doc(db, 'adminUsers', email), (snapshot) => {
        listener(accessRoleFor(snapshot.exists() ? snapshot.data() : null, user.emailVerified))
      }, (error) => listener(null, error))
    },
    subscribeQuery(spec, onData, onError) {
      const constraints: QueryConstraint[] = []
      if (spec.orderBy) constraints.push(orderBy(spec.orderBy, spec.direction || 'asc'))
      if (spec.limit) constraints.push(limit(spec.limit))
      return onSnapshot(query(collection(db, spec.collection), ...constraints),
        (snapshot) => onData(snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))),
        onError)
    },
    subscribeDoc: (name, id, onData, onError) => onSnapshot(doc(db, name, id), (snapshot) => onData(snapshot.data()), onError),
    setDoc: (name, id, data, options = {}) => setDoc(doc(db, name, id), toFirestore(data), { merge: Boolean(options.merge) }),
    updateDoc: (name, id, patch) => updateDoc(doc(db, name, id), toFirestore(patch)),
    deleteDoc: (name, id) => deleteDoc(doc(db, name, id)),
    transactDocument: (name, id, decide) => runTransaction(db, async (transaction) => {
      const ref = doc(db, name, id)
      const snapshot = await transaction.get(ref)
      transaction.update(ref, toFirestore(decide(snapshot.exists() ? snapshot.data() : undefined)))
    }),
    async createWorkItem({ id, counterField, data }) {
      const itemDoc = doc(db, 'workItems', id)
      return runTransaction(db, async (transaction) => {
        const counterRef = doc(db, 'system', 'counters')
        const counter = await transaction.get(counterRef)
        const number = Number(counter.data()?.[counterField] ?? 0) + 1
        transaction.set(counterRef, { [counterField]: number, updatedAt: firestoreServerTimestamp() }, { merge: true })
        transaction.set(itemDoc, toFirestore({ ...data, number }))
        return number
      })
    },
    async uploadAttachments(files, kind, itemId, uploaderEmail) {
      if (files.length === 0) return { urls: [], cleanup: async () => undefined }
      const uid = auth.currentUser?.uid
      if (!uid) throw new Error('Your Google session expired. Sign in again before uploading attachments.')
      const uploaded: StorageReference[] = []
      try {
        for (const [index, file] of files.entries()) {
          const unique = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${index}`
          const target = storageRef(storage, `work-item-attachments/${uid}/${kind}/${itemId}/${unique}-${safeAttachmentName(file.name)}`)
          await uploadBytes(target, file, {
            contentType: attachmentContentType(file),
            customMetadata: { uploaderEmail: uploaderEmail.toLowerCase(), kind, itemId },
          })
          uploaded.push(target)
        }
        const urls = await Promise.all(uploaded.map((target) => getDownloadURL(target)))
        return { urls, cleanup: async () => { await Promise.allSettled(uploaded.map((target) => deleteObject(target))) } }
      } catch (error) {
        await Promise.allSettled(uploaded.map((target) => deleteObject(target)))
        throw error
      }
    },
  }
}
