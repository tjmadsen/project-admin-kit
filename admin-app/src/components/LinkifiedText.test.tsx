import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItem } from '../lib/types'
import LinkifiedText from './LinkifiedText'

function feature(id: string, number: number, title: string): WorkItem {
  return {
    id,
    kind: 'feature',
    number,
    title,
    description: title,
    priority: 'medium',
    status: 'backlog',
    waitingOn: 'agent',
    assignedTo: 'sol-agent',
    thinkingEffort: 'xhigh',
    targetMachine: 'local-mac',
    createdAt: null,
    updatedAt: null,
    messages: [],
  }
}

function bug(id: string, number: number, title: string): WorkItem {
  return { ...feature(id, number, title), kind: 'bug' }
}

describe('LinkifiedText', () => {
  it('linkifies bare URLs without item context', () => {
    const { container } = render(<LinkifiedText text="See https://example.com/docs for details." />)
    const link = screen.getByRole('link', { name: 'https://example.com/docs' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(container).toHaveTextContent('See https://example.com/docs for details.')
  })

  it('links resolved FR-N and BUG-N references and calls onSelectItem, preserving surrounding URL and text', () => {
    const fr = feature('feature-8', 8, 'Mock data')
    const bugItem = bug('bug-3', 3, 'Data issue')
    const onSelectItem = vi.fn()
    render(<LinkifiedText text="See FR-8 and BUG-3, plus https://example.com/x for context." items={[fr, bugItem]} onSelectItem={onSelectItem} />)

    const frButton = screen.getByRole('button', { name: 'FR-8' })
    const bugButton = screen.getByRole('button', { name: 'BUG-3' })
    expect(screen.getByRole('link', { name: 'https://example.com/x' })).toBeInTheDocument()

    frButton.click()
    expect(onSelectItem).toHaveBeenCalledWith(fr)

    bugButton.click()
    expect(onSelectItem).toHaveBeenCalledWith(bugItem)
  })

  it('renders unresolved references and lowercase mentions as plain text', () => {
    render(<LinkifiedText text="Depends on FR-99 and fr-8, unlike FR-8." items={[feature('feature-8', 8, 'Mock data')]} onSelectItem={vi.fn()} />)

    expect(screen.queryByRole('button', { name: 'FR-99' })).not.toBeInTheDocument()
    expect(screen.getByText(/Depends on FR-99 and fr-8, unlike/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'FR-8' })).toBeInTheDocument()
  })

  it('does not linkify FR-N/BUG-N when items or onSelectItem are omitted', () => {
    render(<LinkifiedText text="See FR-8 for details." items={[feature('feature-8', 8, 'Mock data')]} />)
    expect(screen.queryByRole('button', { name: 'FR-8' })).not.toBeInTheDocument()
    expect(screen.getByText('See FR-8 for details.')).toBeInTheDocument()
  })
})
