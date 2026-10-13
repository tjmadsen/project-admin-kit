import { describe, expect, it, vi } from 'vitest'

const firestore = vi.hoisted(() => ({
  updateDoc: vi.fn(async () => undefined),
  setDoc: vi.fn(async () => undefined),
  sets: [] as Array<{ path: string; data: Record<string, unknown> }>,
}))

vi.mock('../lib/firebase', () => ({ db: {}, auth: { currentUser: null }, storage: {}, signInWithGoogle: vi.fn() }))
vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>()
  return {
    ...actual,
    doc: (_db: unknown, ...segments: string[]) => ({ path: segments.join('/') }),
    updateDoc: firestore.updateDoc,
    setDoc: firestore.setDoc,
    serverTimestamp: () => 'server-timestamp',
    arrayUnion: (...values: unknown[]) => ({ arrayUnion: values }),
    runTransaction: async (_db: unknown, operation: (transaction: unknown) => Promise<unknown>) => operation({
      get: async () => ({ data: () => ({ nextBugNumber: 4 }) }),
      set: (reference: { path: string }, data: Record<string, unknown>) => { firestore.sets.push({ path: reference.path, data }) },
    }),
  }
})

import { Timestamp } from 'firebase/firestore'
import { createFirestoreAdapter } from './firestore'
import { arrayUnion, nowTimestamp, serverTimestamp } from './values'

describe('firestore data adapter', () => {
  it('turns the neutral sentinels into Firestore field values', async () => {
    const adapter = createFirestoreAdapter()
    await adapter.updateDoc('workItems', 'item-1', { status: 'in_progress', updatedAt: serverTimestamp(), messages: arrayUnion({ body: 'Go', createdAt: nowTimestamp(1_700_000_000_000) }) })
    const [reference, payload] = firestore.updateDoc.mock.calls[0] as unknown as [{ path: string }, Record<string, any>]
    expect(reference.path).toBe('workItems/item-1')
    expect(payload.updatedAt).toBe('server-timestamp')
    expect(payload.messages.arrayUnion[0].createdAt).toBeInstanceOf(Timestamp)
    expect(payload.messages.arrayUnion[0].createdAt.toMillis()).toBe(1_700_000_000_000)
  })

  it('allocates the next number for a new work item in one transaction', async () => {
    const adapter = createFirestoreAdapter()
    const number = await adapter.createWorkItem({ id: 'draft', counterField: 'nextBugNumber', data: { kind: 'bug', createdAt: serverTimestamp() } })
    expect(number).toBe(5)
    expect(firestore.sets).toEqual([
      { path: 'system/counters', data: { nextBugNumber: 5, updatedAt: 'server-timestamp' } },
      { path: 'workItems/draft', data: { kind: 'bug', createdAt: 'server-timestamp', number: 5 } },
    ])
  })
})
