// The `local` adapter: an HTTP client for scripts/local-server.js (npm run
// local), same origin, loopback only. There is no sign-in: the server reports
// the configured owner as the session. Reads refetch whenever the server's
// event stream reports a change (any writer: console, CLI, loops), falling back
// to polling where EventSource is unavailable.

import type { AccessRole } from '../lib/auth'
import type { DataAdapter, QuerySpec, Row, SessionUser, Unsubscribe } from './types'
import { NOW, isArrayUnion, isNow, isServerTimestamp, mapValues } from './values'

export interface LocalTimestamp {
  seconds: number
  nanoseconds: number
  toDate: () => Date
  toMillis: () => number
}

export function localTimestamp(millis: number): LocalTimestamp {
  return { seconds: Math.floor(millis / 1000), nanoseconds: (millis % 1000) * 1e6, toDate: () => new Date(millis), toMillis: () => millis }
}

/** Server JSON -> values the pages read ({"$ts": ISO} becomes a timestamp). */
export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 1 && entries[0][0] === '$ts' && typeof entries[0][1] === 'string') return localTimestamp(Date.parse(entries[0][1]))
    return Object.fromEntries(entries.map(([key, entry]) => [key, decodeWire(entry)]))
  }
  return value
}

/** Write payload -> the server's wire format. */
export function encodeWire(data: Record<string, unknown>): Record<string, unknown> {
  const convert = (value: unknown): unknown | undefined => {
    if (isServerTimestamp(value)) return { $op: 'serverTimestamp' }
    if (isNow(value)) return { $ts: new Date(value[NOW]).toISOString() }
    if (isArrayUnion(value)) return { $op: 'arrayUnion', values: (Object.values(value)[0] as unknown[]).map((entry) => mapValues(entry, convert)) }
    if (value instanceof Date) return { $ts: value.toISOString() }
    if (value && typeof value === 'object' && typeof (value as LocalTimestamp).toMillis === 'function') return { $ts: new Date((value as LocalTimestamp).toMillis()).toISOString() }
    return undefined
  }
  return mapValues(data, convert) as Record<string, unknown>
}

export interface LocalAdapterOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
  createEventSource?: ((url: string) => EventSource) | null
  pollMs?: number
}

export function createLocalAdapter({
  fetchImpl = (...args) => fetch(...args),
  baseUrl = '',
  createEventSource = typeof EventSource === 'function' ? (url) => new EventSource(url) : null,
  pollMs = 3000,
}: LocalAdapterOptions = {}): DataAdapter {
  const refreshers = new Set<() => void>()
  let source: EventSource | null = null
  let poller: ReturnType<typeof setInterval> | null = null
  let session: Promise<{ user: SessionUser; role: AccessRole }> | null = null

  // One change stream for every live subscription.
  function watch(refresh: () => void): Unsubscribe {
    refreshers.add(refresh)
    if (!source && !poller) {
      const refreshAll = () => refreshers.forEach((entry) => entry())
      if (createEventSource) {
        source = createEventSource(`${baseUrl}/api/events`)
        source.addEventListener('change', refreshAll)
      } else {
        poller = setInterval(refreshAll, pollMs)
      }
    }
    return () => {
      refreshers.delete(refresh)
      if (refreshers.size === 0) {
        source?.close(); source = null
        if (poller) clearInterval(poller)
        poller = null
      }
    }
  }

  async function call<T>(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${route}`, {
      method,
      headers: method === 'GET' ? headers : { 'X-Project-Admin': 'local', 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(payload.error || `Local server ${method} ${route} failed (${response.status})`)
    return decodeWire(payload) as T
  }
  const loadSession = () => (session ||= call('GET', '/api/session'))
  const segment = encodeURIComponent

  function subscribe<T>(load: () => Promise<T>, onData: (value: T) => void, onError: (error: Error) => void): Unsubscribe {
    let active = true
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      load().then((value) => { if (active) onData(value) }, (error: Error) => { if (active) onError(error) })
        .finally(() => { pending = false })
    }
    refresh()
    const stop = watch(refresh)
    return () => { active = false; stop() }
  }

  return {
    backend: 'local',
    ready: async () => undefined,
    onAuthChanged(listener) {
      let active = true
      loadSession().then(({ user }) => { if (active) listener(user) }, () => { if (active) listener(null) })
      return () => { active = false }
    },
    // Single-user: the local owner is always signed in.
    signIn: async () => undefined,
    signOut: async () => undefined,
    subscribeAccessRole(_user, listener) {
      let active = true
      loadSession().then(({ role }) => { if (active) listener(role) }, (error: Error) => { if (active) listener(null, error) })
      return () => { active = false }
    },
    subscribeQuery(spec: QuerySpec, onData, onError) {
      const params = new URLSearchParams()
      if (spec.orderBy) params.set('orderBy', spec.orderBy)
      if (spec.direction) params.set('direction', spec.direction)
      if (spec.limit) params.set('limit', String(spec.limit))
      return subscribe(() => call<{ docs: Row[] }>('GET', `/api/collections/${segment(spec.collection)}?${params}`).then((result) => result.docs), onData, onError)
    },
    subscribeDoc(name, id, onData, onError) {
      return subscribe(() => call<{ exists: boolean; data: Record<string, unknown> | null }>('GET', `/api/docs/${segment(name)}/${segment(id)}`)
        .then((result) => (result.exists && result.data ? result.data : undefined)), onData, onError)
    },
    async setDoc(name, id, data, options = {}) {
      await call('PUT', `/api/docs/${segment(name)}/${segment(id)}`, { data: encodeWire(data), merge: Boolean(options.merge) })
    },
    async updateDoc(name, id, patch) {
      await call('PATCH', `/api/docs/${segment(name)}/${segment(id)}`, { patch: encodeWire(patch) })
    },
    async deleteDoc(name, id) {
      await call('DELETE', `/api/docs/${segment(name)}/${segment(id)}`)
    },
    async transactDocument(name, id, decide) {
      const path = `/api/docs/${segment(name)}/${segment(id)}`
      const current = await call<{ exists: boolean; data: Record<string, unknown> | null }>('GET', path)
      const patch = decide(current.exists && current.data ? current.data : undefined)
      await call('PATCH', path, { patch: encodeWire(patch) })
    },
    async createWorkItem({ id, counterField, data }) {
      const result = await call<{ number: number }>('POST', '/api/work-items', { id, counterField, data: encodeWire(data) })
      return result.number
    },
    async uploadAttachments(files, kind, itemId) {
      const urls: string[] = []
      const remove = () => Promise.allSettled(urls.map((url) => call('DELETE', `/api/attachments?url=${segment(url)}`)))
      try {
        for (const file of files) {
          const params = new URLSearchParams({ uploader: 'local-owner', kind, itemId, name: file.name || 'attachment' })
          const result = await call<{ url: string }>('POST', `/api/attachments?${params}`, file, { 'Content-Type': 'application/octet-stream' })
          urls.push(result.url)
        }
      } catch (error) {
        await remove()
        throw error
      }
      return { urls, cleanup: async () => { await remove() } }
    },
  }
}
