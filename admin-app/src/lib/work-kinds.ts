// Work item kinds as the console sees them. Mirrors scripts/lib/work-kinds.js:
// configured kinds merge over the built-in definition with the same id, then
// generic defaults; an absent `workKinds` means the built-in feature + bug pair.
import builtInKinds from '../../../scripts/lib/work-kinds.defaults.json'
import { projectConfig, type WorkKindConfig } from './project-config'

export const WORK_ITEMS_COLLECTION = 'workItems'

export type WorkKindIcon = 'spark' | 'bug' | 'check'
export type WorkKindTone = 'green' | 'amber' | 'blue' | 'violet'

export interface WorkKindDefinition {
  id: string
  label: string
  pluralLabel: string
  shortLabel: string
  prefix: string
  route: string
  planReview: boolean
  deploys: boolean
  statuses: { initial: string; done: string; declined: string }
  icon: WorkKindIcon
  tone: WorkKindTone
  copy: { eyebrow: string; adminDescription: string; collaboratorDescription: string; createLabel: string; statDetail: 'queued' | 'critical' }
  terminalStatuses: string[]
  completedAtField: 'shippedAt' | 'resolvedAt'
}

const builtIns = builtInKinds as Record<string, WorkKindConfig>

function resolveKind(id: string, raw: WorkKindConfig): WorkKindDefinition {
  const base = builtIns[id] || {}
  const merged = { ...base, ...raw, statuses: { ...base.statuses, ...raw.statuses }, copy: { ...base.copy, ...raw.copy } }
  if (!merged.label || !merged.prefix) throw new Error(`workKinds.${id} needs a label and prefix`)
  const pluralLabel = merged.pluralLabel ?? `${merged.label}s`
  const statuses = {
    initial: merged.statuses.initial ?? 'open',
    done: merged.statuses.done ?? 'closed',
    declined: merged.statuses.declined ?? 'declined',
  }
  return {
    id,
    label: merged.label,
    pluralLabel,
    shortLabel: merged.shortLabel ?? pluralLabel,
    prefix: merged.prefix,
    route: merged.route ?? `${id}s`,
    planReview: merged.planReview ?? false,
    deploys: merged.deploys ?? true,
    statuses,
    icon: (merged.icon ?? 'check') as WorkKindIcon,
    tone: (merged.tone ?? 'blue') as WorkKindTone,
    copy: {
      eyebrow: merged.copy.eyebrow ?? 'Work queue',
      adminDescription: merged.copy.adminDescription ?? `Plan, assign, and complete ${pluralLabel.toLowerCase()}.`,
      collaboratorDescription: merged.copy.collaboratorDescription ?? `Submit ${pluralLabel.toLowerCase()} and follow their progress.`,
      createLabel: merged.copy.createLabel ?? merged.label.toLowerCase(),
      statDetail: merged.copy.statDetail ?? 'queued',
    },
    terminalStatuses: [statuses.done, statuses.declined],
    completedAtField: statuses.done === 'shipped' ? 'shippedAt' : 'resolvedAt',
  }
}

export function resolveWorkKinds(raw: Record<string, WorkKindConfig> | undefined): WorkKindDefinition[] {
  return Object.entries(raw ?? builtIns).map(([id, entry]) => resolveKind(id, entry))
}

export const WORK_KINDS = resolveWorkKinds(projectConfig.workKinds)

export function workKind(id: string | undefined, kinds = WORK_KINDS): WorkKindDefinition | undefined {
  return kinds.find((kind) => kind.id === id)
}

// Unknown kinds (data written under an older config) still render, generically.
export function workKindOrFallback(id: string | undefined, kinds = WORK_KINDS): WorkKindDefinition {
  return workKind(id, kinds) ?? resolveKind(id || 'item', { label: 'Work item', prefix: (id || 'item').toUpperCase() })
}

export function workKindForReference(reference: string | null | undefined, kinds = WORK_KINDS) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(reference?.trim() || '')
  return match ? kinds.find((kind) => kind.prefix.toLowerCase() === match[1].toLowerCase()) : undefined
}

// feature -> nextFeatureNumber and bug -> nextBugNumber are the legacy counter
// fields, so existing numbering continues; must match scripts/lib/work-kinds.js.
export function counterFieldFor(id: string) {
  return `next${id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Number`
}

export function workKindPath(kind: WorkKindDefinition) {
  return `/${kind.route}`
}

export function isTerminalStatus(item: { kind: string; status: string }) {
  return workKindOrFallback(item.kind).terminalStatuses.includes(item.status)
}

// "Marked shipped"/"Accept & mark shipped" for shipping kinds; "Resolved"/"Closed" otherwise.
export function completionCopy(kind: WorkKindDefinition) {
  return kind.statuses.done === 'shipped'
    ? { verb: 'shipped', accept: 'mark shipped', accepted: 'Marked shipped', closed: 'Marked shipped' }
    : { verb: 'closed', accept: 'resolve', accepted: 'Resolved', closed: 'Closed' }
}

export function declineCopy(kind: WorkKindDefinition) {
  return kind.statuses.declined === 'wont_fix'
    ? { action: "Won't fix", confirmation: "Won't fix", title: `Close this ${kind.label.toLowerCase()} as won't fix.` }
    : { action: 'Decline', confirmation: 'Declined', title: `Decline this ${kind.label.toLowerCase()}.` }
}
