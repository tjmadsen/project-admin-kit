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

test('advertises each CLI\'s own effort range instead of one list for every model', () => {
  assert.deepEqual(resolveAgent('sol').efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.deepEqual(resolveAgent('terra').efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  // Luna's gpt-5.6 build has no "ultra" tier in `codex debug models`, unlike sol and terra.
  assert.deepEqual(resolveAgent('luna').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(resolveAgent('opus').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(resolveAgent('sonnet').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(resolveAgent('fable').efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(resolveAgent('grok').efforts, ['low', 'medium', 'high', 'xhigh']);
});
