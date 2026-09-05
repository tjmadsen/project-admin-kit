import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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
})
