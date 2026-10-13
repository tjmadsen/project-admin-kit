import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKEND, setAdapterForTesting, subscribeQuery, updateDocument, uploadAttachments } from './index'
import type { DataAdapter } from './types'
import { githubBacklogRepository } from '../pages/GitHubBackend'

function fakeAdapter(): DataAdapter {
  return {
    backend: 'local',
    ready: async () => undefined,
    onAuthChanged: () => () => undefined,
    signIn: async () => undefined,
    signOut: async () => undefined,
    subscribeAccessRole: () => () => undefined,
    subscribeQuery: vi.fn((_spec, onData) => { onData([{ id: 'a' }]); return vi.fn() }),
    subscribeDoc: () => () => undefined,
    setDoc: vi.fn(async () => undefined),
    updateDoc: vi.fn(async () => undefined),
    deleteDoc: vi.fn(async () => undefined),
    createWorkItem: vi.fn(async () => 1),
    uploadAttachments: vi.fn(async () => ({ urls: [], cleanup: async () => undefined })),
  }
}

afterEach(() => setAdapterForTesting(null))

describe('data layer entry point', () => {
  it('is built for the configured backend (firestore when absent)', () => {
    expect(BACKEND).toBe('firestore')
  })

  it('subscribes once the adapter loads and cancels a subscription made before that', async () => {
    const adapter = fakeAdapter()
    setAdapterForTesting(adapter)
    const onData = vi.fn()
    subscribeQuery({ collection: 'workItems' }, onData, vi.fn())
    const cancelled = subscribeQuery({ collection: 'agentMachines' }, vi.fn(), vi.fn())
    cancelled()
    await Promise.resolve(); await Promise.resolve()
    expect(onData).toHaveBeenCalledWith([{ id: 'a' }])
    expect(adapter.subscribeQuery).toHaveBeenCalledTimes(1)
    await updateDocument('workItems', 'a', { status: 'done' })
    expect(adapter.updateDoc).toHaveBeenCalledWith('workItems', 'a', { status: 'done' })
  })

  it('skips the adapter entirely for an empty attachment list', async () => {
    const adapter = fakeAdapter()
    setAdapterForTesting(adapter)
    expect((await uploadAttachments([], 'bug', 'a', 'owner@example.com')).urls).toEqual([])
    expect(adapter.uploadAttachments).not.toHaveBeenCalled()
  })

  it('points github builds at the backlog repository', () => {
    expect(githubBacklogRepository({ repository: { slug: 'acme/app' } })).toBe('acme/app')
    expect(githubBacklogRepository({ backend: { repository: 'acme/backlog' }, repository: { slug: 'acme/app' } })).toBe('acme/backlog')
  })
})
