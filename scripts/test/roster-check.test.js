'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { entitlements, agentsForMachine, isEntitled, unknownAgents } = require('../agent-loops/roster-check');
const { AGENTS } = require('../lib/agents');

const rosterPath = path.join(__dirname, '..', 'agent-loops', 'roster-check.js');
const roster = require('../agent-loops/machine-roster.json');

function check(machine, queue, agent) {
  try {
    execFileSync(process.execPath, [rosterPath, machine, queue, agent]);
    return 0;
  } catch (error) {
    return error.status;
  }
}

test('the roster entitles every shipped agent on the configured build and deploy queues', () => {
  assert.deepEqual(agentsForMachine(roster, 'local-mac').sort(), Object.keys(AGENTS).sort());
  assert.equal(entitlements(roster, 'local-mac').length, Object.keys(AGENTS).length * 3);
  assert.equal(isEntitled(roster, 'local-mac', 'feature', 'opus'), true);
  assert.equal(isEntitled(roster, 'local-mac', 'deploy', 'grok'), true);
});

test('refuses an unknown machine, queue, or agent instead of trusting the caller', () => {
  assert.equal(isEntitled(roster, 'mac-mini', 'feature', 'opus'), false);
  assert.equal(isEntitled(roster, 'local-mac', 'release', 'opus'), false);
  assert.equal(isEntitled(roster, 'local-mac', 'feature', 'gemini'), false);
  assert.deepEqual(entitlements(roster, 'mac-mini'), []);
  assert.deepEqual(agentsForMachine(roster, 'mac-mini'), []);
});

test('a queue the machine does not list stays unentitled even for a listed agent', () => {
  const limited = { machines: [{ id: 'mac-mini', agents: ['sonnet'], queues: ['bug'] }] };
  assert.equal(isEntitled(limited, 'mac-mini', 'bug', 'sonnet'), true);
  assert.equal(isEntitled(limited, 'mac-mini', 'feature', 'sonnet'), false);
  assert.equal(isEntitled(limited, 'mac-mini', 'bug', 'opus'), false);
});

test('the CLI answers through exit codes and enumerates jobs for provisioning', () => {
  assert.equal(check('local-mac', 'feature', 'opus'), 0);
  assert.equal(check('local-mac', 'feature', 'gemini'), 1);
  assert.equal(check('mac-mini', 'feature', 'opus'), 1);

  const listed = execFileSync(process.execPath, [rosterPath, '--list', 'local-mac'], { encoding: 'utf8' })
    .trim()
    .split('\n');
  assert.equal(listed.length, Object.keys(AGENTS).length * 3);
  assert.ok(listed.includes('deploy grok'));
  const jobs = new Set(listed.map((line) => {
    const [queue, agent] = line.split(' ');
    return queue === 'deploy' ? 'com.projectadmin.loop.configured-deploy' : `com.projectadmin.loop.${agent}-${queue}`;
  }));
  assert.equal(jobs.size, 15);

  const agents = execFileSync(process.execPath, [rosterPath, '--agents', 'local-mac'], { encoding: 'utf8' }).trim();
  assert.equal(agents, Object.keys(AGENTS).join(','));
});

test('the runner and the provisioner both defer to the roster', () => {
  const loops = path.join(__dirname, '..', 'agent-loops');
  const runner = fs.readFileSync(path.join(loops, 'run-loop.sh'), 'utf8');
  const provisioner = fs.readFileSync(path.join(loops, 'provision-machine.sh'), 'utf8');
  assert.match(runner, /roster-check\.js" "\$MACHINE_ID" "\$QUEUE_NAME" "\$AGENT_TOKEN"/);
  assert.match(runner, /does not entitle/);
  assert.match(provisioner, /roster-check\.js" --list "\$MACHINE_ID"/);
  assert.doesNotMatch(provisioner, /for agent in sol terra luna/);
});

test('the provisioner uses the intended polling cadence for each loop class', () => {
  const provisioner = fs.readFileSync(
    path.join(__dirname, '..', 'agent-loops', 'provision-machine.sh'),
    'utf8',
  );
  // Cadence is per agent in the roster: Grok every thirty minutes, the rest every five.
  assert.match(provisioner, /AGENTS_HELPER" get "\$1" pollSeconds/);
  assert.equal(AGENTS.grok.pollSeconds, 1800);
  assert.deepEqual([...new Set(Object.values(AGENTS).filter((agent) => agent.token !== 'grok').map((agent) => agent.pollSeconds))], [300]);
  assert.match(provisioner, /plist com\.projectadmin\.loop\.configured-deploy configured deploy 900/);
});

test('the provisioner checks each entitled agent through its runner adapter, not a fixed CLI list', () => {
  const provisioner = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'provision-machine.sh'), 'utf8');
  assert.match(provisioner, /runners\/\$PA_RUNNER\.sh" check/);
  assert.doesNotMatch(provisioner, /check_binary (Codex|Claude)/);
});

test('roster agents missing from the configured roster entitle nothing', () => {
  const stale = { machines: [{ id: 'mac-mini', agents: ['opus', 'retired'], queues: ['bug'] }] };
  const known = Object.keys(AGENTS);
  assert.equal(isEntitled(stale, 'mac-mini', 'bug', 'retired', known), false);
  assert.equal(isEntitled(stale, 'mac-mini', 'bug', 'opus', known), true);
  assert.deepEqual(agentsForMachine(stale, 'mac-mini', known), ['opus']);
  assert.deepEqual(unknownAgents(stale, 'mac-mini', known), ['retired']);
});
