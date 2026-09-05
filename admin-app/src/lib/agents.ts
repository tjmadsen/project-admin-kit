import { projectConfig } from './project-config'

export const AGENT_MODELS = [
  { token: 'sol', owner: 'sol-agent', family: 'codex', label: 'Codex Sol', short: 'Sol', emoji: '☀️', model: 'gpt-5.6-sol', claimsUnassigned: false },
  { token: 'terra', owner: 'terra-agent', family: 'codex', label: 'Codex Terra', short: 'Terra', emoji: '🌍', model: 'gpt-5.6-terra', claimsUnassigned: false },
  { token: 'luna', owner: 'luna-agent', family: 'codex', label: 'Codex Luna', short: 'Luna', emoji: '🌙', model: 'gpt-5.6-luna', claimsUnassigned: false },
  { token: 'opus', owner: 'opus-agent', family: 'claude', label: 'Claude Opus', short: 'Opus', emoji: '◆', model: 'opus', claimsUnassigned: true },
  { token: 'sonnet', owner: 'sonnet-agent', family: 'claude', label: 'Claude Sonnet', short: 'Sonnet', emoji: '⚡', model: 'sonnet', claimsUnassigned: false },
  { token: 'fable', owner: 'fable-agent', family: 'claude', label: 'Claude Fable', short: 'Fable', emoji: '◇', model: 'fable', claimsUnassigned: false },
  { token: 'grok', owner: 'grok-agent', family: 'grok', label: 'Grok', short: 'Grok', emoji: '✕', model: 'grok', claimsUnassigned: false },
] as const

export type AgentModelToken = typeof AGENT_MODELS[number]['token']
export type AgentFamily = typeof AGENT_MODELS[number]['family']

export const DEFAULT_WORK_AGENT: AgentModelToken = projectConfig.automation.defaultWorkAgent as AgentModelToken
export const DEFAULT_DEPLOY_AGENT: AgentModelToken = projectConfig.automation.defaultDeployAgent as AgentModelToken

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
