'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AGENTS, resolveAgent } = require('../lib/agents');

test('registers the seven selectable loop models', () => {
  assert.deepEqual(Object.keys(AGENTS), ['sol', 'terra', 'luna', 'opus', 'sonnet', 'fable', 'grok']);
});

test('keeps queue ownership model-specific', () => {
  assert.equal(resolveAgent('sol').owner, 'sol-agent');
  assert.equal(resolveAgent('sonnet').model, 'sonnet');
  assert.equal(resolveAgent('codex').token, 'terra');
  assert.equal(resolveAgent('claude').token, 'sonnet');
});

test('uses Opus as the only unassigned-work sweeper', () => {
  assert.deepEqual(Object.values(AGENTS).filter((agent) => agent.claimsUnassigned).map((agent) => agent.token), ['opus']);
});
