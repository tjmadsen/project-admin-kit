import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Users from './Users'

const mocks = vi.hoisted(() => ({
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  users: [] as Array<Record<string, unknown>>,
}))

// The page writes through the backend-neutral data layer.
vi.mock('../data', () => ({
  deleteDocument: (collection: string, id: string) => mocks.deleteDoc(`${collection}/${id}`),
  serverTimestamp: () => 'SERVER_TIMESTAMP',
  setDocument: (collection: string, id: string, data: unknown, options: unknown) => mocks.setDoc(`${collection}/${id}`, data, options),
  updateDocument: (collection: string, id: string, data: unknown) => mocks.updateDoc(`${collection}/${id}`, data),
}))

vi.mock('../hooks/useCollection', () => ({
  useCollection: () => ({ data: mocks.users, loading: false, error: '' }),
}))


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

  it('shows resolved notification defaults and writes the full map when a toggle changes', async () => {
    mocks.users[0] = { ...mocks.users[0], notifications: { email: { final_outcome: false } } }
    render(<Users currentEmail="owner@example.com" />)

    expect(screen.queryByLabelText('Email Needs your action for owner@example.com')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Notifications for owner@example.com' }))

    expect(screen.getByLabelText('Email Needs your action for owner@example.com')).toBeChecked()
    expect(screen.getByLabelText('Email Deploy progress for owner@example.com')).not.toBeChecked()
    expect(screen.getByLabelText('Email Completed for owner@example.com')).not.toBeChecked()
    expect(screen.getByLabelText('Push Deploy progress for owner@example.com')).toBeChecked()
    expect(screen.getByText('Email 1/4 · Push 4/4')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Email Needs your action for owner@example.com'))
    await waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledWith(
      'adminUsers/owner@example.com',
      expect.objectContaining({
        notifications: {
          email: { action_required: false, deployment_failure: false, deployment_progress: false, final_outcome: false },
          push: { action_required: true, deployment_failure: true, deployment_progress: true, final_outcome: true },
        },
      }),
    ))
  })

})
