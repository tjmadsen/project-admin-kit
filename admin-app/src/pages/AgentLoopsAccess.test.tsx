import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentLoops from './AgentLoops'
import type { AgentLoopRun } from '../lib/types'

const mockRuns: AgentLoopRun[] = []

vi.mock('../hooks/useLoopData', () => ({
  useLoopRuns: () => ({ runs: mockRuns, error: '' }),
  useMachines: () => ({ machines: [], error: '' }),
  useLoopConfig: () => ({ config: { deployAgent: 'codex-sol' }, error: '' }),
  useLoopUsage: () => ({ usage: { claude: null, codex: null }, error: '' }),
}))

vi.mock('../lib/firebase', () => ({ db: {} }))

describe('Agent Loops access', () => {
  afterEach(() => { mockRuns.length = 0 })

  it('gives collaborators telemetry and history without deploy routing controls', () => {
    render(<AgentLoops canManage={false} />)
    expect(screen.getByText('Read only')).toBeInTheDocument()
    expect(screen.getByText('Current model usage')).toBeInTheDocument()
    expect(screen.getByText('What the loops actually did')).toBeInTheDocument()
    expect(screen.getAllByText('Codex Sol').length).toBeGreaterThan(0)
    // Every Codex and Grok card says it runs without headless-guard.py; Claude cards do not.
    expect(screen.getAllByText('unguarded')).toHaveLength(4)
    expect(screen.getByText('Fresh-context Codex, Claude, and Grok workers coordinated through the same backlog.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Deploy loop model' })).not.toBeInTheDocument()
    expect(screen.getByText(/Administrators control deploy routing/i)).toBeInTheDocument()
  })

  it('keeps the deploy loop selector available to Project owner', () => {
    render(<AgentLoops canManage />)
    expect(screen.getByRole('combobox', { name: 'Deploy loop model' })).toBeInTheDocument()
    expect(screen.queryByText('Read only')).not.toBeInTheDocument()
  })
})

describe('Agent Loops run history', () => {
  afterEach(() => { mockRuns.length = 0 })

  it('shows a run that stopped heartbeating as interrupted instead of live for hours', () => {
    mockRuns.push({
      id: 'run-1', agent: 'sol', queue: 'feature', machineId: 'local-mac', status: 'running', activeItem: 'FR-29',
      startedAt: { toDate: () => new Date(Date.now() - 190 * 60_000) },
      heartbeatAt: { toDate: () => new Date(Date.now() - 130 * 60_000) },
    })
    render(<MemoryRouter><AgentLoops canManage /></MemoryRouter>)
    expect(screen.getByText('interrupted')).toBeInTheDocument()
    expect(screen.getByText('60m')).toBeInTheDocument()
    expect(screen.queryByText('Live')).not.toBeInTheDocument()
  })
})
