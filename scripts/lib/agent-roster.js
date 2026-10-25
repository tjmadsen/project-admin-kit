'use strict';

// Pure agent-roster normalization shared by the config loader, agents.js, and
// tests. The roster comes from the top-level `agents` array in
// project-admin.config.json; a config without one gets the built-in roster in
// agent-defaults.json so existing deployments keep their seven models.

const DEFAULTS = require('./agent-defaults.json');

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
// `configured` is the deploy dispatcher's placeholder token in run-loop.sh and
// loop-wrapper.sh, so no agent may claim it.
const RESERVED_TOKENS = Object.freeze(['configured']);
const RUNNERS = DEFAULTS.runners;
const PROMPT_VIA = Object.freeze(['arg', 'stdin']);
const PLACEHOLDERS = Object.freeze(['prompt', 'prompt_file', 'model', 'effort', 'repo']);
const AGENT_KEYS = Object.freeze(['token', 'label', 'short', 'emoji', 'runner', 'model', 'claimsUnassigned', 'pollSeconds', 'sandbox', 'usage', 'command', 'promptVia', 'efforts', 'pinModel']);
// Every thinking effort any supported CLI accepts, low to high. Each runner's
// default `efforts` (agent-defaults.json) is the exact set its CLI accepts:
// `codex debug models` reports per-model `supported_reasoning_levels`, `claude
// --effort` documents low..max, and grok's active model advertises low..xhigh.
// An agent overrides it when its model's menu differs (luna's gpt-5.6 build
// lacks "ultra"). A CLI that changes its menu invalidates these until rechecked.
const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function fail(message) {
  throw new Error(`Invalid agent roster: ${message}`);
}

function optionalString(entry, key, where) {
  if (entry[key] === undefined) return undefined;
  if (typeof entry[key] !== 'string' || !entry[key]) fail(`${where}.${key} must be a non-empty string`);
  return entry[key];
}

function normalizeUsage(entry, runner, where) {
  if (entry.usage === false) return null;
  if (entry.usage === undefined) return runner.usage ? { ...runner.usage } : null;
  const usage = entry.usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) fail(`${where}.usage must be false or { provider, script }`);
  if (typeof usage.provider !== 'string' || !TOKEN_PATTERN.test(usage.provider)) fail(`${where}.usage.provider must match ${TOKEN_PATTERN}`);
  if (typeof usage.script !== 'string' || !usage.script) fail(`${where}.usage.script must be a non-empty path`);
  return { provider: usage.provider, script: usage.script };
}

function normalizeCommand(entry, where) {
  const { command } = entry;
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== 'string' || !part)) {
    fail(`${where}.command must be a non-empty array of non-empty strings for the command runner`);
  }
  for (const part of command) {
    for (const [, name] of part.matchAll(/\{\{([^}]*)\}\}/g)) {
      if (!PLACEHOLDERS.includes(name)) fail(`${where}.command uses unknown placeholder {{${name}}}; use ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(', ')}`);
    }
  }
  if (command[0].includes('{{')) fail(`${where}.command[0] must name the executable, not a placeholder`);
  const promptVia = entry.promptVia === undefined ? 'arg' : entry.promptVia;
  if (!PROMPT_VIA.includes(promptVia)) fail(`${where}.promptVia must be "arg" or "stdin"`);
  if (promptVia === 'arg' && !command.some((part) => /\{\{prompt(_file)?\}\}/.test(part))) {
    fail(`${where}.command must contain {{prompt}} or {{prompt_file}} when promptVia is "arg"`);
  }
  return { command: [...command], promptVia };
}

function normalizeEfforts(entry, runner, where) {
  const efforts = entry.efforts === undefined ? runner.efforts || EFFORT_ORDER.slice(2, 5) : entry.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) fail(`${where}.efforts must be a non-empty array`);
  for (const effort of efforts) {
    if (!EFFORT_ORDER.includes(effort)) fail(`${where}.efforts has unknown effort "${effort}"; use ${EFFORT_ORDER.join(', ')}`);
  }
  // Menus render low to high regardless of how the config lists them.
  return Object.freeze(EFFORT_ORDER.filter((effort) => efforts.includes(effort)));
}

function normalizeAgent(entry, index) {
  const where = `agents[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`${where} must be an object`);
  // A misspelled safety key such as `sandBox` must not silently fall back.
  const unknown = Object.keys(entry).filter((key) => !AGENT_KEYS.includes(key));
  if (unknown.length) fail(`${where} has unknown key(s) ${unknown.join(', ')}`);
  const { token } = entry;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) fail(`${where}.token must match ${TOKEN_PATTERN}`);
  if (RESERVED_TOKENS.includes(token)) fail(`${where}.token "${token}" is reserved`);
  if (typeof entry.label !== 'string' || !entry.label) fail(`${where}.label must be a non-empty string`);
  if (typeof entry.model !== 'string' || !entry.model) fail(`${where}.model must be a non-empty string`);
  const runner = RUNNERS[entry.runner];
  if (!runner) fail(`${where}.runner "${entry.runner}" is not one of ${Object.keys(RUNNERS).join(', ')}`);
  if (entry.claimsUnassigned !== undefined && typeof entry.claimsUnassigned !== 'boolean') fail(`${where}.claimsUnassigned must be a boolean`);
  if (entry.pinModel !== undefined && typeof entry.pinModel !== 'boolean') fail(`${where}.pinModel must be a boolean`);
  if (entry.pollSeconds !== undefined && !(Number.isInteger(entry.pollSeconds) && entry.pollSeconds > 0)) fail(`${where}.pollSeconds must be a positive integer`);

  let sandbox = null;
  if (runner.sandboxes) {
    sandbox = entry.sandbox === undefined ? runner.defaultSandbox : entry.sandbox;
    if (!runner.sandboxes.includes(sandbox)) fail(`${where}.sandbox must be one of ${runner.sandboxes.join(', ')}`);
  } else if (entry.sandbox !== undefined) {
    fail(`${where}.sandbox is only supported by runners with a sandbox flag (${Object.keys(RUNNERS).filter((name) => RUNNERS[name].sandboxes).join(', ')})`);
  }

  const agent = {
    token,
    owner: `${token}-agent`,
    family: entry.runner,
    runner: entry.runner,
    model: entry.model,
    label: entry.label,
    short: optionalString(entry, 'short', where) || entry.label,
    emoji: optionalString(entry, 'emoji', where) || token.slice(0, 1).toUpperCase(),
    claimsUnassigned: entry.claimsUnassigned === true,
    sandbox,
    // True only when the runner adapter actually wires headless-guard.py into
    // the CLI. A sandbox flag is not a guard, so Codex stays false.
    guarded: runner.guarded === true,
    pollSeconds: entry.pollSeconds || 300,
    usage: normalizeUsage(entry, runner, where),
    efforts: normalizeEfforts(entry, runner, where),
    // By default a loop runs the newest model in the configured model's tier
    // (runners/README.md); pinModel launches exactly `model` instead.
    pinModel: entry.pinModel === true,
  };
  if (entry.runner === 'command') Object.assign(agent, normalizeCommand(entry, where));
  else if (entry.command !== undefined || entry.promptVia !== undefined) fail(`${where}.command and promptVia are only valid for the command runner`);
  return Object.freeze(agent);
}

/**
 * Turn a project config into { agents, aliases }. `agents` is a frozen object
 * keyed by token in configured order; `aliases` maps legacy tokens to agents.
 */
function normalizeRoster(config = {}) {
  const configured = config.agents !== undefined;
  const entries = configured ? config.agents : DEFAULTS.agents;
  if (!Array.isArray(entries) || entries.length === 0) fail('agents must be a non-empty array');
  const agents = {};
  entries.forEach((entry, index) => {
    const agent = normalizeAgent(entry, index);
    if (agents[agent.token]) fail(`duplicate agent token "${agent.token}"`);
    agents[agent.token] = agent;
  });

  // Built-in aliases only make sense for the built-in roster; a custom roster
  // opts into its own.
  const rawAliases = config.agentAliases !== undefined ? config.agentAliases : configured ? {} : DEFAULTS.agentAliases;
  if (!rawAliases || typeof rawAliases !== 'object' || Array.isArray(rawAliases)) fail('agentAliases must be an object');
  const aliases = {};
  for (const [alias, target] of Object.entries(rawAliases)) {
    if (!TOKEN_PATTERN.test(alias) || RESERVED_TOKENS.includes(alias)) fail(`alias "${alias}" must match ${TOKEN_PATTERN}`);
    if (agents[alias]) fail(`alias "${alias}" shadows a configured agent`);
    if (!agents[target]) fail(`alias "${alias}" points at unknown agent "${target}"`);
    aliases[alias] = target;
  }

  for (const key of ['defaultWorkAgent', 'defaultDeployAgent']) {
    const token = config.automation?.[key];
    if (token !== undefined && !agents[aliases[token] || token]) fail(`automation.${key} "${token}" is not a configured agent`);
  }
  return { agents: Object.freeze(agents), aliases: Object.freeze(aliases) };
}

function resolveFrom(roster, token) {
  const agent = roster.agents[roster.aliases[token] || token];
  if (!agent) throw new Error(`Unknown agent "${token}". Use ${Object.keys(roster.agents).join(', ')}.`);
  return agent;
}

/**
 * Expand a command-runner template. Placeholders may sit inside a larger
 * argument (`--prompt={{prompt}}`); every element stays exactly one argv entry,
 * so prompt text is never word-split or re-parsed by a shell.
 */
function renderCommand(template, values) {
  return template.map((part) => part.replace(/\{\{([^}]*)\}\}/g, (match, name) => {
    if (!PLACEHOLDERS.includes(name)) throw new Error(`Unknown command placeholder ${match}`);
    return String(values[name] ?? '');
  }));
}

module.exports = { DEFAULTS, EFFORT_ORDER, PLACEHOLDERS, RESERVED_TOKENS, RUNNERS, TOKEN_PATTERN, normalizeRoster, renderCommand, resolveFrom };
