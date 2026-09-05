import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { useCollection } from '../hooks/useCollection'
import { useLoopRuns, useMachines } from '../hooks/useLoopData'
import { formatRelative, itemRef, ownerLabel, waitingLabel } from '../lib/format'
import { agentByToken, familyForAgent } from '../lib/agents'
import type { WorkItem } from '../lib/types'
import { projectConfig } from '../lib/project-config'

export default function Dashboard() {
  const features = useCollection<WorkItem>('featureRequests')
  const bugs = useCollection<WorkItem>('bugs')
  const { runs } = useLoopRuns(25)
  const { machines } = useMachines()
  const all = [...features.data, ...bugs.data].sort((a, b) => {
    const av = (a.updatedAt as { seconds?: number })?.seconds ?? 0
    const bv = (b.updatedAt as { seconds?: number })?.seconds ?? 0
    return bv - av
  })
  const active = all.filter((item) => !['shipped', 'closed', 'declined', 'wont_fix'].includes(item.status))
  const deploying = active.filter((item) => item.waitingOn === 'deployer')
  const needsOwner = active.filter((item) => item.waitingOn === 'human')
  const currentRuns = runs.filter((run) => run.status === 'running')
  const lastMachine = machines[0]

  return (
    <>
      <PageHeader eyebrow="Control room" title={`Welcome, ${projectConfig.admin.ownerName}.`} description="A lean view of what needs attention and what the agents are moving forward." />
      <section className="stat-grid">
        <Link to="/features" className="stat-card"><span>Open features</span><strong>{features.data.filter((i) => i.status !== 'shipped').length}</strong><small>{features.data.filter((i) => i.waitingOn === 'agent').length} queued for agents</small></Link>
        <Link to="/bugs" className="stat-card amber"><span>Open bugs</span><strong>{bugs.data.filter((i) => !['closed', 'wont_fix'].includes(i.status)).length}</strong><small>{bugs.data.filter((i) => i.priority === 'critical').length} critical</small></Link>
        <Link to="/activity" className="stat-card blue"><span>Needs you</span><strong>{needsOwner.length}</strong><small>{deploying.length} ready to deploy</small></Link>
        <Link to="/loops" className="stat-card violet"><span>Loops running</span><strong>{currentRuns.length}</strong><small>{lastMachine ? `${lastMachine.label} ${formatRelative(lastMachine.lastSeenAt)}` : 'Awaiting first heartbeat'}</small></Link>
      </section>

      <section className="dashboard-grid">
        <div className="panel">
          <div className="panel-heading"><div><p className="eyebrow">Priority queue</p><h2>Needs attention</h2></div><Link to="/activity">View all</Link></div>
          {active.length === 0 ? <EmptyState title="The queue is clear" copy="New feature requests and bugs will appear here." /> : (
            <div className="item-list compact">
              {active.slice(0, 7).map((item) => (
                <Link to={item.kind === 'feature' ? '/features' : '/bugs'} className="item-row" key={`${item.kind}-${item.id}`}>
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
          {['codex', 'claude', 'grok'].map((agent) => {
            const running = currentRuns.find((run) => familyForAgent(run.agent) === agent)
            const latest = runs.find((run) => familyForAgent(run.agent) === agent)
            const activeModel = agentByToken(running?.agent || latest?.agent)
            return <div className="agent-row" key={agent}><div className={`agent-glyph ${agent}`}>{agent.slice(0, 1).toUpperCase()}</div><div><strong>{agent[0].toUpperCase() + agent.slice(1)}</strong><span>{running ? `${activeModel?.short || running.agent} · ${running.activeItem || `${running.queue} loop`}` : latest ? `${activeModel?.short || latest.agent} last ran ${formatRelative(latest.startedAt)}` : 'Models ready for first run'}</span></div><i className={running ? 'live' : ''} /></div>
          })}
          <div className="machine-strip"><span>{projectConfig.automation.defaultMachineLabel}</span><strong>{lastMachine?.status === 'online' ? 'Online' : 'Not yet provisioned'}</strong></div>
        </div>
      </section>
    </>
  )
}
