import { projectConfig } from './project-config'
import type { ThinkingEffort } from './types'

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
