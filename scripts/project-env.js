#!/usr/bin/env node
'use strict';

const { loadProjectConfig } = require('./lib/project-config');

const config = loadProjectConfig();
const values = {
  PROJECT_NAME: config.project.name,
  PROJECT_SLUG: config.project.slug,
  PROJECT_ID: config.project.firebaseProjectId,
  PRODUCTION_URL: config.project.productionUrl.replace(/\/$/, ''),
  VERCEL_PRODUCTION_URL: (config.project.vercelProductionUrl || config.project.productionUrl).replace(/\/$/, ''),
  ADMIN_PATH: config.project.adminPath,
  ADMIN_BASE_URL: `${config.project.productionUrl.replace(/\/$/, '')}${config.project.adminPath}`,
  STORAGE_BUCKET: config.firebase.storageBucket,
  REPOSITORY_SLUG: config.repository.slug,
  DEFAULT_BRANCH: config.repository.defaultBranch,
  DEFAULT_MACHINE_ID: config.automation.defaultMachineId,
  DEFAULT_MACHINE_LABEL: config.automation.defaultMachineLabel,
  OWNER_NAME: config.admin.ownerName,
  OWNER_EMAIL: config.admin.ownerEmail,
  STATE_DIRECTORY: config.automation.stateDirectory,
  LOG_DIRECTORY_NAME: config.automation.logDirectoryName,
};

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

const command = process.argv[2] || 'json';
if (command === 'shell') {
  for (const [name, value] of Object.entries(values)) console.log(`export ${name}=${shellQuote(value)}`);
} else if (command === 'value') {
  const name = process.argv[3];
  if (!(name in values)) throw new Error(`Unknown project value ${name}`);
  process.stdout.write(String(values[name]));
} else {
  console.log(JSON.stringify(values, null, 2));
}
