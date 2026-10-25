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

// --- configured roster ------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { DEFAULTS, normalizeRoster, renderCommand } = require('../lib/agent-roster');
const { commandArgvFromEnv, shellFields } = require('../lib/agents');

const projectConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'project-admin.config.json'), 'utf8'));
const automation = { defaultWorkAgent: 'gem', defaultDeployAgent: 'gem' };
const gemini = { token: 'gem', label: 'Gemini', runner: 'command', model: 'gemini-pro', command: ['gemini', '-p', '{{prompt}}'] };

test('a config without agents gets the built-in roster, identical to the shipped example', () => {
  const { agents: fallback, aliases } = normalizeRoster({ automation: projectConfig.automation });
  assert.deepEqual(fallback, normalizeRoster(projectConfig).agents);
  assert.deepEqual(aliases, { codex: 'terra', claude: 'sonnet' });
  assert.deepEqual(Object.values(fallback).map((agent) => agent.family), ['codex', 'codex', 'codex', 'claude', 'claude', 'claude', 'grok']);
  assert.equal(fallback.sol.model, 'gpt-5.6-sol');
  assert.deepEqual(DEFAULTS.agents.map((agent) => agent.token), Object.keys(AGENTS));
});

test('owner, guard, sandbox, and usage hook are derived per agent', () => {
  assert.equal(AGENTS.terra.owner, 'terra-agent');
  assert.deepEqual(Object.values(AGENTS).filter((agent) => agent.guarded).map((agent) => agent.token), ['opus', 'sonnet', 'fable']);
  assert.equal(AGENTS.sol.sandbox, 'danger-full-access', 'Codex keeps its historical sandbox unless configured');
  assert.equal(AGENTS.opus.sandbox, null);
  assert.equal(AGENTS.sol.usage.provider, 'codex');
  assert.equal(AGENTS.fable.usage.provider, 'claude');
  assert.equal(AGENTS.grok.usage, null);
  const custom = normalizeRoster({ automation: { defaultWorkAgent: 'safe', defaultDeployAgent: 'safe' }, agents: [
    { token: 'safe', label: 'Safe', runner: 'codex', model: 'm', sandbox: 'workspace-write', usage: false },
  ] }).agents.safe;
  assert.equal(custom.sandbox, 'workspace-write');
  assert.equal(custom.guarded, false);
  assert.equal(custom.usage, null);
  assert.equal(custom.short, 'Safe');
});

test('a custom roster has no implicit aliases', () => {
  assert.deepEqual(normalizeRoster({ automation, agents: [gemini] }).aliases, {});
  assert.deepEqual(normalizeRoster({ automation, agents: [gemini], agentAliases: { g: 'gem' } }).aliases, { g: 'gem' });
});

test('invalid rosters are rejected with a pointed message', () => {
  const invalid = (agents, extra = {}) => () => normalizeRoster({ automation, agents, ...extra });
  assert.throws(invalid([]), /non-empty array/);
  assert.throws(invalid([gemini, gemini]), /duplicate agent token "gem"/);
  assert.throws(invalid([{ ...gemini, token: 'Gem' }]), /token must match/);
  assert.throws(invalid([{ ...gemini, token: '-gem' }]), /token must match/);
  assert.throws(invalid([{ ...gemini, token: 'configured' }]), /reserved/);
  assert.throws(invalid([{ ...gemini, runner: 'copilot' }]), /runner "copilot" is not one of codex, claude, grok, command/);
  assert.throws(invalid([{ ...gemini, model: '' }]), /model must be a non-empty string/);
  assert.throws(invalid([{ ...gemini, sandBox: 'read-only' }]), /unknown key\(s\) sandBox/);
  assert.throws(invalid([{ ...gemini, sandbox: 'read-only' }]), /sandbox is only supported/);
  assert.throws(invalid([{ token: 'x', label: 'X', runner: 'codex', model: 'm', sandbox: 'yolo' }], { automation: { defaultWorkAgent: 'x', defaultDeployAgent: 'x' } }), /sandbox must be one of/);
  assert.throws(invalid([{ ...gemini, command: undefined }]), /command must be a non-empty array/);
  assert.throws(invalid([{ ...gemini, command: ['gemini', '{{prompt}}', '{{cwd}}'] }]), /unknown placeholder \{\{cwd\}\}/);
  assert.throws(invalid([{ ...gemini, command: ['gemini', '--yolo'] }]), /must contain \{\{prompt\}\} or \{\{prompt_file\}\}/);
  assert.throws(invalid([{ ...gemini, promptVia: 'pipe' }]), /promptVia must be/);
  assert.throws(invalid([{ token: 'x', label: 'X', runner: 'claude', model: 'm', command: ['x'] }], { automation: { defaultWorkAgent: 'x', defaultDeployAgent: 'x' } }), /only valid for the command runner/);
  assert.throws(invalid([gemini], { agentAliases: { gem: 'gem' } }), /shadows a configured agent/);
  assert.throws(invalid([gemini], { agentAliases: { g: 'nobody' } }), /unknown agent "nobody"/);
  assert.throws(() => normalizeRoster({ automation: { defaultWorkAgent: 'sol', defaultDeployAgent: 'gem' }, agents: [gemini] }), /automation\.defaultWorkAgent "sol" is not a configured agent/);
  assert.throws(() => normalizeRoster({ automation: { defaultWorkAgent: 'gem', defaultDeployAgent: 'sonnet' }, agents: [gemini] }), /automation\.defaultDeployAgent "sonnet"/);
});

test('the config loader refuses an invalid roster before any loop starts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-agents-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ ...projectConfig, agents: [{ ...gemini, runner: 'nope' }] }));
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'lib', 'agents.js'), 'tokens'], {
    encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: file },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid agent roster: agents\[0\]\.runner "nope"/);
});

test('command templates expand placeholders inside arguments without splitting them', () => {
  assert.deepEqual(
    renderCommand(['cli', '--model={{model}}', '{{prompt}}', '-C', '{{repo}}', '{{effort}}', '@{{prompt_file}}'], {
      prompt: 'two words\nand a line', model: 'm1', repo: '/r', effort: 'high', prompt_file: '/p.md',
    }),
    ['cli', '--model=m1', 'two words\nand a line', '-C', '/r', 'high', '@/p.md'],
  );
  assert.throws(() => renderCommand(['{{nope}}'], {}), /Unknown command placeholder/);
});

test('the command runner reads the prompt file like the built-in adapters do', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-prompt-'));
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, "it's $HOME `x`\n\n");
  const env = { PA_COMMAND_JSON: JSON.stringify(['gemini', '-p', '{{prompt}}', '-m', '{{model}}']), PA_PROMPT_FILE: promptFile, PA_MODEL: 'pro' };
  assert.deepEqual(commandArgvFromEnv(env), ['gemini', '-p', "it's $HOME `x`", '-m', 'pro'], 'trailing newlines trimmed, nothing interpolated');
  assert.deepEqual(commandArgvFromEnv({ ...env, PA_PROMPT_FILE: '/missing' }, { check: true }), ['gemini']);
  assert.throws(() => commandArgvFromEnv({}), /PA_COMMAND_JSON is empty/);
});

test('the shell helper prints eval-safe fields and canonicalizes aliases', () => {
  const helper = path.join(__dirname, '..', 'lib', 'agents.js');
  const output = execFileSync(process.execPath, [helper, 'resolve', 'claude'], { encoding: 'utf8' });
  assert.match(output, /^PA_AGENT_TOKEN='sonnet'$/m);
  assert.match(output, /^PA_RUNNER='claude'$/m);
  assert.match(output, /^PA_GUARDED='1'$/m);
  const evaluated = execFileSync('bash', ['-c', `eval "$(${JSON.stringify(process.execPath)} ${JSON.stringify(helper)} resolve sol)"; printf '%s|%s|%s|%s' "$PA_MODEL" "$PA_SANDBOX" "$PA_EFFORT_ENV" "$PA_GUARDED"`], { encoding: 'utf8' });
  assert.equal(evaluated, 'gpt-5.6-sol|danger-full-access|CODEX_EFFORT|0');
  assert.equal(execFileSync(process.execPath, [helper, 'canonical', 'codex'], { encoding: 'utf8' }).trim(), 'terra');
  assert.equal(execFileSync(process.execPath, [helper, 'tokens', '--separator', '|'], { encoding: 'utf8' }).trim(), 'sol|terra|luna|opus|sonnet|fable|grok');
  assert.equal(spawnSync(process.execPath, [helper, 'resolve', 'gemini']).status, 1);
  assert.equal(shellFields(AGENTS.grok).PA_USAGE_SCRIPT, '');
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
