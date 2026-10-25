import { describe, expect, it } from 'vitest'
import { AGENT_FAMILIES, AGENT_MODELS, ALL_THINKING_EFFORTS, DEFAULT_WORK_AGENT, agentByOwner, agentByToken, buildAgentModels, familyForAgent, thinkingEffortsFor } from './agents'
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

describe('thinkingEffortsFor', () => {
  it('offers each CLI\'s own advertised effort range, not one list for every model', () => {
    expect(thinkingEffortsFor('sol-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(thinkingEffortsFor('terra-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    // Luna's gpt-5.6 build has no "ultra" tier in `codex debug models`, unlike sol and terra.
    expect(thinkingEffortsFor('luna-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingEffortsFor('opus-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingEffortsFor('sonnet-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingEffortsFor('fable-agent')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(thinkingEffortsFor('grok-agent')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('falls back to the full canonical range for an unassigned or unrecognized owner', () => {
    expect(thinkingEffortsFor(null)).toEqual(ALL_THINKING_EFFORTS)
    expect(thinkingEffortsFor('')).toEqual(ALL_THINKING_EFFORTS)
    expect(thinkingEffortsFor('retired-agent')).toEqual(ALL_THINKING_EFFORTS)
  })

  it('keeps a stored value visible even after it falls outside the assigned model\'s menu', () => {
    // e.g. an item set to "ultra" on Sol, then reassigned to Grok, which has no "ultra" tier.
    expect(thinkingEffortsFor('grok-agent', 'ultra')).toEqual(['ultra', 'low', 'medium', 'high', 'xhigh'])
    // A value already on the menu is never duplicated.
    expect(thinkingEffortsFor('grok-agent', 'high')).toEqual(['low', 'medium', 'high', 'xhigh'])
  })
})
