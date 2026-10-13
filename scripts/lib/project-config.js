'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeRoster } = require('./agent-roster');

const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = process.env.PROJECT_ADMIN_CONFIG || path.join(ROOT, 'project-admin.config.json');

function loadProjectConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (config.schemaVersion !== 1) throw new Error(`Unsupported project admin config schema in ${CONFIG_PATH}`);
  for (const [label, value] of [
    ['project.name', config.project?.name],
    ['project.firebaseProjectId', config.project?.firebaseProjectId],
    ['repository.slug', config.repository?.slug],
    ['admin.ownerEmail', config.admin?.ownerEmail],
    ['automation.defaultMachineId', config.automation?.defaultMachineId],
  ]) {
    if (!value || typeof value !== 'string') throw new Error(`Missing ${label} in ${CONFIG_PATH}`);
  }
  // Fail at load time, not mid-loop, when `agents`/`agentAliases` are invalid.
  try {
    normalizeRoster(config);
  } catch (error) {
    throw new Error(`${error.message} (${CONFIG_PATH})`);
  }
  // Lazy require: work-kinds.js itself loads this module.
  if (config.workKinds !== undefined) require('./work-kinds').resolveWorkKinds(config.workKinds);
  return config;
}

module.exports = { CONFIG_PATH, ROOT, loadProjectConfig };
