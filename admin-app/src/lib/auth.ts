import type { User } from 'firebase/auth'
import { doc, onSnapshot, type DocumentData } from 'firebase/firestore'
import { db } from './firebase'

export type AccessRole = 'admin' | 'collaborator'

export interface AdminUserAccess {
  email?: string
  role?: AccessRole
  active?: boolean
}

export function normalizeEmail(email: string | null | undefined) {
  return String(email || '').trim().toLowerCase()
}

export function accessRoleFor(record: AdminUserAccess | DocumentData | null | undefined, emailVerified = false): AccessRole | null {
  if (!emailVerified || !record || record.active !== true) return null
  return record.role === 'admin' || record.role === 'collaborator' ? record.role : null
}

export function isAllowedAdmin(record: AdminUserAccess | DocumentData | null | undefined, emailVerified = false) {
  return accessRoleFor(record, emailVerified) === 'admin'
}

export function subscribeToAccessRole(user: User, listener: (role: AccessRole | null, error?: Error) => void) {
  const email = normalizeEmail(user.email)
  if (!email || !user.emailVerified) {
    listener(null)
    return () => undefined
  }
  return onSnapshot(doc(db, 'adminUsers', email), (snapshot) => {
    listener(accessRoleFor(snapshot.exists() ? snapshot.data() : null, user.emailVerified))
  }, (error) => listener(null, error))
}
