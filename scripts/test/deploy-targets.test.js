'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  BUILT_IN_TARGETS,
  loadDeployTargets,
  migrateLegacy,
  missingRunbooks,
  resolveDeployTargets,
  unmappedLegacyKeys,
} = require('../lib/deploy-targets');

const REPO = path.resolve(__dirname, '..', '..');
const BUILT_IN_ORDER = ['testflight', 'firebase_hosting', 'firebase_functions', 'firebase_rules_indexes', 'vercel', 'flutter_web', 'cloud_run', 'none'];
const LEGACY = { firebaseHosting: true, firebaseFunctions: true, firebaseRulesIndexes: true, vercel: false, flutterWeb: false, cloudRun: false, testflight: false };

// Runs `snippet` in a child whose project config has `deployments` replaced,
// because the contract resolves its targets once per process from config.
function withDeployments(deployments, snippet) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-deploy-targets-'));
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
  if (deployments === undefined) delete config.deployments;
  else config.deployments = deployments;
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const result = spawnSync(process.execPath, ['-e', `
    const contract = require(${JSON.stringify(path.join(REPO, 'scripts/lib/deployment-contract.js'))});
    const attempt = (fn) => { try { return fn(); } catch (error) { return 'ERROR: ' + error.message; } };
    console.log(JSON.stringify((${snippet})(contract, attempt)));
  `], { encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: file } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('an absent deployments block resolves every built-in target with none last', () => {
  const targets = resolveDeployTargets(undefined);
  assert.deepEqual(targets.map((target) => target.id), BUILT_IN_ORDER);
  assert.ok(targets.every((target) => target.enabled && target.builtIn));
  assert.deepEqual(targets.filter((target) => target.requiresHumanAcceptance).map((target) => target.id), ['testflight']);
  assert.equal(targets.find((target) => target.id === 'firebase_rules_indexes').label, 'Rules & indexes');
});

test('the legacy boolean map keeps today\'s behavior and migrates booleans to enabled', () => {
  // The booleans were never enforced, so every built-in stays selectable.
  assert.deepEqual(resolveDeployTargets(LEGACY), resolveDeployTargets(undefined));
  assert.deepEqual(resolveDeployTargets({}), resolveDeployTargets(undefined));
  const migrated = migrateLegacy(LEGACY);
  assert.deepEqual(Object.keys(migrated.targets), BUILT_IN_ORDER.filter((id) => id !== 'none'));
  assert.deepEqual(migrated.targets.firebase_hosting, {});
  assert.deepEqual(migrated.targets.testflight, { enabled: false });
  assert.deepEqual(migrated.targets.cloud_run, { enabled: false });
  // The migrated map is itself a valid config that disables exactly the false ones.
  assert.deepEqual(resolveDeployTargets(migrated).filter((target) => target.enabled).map((target) => target.id),
    ['firebase_hosting', 'firebase_functions', 'firebase_rules_indexes', 'none']);
  assert.deepEqual(unmappedLegacyKeys({ ...LEGACY, netlify: true }), ['netlify']);
});

test('configured targets merge over built-ins, keep their order, and add new targets from config alone', () => {
  const targets = resolveDeployTargets({ targets: {
    fly: { label: 'Fly.io', runbook: 'docs/deploy-targets/examples/fly.md' },
    firebase_hosting: { label: 'Website' },
    testflight: { enabled: false },
    app_store_review: { label: 'App Store review', runbook: 'docs/deploy-targets/app_store_review.md', requiresHumanAcceptance: true },
  } });
  assert.deepEqual(targets.map((target) => target.id), ['fly', 'firebase_hosting', 'testflight', 'app_store_review', 'none']);
  const byId = Object.fromEntries(targets.map((target) => [target.id, target]));
  assert.deepEqual(byId.fly, { id: 'fly', label: 'Fly.io', runbook: 'docs/deploy-targets/examples/fly.md', requiresHumanAcceptance: false, enabled: true, builtIn: false });
  assert.equal(byId.firebase_hosting.label, 'Website');
  assert.equal(byId.firebase_hosting.runbook, BUILT_IN_TARGETS.firebase_hosting.runbook);
  assert.equal(byId.testflight.enabled, false);
  assert.equal(byId.testflight.requiresHumanAcceptance, true, 'a built-in keeps its acceptance rule');
  assert.equal(byId.app_store_review.requiresHumanAcceptance, true);
});

test('invalid target configuration fails with the offending path', () => {
  const invalid = [
    [{ targets: { none: {} } }, /none.*reserved/],
    [{ targets: { mixed: { label: 'Mixed', runbook: 'x.md' } } }, /legacy multi-target marker/],
    [{ targets: { Fly: { label: 'Fly', runbook: 'x.md' } } }, /targets\.Fly.*\^\[a-z\]/],
    [{ targets: { 'fly-io': { label: 'Fly', runbook: 'x.md' } } }, /targets\.fly-io/],
    [{ targets: { fly: { label: 'Fly' } } }, /targets\.fly\.runbook: is required/],
    [{ targets: { fly: { runbook: 'x.md' } } }, /targets\.fly\.label: is required/],
    [{ targets: { firebase_hosting: { enabled: 'yes' } } }, /firebase_hosting\.enabled: must be true or false/],
    [{ targets: { firebase_hosting: { command: 'firebase deploy' } } }, /firebase_hosting\.command: is not a known field/],
    [{ targets: { fly: 'fly.md' } }, /targets\.fly: must be an object/],
    [{ targets: [] }, /must be an object keyed by target id/],
    [{ targets: {}, firebaseHosting: true }, /deployments\.firebaseHosting/],
    [['firebase_hosting'], /Invalid deployments/],
  ];
  for (const [deployments, pattern] of invalid) {
    assert.throws(() => resolveDeployTargets(deployments), pattern, JSON.stringify(deployments));
  }
});

test('the contract validates scopes against configured targets and enforces human acceptance generically', () => {
  const result = withDeployments({ targets: {
    fly: { label: 'Fly.io', runbook: 'docs/deploy-targets/examples/fly.md', requiresHumanAcceptance: true },
    firebase_hosting: {},
    vercel: { enabled: false },
  } }, `(contract, attempt) => ({
    ids: contract.DEPLOY_TARGETS,
    normalized: contract.normalizeDeploymentTargets('firebase_hosting,fly'),
    unknown: attempt(() => contract.normalizeDeploymentTargets('testflight')),
    disabled: attempt(() => contract.normalizeDeploymentTargets('vercel')),
    recorded: contract.deploymentTargetsFor({ deploymentApprovedTargets: ['vercel'] }, true),
    human: contract.targetsRequiringHumanAcceptance(['firebase_hosting', 'fly']),
    label: contract.deployTargetLabel('fly'),
    none: attempt(() => contract.normalizeDeploymentTargets('none,fly')),
  })`);
  assert.deepEqual(result.ids, ['fly', 'firebase_hosting', 'vercel', 'none']);
  assert.deepEqual(result.normalized, ['fly', 'firebase_hosting'], 'scopes follow the configured order');
  assert.match(result.unknown, /Invalid deployment target "testflight"\. One of: fly, firebase_hosting, none/);
  assert.match(result.disabled, /"vercel" is disabled/);
  assert.deepEqual(result.recorded, ['vercel'], 'an already-recorded scope still resolves after the target is disabled');
  assert.deepEqual(result.human, ['fly']);
  assert.equal(result.label, 'Fly.io');
  assert.match(result.none, /cannot be combined/);
});

test('a legacy boolean config still accepts every built-in target, including ones marked false', () => {
  const result = withDeployments(LEGACY, `(contract) => ({
    ids: contract.DEPLOY_TARGETS,
    scope: contract.normalizeDeploymentTargets('cloud_run,testflight,firebase_hosting'),
    human: contract.targetsRequiringHumanAcceptance(['testflight', 'cloud_run']),
  })`);
  assert.deepEqual(result.ids, BUILT_IN_ORDER);
  assert.deepEqual(result.scope, ['testflight', 'firebase_hosting', 'cloud_run']);
  assert.deepEqual(result.human, ['testflight']);
  assert.deepEqual(withDeployments(undefined, '(contract) => contract.DEPLOY_TARGETS'), BUILT_IN_ORDER);
});

test('the project config loader rejects an invalid deployments block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-deploy-config-'));
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
  config.deployments = { targets: { fly: { label: 'Fly.io' } } };
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const result = spawnSync(process.execPath, [path.join(REPO, 'scripts/lib/deploy-targets.js'), 'list'], {
    encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: file },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deployments\.targets\.fly\.runbook: is required/);
});

test('every configured and built-in target has a runbook on disk', () => {
  assert.deepEqual(missingRunbooks(loadDeployTargets()).map((target) => target.id), []);
  assert.deepEqual(missingRunbooks(resolveDeployTargets(undefined)).map((target) => target.id), []);
  const check = spawnSync(process.execPath, [path.join(REPO, 'scripts/lib/deploy-targets.js'), 'check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const show = spawnSync(process.execPath, [path.join(REPO, 'scripts/lib/deploy-targets.js'), 'show', 'firebase_hosting', 'nope'], { encoding: 'utf8' });
  assert.equal(show.status, 1);
  assert.match(show.stdout, /^firebase_hosting\tFirebase Hosting\trunbook=docs\/deploy-targets\/firebase_hosting\.md\trequiresHumanAcceptance=false$/m);
  assert.match(show.stderr, /nope: not a configured deploy target/);
});
