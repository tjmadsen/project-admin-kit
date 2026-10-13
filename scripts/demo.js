#!/usr/bin/env node
'use strict';

// `npm run demo`: a credential-free tryout of the admin console. It
//
//   1. writes a copy of project-admin.config.json with backend.type "local",
//   2. builds the console for that config into the demo directory (never the
//      committed public/<adminPath> bundle),
//   3. seeds a throwaway local store there from the screenshot harness fixtures
//      (admin-app/screenshots/fixtures.ts): feature, bug, and task items at
//      every gate, agent runs, a machine, provider usage, and the deploy agent,
//   4. serves it with the local server (scripts/local-server.js) on 127.0.0.1.
//
// Nothing needs Firebase, GitHub, or an agent CLI, and the real local store is
// never touched. The demo directory defaults to .project-admin/demo/
// (gitignored) and is reseeded on every run.
//
//   node scripts/demo.js [--port 4318] [--dir <path>] [--no-build] [--seed-only]

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CONFIG_PATH, ROOT } = require('./lib/project-config');

const DEFAULT_PORT = 4318;
const DEFAULT_DIR = path.join(ROOT, '.project-admin', 'demo');
const ADMIN_APP = path.join(ROOT, 'admin-app');
const FIXTURES = path.join(ADMIN_APP, 'screenshots', 'fixtures.ts');

function parseArgs(argv) {
  const options = { port: DEFAULT_PORT, dir: DEFAULT_DIR, build: true, serve: true };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--port') options.port = Number(argv[++index]);
    else if (flag === '--dir') options.dir = path.resolve(argv[++index]);
    else if (flag === '--no-build') options.build = false;
    else if (flag === '--seed-only') { options.build = false; options.serve = false; }
    else throw new Error(`Unknown option ${flag}. Usage: node scripts/demo.js [--port N] [--dir path] [--no-build] [--seed-only]`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Invalid --port');
  return options;
}

// The project config with the store switched to a local file in `dir`.
function demoConfig(dir, source = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))) {
  return { ...source, backend: { type: 'local', path: path.join(dir, 'store.json') } };
}

// The fixtures are TypeScript with type-only imports. esbuild ships with the
// console's Vite install, so strip the types with it and evaluate the result.
function loadFixtures({ file = FIXTURES, adminApp = ADMIN_APP } = {}) {
  let esbuild;
  try {
    esbuild = require(require.resolve('esbuild', { paths: [adminApp] }));
  } catch {
    throw new Error('The demo needs the admin console dependencies: run `npm run install:all` first.');
  }
  const { code } = esbuild.transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs', sourcefile: file });
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, require);
  return module.exports;
}

// Fixture timestamps are { seconds, nanoseconds, toDate } stand-ins; the store
// wants values with toMillis().
function toStoreValues(value, StoreTimestamp) {
  if (Array.isArray(value)) return value.map((entry) => toStoreValues(entry, StoreTimestamp));
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function' && Number.isFinite(value.seconds)) return StoreTimestamp.fromMillis(value.seconds * 1000);
    return Object.fromEntries(Object.entries(value)
      .filter(([, entry]) => typeof entry !== 'function')
      .map(([key, entry]) => [key, toStoreValues(entry, StoreTimestamp)]));
  }
  return value;
}

const byId = (rows) => Object.fromEntries(rows.map(({ id, ...data }) => [id, data]));

// Replaces the store at `file` with the fixture data. Returns per-collection counts.
async function seedDemoStore({ file, config, fixtures = loadFixtures() }) {
  const { createJsonFileDatabase } = require('./lib/store/json-file');
  const { StoreTimestamp } = require('./lib/store/values');
  const { WORK_ITEMS_COLLECTION, loadWorkKinds } = require('./lib/work-kinds');
  const kinds = loadWorkKinds(config);
  const now = StoreTimestamp.now();
  const items = [...fixtures.features, ...fixtures.bugs, ...fixtures.tasks].filter((item) => kinds.some((kind) => kind.id === item.kind));
  const counters = Object.fromEntries(kinds.map((kind) => [
    kind.counterField,
    Math.max(0, ...items.filter((item) => item.kind === kind.id).map((item) => item.number)),
  ]));
  const owner = config.admin.ownerEmail.toLowerCase();
  const collections = toStoreValues({
    [WORK_ITEMS_COLLECTION]: byId(items),
    agentLoopRuns: byId(fixtures.runs),
    agentMachines: byId(fixtures.machines),
    system: {
      counters: { ...counters, updatedAt: now },
      agentLoopConfig: fixtures.loopConfig,
      agentLoopUsage: fixtures.usage,
      projectConfig: { defaultWorkOwner: `${config.automation.defaultWorkAgent}-agent`, defaultMachineId: config.automation.defaultMachineId, updatedAt: now },
    },
    adminUsers: {
      [owner]: { email: owner, displayName: config.admin.ownerName, role: 'admin', active: true, createdBy: 'demo', createdAt: now, updatedAt: now },
      'collaborator@example.com': { email: 'collaborator@example.com', displayName: 'Collaborator User', role: 'collaborator', active: true, createdBy: owner, createdAt: now, updatedAt: now },
    },
  }, StoreTimestamp);

  fs.rmSync(path.join(path.dirname(file), 'attachments'), { recursive: true, force: true });
  await createJsonFileDatabase(file).transaction((state) => {
    state.collections = collections;
    state.dirty = true;
  });
  return Object.fromEntries(Object.entries(collections).map(([name, docs]) => [name, Object.keys(docs).length]));
}

// Builds the console for the demo config into `outDir` (vite's --outDir wins
// over the config's public/<adminPath>, so the committed bundle is untouched).
function buildConsole({ configFile, outDir }) {
  const vite = path.join(ADMIN_APP, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) throw new Error('The demo needs the admin console dependencies: run `npm run install:all` first.');
  const result = spawnSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: ADMIN_APP,
    env: { ...process.env, PROJECT_ADMIN_CONFIG: configFile },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('The console build failed');
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = demoConfig(options.dir);
  const configFile = path.join(options.dir, 'project-admin.config.json');
  const publicDir = path.join(options.dir, 'admin');
  const storeFile = config.backend.path;
  fs.mkdirSync(options.dir, { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  if (options.build || (options.serve && !fs.existsSync(path.join(publicDir, 'index.html')))) {
    console.log(`Building the console for the local backend into ${path.relative(ROOT, publicDir) || publicDir} ...`);
    buildConsole({ configFile, outDir: publicDir });
  }
  const counts = await seedDemoStore({ file: storeFile, config });
  console.log(`Seeded ${storeFile}: ${Object.entries(counts).map(([name, count]) => `${count} ${name}`).join(', ')}`);
  if (!options.serve) return null;

  const { createLocalServer } = require('./local-server');
  const { createLocalStore } = require('./lib/store/local-store');
  const server = createLocalServer({ store: createLocalStore({ file: storeFile }), config, publicDir });
  server.listen(options.port, '127.0.0.1', () => {
    const { port } = server.address();
    console.log(`\nProject Admin demo: http://127.0.0.1:${port}${config.project.adminPath.replace(/\/$/, '')}/`);
    console.log('Demo data only; changes are discarded on the next `npm run demo`. Ctrl-C to stop.');
  });
  const stop = () => { server.close(() => process.exit(0)); server.closeAllConnections?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return server;
}

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { DEFAULT_DIR, DEFAULT_PORT, demoConfig, loadFixtures, parseArgs, seedDemoStore };
