import { readPreference, writePreference } from './preferences'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'project-admin-theme'
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
export const THEME_LABELS: Record<ThemePreference, string> = { system: 'System', light: 'Light', dark: 'Dark' }
// Browser-chrome colour per resolved theme (iOS Safari toolbar, PWA status bar).
// index.html's boot script repeats these values so the chrome matches before the
// bundle loads; keep both in sync with --bg in index.css.
export const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#07110d', dark: '#0d1411' }

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readTheme(): ThemePreference {
  const stored = readPreference(THEME_STORAGE_KEY, 'system')
  return isThemePreference(stored) ? stored : 'system'
}

/** Appearance reported by the native admin shell, when the wrapper injects one. */
export function nativeAppearance(): ResolvedTheme | null {
  const value = window.__adminNativeShell?.appearance
  return value === 'light' || value === 'dark' ? value : null
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && Boolean(window.matchMedia('(prefers-color-scheme: dark)')?.matches)
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== 'system') return preference
  return nativeAppearance() ?? (systemPrefersDark() ? 'dark' : 'light')
}

/**
 * Writes the preference to <html data-theme> so index.css can scope its
 * prefers-color-scheme fallback to "system" only, and keeps the theme-color
 * meta in step with the resolved theme. A native wrapper that reports its own
 * appearance replaces the media query while the preference is "system".
 */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const native = preference === 'system' ? nativeAppearance() : null
  document.documentElement.setAttribute('data-theme', native ?? preference)
  const resolved = resolveTheme(preference)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved])
  return resolved
}

export function writeTheme(preference: ThemePreference): ResolvedTheme {
  writePreference(THEME_STORAGE_KEY, preference)
  return applyTheme(preference)
}

export function nextTheme(preference: ThemePreference): ThemePreference {
  return THEME_PREFERENCES[(THEME_PREFERENCES.indexOf(preference) + 1) % THEME_PREFERENCES.length]
}

/** Applies the stored theme now and again whenever the OS appearance changes. Returns the unsubscribe. */
export function initTheme(): () => void {
  applyTheme(readTheme())
  if (typeof window.matchMedia !== 'function') return () => undefined
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  if (typeof query?.addEventListener !== 'function') return () => undefined
  const onChange = () => applyTheme(readTheme())
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
