import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import PageHeader from '../components/PageHeader'
import EmptyState from '../components/EmptyState'
import { useLoopConfig, useLoopRuns, useLoopUsage, useMachines } from '../hooks/useLoopData'
import { AGENT_FAMILIES, AGENT_MODELS, agentByToken, runnerLabel, type AgentModel, type AgentModelToken } from '../lib/agents'
import { serverTimestamp, setDocument } from '../data'
import { formatRelative, toDate } from '../lib/format'
import type { AgentLoopRun, AgentLoopUsageEntry } from '../lib/types'
import { projectConfig } from '../lib/project-config'
import { workKindForReference, workKindPath } from '../lib/work-kinds'

const USAGE_STALE_MS = 50 * 60_000
// A run heartbeats every minute, so six minutes of silence means the runner is
// gone. The loop sweep rewrites those rows to "interrupted", but a row is only
// swept on the next poll of that machine, and rows written before the sweep
// existed are never rewritten at all — so the table applies the same freshness
// rule the agent cards use rather than reporting a dead run as live for hours.
const RUN_STALE_MINUTES = 6

export function formatLoopStart(value: unknown, now = new Date()) {
  const date = toDate(value)
  if (!date) return '—'
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return date.toLocaleString([], sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function formatLoopDuration(run: Pick<AgentLoopRun, 'durationSeconds' | 'startedAt' | 'status'>, now = Date.now()) {
  const startedAt = toDate(run.startedAt)
  const elapsedSeconds = run.status === 'running' && startedAt
    ? Math.max(0, Math.floor((now - startedAt.getTime()) / 1000))
    : run.durationSeconds
  if (elapsedSeconds == null) return '—'
  const seconds = Math.max(0, Math.floor(elapsedSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainder}s`
  return `${seconds}s`
}

// The reference prefix (FR-29, TASK-3) identifies the kind and so its route.
export function runItemPath(run: Pick<AgentLoopRun, 'activeCollection' | 'activeItem'>) {
  const kind = workKindForReference(run.activeItem)
  if (!run.activeItem || !kind) return null
  return `${workKindPath(kind)}?item=${encodeURIComponent(run.activeItem)}`
}

export function usageStatus(entry: AgentLoopUsageEntry | null, now = Date.now()): 'current' | 'stale' | 'unavailable' | 'missing' {
  if (!entry) return 'missing'
  if (entry.captureStatus === 'unavailable' || entry.usedPercent == null) return 'unavailable'
  const capturedAt = toDate(entry.capturedAt)
  if (!capturedAt || now - capturedAt.getTime() > USAGE_STALE_MS) return 'stale'
  return 'current'
}

const failureLabels: Record<string, string> = {
  cli_missing: 'CLI missing', expect_missing: 'PTY helper missing', startup_timeout: 'startup timed out',
  startup_exit: 'exited during startup', trust_prompt: 'folder trust required', usage_timeout: 'usage timed out',
  usage_exit: 'exited in usage screen', pty_error: 'capture failed', missing_label: 'weekly label missing',
  parse_error: 'weekly value unreadable',
}

export function usageSummary(entry: AgentLoopUsageEntry | null) {
  const status = usageStatus(entry)
  if (status === 'missing') return 'Not captured yet'
  const captured = entry?.capturedAt ? `Captured ${formatRelative(entry.capturedAt)}` : 'Capture time unavailable'
  const resetAt = toDate(entry?.resetsAt)
  const reset = entry?.resetsLabel ? ` · resets ${entry.resetsLabel}` : resetAt ? ` · resets ${resetAt.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''
  if (status === 'unavailable') {
    const reason = entry?.captureError ? failureLabels[entry.captureError] || 'capture unavailable' : 'capture unavailable'
    return entry?.usedPercent == null ? `Unavailable · ${reason}` : `Unavailable · ${reason} · last successful ${entry.usedPercent}%`
  }
  if (status === 'stale') return `Stale · ${entry?.usedPercent}% used · ${captured.toLowerCase()}${reset}`
  return `${captured}${reset}`
}

export function joinWithAnd(values: readonly string[]) {
  if (values.length <= 2) return values.join(' and ')
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

export interface UsageGroup { key: string; label: string; detail: string; provider: string | null }

// One card per usage provider (agents sharing a plan share a limit), then one
// "not exposed" card per runner whose agents have no usage hook at all.
export function usageGroups(agents: readonly AgentModel[]): UsageGroup[] {
  const groups = new Map<string, UsageGroup & { shorts: string[] }>()
  for (const agent of agents) {
    const key = agent.usageProvider ? `usage:${agent.usageProvider}` : `runner:${agent.runner}`
    const group = groups.get(key) || { key, label: runnerLabel(agent.usageProvider || agent.runner), detail: '', provider: agent.usageProvider, shorts: [] }
    group.shorts.push(agent.short)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort((a, b) => Number(a.provider === null) - Number(b.provider === null))
    .map(({ shorts, ...group }) => ({ ...group, detail: shorts.join(' · ') }))
}

export function guardDescription(agent: Pick<AgentModel, 'guarded' | 'runner' | 'sandbox'>) {
  if (agent.guarded) return null
  return `The ${runnerLabel(agent.runner)} runner does not enforce headless-guard.py, so destructive shell commands are not blocked${agent.sandbox ? ` (sandbox: ${agent.sandbox})` : ''}.`
}

function isFresh(value: unknown, minutes: number, now = Date.now()) {
  const date = toDate(value)
  return Boolean(date && now - date.getTime() < minutes * 60_000)
}

type RunRow = Pick<AgentLoopRun, 'status' | 'startedAt' | 'heartbeatAt' | 'durationSeconds'>

export function runOutcome(run: RunRow, now = Date.now()) {
  return run.status === 'running' && !isFresh(run.heartbeatAt, RUN_STALE_MINUTES, now) ? 'interrupted' : run.status
}

export function runDuration(run: RunRow, now = Date.now()) {
  if (run.durationSeconds != null) return `${Math.max(1, Math.round(run.durationSeconds / 60))}m`
  if (runOutcome(run, now) === 'running') return 'Live'
  // An interrupted run stops at its last heartbeat; a growing "Live" duration
  // is exactly what made these loops look like they ran for hours.
  const startedAt = toDate(run.startedAt)
  const lastSign = toDate(run.heartbeatAt)
  if (!startedAt || !lastSign) return '—'
  return `${Math.max(1, Math.round((lastSign.getTime() - startedAt.getTime()) / 60_000))}m`
}

export default function AgentLoops({ canManage = true }: { canManage?: boolean }) {
  const { runs, error: runError } = useLoopRuns(150)
  const { machines, error: machineError } = useMachines()
  const { config, error: configError } = useLoopConfig()
  const { usage, error: usageError } = useLoopUsage()
  const [saving, setSaving] = useState(false)
  const [queueFilter, setQueueFilter] = useState('all')
  const [modelFilter, setModelFilter] = useState('all')
  const [outcomeFilter, setOutcomeFilter] = useState('all')
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [now, setNow] = useState(() => Date.now())
  const current = runs.filter((run) => runOutcome(run, now) === 'running')
  const filteredRuns = useMemo(() => runs.filter((run) =>
    (queueFilter === 'all' || run.queue === queueFilter)
    && (modelFilter === 'all' || run.agent === modelFilter)
    && (outcomeFilter === 'all' || runOutcome(run) === outcomeFilter)
  ), [modelFilter, outcomeFilter, queueFilter, runs])
  const pageSize = 25
  const pageCount = Math.max(1, Math.ceil(filteredRuns.length / pageSize))
  const visibleRuns = filteredRuns.slice((page - 1) * pageSize, page * pageSize)

  useEffect(() => { setPage(1) }, [modelFilter, outcomeFilter, queueFilter])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const setDeployAgent = async (deployAgent: AgentModelToken) => {
    if (!canManage) return
    setSaving(true)
    try {
      await setDocument('system', 'agentLoopConfig', { deployAgent, updatedAt: serverTimestamp() }, { merge: true })
    } finally {
      setSaving(false)
    }
  }

  return <>
    <PageHeader eyebrow={`${projectConfig.automation.defaultMachineLabel} automation`} title="Agent Loops" description={`Fresh-context ${joinWithAnd(AGENT_FAMILIES.map(runnerLabel))} workers coordinated through the same backlog.`} action={!canManage && <span className="readonly-badge">Read only</span>} />
    {(runError || machineError || configError || usageError) && <div className="error-banner">{runError || machineError || configError || usageError}</div>}
    <section className="panel usage-panel">
      <div className="usage-heading"><div><p className="eyebrow">7-day provider usage</p><h2>Current model usage</h2><p>Shared limits across every model in each provider family, captured by {projectConfig.automation.defaultMachineLabel}.</p></div><small>Refreshes during every loop poll</small></div>
      <div className="usage-grid">
        {usageGroups(AGENT_MODELS).map((group) => group.provider
          ? <UsageCard key={group.key} provider={group.label} detail={group.detail} entry={usage[group.provider] || null} />
          : <article className="usage-card unavailable" key={group.key}><div><span>{group.label}</span><strong>—</strong></div><p>{group.detail}</p><small>CLI plan usage is not exposed</small><div className="usage-track"><i style={{ width: '0%' }} /></div></article>)}
      </div>
    </section>
    <section className="panel loop-config-panel">
      <div><p className="eyebrow">Queue routing</p><h2>Choose who ships production</h2><p>Feature and bug models are selected on each item. The shared deploy queue uses this model for its next fresh-context run.</p></div>
      {canManage
        ? <label>Deploy loop model<select aria-label="Deploy loop model" value={config.deployAgent} disabled={saving} onChange={(event) => void setDeployAgent(event.target.value as AgentModelToken)}>{AGENT_MODELS.map((agent) => <option key={agent.token} value={agent.token}>{agent.emoji} {agent.label}</option>)}</select><small>{saving ? 'Saving…' : 'Saved automatically · used on the next poll'}</small></label>
        : <div className="readonly-field loop-readonly-field"><span>Deploy loop model</span><strong>{agentByToken(config.deployAgent)?.label || config.deployAgent}</strong><small>Administrators control deploy routing. You can view usage, workers, and run history.</small></div>}
    </section>
    <section className="loop-agent-grid">
      {AGENT_MODELS.map((agent) => {
        const active = current.find((run) => run.agent === agent.token)
        const latest = runs.find((run) => run.agent === agent.token)
        const deployer = config.deployAgent === agent.token
        const unguarded = guardDescription(agent)
        return <article className={`loop-agent-card ${deployer ? 'deployer' : ''}`} key={agent.token}><div className={`agent-glyph ${agent.family}`}>{agent.emoji}</div><div><p className="eyebrow">{active ? 'Running now' : deployer ? 'Deploy model' : 'Available'}{unguarded && <span className="unguarded-badge" title={unguarded} aria-label={`Unguarded: ${unguarded}`}>unguarded</span>}</p><h2>{agent.label}</h2><p>{active ? `${active.queue} · ${active.activeItem || 'selecting work'}` : latest ? `Last ${latest.status} ${formatRelative(latest.finishedAt || latest.startedAt)}` : agent.model}</p></div><i className={active ? 'live' : ''} /></article>
      })}
    </section>
    <section className="dashboard-grid loops-layout">
      <div className="panel">
        <div className="panel-heading"><div><p className="eyebrow">Live run history</p><h2>What the loops actually did</h2></div><small>{filteredRuns.length} runs · live updates</small></div>
        <div className="run-filters">
          <label>Queue<select aria-label="Filter runs by queue" value={queueFilter} onChange={(event) => setQueueFilter(event.target.value)}><option value="all">All queues</option><option value="feature">Feature</option><option value="bug">Bug</option><option value="deploy">Deploy</option></select></label>
          <label>Model<select aria-label="Filter runs by model" value={modelFilter} onChange={(event) => setModelFilter(event.target.value)}><option value="all">All models</option>{AGENT_MODELS.map((agent) => <option key={agent.token} value={agent.token}>{agent.label}</option>)}</select></label>
          <label>Outcome<select aria-label="Filter runs by outcome" value={outcomeFilter} onChange={(event) => setOutcomeFilter(event.target.value)}><option value="all">All outcomes</option><option value="running">Running</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="interrupted">Interrupted</option></select></label>
        </div>
        {runs.length === 0 ? <EmptyState title="No loop runs yet" copy="Provision the Mac Studio or run a one-shot smoke test from Operations." /> : <div className="run-table">
          <div className="run-table-head"><span>Agent</span><span>Queue</span><span>Effort</span><span>Result</span><span>Work</span><span>Started</span><span>Duration</span><span /></div>
          {visibleRuns.map((run) => <RunRecord key={run.id} run={run} now={now} expanded={expandedRun === run.id} onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)} />)}
          {filteredRuns.length === 0 && <EmptyState title="No matching runs" copy="Try a different queue, model, or outcome filter." />}
          {filteredRuns.length > pageSize && <div className="run-pagination"><button disabled={page === 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>← Previous</button><span>Page {page} of {pageCount}</span><button disabled={page === pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>Next →</button></div>}
        </div>}
      </div>
      <aside className="panel machine-panel">
        <div className="panel-heading"><div><p className="eyebrow">Machines</p><h2>Runner health</h2></div></div>
        {machines.length === 0 ? <EmptyState title="No heartbeat" copy={`Run provision-machine.sh to register ${projectConfig.automation.defaultMachineLabel}.`} /> : machines.map((machine) => <article className="machine-card" key={machine.id}><div><i className={isFresh(machine.lastSeenAt, 10) ? 'online' : ''} /><strong>{machine.label}</strong></div><p>{machine.hostname}</p><span>{machine.repoRoot}</span><small>{machine.agents?.join(' · ')} · {formatRelative(machine.lastSeenAt)}</small></article>)}
      </aside>
    </section>
  </>
}

function RunRecord({ run, now, expanded, onToggle }: { run: AgentLoopRun; now: number; expanded: boolean; onToggle: () => void }) {
  const agent = agentByToken(run.agent)
  const itemPath = runItemPath(run)
  const startedAt = toDate(run.startedAt)
  const outcome = runOutcome(run, now)
  const detail = outcome === 'running'
    ? run.progressSummary || 'The worker is still running. A progress snapshot will appear after 15 minutes.'
    : run.summary || (outcome === 'interrupted'
      ? 'The runner stopped reporting before it recorded a result. Its item returns to the queue on the next loop sweep.'
      : 'No result output was captured.')
  return <div className="run-record">
    <div className="run-table-row">
      <span className="agent-name"><i className={`mini-agent ${agent?.family || run.agent}`} />{agent?.short || run.agent}</span>
      <span className="run-queue">{run.queue}</span>
      <span className="run-effort">{run.thinkingEffort || '—'}</span>
      <span className="run-result"><b className={`run-status ${outcome}`}>{outcome}</b></span>
      {itemPath ? <Link className="run-work run-work-link" to={itemPath}>{run.activeItem}</Link> : <span className="run-work">{run.activeItem || '—'}</span>}
      <time className="run-start" dateTime={startedAt?.toISOString()} title={startedAt?.toLocaleString()}><strong>{formatLoopStart(run.startedAt, new Date(now))}</strong><small>{formatRelative(run.startedAt, new Date(now))}</small></time>
      <span className="run-duration"><strong>{outcome === 'interrupted' ? runDuration(run, now) : formatLoopDuration(run, now)}</strong>{outcome === 'running' && <small>{run.progressAt ? `Progress ${formatRelative(run.progressAt, new Date(now))}` : 'Live · snapshot at 15m'}</small>}</span>
      <button className="run-expand-button" type="button" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${run.activeItem || `${run.agent} ${run.queue}`} run details`} aria-expanded={expanded} onClick={onToggle}>{expanded ? '−' : '+'}</button>
    </div>
    {expanded && <div className="run-detail">
      <div><span>Exit code</span><strong>{run.exitCode ?? (outcome === 'running' ? 'Running' : '—')}</strong></div>
      <div><span>Machine</span><strong>{run.machineId}</strong></div>
      <div><span>Effort</span><strong>{run.thinkingEffort || '—'}</strong></div>
      <div><span>{outcome === 'running' ? 'Progress captured' : 'Finished'}</span><strong>{formatLoopStart(outcome === 'running' ? run.progressAt : run.finishedAt, new Date(now))}</strong></div>
      <pre>{detail}</pre>
    </div>}
  </div>
}

function UsageCard({ provider, detail, entry }: { provider: string; detail: string; entry: AgentLoopUsageEntry | null }) {
  const status = usageStatus(entry)
  const percent = entry?.usedPercent == null ? null : Math.max(0, Math.min(100, entry.usedPercent))
  const tone = status === 'current' && percent != null ? percent >= 90 ? 'critical' : percent >= 70 ? 'warning' : '' : ''
  return <article className={`usage-card ${status} ${tone}`}><div><span>{provider}</span><strong>{percent == null ? '—' : `${percent}%`}</strong></div><p>{detail}</p><small>{usageSummary(entry)}</small><div className="usage-track"><i style={{ width: `${percent || 0}%` }} /></div></article>
}
