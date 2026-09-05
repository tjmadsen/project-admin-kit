import { agentByToken } from '../lib/agents'
import { formatRelative, toDate } from '../lib/format'
import type { AgentLoopRun } from '../lib/types'

export const ACTIVE_RUN_STALE_MS = 6 * 60_000

export function activeAgentRunFor(runs: AgentLoopRun[], itemReference: string | null, now = Date.now()) {
  if (!itemReference) return undefined
  const normalized = itemReference.trim().toLowerCase()
  return runs.find((run) => {
    if (run.status !== 'running' || run.activeItem?.trim().toLowerCase() !== normalized) return false
    const heartbeat = toDate(run.heartbeatAt)?.getTime()
    return heartbeat != null && now - heartbeat >= 0 && now - heartbeat < ACTIVE_RUN_STALE_MS
  })
}

export default function ActiveAgentBadge({ itemRef, runs }: { itemRef: string | null; runs: AgentLoopRun[] }) {
  const run = activeAgentRunFor(runs, itemRef)
  if (!itemRef || !run) return null

  const agent = agentByToken(run.agent)
  const agentLabel = agent?.short || run.agent || 'Agent'
  const tooltip = [
    `${agentLabel} is working on ${itemRef} now`,
    run.queue ? `${run.queue} queue` : null,
    run.machineId ? `machine ${run.machineId}` : null,
    toDate(run.startedAt) ? `started ${formatRelative(run.startedAt)}` : null,
  ].filter(Boolean).join(' · ')

  return <span className="active-agent-badge" title={tooltip}><i aria-hidden="true" />{agentLabel} active</span>
}
