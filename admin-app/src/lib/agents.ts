import { projectConfig } from './project-config'
import type { AgentLoopRun, ThinkingEffort } from './types'

// Each `efforts` list is the exact set the agent's own CLI accepts for its
// current model, low to high — see scripts/lib/agents.js for how each list
// was sourced (`codex debug models`, `claude --effort`, `grok`'s active
// model menu). Keep both copies in sync.
export const AGENT_MODELS = [
  { token: 'sol', owner: 'sol-agent', family: 'codex', label: 'Codex Sol', short: 'Sol', emoji: '☀️', model: 'gpt-5.6-sol', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { token: 'terra', owner: 'terra-agent', family: 'codex', label: 'Codex Terra', short: 'Terra', emoji: '🌍', model: 'gpt-5.6-terra', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { token: 'luna', owner: 'luna-agent', family: 'codex', label: 'Codex Luna', short: 'Luna', emoji: '🌙', model: 'gpt-5.6-luna', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { token: 'opus', owner: 'opus-agent', family: 'claude', label: 'Claude Opus', short: 'Opus', emoji: '◆', model: 'opus', claimsUnassigned: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { token: 'sonnet', owner: 'sonnet-agent', family: 'claude', label: 'Claude Sonnet', short: 'Sonnet', emoji: '⚡', model: 'sonnet', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { token: 'fable', owner: 'fable-agent', family: 'claude', label: 'Claude Fable', short: 'Fable', emoji: '◇', model: 'fable', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { token: 'grok', owner: 'grok-agent', family: 'grok', label: 'Grok', short: 'Grok', emoji: '✕', model: 'grok', claimsUnassigned: false, efforts: ['low', 'medium', 'high', 'xhigh'] },
] as const satisfies ReadonlyArray<{ token: string; owner: string; family: string; label: string; short: string; emoji: string; model: string; claimsUnassigned: boolean; efforts: readonly ThinkingEffort[] }>

export type AgentModelToken = typeof AGENT_MODELS[number]['token']
export type AgentFamily = typeof AGENT_MODELS[number]['family']

export const DEFAULT_WORK_AGENT: AgentModelToken = projectConfig.automation.defaultWorkAgent as AgentModelToken
export const DEFAULT_DEPLOY_AGENT: AgentModelToken = projectConfig.automation.defaultDeployAgent as AgentModelToken

// The full canonical range across every model, used as a fallback when an
// item has no assigned agent (or a legacy one) to look up a narrower menu.
export const ALL_THINKING_EFFORTS: readonly ThinkingEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

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
  if (token === 'codex' || token === 'claude' || token === 'grok') return token
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
