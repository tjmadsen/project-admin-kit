// Small localStorage wrappers shared by the work list (sort/filter memory) and
// the theme switcher. Both tolerate restricted or private-browsing storage by
// falling back to the caller's default instead of throwing.
export function readPreference(key: string, fallback: string) {
  try { return typeof window.localStorage?.getItem === 'function' ? window.localStorage.getItem(key) || fallback : fallback }
  catch { return fallback }
}

export function writePreference(key: string, value: string) {
  try { if (typeof window.localStorage?.setItem === 'function') window.localStorage.setItem(key, value) }
  catch { /* Preferences are optional in restricted/private browsing contexts. */ }
}
