// Entry point of the console's data layer. The backend is a build-time
// constant (__PA_BACKEND__, defined in vite.config.ts from
// project-admin.config.json `backend.type`), so the bundler drops the other
// adapter: firestore builds load the Firebase SDK lazily from here, local
// builds never include it, and github builds render a notice instead of a
// dashboard (App.tsx).
//
// The helpers below return synchronously where React effects need an
// unsubscribe, and wait for the adapter internally.

import type { DataAdapter, NewWorkItem, QuerySpec, Row, SessionUser, Unsubscribe, UploadedAttachments } from './types'
import type { AccessRole } from '../lib/auth'

export type { Backend, SessionUser } from './types'
export { arrayUnion, newDocumentId, nowTimestamp, serverTimestamp } from './values'

export const BACKEND = __PA_BACKEND__

let adapterPromise: Promise<DataAdapter> | null = null

export function loadAdapter(): Promise<DataAdapter> {
  if (!adapterPromise) {
    if (BACKEND === 'local') adapterPromise = import('./local').then(({ createLocalAdapter }) => createLocalAdapter())
    else if (BACKEND === 'github') adapterPromise = Promise.reject(new Error('The github backend has no dashboard data layer; manage work in GitHub Issues.'))
    else adapterPromise = import('./firestore').then(({ createFirestoreAdapter }) => createFirestoreAdapter())
  }
  return adapterPromise
}

/** Test seam: use a specific adapter (or reset with null). */
export function setAdapterForTesting(adapter: DataAdapter | null) {
  adapterPromise = adapter ? Promise.resolve(adapter) : null
}

// Subscribes once the adapter is loaded; unsubscribing first cancels it.
function deferred(start: (adapter: DataAdapter) => Unsubscribe, onError?: (error: Error) => void): Unsubscribe {
  let stop: Unsubscribe | null = null
  let cancelled = false
  loadAdapter().then((adapter) => { if (!cancelled) stop = start(adapter) }, (error: Error) => { if (!cancelled) onError?.(error) })
  return () => { cancelled = true; stop?.() }
}

export const ready = () => loadAdapter().then((adapter) => adapter.ready())
export const signIn = () => loadAdapter().then((adapter) => adapter.signIn())
export const signOut = () => loadAdapter().then((adapter) => adapter.signOut())

export function onAuthChanged(listener: (user: SessionUser | null) => void): Unsubscribe {
  return deferred((adapter) => adapter.onAuthChanged(listener), () => listener(null))
}

export function subscribeAccessRole(user: SessionUser, listener: (role: AccessRole | null, error?: Error) => void): Unsubscribe {
  return deferred((adapter) => adapter.subscribeAccessRole(user, listener), (error) => listener(null, error))
}

export function subscribeQuery(spec: QuerySpec, onData: (rows: Row[]) => void, onError: (error: Error) => void): Unsubscribe {
  return deferred((adapter) => adapter.subscribeQuery(spec, onData, onError), onError)
}

export function subscribeDoc(collection: string, id: string, onData: (data: Record<string, unknown> | undefined) => void, onError: (error: Error) => void): Unsubscribe {
  return deferred((adapter) => adapter.subscribeDoc(collection, id, onData, onError), onError)
}

export const setDocument = (collection: string, id: string, data: Record<string, unknown>, options?: { merge?: boolean }) =>
  loadAdapter().then((adapter) => adapter.setDoc(collection, id, data, options))
export const updateDocument = (collection: string, id: string, patch: Record<string, unknown>) =>
  loadAdapter().then((adapter) => adapter.updateDoc(collection, id, patch))
export const deleteDocument = (collection: string, id: string) =>
  loadAdapter().then((adapter) => adapter.deleteDoc(collection, id))
export const createWorkItem = (item: NewWorkItem) => loadAdapter().then((adapter) => adapter.createWorkItem(item))
export const uploadAttachments = (files: File[], kind: string, itemId: string, uploaderEmail: string): Promise<UploadedAttachments> => {
  if (files.length === 0) return Promise.resolve({ urls: [], cleanup: async () => undefined })
  return loadAdapter().then((adapter) => adapter.uploadAttachments(files, kind, itemId, uploaderEmail))
}
