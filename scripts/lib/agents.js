'use strict';

// Each `efforts` list is the exact set the agent's own CLI accepts for its
// current model, low to high: `codex debug models` reports per-model
// `supported_reasoning_levels` (luna's gpt-5.6 build lacks "ultra", unlike
// sol/terra); `claude --effort` documents low/medium/high/xhigh/max for
// opus/sonnet/fable; `grok`'s active model (grok-4.6) advertises
// low/medium/high/xhigh only. A CLI that changes its per-model menu
// invalidates this list until re-checked.
//
// `model` is what run-loop.sh launches with, not the version that runs: Claude
// aliases and Grok's default resolve to the newest model, and Codex tiers move
// to their newest listed slug (resolve-model.js). Each run records the exact
// model it used.
const AGENTS = Object.freeze({
  sol: Object.freeze({ token: 'sol', owner: 'sol-agent', family: 'codex', model: 'gpt-5.6-sol', label: 'Codex Sol', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) }),
  terra: Object.freeze({ token: 'terra', owner: 'terra-agent', family: 'codex', model: 'gpt-5.6-terra', label: 'Codex Terra', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']) }),
  luna: Object.freeze({ token: 'luna', owner: 'luna-agent', family: 'codex', model: 'gpt-5.6-luna', label: 'Codex Luna', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  opus: Object.freeze({ token: 'opus', owner: 'opus-agent', family: 'claude', model: 'opus', label: 'Claude Opus', claimsUnassigned: true, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  sonnet: Object.freeze({ token: 'sonnet', owner: 'sonnet-agent', family: 'claude', model: 'sonnet', label: 'Claude Sonnet', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  fable: Object.freeze({ token: 'fable', owner: 'fable-agent', family: 'claude', model: 'fable', label: 'Claude Fable', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']) }),
  grok: Object.freeze({ token: 'grok', owner: 'grok-agent', family: 'grok', model: 'grok', label: 'Grok', claimsUnassigned: false, efforts: Object.freeze(['low', 'medium', 'high', 'xhigh']) }),
});

const ALIASES = Object.freeze({ codex: 'terra', claude: 'sonnet' });

function resolveAgent(token) {
  const agent = AGENTS[ALIASES[token] || token];
  if (!agent) throw new Error(`Unknown agent "${token}". Use ${Object.keys(AGENTS).join(', ')}.`);
  return agent;
}

module.exports = { AGENTS, resolveAgent };
