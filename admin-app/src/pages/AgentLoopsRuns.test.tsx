import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AGENT_MODELS } from '../lib/agents'
import type { AgentLoopRun } from '../lib/types'
import AgentLoops from './AgentLoops'

const mocks = vi.hoisted(() => ({ runs: [] as AgentLoopRun[] }))

vi.mock('../hooks/useLoopData', () => ({
  useLoopRuns: () => ({ runs: mocks.runs, error: '' }),
  useMachines: () => ({ machines: [], error: '' }),
  useLoopConfig: () => ({ config: { deployAgent: 'sol' }, error: '' }),
  useLoopUsage: () => ({ usage: { claude: null, codex: null }, error: '' }),
}))

vi.mock('../lib/firebase', () => ({ db: {} }))

const timestamp = (date: Date) => ({ toDate: () => date })

describe('Agent Loops run history', () => {
  it('shows exact timing, actual effort, current duration, progress, and a work-item link', () => {
    const now = Date.now()
    mocks.runs = [{
      id: 'run-29', agent: 'sol', queue: 'feature', machineId: 'local-mac', status: 'running',
      activeItem: 'FR-29', activeItemId: 'feature-29', activeCollection: 'featureRequests', thinkingEffort: 'xhigh',
      startedAt: timestamp(new Date(now - 90 * 60_000)), heartbeatAt: timestamp(new Date(now - 10_000)),
      progressAt: timestamp(new Date(now - 2 * 60_000)), progressSummary: 'Tests are running after the implementation pass.',
    }]

    render(<MemoryRouter><AgentLoops /></MemoryRouter>)

    expect(screen.getByRole('link', { name: 'FR-29' })).toHaveAttribute('href', '/features?item=FR-29')
    expect(screen.getAllByText('xhigh').length).toBeGreaterThan(0)
    expect(screen.getByText('1h 30m')).toBeInTheDocument()
    expect(screen.getByText(/Progress 2m ago/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Expand FR-29 run details' }))
    expect(screen.getByText('Tests are running after the implementation pass.')).toBeInTheDocument()
    expect(screen.getByText('Progress captured')).toBeInTheDocument()
  })

  it('keeps deploy routing as a small setting on the bottom roster instead of a hero panel', () => {
    mocks.runs = []
    render(<MemoryRouter><AgentLoops /></MemoryRouter>)

    expect(screen.queryByText('Choose who ships production')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Deploy loop model' })).toBeInTheDocument()
    expect(screen.getByText(/^Every model on /)).toBeInTheDocument()
    expect(document.querySelectorAll('.loop-roster-row').length).toBe(AGENT_MODELS.length)
  })

  it('exposes each run queue to the mobile layout next to the agent name', () => {
    const now = Date.now()
    mocks.runs = [{
      id: 'run-mobile', agent: 'sol', queue: 'deploy', machineId: 'local-mac', status: 'running',
      activeItem: 'FR-64', activeItemId: 'fr-64', activeCollection: 'featureRequests', thinkingEffort: 'high',
      startedAt: timestamp(new Date(now - 50 * 60_000)), heartbeatAt: timestamp(new Date(now - 10_000)),
    }]

    render(<MemoryRouter><AgentLoops /></MemoryRouter>)

    const chips = document.querySelectorAll('.run-queue-chip')
    expect(chips.length).toBe(1)
    expect(chips[0].textContent).toBe('deploy')
  })

  it('names the model version each run used instead of only the model family', () => {
    const now = Date.now()
    const run = (id: string, agent: string, model: string | undefined, minutesAgo: number): AgentLoopRun => ({
      id, agent, queue: 'bug', machineId: 'local-mac', status: 'completed', ...(model ? { model } : {}),
      startedAt: timestamp(new Date(now - minutesAgo * 60_000)), heartbeatAt: timestamp(new Date(now - minutesAgo * 60_000)),
      finishedAt: timestamp(new Date(now - minutesAgo * 60_000)),
    })
    mocks.runs = [
      run('run-sol-new', 'sol', 'gpt-6.1-sol', 5),
      run('run-opus', 'opus', 'claude-opus-5-5', 10),
      run('run-sol-old', 'sol', 'gpt-5.6-sol', 60),
      run('run-fable-legacy', 'fable', undefined, 90),
    ]

    const { container } = render(<MemoryRouter><AgentLoops /></MemoryRouter>)

    const roster = [...container.querySelectorAll('.loop-roster-row strong')].map((node) => node.textContent)
    expect(roster).toContain('Claude Opus 5.5')
    expect(roster).toContain('Codex Sol 6.1')
    expect(roster).toContain('Claude Fable')
    const rows = [...container.querySelectorAll('.run-table-row .agent-name')].map((node) => node.firstChild?.nextSibling?.textContent)
    expect(rows).toEqual(['Sol 6.1', 'Opus 5.5', 'Sol 5.6', 'Fable'])
    expect(screen.getByRole('option', { name: 'Claude Opus 5.5' })).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Filter runs by model' })).toHaveTextContent('Codex Sol 6.1')
  })
})
