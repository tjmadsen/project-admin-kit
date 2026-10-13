#!/usr/bin/env node
'use strict';

/**
 * roster-check.js — machine-roster.json is the single source of truth for which
 * machine may run which agent x queue loop, and this makes it enforcing rather
 * than descriptive.
 *
 * Two callers:
 *   - run-loop.sh, on every fire, so a hand-copied or stale launchd plist can
 *     never poll a queue this host is no longer entitled to run.
 *   - provision-machine.sh, which enumerates entitlements (--list) instead of
 *     hardcoding the agent roster in a second place.
 *
 * Agents must also exist in the configured roster (project-admin.config.json
 * `agents`, via scripts/lib/agents.js): a roster entry for a token the config
 * no longer defines entitles nothing, and the CLI warns about it.
 *
 * The plain check form prints nothing and answers through its exit code.
 */

const path = require('path');

// Work-kind queues come from config; `deploy` spans every deploying kind.
// Loaded lazily so the plain check stays cheap when the roster rejects first.
function configuredQueues() {
  const { loadWorkKinds, queueNames } = require('../lib/work-kinds');
  return queueNames(loadWorkKinds());
}

function machineEntry(roster, machineId) {
  const machines = (roster && roster.machines) || [];
  return machines.find((machine) => machine && machine.id === machineId) || null;
}

// `knownAgents`, when given, is the configured token list; anything else in the
// roster is ignored rather than trusted.
function entitlements(roster, machineId, knownAgents) {
  const machine = machineEntry(roster, machineId);
  if (!machine) return [];
  const queues = Array.isArray(machine.queues) ? machine.queues : [];
  const agents = (Array.isArray(machine.agents) ? machine.agents : [])
    .filter((agent) => !knownAgents || knownAgents.includes(agent));
  const pairs = [];
  const valid = configuredQueues();
  for (const queue of queues) {
    if (!valid.includes(queue)) continue;
    for (const agent of agents) pairs.push({ queue, agent });
  }
  return pairs;
}

function agentsForMachine(roster, machineId, knownAgents) {
  const seen = new Set();
  for (const { agent } of entitlements(roster, machineId, knownAgents)) seen.add(agent);
  return [...seen];
}

function isEntitled(roster, machineId, queue, agent, knownAgents) {
  return entitlements(roster, machineId, knownAgents).some((pair) => pair.queue === queue && pair.agent === agent);
}

function unknownAgents(roster, machineId, knownAgents) {
  const machine = machineEntry(roster, machineId);
  const agents = machine && Array.isArray(machine.agents) ? machine.agents : [];
  return agents.filter((agent) => !knownAgents.includes(agent));
}

if (require.main === module) {
  // PROJECT_ADMIN_MACHINE_ROSTER points a container or test at another roster.
  const roster = require(process.env.PROJECT_ADMIN_MACHINE_ROSTER || path.join(__dirname, 'machine-roster.json'));
  const known = Object.keys(require('../lib/agents').AGENTS);
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const unknown = unknownAgents(roster, args[1], known);
    if (unknown.length) console.error(`machine-roster.json lists agents missing from the configured roster: ${unknown.join(', ')}`);
    for (const { queue, agent } of entitlements(roster, args[1], known)) console.log(`${queue} ${agent}`);
    process.exit(0);
  }

  if (args[0] === '--agents') {
    console.log(agentsForMachine(roster, args[1], known).join(','));
    process.exit(0);
  }

  const [machineId, queue, agent] = args;
  process.exit(isEntitled(roster, machineId, queue, agent, known) ? 0 : 1);
}

module.exports = { configuredQueues, entitlements, agentsForMachine, isEntitled, unknownAgents };
