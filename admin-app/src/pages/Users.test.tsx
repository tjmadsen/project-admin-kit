import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Users from './Users'

const mocks = vi.hoisted(() => ({
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  users: [] as Array<Record<string, unknown>>,
}))

vi.mock('firebase/firestore', () => ({
  deleteDoc: mocks.deleteDoc,
  doc: (_db: unknown, collection: string, id: string) => `${collection}/${id}`,
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  setDoc: mocks.setDoc,
  updateDoc: mocks.updateDoc,
}))

vi.mock('../hooks/useCollection', () => ({
  useCollection: () => ({ data: mocks.users, loading: false, error: '' }),
}))

vi.mock('../lib/firebase', () => ({ db: {} }))

describe('Users access management', () => {
  beforeEach(() => {
    mocks.deleteDoc.mockReset()
    mocks.setDoc.mockReset()
    mocks.updateDoc.mockReset()
    mocks.users.splice(0, mocks.users.length,
      { id: 'owner@example.com', email: 'owner@example.com', displayName: 'Owner', role: 'admin', active: true, updatedAt: null },
      { id: 'alex@example.com', email: 'alex@example.com', displayName: 'Alex', role: 'collaborator', active: true, updatedAt: null },
    )
  })

  it('protects the signed-in administrator from self-demotion and removal', () => {
    render(<Users currentEmail="OWNER@example.com" />)

    const ownerRole = screen.getByRole('combobox', { name: 'Role for owner@example.com' })
    const ownerRow = ownerRole.closest('article')
    expect(ownerRole).toBeDisabled()
    expect(ownerRow).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Remove owner@example.com' })).toBeDisabled()
    expect(within(ownerRow as HTMLElement).getByRole('button', { name: 'Suspend' })).toBeDisabled()
  })

  it('adds normalized collaborator access and updates an existing role', async () => {
    render(<Users currentEmail="owner@example.com" />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sam User' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' SAM@Example.com ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add user' }))

    await waitFor(() => expect(mocks.setDoc).toHaveBeenCalledWith(
      'adminUsers/sam@example.com',
      expect.objectContaining({ email: 'sam@example.com', displayName: 'Sam User', role: 'collaborator', active: true }),
      { merge: true },
    ))

    fireEvent.change(screen.getByRole('combobox', { name: 'Role for alex@example.com' }), { target: { value: 'admin' } })
    await waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledWith(
      'adminUsers/alex@example.com',
      expect.objectContaining({ role: 'admin' }),
    ))
  })
})
