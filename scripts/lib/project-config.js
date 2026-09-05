'use strict';

const fs = require('node:fs');
const path = require('node:path');

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
  return config;
}

module.exports = { CONFIG_PATH, ROOT, loadProjectConfig };
