import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { useCollection } from '../hooks/useCollection'
import { useLoopRuns, useMachines } from '../hooks/useLoopData'
import { formatRelative, itemRef, ownerLabel, waitingLabel } from '../lib/format'
import { AGENT_FAMILIES, agentByToken, familyForAgent, runnerLabel } from '../lib/agents'
import type { WorkItem } from '../lib/types'
import { projectConfig } from '../lib/project-config'
import { WORK_ITEMS_COLLECTION, WORK_KINDS, isTerminalStatus, workKindOrFallback, workKindPath } from '../lib/work-kinds'

export default function Dashboard() {
  const workItems = useCollection<WorkItem>(WORK_ITEMS_COLLECTION, 500)
  const { runs } = useLoopRuns(25)
  const { machines } = useMachines()
  const all = [...workItems.data].sort((a, b) => {
    const av = (a.updatedAt as { seconds?: number })?.seconds ?? 0
    const bv = (b.updatedAt as { seconds?: number })?.seconds ?? 0
    return bv - av
  })
  const active = all.filter((item) => !isTerminalStatus(item))
  const deploying = active.filter((item) => item.waitingOn === 'deployer')
  const needsOwner = active.filter((item) => item.waitingOn === 'human')
  const currentRuns = runs.filter((run) => run.status === 'running')
  const lastMachine = machines[0]

  return (
    <>
      <PageHeader eyebrow="Control room" title={`Welcome, ${projectConfig.admin.ownerName}.`} description="A lean view of what needs attention and what the agents are moving forward." />
      <section className="stat-grid">
        {WORK_KINDS.map((kind) => {
          const open = active.filter((item) => item.kind === kind.id)
          return <Link to={workKindPath(kind)} className={`stat-card ${kind.tone === 'green' ? '' : kind.tone}`.trim()} key={kind.id}><span>Open {kind.shortLabel.toLowerCase()}</span><strong>{open.length}</strong><small>{kind.copy.statDetail === 'critical' ? `${open.filter((i) => i.priority === 'critical').length} critical` : `${open.filter((i) => i.waitingOn === 'agent').length} queued for agents`}</small></Link>
        })}
        <Link to="/activity" className="stat-card blue"><span>Needs you</span><strong>{needsOwner.length}</strong><small>{deploying.length} ready to deploy</small></Link>
        <Link to="/loops" className="stat-card violet"><span>Loops running</span><strong>{currentRuns.length}</strong><small>{lastMachine ? `${lastMachine.label} ${formatRelative(lastMachine.lastSeenAt)}` : 'Awaiting first heartbeat'}</small></Link>
      </section>

      <section className="dashboard-grid">
        <div className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Priority queue</p><h2>Needs attention</h2></div><Link to="/activity">View all</Link></div>
          {active.length === 0 ? <EmptyState title="The queue is clear" copy={`New ${WORK_KINDS.map((kind) => kind.pluralLabel.toLowerCase()).join(' and ')} will appear here.`} /> : (
            <div className="item-list compact">
              {active.slice(0, 7).map((item) => (
                <Link to={workKindPath(workKindOrFallback(item.kind))} className="item-row" key={`${item.kind}-${item.id}`}>
                  <span className={`priority-dot ${item.priority}`} />
                  <div className="item-main"><strong>{item.title}</strong><small>{itemRef(item.kind, item.number)} · {ownerLabel(item.assignedTo)}</small></div>
                  <span className={`queue-pill ${item.waitingOn}`}>{waitingLabel(item.waitingOn)}</span>
                  <time>{formatRelative(item.updatedAt)}</time>
                </Link>
              ))}
            </div>
          )}
        </div>
        <div className="panel agent-snapshot">
          <div className="panel-heading"><div><p className="eyebrow">Automation</p><h2>Agent bench</h2></div><Link to="/loops">Details</Link></div>
          {AGENT_FAMILIES.map((agent) => {
            const running = currentRuns.find((run) => familyForAgent(run.agent) === agent)
            const latest = runs.find((run) => familyForAgent(run.agent) === agent)
            const activeModel = agentByToken(running?.agent || latest?.agent)
            return <div className="agent-row" key={agent}><div className={`agent-glyph ${agent}`}>{agent.slice(0, 1).toUpperCase()}</div><div><strong>{runnerLabel(agent)}</strong><span>{running ? `${activeModel?.short || running.agent} · ${running.activeItem || `${running.queue} loop`}` : latest ? `${activeModel?.short || latest.agent} last ran ${formatRelative(latest.startedAt)}` : 'Models ready for first run'}</span></div><i className={running ? 'live' : ''} /></div>
          })}
          <div className="machine-strip"><span>{projectConfig.automation.defaultMachineLabel}</span><strong>{lastMachine?.status === 'online' ? 'Online' : 'Not yet provisioned'}</strong></div>
        </div>
      </section>
    </>
  )
}
