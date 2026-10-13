// Backend-neutral write values. Pages build patches with these; each adapter
// translates them when it writes (Firestore: serverTimestamp()/arrayUnion()/
// Timestamp; local: the server's {"$op": ...} wire format).

export const SERVER_TIMESTAMP = '__pa_serverTimestamp'
export const ARRAY_UNION = '__pa_arrayUnion'
export const NOW = '__pa_now'

export type ServerTimestampValue = { [SERVER_TIMESTAMP]: true }
export type ArrayUnionValue = { [ARRAY_UNION]: unknown[] }
export type NowValue = { [NOW]: number; toDate: () => Date; toMillis: () => number; seconds: number }

/** Resolved to the commit time by the backend. */
export function serverTimestamp(): ServerTimestampValue {
  return { [SERVER_TIMESTAMP]: true }
}

/** Appends to an array field (used for thread messages). */
export function arrayUnion(...values: unknown[]): ArrayUnionValue {
  return { [ARRAY_UNION]: values }
}

/** A client-clock timestamp, e.g. a message's createdAt. Renders like one, too. */
export function nowTimestamp(millis = Date.now()): NowValue {
  return { [NOW]: millis, toDate: () => new Date(millis), toMillis: () => millis, seconds: Math.floor(millis / 1000) }
}

export const isServerTimestamp = (value: unknown): value is ServerTimestampValue => Boolean(value && typeof value === 'object' && SERVER_TIMESTAMP in value)
export const isArrayUnion = (value: unknown): value is ArrayUnionValue => Boolean(value && typeof value === 'object' && ARRAY_UNION in value)
export const isNow = (value: unknown): value is NowValue => Boolean(value && typeof value === 'object' && NOW in value)

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
}

/** Walks a write payload, replacing sentinels with what `convert` returns. */
export function mapValues(value: unknown, convert: (value: unknown) => unknown | undefined): unknown {
  const converted = convert(value)
  if (converted !== undefined) return converted
  if (Array.isArray(value)) return value.map((entry) => mapValues(entry, convert))
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapValues(entry, convert)]))
  return value
}

/** Firestore-style auto id: 20 alphanumerics from the platform CSPRNG. */
export function newDocumentId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
