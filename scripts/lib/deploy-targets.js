#!/usr/bin/env node
'use strict';

// Deploy targets are configuration. `project-admin.config.json#deployments`
// names each release surface the deploy loop may execute and the runbook that
// holds its procedure (preconditions, commands, live proof, known failures):
//
//   "deployments": { "targets": { "fly": { "label": "Fly.io", "runbook": "docs/deploy-targets/fly.md" } } }
//
// Entries merge over the built-in definition with the same id
// (deploy-targets.defaults.json). `none` is built in, reserved, and always
// available. The legacy shape — a flat map of booleans such as
// `{ "firebaseHosting": true, "testflight": false }` — was never enforced, so it
// resolves to every built-in target exactly as before; `migrate` prints the
// equivalent `targets` map with those booleans carried over as `enabled`.

const fs = require('node:fs');
const path = require('node:path');
const BUILT_IN_TARGETS = require('./deploy-targets.defaults.json');

const TARGET_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const RESERVED_TARGET = 'none';
const TARGET_FIELDS = new Set(['label', 'runbook', 'requiresHumanAcceptance', 'enabled']);

function fail(id, field, problem) {
  throw new Error(`Invalid deployments.targets${id ? `.${id}` : ''}${field ? `.${field}` : ''}: ${problem}`);
}

// A legacy map is a non-empty object of booleans with no `targets` key.
function isLegacyShape(deployments) {
  return Boolean(deployments) && typeof deployments === 'object' && !Array.isArray(deployments)
    && !('targets' in deployments) && Object.values(deployments).every((value) => typeof value === 'boolean');
}

function builtIn(id, overrides = {}) {
  const base = BUILT_IN_TARGETS[id];
  return {
    id,
    label: base.label,
    runbook: base.runbook,
    requiresHumanAcceptance: base.requiresHumanAcceptance === true,
    enabled: true,
    builtIn: true,
    ...overrides,
  };
}

function resolveTarget(id, raw) {
  if (!TARGET_ID_PATTERN.test(id)) fail(id, '', 'id must match ^[a-z][a-z0-9_]*$');
  if (id === RESERVED_TARGET) fail(id, '', '`none` is a reserved built-in target and cannot be configured');
  if (id === 'mixed') fail(id, '', '`mixed` is the legacy multi-target marker, not a target');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(id, '', 'must be an object');
  for (const field of Object.keys(raw)) if (!TARGET_FIELDS.has(field)) fail(id, field, 'is not a known field');
  const base = BUILT_IN_TARGETS[id] || {};
  const merged = { ...base, ...raw };
  for (const field of ['label', 'runbook']) {
    if (typeof merged[field] !== 'string' || merged[field].trim().length === 0) {
      fail(id, field, BUILT_IN_TARGETS[id] ? 'must be a non-empty string' : 'is required for a target that is not built in');
    }
  }
  for (const field of ['requiresHumanAcceptance', 'enabled']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') fail(id, field, 'must be true or false');
  }
  return {
    id,
    label: merged.label.trim(),
    runbook: merged.runbook.trim(),
    requiresHumanAcceptance: merged.requiresHumanAcceptance === true,
    enabled: merged.enabled !== false,
    builtIn: Boolean(BUILT_IN_TARGETS[id]),
  };
}

// Ordered definitions: configured (or built-in) order, `none` always last.
function resolveDeployTargets(deployments) {
  let targets;
  if (deployments === undefined || isLegacyShape(deployments)) {
    targets = Object.keys(BUILT_IN_TARGETS).filter((id) => id !== RESERVED_TARGET).map((id) => builtIn(id));
  } else {
    if (!deployments || typeof deployments !== 'object' || Array.isArray(deployments)) {
      throw new Error('Invalid deployments: expected { "targets": { ... } } or the legacy boolean map');
    }
    for (const key of Object.keys(deployments)) {
      if (key !== 'targets') throw new Error(`Invalid deployments.${key}: only "targets" is supported alongside the new shape`);
    }
    const raw = deployments.targets;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('', '', 'must be an object keyed by target id');
    targets = Object.entries(raw).map(([id, entry]) => resolveTarget(id, entry));
  }
  return [...targets, builtIn(RESERVED_TARGET)];
}

// Legacy boolean keys (firebaseHosting, cloudRun, ...) that name no built-in.
function unmappedLegacyKeys(deployments) {
  if (!isLegacyShape(deployments)) return [];
  const known = new Set(Object.values(BUILT_IN_TARGETS).map((value) => value.legacyKey).filter(Boolean));
  return Object.keys(deployments).filter((key) => !known.has(key));
}

// The `targets` map equivalent to a legacy boolean map, with `false` carried
// over as `enabled: false`. Any other shape is returned unchanged.
function migrateLegacy(deployments) {
  if (deployments !== undefined && !isLegacyShape(deployments)) return deployments;
  const targets = {};
  for (const [id, value] of Object.entries(BUILT_IN_TARGETS)) {
    if (id === RESERVED_TARGET) continue;
    targets[id] = deployments?.[value.legacyKey] === false ? { enabled: false } : {};
  }
  return { targets };
}

function loadDeployTargets(config) {
  const source = config || require('./project-config').loadProjectConfig();
  return resolveDeployTargets(source.deployments);
}

// Runbook paths are repository-relative; a missing file is a config error the
// `check` command (and the scripts test suite) reports.
function missingRunbooks(targets, root = path.resolve(__dirname, '../..')) {
  return targets.filter((target) => !fs.existsSync(path.join(root, target.runbook)));
}

function main(argv = process.argv.slice(2)) {
  const [command = 'list', ...rest] = argv;
  const { loadProjectConfig, ROOT } = require('./project-config');
  const config = loadProjectConfig();
  const targets = resolveDeployTargets(config.deployments);
  if (command === 'list') {
    console.log(JSON.stringify(targets, null, 2));
  } else if (command === 'ids') {
    for (const target of targets) if (target.enabled) console.log(target.id);
  } else if (command === 'show') {
    if (rest.length === 0) throw new Error('Usage: deploy-targets.js show <target> [<target> ...]');
    let failed = false;
    for (const id of rest) {
      const target = targets.find((entry) => entry.id === id);
      if (!target) { console.error(`${id}: not a configured deploy target (${targets.map((entry) => entry.id).join(', ')})`); failed = true; continue; }
      const readable = fs.existsSync(path.join(ROOT, target.runbook));
      console.log(`${target.id}\t${target.label}\trunbook=${target.runbook}${readable ? '' : ' (MISSING)'}\trequiresHumanAcceptance=${target.requiresHumanAcceptance}${target.enabled ? '' : '\tDISABLED'}`);
      if (!readable || !target.enabled) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  } else if (command === 'check') {
    const missing = missingRunbooks(targets, ROOT);
    for (const target of missing) console.error(`deploy target ${target.id}: runbook ${target.runbook} does not exist`);
    if (isLegacyShape(config.deployments)) {
      console.error('deployments uses the legacy boolean map; every built-in target stays enabled. Run `node scripts/lib/deploy-targets.js migrate` for the equivalent "targets" config.');
    }
    process.exitCode = missing.length ? 1 : 0;
  } else if (command === 'migrate') {
    const unmapped = unmappedLegacyKeys(config.deployments);
    if (unmapped.length) console.error(`ignoring legacy keys with no built-in target: ${unmapped.join(', ')}`);
    console.log(JSON.stringify({ deployments: migrateLegacy(config.deployments) }, null, 2));
  } else {
    console.error('Usage: deploy-targets.js <list|ids|show <target>...|check|migrate>');
    process.exitCode = 2;
  }
}

module.exports = {
  BUILT_IN_TARGETS,
  RESERVED_TARGET,
  TARGET_ID_PATTERN,
  isLegacyShape,
  loadDeployTargets,
  migrateLegacy,
  missingRunbooks,
  resolveDeployTargets,
  unmappedLegacyKeys,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
