import { useMemo } from 'react'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { useCollection } from '../hooks/useCollection'
import { useLoopRuns } from '../hooks/useLoopData'
import { formatRelative, itemRef, ownerLabel, waitingLabel, toDate } from '../lib/format'
import type { WorkItem } from '../lib/types'

export default function Activity({ readOnly = false }: { readOnly?: boolean }) {
  const features = useCollection<WorkItem>('featureRequests')
  const bugs = useCollection<WorkItem>('bugs')
  const { runs } = useLoopRuns(75)
  const events = useMemo(() => [
    ...features.data.map((item) => ({ id: `f-${item.id}`, at: item.updatedAt, icon: '✦', tone: 'green', title: `${itemRef('feature', item.number)} ${item.title}`, copy: `${ownerLabel(item.assignedTo)} · waiting on ${waitingLabel(item.waitingOn)}` })),
    ...bugs.data.map((item) => ({ id: `b-${item.id}`, at: item.updatedAt, icon: '!', tone: 'amber', title: `${itemRef('bug', item.number)} ${item.title}`, copy: `${ownerLabel(item.assignedTo)} · waiting on ${waitingLabel(item.waitingOn)}` })),
    ...runs.map((run) => ({ id: `r-${run.id}`, at: run.finishedAt || run.startedAt, icon: '↻', tone: run.status === 'failed' ? 'red' : 'blue', title: `${run.agent} ${run.queue} loop ${run.status}`, copy: run.activeItem || `${run.machineId} · exit ${run.exitCode ?? '—'}` })),
  ].sort((a, b) => (toDate(b.at)?.getTime() ?? 0) - (toDate(a.at)?.getTime() ?? 0)), [bugs.data, features.data, runs])

  return <><PageHeader eyebrow="Unified timeline" title="Activity" description="Backlog movement and agent execution, ordered by the last meaningful update." action={readOnly && <span className="readonly-badge">Read only</span>} /><div className="panel activity-panel">{events.length === 0 ? <EmptyState title="No activity yet" copy="Create a request or run an agent loop to begin the timeline." /> : <div className="timeline">{events.slice(0, 100).map((event) => <article key={event.id}><div className={`timeline-icon ${event.tone}`}>{event.icon}</div><div><strong>{event.title}</strong><p>{event.copy}</p></div><time>{formatRelative(event.at)}</time></article>)}</div>}</div></>
}
