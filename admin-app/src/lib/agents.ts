import { projectConfig, type AgentConfigEntry, type ProjectAdminConfig } from './project-config'
import agentDefaults from '../../../scripts/lib/agent-defaults.json'

// The roster comes from project-admin.config.json `agents`, falling back to the
// same built-in defaults the loop scripts use (scripts/lib/agent-defaults.json).
// The scripts validate the config; the console only derives display fields.

export interface AgentModel {
  token: string
  owner: string
  /** The runner adapter name (codex, claude, grok, command). */
  family: string
  runner: string
  label: string
  short: string
  emoji: string
  model: string
  claimsUnassigned: boolean
  sandbox: string | null
  /** True only when the runner enforces headless-guard.py on shell commands. */
  guarded: boolean
  /** Key in system/agentLoopUsage written by this agent's usage hook, if any. */
  usageProvider: string | null
}

export type AgentModelToken = string
export type AgentFamily = string

interface RunnerDefaults { label: string; guarded: boolean; defaultSandbox?: string; usage?: { provider: string } }
const RUNNERS = agentDefaults.runners as Record<string, RunnerDefaults>

export function runnerLabel(runner: string) {
  return RUNNERS[runner]?.label || runner.slice(0, 1).toUpperCase() + runner.slice(1)
}

export function buildAgentModels(config: Pick<ProjectAdminConfig, 'agents'>): AgentModel[] {
  const entries = (config.agents ?? agentDefaults.agents) as AgentConfigEntry[]
  return entries.map((entry) => {
    const runner = RUNNERS[entry.runner]
    return {
      token: entry.token,
      owner: `${entry.token}-agent`,
      family: entry.runner,
      runner: entry.runner,
      label: entry.label,
      short: entry.short || entry.label,
      emoji: entry.emoji || entry.token.slice(0, 1).toUpperCase(),
      model: entry.model,
      claimsUnassigned: entry.claimsUnassigned === true,
      sandbox: entry.sandbox || runner?.defaultSandbox || null,
      guarded: runner?.guarded === true,
      usageProvider: entry.usage === false ? null : entry.usage?.provider || runner?.usage?.provider || null,
    }
  })
}

export const AGENT_MODELS: readonly AgentModel[] = buildAgentModels(projectConfig)

/** Distinct runner families in configured order, e.g. ['codex', 'claude', 'grok']. */
export const AGENT_FAMILIES: readonly AgentFamily[] = [...new Set(AGENT_MODELS.map((agent) => agent.family))]

export const DEFAULT_WORK_AGENT: AgentModelToken = projectConfig.automation.defaultWorkAgent
export const DEFAULT_DEPLOY_AGENT: AgentModelToken = projectConfig.automation.defaultDeployAgent

export function agentByOwner(owner?: string | null) {
  return AGENT_MODELS.find((agent) => agent.owner === owner)
}

export function agentByToken(token?: string | null) {
  return AGENT_MODELS.find((agent) => agent.token === token)
}

export function familyForAgent(token?: string | null): AgentFamily | undefined {
  // Legacy runs recorded the runner name itself as the agent token.
  if (token && AGENT_FAMILIES.includes(token)) return token
  return agentByToken(token)?.family
}
