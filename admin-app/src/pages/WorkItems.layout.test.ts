import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8')

function declarationBlock(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

describe('WorkItems layout', () => {
  it('lets the waiting filters shrink to the list pane without scrolling', () => {
    expect(declarationBlock('.work-list-tools .filter-group')).toMatch(/min-width:\s*0/)
    expect(declarationBlock('.work-list-tools .filter-group')).toMatch(/overflow:\s*hidden/)
    expect(declarationBlock('.work-list-tools .filter-group button')).toMatch(/min-width:\s*0/)
  })

  it('centers an empty detail state across the entire pane', () => {
    expect(declarationBlock('.work-detail-pane > .empty-state')).toMatch(/flex:\s*1/)
  })

  it('preserves mobile-sized filter targets', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 760px)'))
    expect(mobile).toMatch(/\.work-list-tools \.filter-group button\s*\{[^}]*min-height:\s*44px/)
  })

  it('bounds expanded phone reply tools while keeping item actions in a compact grid', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 760px)'))
    expect(mobile).toMatch(/\.reply-tools > div\s*\{[^}]*max-height:\s*min\(46vh,\s*360px\)[^}]*overflow-y:\s*auto/)
    expect(mobile).toMatch(/\.phone-item-actions \.action-bar\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/)
  })
})
