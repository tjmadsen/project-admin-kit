export type WorkKind = 'feature' | 'bug'
export type Priority = 'critical' | 'high' | 'medium' | 'low'
export type WaitingOn = 'agent' | 'human' | 'deployer' | 'hold' | 'done'
export type ReviewGate = 'triage' | 'question' | 'plan_review' | 'pr_review' | 'deploy_approval' | 'acceptance_review'
export type Owner = string
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh'

export interface WorkMessage {
  author: string
  authorEmail?: string
  body: string
  createdAt: unknown
  imageUrls?: string[]
}

export interface WorkItem {
  id: string
  kind: WorkKind
  number: number
  title: string
  description: string
  priority: Priority
  status: string
  waitingOn: WaitingOn
  blockedReason?: ReviewGate
  dependsOn?: string[]
  assignedTo: Owner
  thinkingEffort: ThinkingEffort
  targetMachine: string
  deploymentType?: string
  deploymentTargets?: string[]
  deploymentNotes?: string
  deploymentNotesPrNumber?: number
  deploymentNotesPrUrl?: string
  deploymentNotesBranchName?: string
  deploymentApprovedAt?: unknown
  deploymentApprovedBy?: string
  deploymentApprovedTargets?: string[]
  deploymentApprovedNotes?: string
  deploymentEvidence?: Record<string, { proof?: string; acceptance?: string; verifiedAt?: unknown; verifiedBy?: string }>
  deploymentStartedAt?: unknown
  deploymentInProgressTarget?: string
  deploymentVerifiedAt?: unknown
  deploymentAcceptedAt?: unknown
  deployedAt?: unknown
  deploymentBuild?: string
  deploymentResult?: string
  imageUrls?: string[]
  prUrl?: string
  prNumber?: number
  branchName?: string
  resolution?: string
  createdByEmail?: string
  createdByRole?: 'admin' | 'collaborator'
  claimedBy?: string
  leaseExpiresAt?: unknown
  createdAt: unknown
  updatedAt: unknown
  messages: WorkMessage[]
}

export interface AgentLoopRun {
  id: string
  agent: string
  queue: string
  machineId: string
  status: string
  activeItem?: string
  activeItemId?: string
  activeCollection?: 'featureRequests' | 'bugs'
  thinkingEffort?: string
  startedAt: unknown
  heartbeatAt: unknown
  progressAt?: unknown
  progressSummary?: string
  finishedAt?: unknown
  durationSeconds?: number
  exitCode?: number
  summary?: string
}

export interface AgentMachine {
  id: string
  label: string
  hostname: string
  status: string
  repoRoot: string
  agents: string[]
  lastSeenAt: unknown
}

export interface AgentLoopConfig {
  deployAgent: import('./agents').AgentModelToken
  updatedAt?: unknown
}

export interface AgentLoopUsageEntry {
  usedPercent: number | null
  resetsAt?: unknown
  resetsLabel?: string | null
  capturedAt?: unknown
  lastAttemptAt?: unknown
  captureStatus?: 'available' | 'unavailable'
  captureError?: string | null
  captureCliVersion?: string | null
}

export interface AgentLoopUsage {
  claude: AgentLoopUsageEntry | null
  codex: AgentLoopUsageEntry | null
}

export interface AdminUser {
  id: string
  email: string
  displayName: string
  role: 'admin' | 'collaborator'
  active: boolean
  createdAt: unknown
  updatedAt: unknown
  createdBy?: string
}
