import { describe, expect, it } from 'vitest'
import { AGENT_FAMILIES, AGENT_MODELS, DEFAULT_WORK_AGENT, agentByOwner, agentByToken, buildAgentModels, familyForAgent } from './agents'
import agentDefaults from '../../../scripts/lib/agent-defaults.json'

describe('agent model registry', () => {
  it('offers every configured Codex, Claude, and Grok model', () => {
    expect(AGENT_MODELS.map((agent) => agent.token)).toEqual(['sol', 'terra', 'luna', 'opus', 'sonnet', 'fable', 'grok'])
    expect(AGENT_FAMILIES).toEqual(['codex', 'claude', 'grok'])
  })

  it('maps queue owners and runner tokens consistently', () => {
    expect(agentByOwner('sol-agent')?.model).toBe('gpt-5.6-sol')
    expect(agentByToken('sonnet')?.owner).toBe('sonnet-agent')
    expect(familyForAgent('terra')).toBe('codex')
    expect(familyForAgent('claude')).toBe('claude')
    expect(familyForAgent('nobody')).toBeUndefined()
  })

  it('defaults new feature and bug work to Codex Sol', () => {
    expect(DEFAULT_WORK_AGENT).toBe('sol')
  })

  it('falls back to the built-in roster when the config has no agents', () => {
    expect(buildAgentModels({})).toEqual(buildAgentModels({ agents: agentDefaults.agents }))
    expect(buildAgentModels({}).map((agent) => agent.token)).toEqual(AGENT_MODELS.map((agent) => agent.token))
  })

  it('marks only headless-guard runners as guarded and keeps the Codex sandbox visible', () => {
    expect(AGENT_MODELS.filter((agent) => agent.guarded).map((agent) => agent.token)).toEqual(['opus', 'sonnet', 'fable'])
    expect(agentByToken('sol')?.sandbox).toBe('danger-full-access')
    expect(agentByToken('opus')?.sandbox).toBeNull()
  })

  it('derives a custom command-runner agent from config alone', () => {
    const [gemini] = buildAgentModels({ agents: [{ token: 'gemini', label: 'Gemini Pro', runner: 'command', model: 'gemini-2.5-pro', command: ['gemini', '-p', '{{prompt}}'] }] })
    expect(gemini).toMatchObject({ owner: 'gemini-agent', family: 'command', short: 'Gemini Pro', emoji: 'G', guarded: false, usageProvider: null })
  })
})
