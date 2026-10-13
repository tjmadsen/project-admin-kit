type DocumentData = Record<string, unknown>

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

// Live role lookups are backend-specific; see data/ (subscribeAccessRole).
