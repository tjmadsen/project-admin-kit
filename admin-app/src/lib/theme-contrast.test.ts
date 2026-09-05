// Guards the palette in index.css: every colour lives in the :root token block,
// and the dark values keep WCAG AA contrast for text, chips, and disabled buttons.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

type Mode = 'light' | 'dark'
type Rgb = [number, number, number]

const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8')
const rootStart = css.indexOf(':root {')
const rootEnd = css.indexOf('}', rootStart)
const rootBlock = css.slice(rootStart, rootEnd + 1)
const darkBlock = css.slice(css.indexOf('[data-theme="dark"]'))
const tokens = new Map<string, string>()
for (const match of rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)) tokens.set(match[1], match[2].trim())

function resolve(name: string, mode: Mode): string {
  const value = tokens.get(name)
  if (!value) throw new Error(`unknown token ${name}`)
  const pair = value.match(/^light-dark\((.+?),\s*(.+)\)$/)
  const chosen = pair ? (mode === 'light' ? pair[1] : pair[2]) : value
  const reference = chosen.match(/^var\((--[\w-]+)\)$/)
  return reference ? resolve(reference[1], mode) : chosen.trim()
}

function rgb(hex: string): Rgb {
  const digits = hex.slice(1)
  const full = digits.length <= 4 ? digits.split('').map((d) => d + d).join('') : digits
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16)) as Rgb
}

function luminance([r, g, b]: Rgb) {
  const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: Rgb, background: Rgb) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

function blend(top: Rgb, under: Rgb, opacity: number): Rgb {
  return top.map((value, index) => Math.round(value * opacity + under[index] * (1 - opacity))) as Rgb
}

const color = (name: string, mode: Mode) => rgb(resolve(name, mode))

// [text token, surface token, minimum ratio]. 4.5 is AA for normal text; 3 is
// AA for large text and UI components.
const darkPairs: Array<[string, string, number]> = [
  ['--ink', '--bg', 4.5], ['--ink', '--panel', 4.5], ['--ink-strong', '--panel', 4.5],
  ['--ink-emphasis', '--panel', 4.5], ['--ink-body', '--panel', 4.5], ['--ink-body', '--bg-elevated', 4.5],
  ['--ink-label', '--panel', 4.5], ['--ink-soft', '--panel', 4.5], ['--ink-soft', '--chip-bg', 4.5], ['--ink-soft', '--panel-muted', 4.5],
  ['--ink-muted', '--panel', 4.5], ['--ink-muted', '--panel-muted', 4.5], ['--ink-muted', '--chip-bg', 4.5],
  ['--ink-quiet', '--panel', 4.5], ['--ink-quiet', '--bg-elevated', 4.5],
  ['--ink-faint', '--panel', 4.5], ['--ink-faint', '--panel-hover', 4.5], ['--ink-faint', '--bg-elevated', 4.5], ['--ink-faint', '--accent-faint', 4.5],
  ['--chip-ink', '--chip-bg', 4.5],
  ['--accent-text', '--panel', 4.5], ['--accent-text', '--bg', 4.5], ['--link', '--panel', 4.5],
  ['--accent-ink', '--panel', 4.5], ['--accent-ink', '--accent-soft', 4.5], ['--accent-ink', '--accent-faint', 4.5], ['--accent-ink', '--accent-tint', 4.5], ['--accent-ink', '--segment-active', 4.5],
  ['--accent-ink-strong', '--panel', 4.5], ['--accent-bright', '--panel', 4.5], ['--accent-muted', '--panel', 4.5], ['--accent-muted', '--accent-faint', 4.5], ['--accent-quiet', '--chip-bg', 4.5],
  ['--success', '--success-soft', 4.5], ['--on-accent', '--accent', 4.5], ['--on-accent', '--accent-hover', 4.5], ['--on-accent', '--info-strong', 4.5], ['--on-accent', '--agent-grok', 4.5],
  ['--info', '--info-soft', 4.5], ['--info', '--info-tint', 4.5], ['--info-muted', '--thread-human-bg', 4.5],
  ['--warning-deep', '--warning-soft', 4.5], ['--warning-deep', '--panel', 4.5], ['--warning', '--panel', 4.5], ['--warning', '--warning-soft', 4.5], ['--warning', '--warning-faint', 4.5], ['--warning-ink', '--warning-soft', 4.5], ['--warning-ink', '--warning-faint', 4.5], ['--warning-ink', '--panel', 4.5],
  ['--danger', '--panel', 4.5], ['--danger', '--danger-soft', 4.5], ['--danger-muted', '--warning-faint', 4.5],
  ['--violet', '--violet-soft', 4.5],
  ['--line-strong', '--panel', 1.3], ['--marker', '--panel', 3],
]

describe('index.css palette', () => {
  it('defines every colour in the :root token block', () => {
    const outside = css.replace(rootBlock, '')
    const literals = outside.match(/#[0-9a-fA-F]{3,8}\b/g) || []
    expect(literals).toEqual([])
  })

  it('switches color-scheme for a stored dark preference and for system + OS dark only', () => {
    expect(rootBlock).toContain('color-scheme: light')
    expect(darkBlock).toMatch(/\[data-theme="dark"\]\s*\{[^}]*color-scheme: dark/)
    expect(darkBlock).toMatch(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{[^}]*color-scheme: dark/)
  })

  it('keeps light values as the first light-dark() argument for the core tokens', () => {
    expect(resolve('--bg', 'light')).toBe('#f4f6f2')
    expect(resolve('--panel', 'light')).toBe('#fff')
    expect(resolve('--ink', 'light')).toBe('#17221d')
    expect(resolve('--ink-strong', 'light')).toBe('#101a15')
    expect(resolve('--line', 'light')).toBe('#dde3dd')
    expect(resolve('--muted', 'light')).toBe('#66726c')
    expect(resolve('--accent', 'light')).toBe('#16784f')
  })

  it.each(darkPairs)('dark: %s on %s reaches %s:1', (text, surface, minimum) => {
    expect(contrast(color(text, 'dark'), color(surface, 'dark'))).toBeGreaterThanOrEqual(minimum)
  })

  it('keeps status chips distinguishable from each other in the dark theme', () => {
    const chips = ['--warning-soft', '--info-soft', '--violet-soft', '--accent-soft', '--chip-bg'].map((name) => color(name, 'dark'))
    for (let a = 0; a < chips.length; a += 1) {
      for (let b = a + 1; b < chips.length; b += 1) {
        const distance = Math.hypot(...chips[a].map((value, index) => value - chips[b][index]))
        expect(distance).toBeGreaterThan(12)
      }
    }
  })

  it('keeps disabled buttons readable in the dark theme', () => {
    const opacity = Number(darkBlock.match(/--disabled-opacity:\s*([\d.]+)/)?.[1])
    const actionOpacity = Number(darkBlock.match(/--disabled-action-opacity:\s*([\d.]+)/)?.[1])
    expect(opacity).toBeGreaterThan(0)
    expect(actionOpacity).toBeGreaterThan(0)
    const panel = color('--panel', 'dark')
    const primary = contrast(blend(color('--on-accent', 'dark'), panel, opacity), blend(color('--accent', 'dark'), panel, opacity))
    const secondary = contrast(blend(color('--ink-label', 'dark'), panel, opacity), panel)
    const action = contrast(blend(color('--ink-label', 'dark'), panel, actionOpacity), panel)
    const primaryAction = contrast(blend(color('--on-accent', 'dark'), panel, actionOpacity), blend(color('--accent', 'dark'), panel, actionOpacity))
    expect(primary).toBeGreaterThanOrEqual(4.5)
    expect(secondary).toBeGreaterThanOrEqual(4.5)
    expect(action).toBeGreaterThanOrEqual(4.5)
    expect(primaryAction).toBeGreaterThanOrEqual(4.5)
  })
})
