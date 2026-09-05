import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItem } from '../lib/types'
import WorkItemDependencies, { blockingDependencies, dependencyWaitLabel, wouldCreateDependencyCycle } from './WorkItemDependencies'

function feature(id: string, number: number, title: string, status = 'backlog', dependsOn: string[] = []): WorkItem {
  return {
    id,
    kind: 'feature',
    number,
    title,
    description: title,
    priority: 'medium',
    status,
    waitingOn: 'agent',
    assignedTo: 'sol-agent',
    thinkingEffort: 'xhigh',
    targetMachine: 'local-mac',
    createdAt: null,
    updatedAt: null,
    messages: [],
    dependsOn,
  }
}

function bug(id: string, number: number, title: string, status = 'open', dependsOn: string[] = []): WorkItem {
  return { ...feature(id, number, title, status, dependsOn), kind: 'bug' }
}

describe('work item dependency model', () => {
  it('derives blockers across feature and bug collections', () => {
    const shipped = feature('feature-7', 7, 'UI overhaul', 'shipped')
    const openBug = bug('bug-4', 4, 'Login regression')
    const item = feature('feature-8', 8, 'Mock data', 'backlog', [shipped.id, openBug.id, 'missing-id'])

    expect(blockingDependencies(item, [item, shipped, openBug]).map((dependency) => dependency.id)).toEqual(['bug-4', 'missing-id'])
    expect(dependencyWaitLabel(item, [item, shipped, openBug])).toBe('Waiting on BUG-4, Missing item')
  })

  it('detects direct and transitive cycles before saving', () => {
    const current = feature('feature-11', 11, 'Dependencies')
    const direct = feature('feature-8', 8, 'Mock data', 'backlog', [current.id])
    const transitive = bug('bug-3', 3, 'Data issue', 'open', [direct.id])
    const unrelated = feature('feature-2', 2, 'Unrelated')

    expect(wouldCreateDependencyCycle(current.id, direct.id, [current, direct, transitive, unrelated])).toBe(true)
    expect(wouldCreateDependencyCycle(current.id, transitive.id, [current, direct, transitive, unrelated])).toBe(true)
    expect(wouldCreateDependencyCycle(current.id, unrelated.id, [current, direct, transitive, unrelated])).toBe(false)
  })
})

describe('dependency picker', () => {
  it('searches by reference or title and adds a prerequisite', () => {
    const current = feature('feature-11', 11, 'Dependencies')
    const prerequisite = feature('feature-7', 7, 'UI overhaul', 'shipped')
    const onChange = vi.fn()
    render(<WorkItemDependencies item={current} allItems={[current, prerequisite]} canManage disabled={false} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Find a prerequisite'), { target: { value: 'overhaul' } })
    fireEvent.click(screen.getByRole('button', { name: /FR-7.*UI overhaul/i }))

    expect(onChange).toHaveBeenCalledWith(['feature-7'])
  })

  it('warns and refuses to save a dependency cycle', () => {
    const current = feature('feature-11', 11, 'Dependencies')
    const candidate = feature('feature-8', 8, 'Mock data', 'backlog', [current.id])
    const onChange = vi.fn()
    render(<WorkItemDependencies item={current} allItems={[current, candidate]} canManage disabled={false} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Find a prerequisite'), { target: { value: 'FR-8' } })
    fireEvent.click(screen.getByRole('button', { name: /FR-8.*Creates cycle/i }))

    expect(screen.getByRole('alert')).toHaveTextContent('would create a dependency cycle')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('shows prerequisite status and reverse dependencies', () => {
    const prerequisite = feature('feature-7', 7, 'UI overhaul', 'in_review')
    const current = feature('feature-8', 8, 'Mock data', 'backlog', [prerequisite.id])
    const dependent = bug('bug-9', 9, 'Fixture mismatch', 'open', [current.id])
    render(<WorkItemDependencies item={current} allItems={[prerequisite, current, dependent]} canManage={false} disabled={false} onChange={vi.fn()} />)

    expect(screen.getByText('Waiting on FR-7')).toBeInTheDocument()
    expect(screen.getByText('in review')).toBeInTheDocument()
    expect(screen.getByText('BUG-9')).toBeInTheDocument()
    expect(screen.queryByLabelText('Find a prerequisite')).not.toBeInTheDocument()
  })

  it('makes the dependency chip and the Blocks dependents navigable when onSelectItem is given', () => {
    const prerequisite = feature('feature-7', 7, 'UI overhaul', 'in_review')
    const current = feature('feature-8', 8, 'Mock data', 'backlog', [prerequisite.id])
    const dependent = bug('bug-9', 9, 'Fixture mismatch', 'open', [current.id])
    const onSelectItem = vi.fn()
    render(<WorkItemDependencies item={current} allItems={[prerequisite, current, dependent]} canManage disabled={false} onChange={vi.fn()} onSelectItem={onSelectItem} />)

    fireEvent.click(screen.getByRole('button', { name: 'FR-7' }))
    expect(onSelectItem).toHaveBeenCalledWith(prerequisite)

    fireEvent.click(screen.getByRole('button', { name: /BUG-9/ }))
    expect(onSelectItem).toHaveBeenCalledWith(dependent)
  })

  it('leaves the chip reference and Blocks dependents inert without onSelectItem', () => {
    const prerequisite = feature('feature-7', 7, 'UI overhaul', 'in_review')
    const current = feature('feature-8', 8, 'Mock data', 'backlog', [prerequisite.id])
    const dependent = bug('bug-9', 9, 'Fixture mismatch', 'open', [current.id])
    render(<WorkItemDependencies item={current} allItems={[prerequisite, current, dependent]} canManage disabled={false} onChange={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'FR-7' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /BUG-9/ })).not.toBeInTheDocument()
    expect(screen.getByText('FR-7')).toBeInTheDocument()
    expect(screen.getByText('BUG-9')).toBeInTheDocument()
  })
})
