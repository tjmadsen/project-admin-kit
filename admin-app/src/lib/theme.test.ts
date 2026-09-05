import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_COLORS, THEME_STORAGE_KEY, applyTheme, initTheme, nextTheme, readTheme, resolveTheme, writeTheme } from './theme'

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>()
  const query = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: vi.fn((_: string, listener: () => void) => { listeners.add(listener) }),
    removeEventListener: vi.fn((_: string, listener: () => void) => { listeners.delete(listener) }),
  }
  window.matchMedia = vi.fn().mockReturnValue(query) as unknown as typeof window.matchMedia
  return { query, fire: () => listeners.forEach((listener) => listener()) }
}

const html = () => document.documentElement.getAttribute('data-theme')
const themeColor = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content')

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.head.innerHTML = '<meta name="theme-color" content="#07110d">'
  delete window.__adminNativeShell
  mockMatchMedia(false)
})

describe('theme preference', () => {
  it('defaults to system when nothing valid is stored', () => {
    expect(readTheme()).toBe('system')
    window.localStorage.setItem(THEME_STORAGE_KEY, 'sepia')
    expect(readTheme()).toBe('system')
  })

  it.each(['system', 'light', 'dark'] as const)('writes %s to storage and to <html data-theme>', (preference) => {
    writeTheme(preference)
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(preference)
    expect(html()).toBe(preference)
    expect(readTheme()).toBe(preference)
  })

  it('keeps the theme-color meta in step with the resolved theme', () => {
    expect(applyTheme('dark')).toBe('dark')
    expect(themeColor()).toBe(THEME_COLORS.dark)
    expect(applyTheme('light')).toBe('light')
    expect(themeColor()).toBe(THEME_COLORS.light)
  })

  it('lets the OS decide while the preference is system', () => {
    mockMatchMedia(true)
    expect(resolveTheme('system')).toBe('dark')
    expect(applyTheme('system')).toBe('dark')
    expect(html()).toBe('system')
    expect(themeColor()).toBe(THEME_COLORS.dark)

    mockMatchMedia(false)
    expect(applyTheme('system')).toBe('light')
    expect(themeColor()).toBe(THEME_COLORS.light)
  })

  it('honours an appearance reported by the native shell over the media query', () => {
    mockMatchMedia(false)
    window.__adminNativeShell = { googleIDToken: '', googleAccessToken: '', appearance: 'dark' }
    expect(applyTheme('system')).toBe('dark')
    expect(html()).toBe('dark')
    expect(applyTheme('light')).toBe('light')
    expect(html()).toBe('light')
  })

  it('cycles system → light → dark → system', () => {
    expect(nextTheme('system')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(nextTheme('dark')).toBe('system')
  })

  it('applies the stored theme on init and re-applies when the OS appearance changes', () => {
    const media = mockMatchMedia(false)
    window.localStorage.setItem(THEME_STORAGE_KEY, 'system')
    const stop = initTheme()
    expect(html()).toBe('system')
    expect(themeColor()).toBe(THEME_COLORS.light)

    media.query.matches = true
    media.fire()
    expect(themeColor()).toBe(THEME_COLORS.dark)

    stop()
    expect(media.query.removeEventListener).toHaveBeenCalled()
  })
})

describe('index.html boot script', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8')
  const boot = source.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  const run = () => new Function(boot as string)()

  it('exists as an inline classic script so it runs before first paint', () => {
    expect(boot).toBeTruthy()
    expect(source).toContain('<meta name="color-scheme" content="light dark" />')
    expect(source.indexOf('<script>')).toBeLessThan(source.indexOf('<script type="module"'))
  })

  it('applies a stored dark preference and the matching theme-color', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark')
    run()
    expect(html()).toBe('dark')
    expect(themeColor()).toBe(THEME_COLORS.dark)
  })

  it('leaves system to the media query and picks the chrome colour from it', () => {
    mockMatchMedia(true)
    run()
    expect(html()).toBe('system')
    expect(themeColor()).toBe(THEME_COLORS.dark)
  })

  it('uses the native shell appearance while the preference is system', () => {
    mockMatchMedia(true)
    window.__adminNativeShell = { googleIDToken: '', googleAccessToken: '', appearance: 'light' }
    run()
    expect(html()).toBe('light')
    expect(themeColor()).toBe(THEME_COLORS.light)
  })
})
