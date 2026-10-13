import rawConfig from '../../../project-admin.config.json'

/** One `agents` entry; see project-admin.config.schema.json. */
export interface AgentConfigEntry {
  token: string
  label: string
  short?: string
  emoji?: string
  runner: string
  model: string
  claimsUnassigned?: boolean
  pollSeconds?: number
  sandbox?: string
  usage?: false | { provider: string; script: string }
  command?: string[]
  promptVia?: 'arg' | 'stdin'
}

// One entry of project-admin.config.json#workKinds. Every field is optional
// here because built-in kinds (feature, bug) fill gaps; see lib/work-kinds.ts.
export interface WorkKindConfig {
  label?: string
  pluralLabel?: string
  shortLabel?: string
  prefix?: string
  route?: string
  planReview?: boolean
  deploys?: boolean
  runbook?: string
  statuses?: { initial?: string; done?: string; declined?: string }
  icon?: string
  tone?: string
  copy?: { eyebrow?: string; adminDescription?: string; collaboratorDescription?: string; createLabel?: string; statDetail?: 'queued' | 'critical' }
}

// One `deployments.targets` entry; built-in ids may omit label and runbook.
export interface DeployTargetConfig {
  label?: string
  runbook?: string
  requiresHumanAcceptance?: boolean
  enabled?: boolean
}

// The `targets` map, or the legacy boolean map keyed by firebaseHosting, ...
export type DeploymentsConfig = { targets: Record<string, DeployTargetConfig> } | Record<string, boolean>

export interface ProjectAdminConfig {
  schemaVersion: 1
  project: {
    name: string
    shortName: string
    slug: string
    description: string
    productionUrl: string
    vercelProductionUrl?: string
    adminPath: string
    firebaseProjectId: string
    firestoreLocation: string
  }
  firebase: {
    apiKey: string
    authDomain: string
    storageBucket: string
    messagingSenderId: string
    appId: string
    measurementId?: string
  }
  repository: { slug: string; defaultBranch: string }
  workKinds?: Record<string, WorkKindConfig>
  admin: { ownerName: string; ownerEmail: string; defaultCollaboratorName: string }
  automation: {
    defaultMachineId: string
    defaultMachineLabel: string
    defaultWorkAgent: string
    defaultDeployAgent: string
    stateDirectory: string
    logDirectoryName: string
    scheduler?: 'launchd' | 'systemd' | 'cron' | 'foreground'
  }
  notifications?: { desktop?: boolean; webhook?: boolean | { urlEnv?: string; format?: 'json' | 'slack' | 'ntfy' } }
  deployments?: DeploymentsConfig
  agents?: AgentConfigEntry[]
  agentAliases?: Record<string, string>
}

export const projectConfig = rawConfig as ProjectAdminConfig
export const adminBaseUrl = `${projectConfig.project.productionUrl.replace(/\/$/, '')}${projectConfig.project.adminPath}`
export const preferencePrefix = `project-admin:${projectConfig.project.slug}`
