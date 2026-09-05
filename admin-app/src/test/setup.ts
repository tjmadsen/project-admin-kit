import '@testing-library/jest-dom'

// Node may expose an incomplete experimental localStorage object before jsdom
// installs its own. Keep browser-facing tests deterministic across supported
// Node releases.
if (typeof window !== 'undefined' && typeof window.localStorage?.clear !== 'function') {
  const values = new Map<string, string>()
  const storage: Storage = {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
}
