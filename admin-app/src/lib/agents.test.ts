import { describe, expect, it } from 'vitest'
import { AGENT_MODELS, DEFAULT_WORK_AGENT, agentByOwner, agentByToken, familyForAgent } from './agents'

describe('agent model registry', () => {
  it('offers every configured Codex, Claude, and Grok model', () => {
    expect(AGENT_MODELS.map((agent) => agent.token)).toEqual(['sol', 'terra', 'luna', 'opus', 'sonnet', 'fable', 'grok'])
  })

  it('maps queue owners and runner tokens consistently', () => {
    expect(agentByOwner('sol-agent')?.model).toBe('gpt-5.6-sol')
    expect(agentByToken('sonnet')?.owner).toBe('sonnet-agent')
    expect(familyForAgent('terra')).toBe('codex')
  })

  it('defaults new feature and bug work to Codex Sol', () => {
    expect(DEFAULT_WORK_AGENT).toBe('sol')
  })
})
