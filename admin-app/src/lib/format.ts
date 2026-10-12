import type { Owner, ReviewGate, WaitingOn, WorkItem } from './types'
import { agentByOwner } from './agents'
import { projectConfig } from './project-config'

type TimestampLike = { toDate?: () => Date; seconds?: number }

export function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Date) return value
  if (typeof value === 'object') {
    const timestamp = value as TimestampLike
    if (timestamp.toDate) return timestamp.toDate()
    if (typeof timestamp.seconds === 'number') return new Date(timestamp.seconds * 1000)
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

export function formatRelative(value: unknown, now = new Date()) {
  const date = toDate(value)
  if (!date) return '—'
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`
  return date.toLocaleDateString()
}

export function ownerLabel(owner: Owner | string | undefined) {
  const modelAgent = agentByOwner(owner)
  if (modelAgent) return modelAgent.label
  return ({
    'codex-agent': 'Codex (legacy)',
    'claude-agent': 'Claude (legacy)',
    'grok-agent': 'Grok',
    '': 'Unassigned',
  } as Record<string, string>)[owner ?? ''] ?? owner
}

export function waitingLabel(waitingOn: WaitingOn | string) {
  return ({
    agent: 'Agent', human: projectConfig.admin.ownerName, deployer: 'Deploy', hold: 'Hold', done: 'Done',
  } as Record<string, string>)[waitingOn] ?? waitingOn
}

export function gateLabel(gate?: ReviewGate | string) {
  return ({
    triage: 'Triage',
    question: 'Question',
    plan_review: 'Plan review',
    pr_review: 'PR review',
    deploy_approval: 'Deploy approval',
    acceptance_review: 'Acceptance review',
  } as Record<string, string>)[gate ?? ''] ?? gate ?? ''
}

export function deploymentLabel(type?: string) {
  return ({
    testflight: 'TestFlight', firebase_hosting: 'Firebase Hosting', firebase_functions: 'Firebase Functions',
    firebase_rules: 'Firebase rules', firebase_rules_indexes: 'Rules & indexes', vercel: 'Vercel',
    flutter_web: 'Flutter web', cloud_run: 'Cloud Run', mixed: 'Mixed release', none: 'No deploy',
  } as Record<string, string>)[type ?? ''] ?? (type || 'Not selected').replaceAll('_', ' ')
}

export function itemRef(kind: string, number: number) {
  return kind === 'feature' ? `FR-${number}` : `BUG-${number}`
}

export function adminWorkItemPath(item: Pick<WorkItem, 'kind' | 'number'>) {
  const route = item.kind === 'feature' ? 'features' : 'bugs'
  return `/admin/${route}?item=${encodeURIComponent(itemRef(item.kind, item.number))}`
}

export function matchesItemReference(item: WorkItem, reference: string | null) {
  if (!reference) return false
  const normalized = reference.trim().toLowerCase()
  return item.id.toLowerCase() === normalized || itemRef(item.kind, item.number).toLowerCase() === normalized
}
