import type { Owner, ReviewGate, WaitingOn, WorkItem } from './types'
import { agentByOwner } from './agents'
import { deployTargetDefinition } from './deployment'
import { projectConfig } from './project-config'
import { workKindOrFallback } from './work-kinds'

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

// Configured targets carry their own label; the rest are legacy item values.
export function deploymentLabel(type?: string) {
  return deployTargetDefinition(type ?? '')?.label ?? ({
    firebase_rules: 'Firebase rules', mixed: 'Mixed release',
  } as Record<string, string>)[type ?? ''] ?? (type || 'Not selected').replaceAll('_', ' ')
}

export function itemRef(kind: string, number: number) {
  return `${workKindOrFallback(kind).prefix}-${number}`
}

export function matchesItemReference(item: WorkItem, reference: string | null) {
  if (!reference) return false
  const normalized = reference.trim().toLowerCase()
  return item.id.toLowerCase() === normalized || itemRef(item.kind, item.number).toLowerCase() === normalized
}
