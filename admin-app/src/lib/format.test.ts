import { describe, expect, it } from 'vitest'
import { formatRelative, itemRef, ownerLabel, waitingLabel } from './format'

describe('admin formatting', () => {
  it('uses the right backlog references', () => { expect(itemRef('feature', 12)).toBe('FR-12'); expect(itemRef('bug', 8)).toBe('BUG-8') })
  it('labels precise model ownership', () => { expect(ownerLabel('grok-agent')).toBe('Grok'); expect(ownerLabel('sol-agent')).toBe('Codex Sol') })
  it('labels human handoffs', () => expect(waitingLabel('human')).toBe('Project owner'))
  it('formats recent timestamps', () => expect(formatRelative(new Date('2026-08-31T12:55:00Z'), new Date('2026-08-31T13:00:00Z'))).toBe('5m ago'))
})
