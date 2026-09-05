import { describe, expect, it } from 'vitest'
import { accessRoleFor, isAllowedAdmin, normalizeEmail } from './auth'

describe('dynamic admin access', () => {
  it('allows an active administrator record', () => {
    const record = { email: 'owner@example.com', role: 'admin' as const, active: true }
    expect(isAllowedAdmin(record, true)).toBe(true)
    expect(accessRoleFor(record, true)).toBe('admin')
  })

  it('returns collaborator access without management permission', () => {
    const record = { email: 'person@example.com', role: 'collaborator' as const, active: true }
    expect(accessRoleFor(record, true)).toBe('collaborator')
    expect(isAllowedAdmin(record, true)).toBe(false)
  })

  it('rejects disabled, unverified, missing, and unknown-role records', () => {
    expect(accessRoleFor({ role: 'admin', active: false }, true)).toBeNull()
    expect(accessRoleFor({ role: 'admin' }, true)).toBeNull()
    expect(accessRoleFor({ role: 'admin', active: true }, false)).toBeNull()
    expect(accessRoleFor(null, true)).toBeNull()
    expect(accessRoleFor({ role: 'owner', active: true }, true)).toBeNull()
  })

  it('normalizes document IDs from email addresses', () => {
    expect(normalizeEmail(' Owner@Example.COM ')).toBe('owner@example.com')
  })
})
