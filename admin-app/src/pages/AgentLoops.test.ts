import { describe, expect, it } from 'vitest'
import type { AgentLoopRun, AgentLoopUsageEntry } from '../lib/types'
import { formatLoopDuration, guardDescription, joinWithAnd, runDuration, runItemPath, runOutcome, usageGroups, usageStatus, usageSummary } from './AgentLoops'
import { AGENT_MODELS, agentByToken } from '../lib/agents'

const timestamp = (date: Date) => ({ toDate: () => date })

describe('Agent Loops usage telemetry', () => {
  it('treats a recent successful capture as current', () => {
    const now = new Date('2026-08-31T19:00:00Z')
    const entry: AgentLoopUsageEntry = {
      usedPercent: 42,
      capturedAt: timestamp(new Date(now.getTime() - 10 * 60_000)),
      captureStatus: 'available',
    }
    expect(usageStatus(entry, now.getTime())).toBe('current')
  })

  it('marks captures older than fifty minutes as stale', () => {
    const now = new Date('2026-08-31T19:00:00Z')
    const entry: AgentLoopUsageEntry = {
      usedPercent: 67,
      capturedAt: timestamp(new Date(now.getTime() - 51 * 60_000)),
      captureStatus: 'available',
    }
    expect(usageStatus(entry, now.getTime())).toBe('stale')
  })

  it('shows an explicit failed capture without erasing the last successful value', () => {
    const entry: AgentLoopUsageEntry = {
      usedPercent: 71,
      captureStatus: 'unavailable',
      captureError: 'usage_timeout',
    }
    expect(usageStatus(entry)).toBe('unavailable')
    expect(usageSummary(entry)).toContain('last successful 71%')
  })

  it('does not invent a number before the first capture', () => {
    expect(usageStatus(null)).toBe('missing')
    expect(usageSummary(null)).toBe('Not captured yet')
  })
})

describe('Agent Loops run outcomes', () => {
  const now = new Date('2026-09-04T05:00:00Z')
  const run = (overrides: Partial<AgentLoopRun>): AgentLoopRun => ({
    id: 'run-1', agent: 'sol', queue: 'feature', machineId: 'local-mac', status: 'running',
    startedAt: timestamp(new Date('2026-09-04T03:00:00Z')),
    heartbeatAt: timestamp(new Date('2026-09-04T04:00:00Z')),
    ...overrides,
  })

  it('reports a run that stopped heartbeating as interrupted with the duration frozen at the last heartbeat', () => {
    const stalled = run({})
    expect(runOutcome(stalled, now.getTime())).toBe('interrupted')
    expect(runDuration(stalled, now.getTime())).toBe('60m')
  })

  it('keeps a run that is still heartbeating live', () => {
    const live = run({ heartbeatAt: timestamp(new Date('2026-09-04T04:57:00Z')) })
    expect(runOutcome(live, now.getTime())).toBe('running')
    expect(runDuration(live, now.getTime())).toBe('Live')
  })

  it('leaves a finished run and its recorded duration alone', () => {
    const finished = run({ status: 'completed', durationSeconds: 7200 })
    expect(runOutcome(finished, now.getTime())).toBe('completed')
    expect(runDuration(finished, now.getTime())).toBe('120m')
  })
})

describe('Agent Loops run details', () => {
  it('keeps hours and minutes for long-running iterations', () => {
    const startedAt = timestamp(new Date('2026-09-04T01:00:00Z'))
    expect(formatLoopDuration({ status: 'running', startedAt }, new Date('2026-09-04T02:30:00Z').getTime())).toBe('1h 30m')
    expect(formatLoopDuration({ status: 'completed', startedAt, durationSeconds: 3723 })).toBe('1h 2m')
    expect(formatLoopDuration({ status: 'completed', startedAt, durationSeconds: 83 })).toBe('1m 23s')
  })

  it('routes feature and bug references to their detail views', () => {
    expect(runItemPath({ activeItem: 'FR-29', activeCollection: 'featureRequests' })).toBe('/features?item=FR-29')
    expect(runItemPath({ activeItem: 'BUG-16' })).toBe('/bugs?item=BUG-16')
    expect(runItemPath({ activeItem: 'selecting work' })).toBeNull()
  })
})

describe('Agent Loops roster presentation', () => {
  it('groups usage cards by provider and lists runners without telemetry last', () => {
    expect(usageGroups(AGENT_MODELS).map(({ label, detail, provider }) => ({ label, detail, provider }))).toEqual([
      { label: 'Codex', detail: 'Sol · Terra · Luna', provider: 'codex' },
      { label: 'Claude', detail: 'Opus · Sonnet · Fable', provider: 'claude' },
      { label: 'Grok', detail: 'Grok', provider: null },
    ])
  })

  it('describes unguarded runners and stays quiet for guarded ones', () => {
    expect(guardDescription(agentByToken('opus')!)).toBeNull()
    expect(guardDescription(agentByToken('sol')!)).toMatch(/Codex runner does not enforce headless-guard\.py.*sandbox: danger-full-access/)
    expect(guardDescription(agentByToken('grok')!)).toMatch(/Grok runner/)
  })

  it('joins runner names for the page description', () => {
    expect(joinWithAnd(['Codex', 'Claude', 'Grok'])).toBe('Codex, Claude, and Grok')
    expect(joinWithAnd(['Claude'])).toBe('Claude')
  })
})
