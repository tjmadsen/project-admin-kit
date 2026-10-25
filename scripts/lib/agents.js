#!/usr/bin/env node
'use strict';

// The configured agent roster (project-admin.config.json `agents`, or the
// built-in defaults) plus a small CLI so the shell loops validate tokens and
// pick runner adapters from the same source instead of hardcoded regexes.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadProjectConfig } = require('./project-config');
const { RUNNERS, normalizeRoster, renderCommand, resolveFrom } = require('./agent-roster');

const ROSTER = normalizeRoster(loadProjectConfig());
const AGENTS = ROSTER.agents;
const ALIASES = ROSTER.aliases;

function resolveAgent(token) {
  return resolveFrom(ROSTER, token);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

// Everything run-loop.sh and the adapters need, as flat strings.
function shellFields(agent) {
  const runner = RUNNERS[agent.runner];
  return {
    PA_AGENT_TOKEN: agent.token,
    PA_AGENT_LABEL: agent.label,
    PA_RUNNER: agent.runner,
    PA_MODEL: agent.model,
    PA_MODEL_ENV: runner.modelEnv || '',
    PA_EFFORT_ENV: runner.effortEnv || '',
    PA_SANDBOX: agent.sandbox || '',
    PA_GUARDED: agent.guarded ? '1' : '0',
    PA_USAGE_PROVIDER: agent.usage ? agent.usage.provider : '',
    PA_USAGE_SCRIPT: agent.usage ? path.resolve(ROOT, agent.usage.script) : '',
    PA_COMMAND_JSON: agent.command ? JSON.stringify(agent.command) : '',
    PA_PROMPT_VIA: agent.promptVia || '',
    PA_POLL_SECONDS: String(agent.pollSeconds),
    PA_PIN_MODEL: agent.pinModel ? '1' : '0',
    PA_OBSERVES_MODEL: runner.observesModel ? '1' : '0',
  };
}

// The command runner's argv, from the environment run-loop.sh hands every
// adapter (see runners/README.md). `--check` needs only the executable.
function commandArgvFromEnv(env, { check = false } = {}) {
  const template = JSON.parse(env.PA_COMMAND_JSON || '[]');
  if (!Array.isArray(template) || template.length === 0) throw new Error('PA_COMMAND_JSON is empty; configure a `command` array for this agent');
  if (check) return [template[0]];
  const promptFile = env.PA_PROMPT_FILE || '';
  const needsPrompt = template.some((part) => part.includes('{{prompt}}'));
  // Match `$(cat file)` in the built-in adapters: trailing newlines dropped.
  const prompt = needsPrompt ? fs.readFileSync(promptFile, 'utf8').replace(/\n+$/, '') : '';
  return renderCommand(template, {
    prompt,
    prompt_file: promptFile,
    model: env.PA_MODEL || '',
    effort: env.PA_EFFORT || '',
    repo: env.PA_REPO_ROOT || '',
  });
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'tokens') {
    process.stdout.write(`${Object.keys(AGENTS).join(option(args, '--separator', '\n'))}\n`);
    return;
  }
  if (command === 'resolve') {
    const fields = shellFields(resolveAgent(args[0]));
    if (args.includes('--json')) { console.log(JSON.stringify(fields)); return; }
    for (const [name, value] of Object.entries(fields)) console.log(`${name}=${shellQuote(value)}`);
    return;
  }
  if (command === 'canonical') { process.stdout.write(`${resolveAgent(args[0]).token}\n`); return; }
  if (command === 'get') {
    const agent = resolveAgent(args[0]);
    if (!(args[1] in agent)) throw new Error(`Unknown agent field ${args[1]}`);
    const value = agent[args[1]];
    process.stdout.write(`${value !== null && typeof value === 'object' ? JSON.stringify(value) : value ?? ''}\n`);
    return;
  }
  if (command === 'render-command') {
    // NUL-separated so a multi-line prompt survives as one argument.
    process.stdout.write(commandArgvFromEnv(process.env, { check: args.includes('--check') }).map((part) => `${part}\0`).join(''));
    return;
  }
  throw new Error('Usage: agents.js <tokens [--separator s]|resolve <token> [--json]|canonical <token>|get <token> <field>|render-command [--check]>');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { AGENTS, ALIASES, commandArgvFromEnv, resolveAgent, shellFields };
