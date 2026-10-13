import { describe, expect, it, vi } from 'vitest'
import { createLocalAdapter, decodeWire, encodeWire } from './local'
import { arrayUnion, nowTimestamp, serverTimestamp } from './values'

type Call = { url: string; init: RequestInit }

function fakeServer(routes: Record<string, unknown>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init })
    const key = `${init.method || 'GET'} ${url.split('?')[0]}`
    const body = key in routes ? routes[key] : { error: `no route ${key}` }
    return { ok: key in routes, status: key in routes ? 200 : 404, json: async () => body } as Response
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

class FakeEventSource {
  static last: FakeEventSource
  listeners = new Map<string, () => void>()
  closed = false
  constructor(public url: string) { FakeEventSource.last = this }
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener) }
  close() { this.closed = true }
  emit(type: string) { this.listeners.get(type)?.() }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('local data adapter', () => {
  it('treats the server session as the signed-in owner with admin access', async () => {
    const { fetchImpl } = fakeServer({ 'GET /api/session': { role: 'admin', user: { uid: 'local-owner', email: 'owner@example.com', emailVerified: true, displayName: 'Owner', photoURL: null } } })
    const adapter = createLocalAdapter({ fetchImpl, createEventSource: null })
    const user = await new Promise((resolve) => adapter.onAuthChanged(resolve))
    expect(user).toMatchObject({ email: 'owner@example.com', emailVerified: true })
    const role = await new Promise((resolve) => adapter.subscribeAccessRole(user as never, resolve))
    expect(role).toBe('admin')
  })

  it('queries with ordering, decodes timestamps, and refetches on change events', async () => {
    const { calls, fetchImpl } = fakeServer({ 'GET /api/collections/workItems': { docs: [{ id: 'a', updatedAt: { $ts: '2026-01-02T03:04:05.000Z' } }] } })
    const adapter = createLocalAdapter({ fetchImpl, createEventSource: (url) => new FakeEventSource(url) as unknown as EventSource })
    const onData = vi.fn()
    const stop = adapter.subscribeQuery({ collection: 'workItems', orderBy: 'updatedAt', direction: 'desc', limit: 500 }, onData, vi.fn())
    await flush()
    expect(calls[0].url).toBe('/api/collections/workItems?orderBy=updatedAt&direction=desc&limit=500')
    const [rows] = onData.mock.calls[0]
    expect(rows[0].updatedAt.toDate().toISOString()).toBe('2026-01-02T03:04:05.000Z')
    expect(rows[0].updatedAt.seconds).toBe(Date.parse('2026-01-02T03:04:05.000Z') / 1000)
    expect(FakeEventSource.last.url).toBe('/api/events')
    FakeEventSource.last.emit('change')
    await flush()
    expect(onData).toHaveBeenCalledTimes(2)
    stop()
    expect(FakeEventSource.last.closed).toBe(true)
  })

  it('sends writes with the guard header and the server wire format', async () => {
    const { calls, fetchImpl } = fakeServer({ 'PATCH /api/docs/workItems/item%201': { ok: true }, 'POST /api/work-items': { id: 'draft', number: 7 } })
    const adapter = createLocalAdapter({ fetchImpl, createEventSource: null })
    await adapter.updateDoc('workItems', 'item 1', { status: 'done', updatedAt: serverTimestamp(), messages: arrayUnion({ body: 'Hi', createdAt: nowTimestamp(Date.parse('2026-01-01T00:00:00Z')) }) })
    expect((calls[0].init.headers as Record<string, string>)['X-Project-Admin']).toBe('local')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ patch: {
      status: 'done', updatedAt: { $op: 'serverTimestamp' },
      messages: { $op: 'arrayUnion', values: [{ body: 'Hi', createdAt: { $ts: '2026-01-01T00:00:00.000Z' } }] },
    } })
    expect(await adapter.createWorkItem({ id: 'draft', counterField: 'nextFeatureNumber', data: { title: 'x' } })).toBe(7)
  })

  it('uploads attachments as raw bytes and removes them when asked to clean up', async () => {
    const { calls, fetchImpl } = fakeServer({ 'POST /api/attachments': { url: '/attachments/local-owner/bug/i/one.png' }, 'DELETE /api/attachments': { ok: true } })
    const adapter = createLocalAdapter({ fetchImpl, createEventSource: null })
    const uploaded = await adapter.uploadAttachments([new File(['x'], 'one.png', { type: 'image/png' })], 'bug', 'i', 'owner@example.com')
    expect(uploaded.urls).toEqual(['/attachments/local-owner/bug/i/one.png'])
    expect(calls[0].url).toBe('/api/attachments?uploader=local-owner&kind=bug&itemId=i&name=one.png')
    await uploaded.cleanup()
    expect(calls[1].url).toBe(`/api/attachments?url=${encodeURIComponent('/attachments/local-owner/bug/i/one.png')}`)
  })

  it('surfaces server errors', async () => {
    const { fetchImpl } = fakeServer({})
    const adapter = createLocalAdapter({ fetchImpl, createEventSource: null })
    await expect(adapter.deleteDoc('adminUsers', 'a@b.c')).rejects.toThrow(/no route DELETE/)
  })

  it('round-trips the wire encoding', () => {
    const decoded = decodeWire({ at: { $ts: '2026-05-06T07:08:09.000Z' }, list: [{ $ts: '2026-05-06T07:08:09.000Z' }] }) as { at: { toMillis: () => number } }
    expect(encodeWire(decoded as Record<string, unknown>)).toEqual({ at: { $ts: '2026-05-06T07:08:09.000Z' }, list: [{ $ts: '2026-05-06T07:08:09.000Z' }] })
  })
})
