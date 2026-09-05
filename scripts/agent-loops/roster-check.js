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
 * The plain check form prints nothing and answers through its exit code.
 */

const path = require('path');

const QUEUES = Object.freeze(['feature', 'bug', 'deploy']);

function machineEntry(roster, machineId) {
  const machines = (roster && roster.machines) || [];
  return machines.find((machine) => machine && machine.id === machineId) || null;
}

function entitlements(roster, machineId) {
  const machine = machineEntry(roster, machineId);
  if (!machine) return [];
  const queues = Array.isArray(machine.queues) ? machine.queues : [];
  const agents = Array.isArray(machine.agents) ? machine.agents : [];
  const pairs = [];
  for (const queue of queues) {
    if (!QUEUES.includes(queue)) continue;
    for (const agent of agents) pairs.push({ queue, agent });
  }
  return pairs;
}

function agentsForMachine(roster, machineId) {
  const seen = new Set();
  for (const { agent } of entitlements(roster, machineId)) seen.add(agent);
  return [...seen];
}

function isEntitled(roster, machineId, queue, agent) {
  return entitlements(roster, machineId).some((pair) => pair.queue === queue && pair.agent === agent);
}

if (require.main === module) {
  const roster = require(path.join(__dirname, 'machine-roster.json'));
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    for (const { queue, agent } of entitlements(roster, args[1])) console.log(`${queue} ${agent}`);
    process.exit(0);
  }

  if (args[0] === '--agents') {
    console.log(agentsForMachine(roster, args[1]).join(','));
    process.exit(0);
  }

  const [machineId, queue, agent] = args;
  process.exit(isEntitled(roster, machineId, queue, agent) ? 0 : 1);
}

module.exports = { QUEUES, entitlements, agentsForMachine, isEntitled };
