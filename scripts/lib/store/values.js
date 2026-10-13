'use strict';

// Backend-neutral values for the stores that do not have Firestore's types:
// a Timestamp with the same toMillis()/toDate() surface the CLI already reads,
// a server-timestamp sentinel resolved at commit time, the JSON encoding the
// local store and local server share, and Firestore's two write semantics
// (update replaces top-level fields; set-merge merges maps recursively).

class StoreTimestamp {
  constructor(millis) {
    if (!Number.isFinite(millis)) throw new Error(`Invalid timestamp ${millis}`);
    this.millis = Math.trunc(millis);
  }
  static now() { return new StoreTimestamp(Date.now()); }
  static fromMillis(millis) { return new StoreTimestamp(millis); }
  static fromDate(date) { return new StoreTimestamp(date.getTime()); }
  get seconds() { return Math.floor(this.millis / 1000); }
  get nanoseconds() { return (this.millis % 1000) * 1e6; }
  toMillis() { return this.millis; }
  toDate() { return new Date(this.millis); }
}

const SERVER_TIMESTAMP = Object.freeze({ $op: 'serverTimestamp' });
const serverTimestamp = () => SERVER_TIMESTAMP;
const isServerTimestamp = (value) => Boolean(value && typeof value === 'object' && value.$op === 'serverTimestamp');

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

// Anything with toMillis() (Firestore Timestamp, StoreTimestamp) or a Date.
function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return null;
}

// JSON form: timestamps become {"$ts": ISO}; everything else is plain JSON.
function encode(value) {
  const millis = timestampMillis(value);
  if (millis !== null) return { $ts: new Date(millis).toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]));
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === '$ts' && typeof value.$ts === 'string') return StoreTimestamp.fromMillis(Date.parse(value.$ts));
    return Object.fromEntries(keys.map((key) => [key, decode(value[key])]));
  }
  return value;
}

// Resolves sentinels (server timestamps, and {$op:'arrayUnion'} from the
// local server's wire format) against the current field value.
function resolveValue(current, value, now) {
  if (isServerTimestamp(value)) return now;
  if (isPlainObject(value) && value.$op === 'arrayUnion') {
    const existing = Array.isArray(current) ? current : [];
    return [...existing, ...value.values.map((entry) => resolveValue(undefined, entry, now))];
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(undefined, entry, now));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveValue(undefined, entry, now)]));
  return value;
}

// Firestore update(): each top-level key replaces the stored field.
function applyUpdate(current, patch, now = StoreTimestamp.now()) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) next[key] = resolveValue(current[key], value, now);
  return next;
}

// Firestore set(..., { merge: true }): nested maps merge key by key.
function applyMerge(current, data, now = StoreTimestamp.now()) {
  const next = { ...(current || {}) };
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && !value.$op && isPlainObject(next[key])) next[key] = applyMerge(next[key], value, now);
    else next[key] = resolveValue(next[key], value, now);
  }
  return next;
}

// Firestore-style auto id: 20 alphanumerics.
function autoId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = require('node:crypto').randomBytes(20);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

module.exports = {
  StoreTimestamp, applyMerge, applyUpdate, autoId, decode, encode, isPlainObject, isServerTimestamp,
  resolveValue, serverTimestamp, timestampMillis,
};
