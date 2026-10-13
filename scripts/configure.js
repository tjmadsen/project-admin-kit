#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CONFIG_PATH, loadProjectConfig } = require('./lib/project-config');
const { loadWorkKinds, syncDerivedFiles } = require('./lib/work-kinds');

const FLAG_PATHS = {
  name: ['project', 'name'], shortName: ['project', 'shortName'], slug: ['project', 'slug'],
  description: ['project', 'description'], productionUrl: ['project', 'productionUrl'], vercelProductionUrl: ['project', 'vercelProductionUrl'], adminPath: ['project', 'adminPath'],
  firebaseProject: ['project', 'firebaseProjectId'], firestoreLocation: ['project', 'firestoreLocation'],
  apiKey: ['firebase', 'apiKey'], authDomain: ['firebase', 'authDomain'], storageBucket: ['firebase', 'storageBucket'],
  messagingSenderId: ['firebase', 'messagingSenderId'], appId: ['firebase', 'appId'], measurementId: ['firebase', 'measurementId'],
  repo: ['repository', 'slug'], branch: ['repository', 'defaultBranch'], ownerName: ['admin', 'ownerName'], ownerEmail: ['admin', 'ownerEmail'],
  machineId: ['automation', 'defaultMachineId'], machineLabel: ['automation', 'defaultMachineLabel'],
  workAgent: ['automation', 'defaultWorkAgent'], deployAgent: ['automation', 'defaultDeployAgent'],
};

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) continue;
    const name = part.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    flags[name] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return flags;
}

function setPath(target, keys, value) {
  let current = target;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = value;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function updateMarketingPage(config) {
  const file = path.join(ROOT, 'public/index.html');
  let html = fs.readFileSync(file, 'utf8');
  html = html.replace(/<title>.*?<\/title>/, `<title>${config.project.name}</title>`)
    .replace(/<h1>.*?<\/h1>/, `<h1>${config.project.name}</h1>`)
    .replace(/href="\/admin\/"/, `href="${config.project.adminPath.replace(/\/$/, '')}/"`);
  fs.writeFileSync(file, html);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log('npm run configure -- --name "App Name" --slug app-name --firebase-project id --api-key key --messaging-sender-id id --app-id id --production-url https://app.example --owner-email owner@example.com --owner-name "Owner" --repo owner/repo');
    return;
  }
  const config = loadProjectConfig();
  for (const [flag, keys] of Object.entries(FLAG_PATHS)) if (typeof flags[flag] === 'string') setPath(config, keys, flags[flag]);
  if (typeof flags.name === 'string' && typeof flags.shortName !== 'string') config.project.shortName = flags.name;
  if (typeof flags.name === 'string' && typeof flags.slug !== 'string') config.project.slug = flags.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (typeof flags.firebaseProject === 'string') {
    if (!flags.authDomain) config.firebase.authDomain = `${flags.firebaseProject}.firebaseapp.com`;
    if (!flags.storageBucket) config.firebase.storageBucket = `${flags.firebaseProject}.firebasestorage.app`;
  }
  config.admin.ownerEmail = config.admin.ownerEmail.toLowerCase();
  config.project.adminPath = `/${config.project.adminPath.replace(/^\/+|\/+$/g, '')}`;
  writeJson(CONFIG_PATH, config);
  writeJson(path.join(ROOT, '.firebaserc'), { projects: { default: config.project.firebaseProjectId } });
  const firebaseConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const adminPath = config.project.adminPath.replace(/\/$/, '');
  firebaseConfig.firestore.location = config.project.firestoreLocation;
  firebaseConfig.hosting.rewrites = [
    { source: adminPath, destination: `${adminPath}/index.html` },
    { source: `${adminPath}/**`, destination: `${adminPath}/index.html` },
  ];
  firebaseConfig.hosting.headers = [adminPath, `${adminPath}/`, `${adminPath}/index.html`].map((source) => ({
    source,
    headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }],
  }));
  writeJson(path.join(ROOT, 'firebase.json'), firebaseConfig);
  writeJson(path.join(ROOT, 'functions/project-config.json'), {
    projectName: config.project.name,
    ownerEmail: config.admin.ownerEmail,
    adminBaseUrl: `${config.project.productionUrl.replace(/\/$/, '')}${config.project.adminPath}`,
  });
  writeJson(path.join(ROOT, 'native-ios/ProjectAdminConfig.json'), {
    projectName: config.project.name,
    adminURL: `${config.project.productionUrl.replace(/\/$/, '')}${config.project.adminPath.replace(/\/$/, '')}/`,
  });
  writeJson(path.join(ROOT, 'scripts/agent-loops/machine-roster.json'), { machines: [{
    id: config.automation.defaultMachineId,
    label: config.automation.defaultMachineLabel,
    repoRoot: ROOT,
    agents: ['sol', 'terra', 'luna', 'opus', 'sonnet', 'fable', 'grok'],
    queues: ['feature', 'bug', 'deploy'],
  }] });
  updateMarketingPage(config);
  // Rules, Functions, and the iOS wrapper carry generated copies of workKinds.
  syncDerivedFiles({ root: ROOT, kinds: loadWorkKinds(config) });
  console.log(`Configured ${config.project.name}. Next: npm run install:all, firebase login, then npm run bootstrap-admin.`);
}

main();
