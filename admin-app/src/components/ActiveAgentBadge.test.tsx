import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AgentLoopRun } from '../lib/types'
import ActiveAgentBadge, { ACTIVE_RUN_STALE_MS, activeAgentRunFor } from './ActiveAgentBadge'

const now = Date.now()
const run = (overrides: Partial<AgentLoopRun> = {}): AgentLoopRun => ({
  id: 'run-1', agent: 'sol', queue: 'feature', machineId: 'local-mac', status: 'running', activeItem: 'FR-18',
  startedAt: { toDate: () => new Date(now - 120_000) }, heartbeatAt: { toDate: () => new Date(now - 30_000) }, ...overrides,
})

describe('ActiveAgentBadge', () => {
  it('matches a running fresh loop by item reference', () => {
    expect(activeAgentRunFor([run()], 'fr-18', now)?.id).toBe('run-1')
    expect(activeAgentRunFor([run({ status: 'completed' })], 'FR-18', now)).toBeUndefined()
  })

  it('rejects stale heartbeats', () => {
    expect(activeAgentRunFor([run({ heartbeatAt: { toDate: () => new Date(now - ACTIVE_RUN_STALE_MS) } })], 'FR-18', now)).toBeUndefined()
  })

  it('renders an agent label with queue, machine, and start details', () => {
    render(<ActiveAgentBadge itemRef="FR-18" runs={[run()]} />)
    const badge = screen.getByText('Sol active')
    expect(badge).toHaveAttribute('title', expect.stringContaining('feature queue'))
    expect(badge).toHaveAttribute('title', expect.stringContaining('machine local-mac'))
    expect(badge).toHaveAttribute('title', expect.stringContaining('started'))
  })
})
