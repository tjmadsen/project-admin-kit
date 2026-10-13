import { describe, expect, it } from 'vitest'
import { itemRef } from './format'
import { WORK_KINDS, completionCopy, counterFieldFor, declineCopy, isTerminalStatus, resolveWorkKinds, workKindForReference, workKindOrFallback } from './work-kinds'

describe('work kind resolution', () => {
  it('falls back to exactly the built-in feature and bug pair', () => {
    const kinds = resolveWorkKinds(undefined)
    expect(kinds.map((kind) => [kind.id, kind.prefix, kind.route, kind.pluralLabel])).toEqual([
      ['feature', 'FR', 'features', 'Feature Requests'],
      ['bug', 'BUG', 'bugs', 'Bugs'],
    ])
    expect(kinds[1].planReview).toBe(true)
    expect(kinds[0].terminalStatuses).toEqual(['shipped', 'declined'])
    expect(kinds[1].terminalStatuses).toEqual(['closed', 'wont_fix'])
  })

  it('merges configured fields over built-ins and defaults new kinds', () => {
    const [feature, chore] = resolveWorkKinds({ feature: { prefix: 'FEAT' }, chore: { label: 'Chore', prefix: 'CH', deploys: false } })
    expect(feature.prefix).toBe('FEAT')
    expect(feature.copy.createLabel).toBe('request')
    expect(chore).toMatchObject({ route: 'chores', pluralLabel: 'Chores', deploys: false, icon: 'check', completedAtField: 'resolvedAt' })
    expect(chore.copy.createLabel).toBe('chore')
  })

  it('loads the configured task kind and derives copy from status vocabulary', () => {
    expect(WORK_KINDS.map((kind) => kind.id)).toEqual(['feature', 'bug', 'task'])
    const task = workKindOrFallback('task')
    expect(task.deploys).toBe(false)
    expect(itemRef('task', 3)).toBe('TASK-3')
    expect(workKindForReference('task-3')?.id).toBe('task')
    expect(workKindForReference('NOPE-3')).toBeUndefined()
    expect(counterFieldFor('task')).toBe('nextTaskNumber')
    expect(counterFieldFor('bug')).toBe('nextBugNumber')
    expect(counterFieldFor('tech-debt')).toBe('nextTechDebtNumber')
    expect(completionCopy(workKindOrFallback('feature')).accept).toBe('mark shipped')
    expect(completionCopy(task).verb).toBe('closed')
    expect(declineCopy(workKindOrFallback('bug')).action).toBe("Won't fix")
    expect(isTerminalStatus({ kind: 'task', status: 'declined' })).toBe(true)
    expect(isTerminalStatus({ kind: 'feature', status: 'closed' })).toBe(false)
  })

  it('renders items of an unknown kind generically instead of failing', () => {
    expect(itemRef('epic', 2)).toBe('EPIC-2')
    expect(workKindOrFallback('epic').label).toBe('Work item')
  })
})
