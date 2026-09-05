'use strict';

const AGENTS = Object.freeze({
  sol: Object.freeze({ token: 'sol', owner: 'sol-agent', family: 'codex', model: 'gpt-5.6-sol', label: 'Codex Sol', claimsUnassigned: false }),
  terra: Object.freeze({ token: 'terra', owner: 'terra-agent', family: 'codex', model: 'gpt-5.6-terra', label: 'Codex Terra', claimsUnassigned: false }),
  luna: Object.freeze({ token: 'luna', owner: 'luna-agent', family: 'codex', model: 'gpt-5.6-luna', label: 'Codex Luna', claimsUnassigned: false }),
  opus: Object.freeze({ token: 'opus', owner: 'opus-agent', family: 'claude', model: 'opus', label: 'Claude Opus', claimsUnassigned: true }),
  sonnet: Object.freeze({ token: 'sonnet', owner: 'sonnet-agent', family: 'claude', model: 'sonnet', label: 'Claude Sonnet', claimsUnassigned: false }),
  fable: Object.freeze({ token: 'fable', owner: 'fable-agent', family: 'claude', model: 'fable', label: 'Claude Fable', claimsUnassigned: false }),
  grok: Object.freeze({ token: 'grok', owner: 'grok-agent', family: 'grok', model: 'grok', label: 'Grok', claimsUnassigned: false }),
});

const ALIASES = Object.freeze({ codex: 'terra', claude: 'sonnet' });

function resolveAgent(token) {
  const agent = AGENTS[ALIASES[token] || token];
  if (!agent) throw new Error(`Unknown agent "${token}". Use ${Object.keys(AGENTS).join(', ')}.`);
  return agent;
}

module.exports = { AGENTS, resolveAgent };
