// The admin console's data layer contract. Pages and hooks talk to this
// interface only; `firestore` (Firebase Auth + Firestore + Storage) and `local`
// (the loopback `npm run local` server) implement it. The backend is fixed at
// build time from project-admin.config.json `backend` (see data/index.ts).

import type { AccessRole } from '../lib/auth'

export type Backend = 'firestore' | 'local' | 'github'
export type Unsubscribe = () => void

/** The signed-in person: the Firebase user's identity fields, or the local owner. */
export interface SessionUser {
  uid: string
  email: string | null
  emailVerified: boolean
  displayName: string | null
  photoURL: string | null
}

export interface QuerySpec {
  collection: string
  orderBy?: string
  direction?: 'asc' | 'desc'
  limit?: number
}

export type Row = { id: string } & Record<string, unknown>

export interface UploadedAttachments {
  urls: string[]
  cleanup: () => Promise<void>
}

export interface NewWorkItem {
  id: string
  counterField: string
  /** The document without `number`; the adapter allocates it atomically. */
  data: Record<string, unknown>
}

export interface DataAdapter {
  backend: Exclude<Backend, 'github'>
  /** Resolves once any injected credential (native shell) has been exchanged. */
  ready(): Promise<void>
  onAuthChanged(listener: (user: SessionUser | null) => void): Unsubscribe
  signIn(): Promise<void>
  signOut(): Promise<void>
  subscribeAccessRole(user: SessionUser, listener: (role: AccessRole | null, error?: Error) => void): Unsubscribe
  subscribeQuery(spec: QuerySpec, onData: (rows: Row[]) => void, onError: (error: Error) => void): Unsubscribe
  subscribeDoc(collection: string, id: string, onData: (data: Record<string, unknown> | undefined) => void, onError: (error: Error) => void): Unsubscribe
  setDoc(collection: string, id: string, data: Record<string, unknown>, options?: { merge?: boolean }): Promise<void>
  updateDoc(collection: string, id: string, patch: Record<string, unknown>): Promise<void>
  deleteDoc(collection: string, id: string): Promise<void>
  createWorkItem(item: NewWorkItem): Promise<number>
  uploadAttachments(files: File[], kind: string, itemId: string, uploaderEmail: string): Promise<UploadedAttachments>
}
