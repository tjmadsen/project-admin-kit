import { projectConfig, type AgentConfigEntry, type ProjectAdminConfig } from './project-config'
import agentDefaults from '../../../scripts/lib/agent-defaults.json'
import type { AgentLoopRun, ThinkingEffort } from './types'

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
  /** Thinking efforts this agent's CLI accepts for its model, low to high. */
  efforts: readonly ThinkingEffort[]
}

// The full canonical range across every model, used as a fallback when an
// item has no assigned agent (or a legacy one) to look up a narrower menu.
export const ALL_THINKING_EFFORTS: readonly ThinkingEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export type AgentModelToken = string
export type AgentFamily = string

interface RunnerDefaults { label: string; guarded: boolean; defaultSandbox?: string; usage?: { provider: string }; efforts?: string[] }
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
      // Same rule as scripts/lib/agent-roster.js: the agent's list, else the
      // runner's, always rendered low to high.
      efforts: ALL_THINKING_EFFORTS.filter((effort) => ((entry.efforts ?? runner?.efforts ?? ['low', 'medium', 'high']) as string[]).includes(effort)),
    }
  })
}

export const AGENT_MODELS: readonly AgentModel[] = buildAgentModels(projectConfig)

/** Distinct runner families in configured order, e.g. ['codex', 'claude', 'grok']. */
export const AGENT_FAMILIES: readonly AgentFamily[] = [...new Set(AGENT_MODELS.map((agent) => agent.family))]

export const DEFAULT_WORK_AGENT: AgentModelToken = projectConfig.automation.defaultWorkAgent
export const DEFAULT_DEPLOY_AGENT: AgentModelToken = projectConfig.automation.defaultDeployAgent

// The loops launch each tier's newest model (a Claude alias, the newest Codex
// slug for the tier, Grok's CLI default), so `model` above is only the launch
// hint. The version shown comes from the exact model ID each run recorded.
export function modelVersion(model?: string | null): string | null {
  if (!model) return null
  const claude = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model)
  if (claude) return claude[2] ? `${claude[1]}.${claude[2]}` : claude[1]
  return /^(?:gpt|grok)-(\d+(?:\.\d+)*)(?:-|$)/.exec(model)?.[1] ?? null
}

// "Claude Opus" + claude-opus-5-5 → "Claude Opus 5.5"; a label that already
// names a version ("Agent 1.3") has it replaced in place.
export function versionedAgentLabel(label: string, model?: string | null): string {
  const version = modelVersion(model)
  if (!version) return label
  return /\d+(?:\.\d+)*/.test(label) ? label.replace(/\d+(?:\.\d+)*/, version) : `${label} ${version}`
}

// The newest recorded model per agent, from runs ordered newest first.
export function latestRunModels(runs: readonly Pick<AgentLoopRun, 'agent' | 'model'>[]): Map<string, string> {
  const models = new Map<string, string>()
  for (const run of runs) if (run.model && !models.has(run.agent)) models.set(run.agent, run.model)
  return models
}

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

// The options to render in a thinking-effort dropdown for the given owner,
// always including the item's current value even if it falls outside the
// assigned model's menu (a legacy value, or a value from before reassignment).
export function thinkingEffortsFor(owner: string | null | undefined, current?: ThinkingEffort | string | null): ThinkingEffort[] {
  const options = agentByOwner(owner)?.efforts ?? ALL_THINKING_EFFORTS
  if (current && !(options as readonly string[]).includes(current)) return [current as ThinkingEffort, ...options]
  return [...options]
}
