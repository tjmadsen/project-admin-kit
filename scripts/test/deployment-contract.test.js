'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  deploymentTargetsFor,
  legacyDeploymentType,
  missingDeploymentEvidence,
  normalizeDeploymentTargets,
  resetDeploymentForPrChange,
  validateDeploymentNotes,
} = require('../lib/deployment-contract');

const notes = [
  'Scope: Release the admin UI and callable backend used by this feature.',
  'Commands: Build admin; deploy Hosting; deploy the named Firebase Function.',
  'Verification: Open the production route and invoke the production callable.',
  'Acceptance: Complete the feature workflow end to end with the expected result.',
].join('\n');

test('normalizes explicit multi-target scopes and keeps none exclusive', () => {
  assert.deepEqual(normalizeDeploymentTargets('firebase_functions,firebase_hosting,firebase_functions'), ['firebase_hosting', 'firebase_functions']);
  assert.equal(legacyDeploymentType(['firebase_hosting', 'firebase_functions']), 'mixed');
  assert.throws(() => normalizeDeploymentTargets('none,testflight'), /cannot be combined/i);
  assert.throws(() => normalizeDeploymentTargets('mixed'), /invalid deployment target/i);
});

test('prefers immutable approved targets and supports unambiguous legacy items', () => {
  assert.deepEqual(deploymentTargetsFor({ deploymentTargets: ['firebase_hosting'], deploymentApprovedTargets: ['testflight'] }, true), ['testflight']);
  assert.deepEqual(deploymentTargetsFor({ deploymentType: 'firebase_hosting' }, true), ['firebase_hosting']);
  assert.deepEqual(deploymentTargetsFor({ deploymentType: 'mixed' }, true), []);
});

test('requires structured deploy notes from feature and bug agents', () => {
  assert.equal(validateDeploymentNotes(notes), notes);
  assert.throws(() => validateDeploymentNotes('Deploy hosting and check it.'), /at least 80 characters/i);
  assert.throws(() => validateDeploymentNotes(notes.replace('Acceptance:', 'Outcome:')), /Acceptance:/i);
});

test('requires proof and contextual acceptance for every approved target', () => {
  const item = {
    deploymentApprovedTargets: ['firebase_hosting', 'firebase_functions'],
    deploymentEvidence: {
      firebase_hosting: { proof: 'Production route returned the new asset hash.', acceptance: 'The requested admin workflow completed successfully.' },
      firebase_functions: { proof: 'Deployed function revision 42 successfully.', acceptance: 'short' },
    },
  };
  assert.deepEqual(missingDeploymentEvidence(item), ['firebase_functions']);
  item.deploymentEvidence.firebase_functions.acceptance = 'The production callable returned the expected feature result.';
  assert.deepEqual(missingDeploymentEvidence(item), []);
});

test('a changed PR identity clears stale deployment approval while the same PR preserves it', () => {
  const item = {
    prNumber: 30,
    prUrl: 'https://github.com/example/project/pull/30',
    branchName: 'sol/bug-8',
    deploymentTargets: ['none'],
    deploymentNotes: 'Scope: PR #30 agent tooling release.',
    deploymentApprovedAt: new Date(),
    deploymentApprovedBy: 'owner@example.com',
    deploymentApprovedTargets: ['none'],
    deploymentApprovedNotes: 'Approved PR #30.',
  };
  const samePr = { prNumber: 30, prUrl: item.prUrl, branchName: item.branchName };
  assert.deepEqual(resetDeploymentForPrChange(item, samePr), {});

  const changed = resetDeploymentForPrChange(item, {
    prNumber: 40,
    prUrl: 'https://github.com/example/project/pull/40',
    branchName: 'sol/bug-8-follow-up',
  });
  assert.deepEqual(changed.deploymentApprovedTargets, []);
  assert.equal(changed.deploymentApprovedAt, null);
  assert.equal(changed.deploymentApprovedNotes, '');
  assert.equal(changed.deploymentNotes, '');

  const backlog = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backlog-agent.js'), 'utf8');
  assert.match(backlog, /resetDeploymentForPrChange\(data, nextPr\)/);
});

test('deploy playbook reconciles PR context and records each target before closure', () => {
  const prompt = fs.readFileSync(path.join(__dirname, '..', '..', '.claude', 'commands', 'deploy-loop.md'), 'utf8');
  const backlog = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backlog-agent.js'), 'utf8');
  const testflightLauncher = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'launch-testflight.sh'), 'utf8');
  assert.match(prompt, /Inspect the PR file list and diff/i);
  assert.match(prompt, /deploy-check/);
  assert.match(prompt, /Command success alone is not proof/i);
  assert.match(prompt, /cannot close the item until|rejects (completion|closure)/i);
  assert.match(backlog, /missingDeploymentEvidence\(data, targets\)/);
  assert.match(backlog, /TestFlight items require \$\{OWNER_NAME\} hands-on acceptance/);
  assert.match(testflightLauncher, /deployment-started/);
});

test('allows closing without deployment only when no release scope is planned, approved, or in flight', () => {
  const { assertClosableWithoutDeployment } = require('../lib/deployment-contract');
  assert.equal(assertClosableWithoutDeployment({ status: 'in_progress', waitingOn: 'agent', deploymentType: 'none', deploymentTargets: [] }), true);
  assert.equal(assertClosableWithoutDeployment({ status: 'in_review', waitingOn: 'human', deploymentTargets: ['none'] }), true);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'shipped', deploymentType: 'none' }), /already shipped/i);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'ready_for_deploy', waitingOn: 'deployer', deploymentApprovedAt: new Date(), deploymentApprovedTargets: ['firebase_hosting'] }), /approved a release for: firebase_hosting/i);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'ready_for_deploy', waitingOn: 'deployer', deploymentTargets: ['none'] }), /queued for the deploy loop/i);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'ready_for_deploy', waitingOn: 'hold', deploymentInProgressTarget: 'testflight', deploymentTargets: ['none'] }), /testflight is being released/i);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'in_review', waitingOn: 'human', deploymentTargets: ['vercel', 'flutter_web'] }), /still lists release targets: vercel, flutter_web/i);
  assert.throws(() => assertClosableWithoutDeployment({ status: 'in_review', waitingOn: 'human', deploymentType: 'firebase_hosting' }), /still lists release targets: firebase_hosting/i);
});

test('exposes close-no-deploy as a backlog command that never records deployment timestamps', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'backlog-agent.js'), 'utf8');
  assert.match(source, /case 'close-no-deploy': return closeWithoutDeployment\(id, flags\);/);
  const body = source.slice(source.indexOf('async function closeWithoutDeployment'), source.indexOf('async function setFields'));
  assert.match(body, /assertClosableWithoutDeployment\(data\)/);
  assert.match(body, /Closed without deployment: \$\{note\}/);
  assert.doesNotMatch(body, /deployedAt|deploymentVerifiedAt|deploymentAcceptedAt/);
});
