'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeRoster } = require('./agent-roster');

// The kit directory. In the default layout it is also the product repository;
// see scripts/lib/layout.js for PRODUCT_ROOT when it is not.
const ROOT = path.resolve(__dirname, '../..');
const KIT_ROOT = ROOT;
const CONFIG_PATH = process.env.PROJECT_ADMIN_CONFIG || path.join(ROOT, 'project-admin.config.json');
const BACKEND_TYPES = Object.freeze(['firestore', 'local', 'github']);
const FIREBASE_WEB_KEYS = Object.freeze(['apiKey', 'authDomain', 'storageBucket', 'messagingSenderId', 'appId']);

// `backend` picks the backlog/telemetry store (docs/BACKENDS.md). Absent means
// Firestore, exactly as before the key existed.
function resolveBackend(config) {
  const raw = config.backend ?? { type: 'firestore' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('backend must be an object such as { "type": "local" }');
  const type = raw.type ?? 'firestore';
  if (!BACKEND_TYPES.includes(type)) throw new Error(`backend.type must be one of ${BACKEND_TYPES.join(', ')}, got "${type}"`);
  const allowed = { firestore: ['type'], local: ['type', 'path'], github: ['type', 'repository', 'labelPrefix'] }[type];
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`backend.${unknown[0]} is not a ${type} backend option (allowed: ${allowed.join(', ')})`);
  if (type === 'local') {
    if (raw.path !== undefined && (typeof raw.path !== 'string' || !raw.path.trim())) throw new Error('backend.path must be a non-empty string');
    return { type, path: raw.path?.trim() || null };
  }
  if (type === 'github') {
    const repository = raw.repository ?? config.repository?.slug;
    if (typeof repository !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error('backend.repository (or repository.slug) must be owner/repo');
    const labelPrefix = raw.labelPrefix ?? 'pa:';
    if (typeof labelPrefix !== 'string' || !/^[A-Za-z0-9_.:/-]{1,20}$/.test(labelPrefix)) throw new Error('backend.labelPrefix must be 1-20 label-safe characters, e.g. "pa:"');
    return { type, repository, labelPrefix };
  }
  return { type };
}

function loadProjectConfig() {
  return validateProjectConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
}

// Throws on the first problem; `source` names the file in messages.
function validateProjectConfig(config, source = CONFIG_PATH) {
  if (config.schemaVersion !== 1) throw new Error(`Unsupported project admin config schema in ${source}`);
  let backend;
  try {
    backend = resolveBackend(config);
  } catch (error) {
    throw new Error(`${error.message} (${source})`);
  }
  // Firebase identity is required only when Firestore is the store.
  const firebaseRequired = backend.type === 'firestore'
    ? [['project.firebaseProjectId', config.project?.firebaseProjectId], ...FIREBASE_WEB_KEYS.map((key) => [`firebase.${key}`, config.firebase?.[key]])]
    : [];
  for (const [label, value] of [
    ['project.name', config.project?.name],
    ...firebaseRequired,
    ['repository.slug', config.repository?.slug],
    ['admin.ownerEmail', config.admin?.ownerEmail],
    ['automation.defaultMachineId', config.automation?.defaultMachineId],
  ]) {
    if (!value || typeof value !== 'string') {
      throw new Error(`Missing ${label} in ${source}${firebaseRequired.some(([name]) => name === label) ? ' (required by the firestore backend)' : ''}`);
    }
  }
  // Fail at load time, not mid-loop, when `agents`/`agentAliases` are invalid.
  try {
    normalizeRoster(config);
  } catch (error) {
    throw new Error(`${error.message} (${source})`);
  }
  try {
    require('./layout').validateLayout(config.layout);
  } catch (error) {
    throw new Error(`${error.message} (${source})`);
  }
  // Lazy require: work-kinds.js itself loads this module.
  if (config.workKinds !== undefined) require('./work-kinds').resolveWorkKinds(config.workKinds);
  // Deploy targets (new `targets` map or the legacy boolean map), the loop
  // scheduler, and notification channels.
  try {
    require('./deploy-targets').resolveDeployTargets(config.deployments);
    const { resolveNotifications, resolveScheduler } = require('./automation');
    resolveScheduler(config.automation);
    resolveNotifications(config.notifications);
  } catch (error) {
    throw new Error(`${error.message} (${CONFIG_PATH})`);
  }
  return config;
}

// Kit and product roots for a loaded config (docs/LAYOUTS.md).
function resolveProjectLayout(config = loadProjectConfig()) {
  return require('./layout').resolveLayout(config);
}

module.exports = { BACKEND_TYPES, CONFIG_PATH, FIREBASE_WEB_KEYS, KIT_ROOT, ROOT, loadProjectConfig, resolveBackend, resolveProjectLayout, validateProjectConfig };
