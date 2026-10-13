#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, CONFIG_PATH, resolveBackend, validateProjectConfig } = require('./lib/project-config');
const { normalizeRoster } = require('./lib/agent-roster');
const { loadWorkKinds, queueNames, syncDerivedFiles } = require('./lib/work-kinds');

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

// --backend firestore|local|github (docs/BACKENDS.md). Firestore is the
// default and is written as an absent key, so existing configs stay unchanged.
function applyBackend(config, flags) {
  if (typeof flags.backend !== 'string') return;
  if (flags.backend === 'firestore') {
    delete config.backend;
  } else {
    config.backend = { type: flags.backend };
    if (flags.backend === 'local' && typeof flags.localPath === 'string') config.backend.path = flags.localPath;
    if (flags.backend === 'github') {
      if (typeof flags.githubRepo === 'string') config.backend.repository = flags.githubRepo;
      if (typeof flags.labelPrefix === 'string') config.backend.labelPrefix = flags.labelPrefix;
    }
  }
  resolveBackend(config);
}

const NEXT_STEPS = {
  firestore: 'npm run install:all, firebase login, then npm run bootstrap-admin.',
  local: 'npm run install:all, npm run bootstrap-admin, npm run build, then npm run local.',
  github: 'npm run install:all and `gh auth login` (or export GITHUB_TOKEN); manage work in GitHub Issues (docs/BACKENDS.md).',
};

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log('npm run configure -- --name "App Name" --slug app-name [--backend firestore|local|github] --firebase-project id --api-key key --messaging-sender-id id --app-id id --production-url https://app.example --owner-email owner@example.com --owner-name "Owner" --repo owner/repo');
    console.log('  --backend local  [--local-path ~/.project-admin/app/store.json]   no Firebase keys needed');
    console.log('  --backend github [--github-repo owner/repo] [--label-prefix pa:]   no Firebase keys needed');
    return;
  }
  // Validated after the flags apply, so --backend can drop Firebase requirements.
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  applyBackend(config, flags);
  for (const [flag, keys] of Object.entries(FLAG_PATHS)) if (typeof flags[flag] === 'string') setPath(config, keys, flags[flag]);
  if (typeof flags.name === 'string' && typeof flags.shortName !== 'string') config.project.shortName = flags.name;
  if (typeof flags.name === 'string' && typeof flags.slug !== 'string') config.project.slug = flags.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (typeof flags.firebaseProject === 'string') {
    config.firebase ||= {};
    if (!flags.authDomain) config.firebase.authDomain = `${flags.firebaseProject}.firebaseapp.com`;
    if (!flags.storageBucket) config.firebase.storageBucket = `${flags.firebaseProject}.firebasestorage.app`;
  }
  config.admin.ownerEmail = config.admin.ownerEmail.toLowerCase();
  config.project.adminPath = `/${config.project.adminPath.replace(/^\/+|\/+$/g, '')}`;
  // Re-validate the edited config (backend-specific requirements included)
  // before anything is written.
  const backend = resolveBackend(config);
  validateProjectConfig(config);
  writeJson(CONFIG_PATH, config);
  if (config.project.firebaseProjectId) writeJson(path.join(ROOT, '.firebaserc'), { projects: { default: config.project.firebaseProjectId } });
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
    agents: Object.keys(normalizeRoster(config).agents),
    queues: queueNames(loadWorkKinds(config)),
  }] });
  updateMarketingPage(config);
  // Rules, Functions, and the iOS wrapper carry generated copies of workKinds.
  syncDerivedFiles({ root: ROOT, kinds: loadWorkKinds(config) });
  console.log(`Configured ${config.project.name} (${backend.type} backend). Next: ${NEXT_STEPS[backend.type]}`);
}

main();
