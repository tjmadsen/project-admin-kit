'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sourceRoot = path.resolve(__dirname, '..', '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function copyKit(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-configure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of [
    'project-admin.config.json', 'firebase.json', 'public/index.html',
    'extras/functions/project-config.json', 'extras/native-ios/ProjectAdminConfig.json',
    'scripts/configure.js', 'scripts/project-env.js', 'scripts/lib/project-config.js',
    'scripts/lib/agent-roster.js', 'scripts/lib/agent-defaults.json',
    'scripts/lib/work-kinds.js', 'scripts/lib/work-kinds.defaults.json',
    'scripts/lib/deploy-targets.js', 'scripts/lib/deploy-targets.defaults.json', 'scripts/lib/automation.js',
    'firestore.rules', 'storage.rules',
    'scripts/agent-loops/machine-roster.json',
  ]) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  return root;
}

test('configure applies a new project identity across deployable surfaces', (t) => {
  const root = copyKit(t);

  execFileSync(process.execPath, [path.join(root, 'scripts/configure.js'),
    '--name', 'Rocket Notes',
    '--firebase-project', 'rocket-notes-prod',
    '--api-key', 'web-key',
    '--messaging-sender-id', 'sender-42',
    '--app-id', 'app-42',
    '--production-url', 'https://rocket.example',
    '--vercel-production-url', 'https://rocket.vercel.app',
    '--admin-path', '/control',
    '--owner-email', 'OWNER@Example.com',
    '--owner-name', 'Owner Name',
    '--repo', 'example/rocket-notes',
    '--branch', 'trunk',
    '--machine-id', 'build-mac',
    '--machine-label', 'Build Mac',
  ]);

  const config = readJson(path.join(root, 'project-admin.config.json'));
  assert.equal(config.project.name, 'Rocket Notes');
  assert.equal(config.project.slug, 'rocket-notes');
  assert.equal(config.project.firebaseProjectId, 'rocket-notes-prod');
  assert.equal(config.firebase.authDomain, 'rocket-notes-prod.firebaseapp.com');
  assert.equal(config.admin.ownerEmail, 'owner@example.com');
  assert.equal(config.repository.defaultBranch, 'trunk');

  const firebase = readJson(path.join(root, 'firebase.json'));
  assert.equal(firebase.hosting.rewrites[0].source, '/control');
  assert.equal(readJson(path.join(root, '.firebaserc')).projects.default, 'rocket-notes-prod');
  const functionsConfig = readJson(path.join(root, 'extras/functions/project-config.json'));
  assert.deepEqual({ ...functionsConfig, workKinds: undefined }, {
    projectName: 'Rocket Notes', ownerEmail: 'owner@example.com', adminBaseUrl: 'https://rocket.example/control', workKinds: undefined,
  });
  assert.deepEqual(Object.keys(functionsConfig.workKinds), Object.keys(config.workKinds));
  assert.equal(readJson(path.join(root, 'scripts/agent-loops/machine-roster.json')).machines[0].repoRoot, fs.realpathSync(root));
  assert.deepEqual(config.agents, readJson(path.join(sourceRoot, 'project-admin.config.json')).agents, 'configure preserves the agent roster');
  assert.deepEqual(readJson(path.join(root, 'scripts/agent-loops/machine-roster.json')).machines[0].agents, config.agents.map((agent) => agent.token));

  const env = JSON.parse(execFileSync(process.execPath, [path.join(root, 'scripts/project-env.js')], { encoding: 'utf8' }));
  assert.equal(env.PROJECT_ID, 'rocket-notes-prod');
  assert.equal(env.REPOSITORY_SLUG, 'example/rocket-notes');
  assert.equal(env.DEFAULT_BRANCH, 'trunk');
  assert.equal(env.ADMIN_BASE_URL, 'https://rocket.example/control');
});

test('configure --backend switches stores and only firestore needs Firebase identity', (t) => {
  const root = copyKit(t);
  const configPath = path.join(root, 'project-admin.config.json');
  const withoutFirebase = readJson(configPath);
  delete withoutFirebase.firebase;
  fs.writeFileSync(configPath, JSON.stringify(withoutFirebase));
  const configure = (...args) => execFileSync(process.execPath, [path.join(root, 'scripts/configure.js'), ...args], { encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: '' } });
  const load = () => execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(require("./scripts/lib/project-config").loadProjectConfig().backend || null))'], { cwd: root, encoding: 'utf8', env: { ...process.env, PROJECT_ADMIN_CONFIG: '' } });

  assert.match(configure('--backend', 'local', '--local-path', '~/data/app.json'), /\(local backend\)/);
  assert.deepEqual(readJson(configPath).backend, { type: 'local', path: '~/data/app.json' });
  assert.equal(load().trim(), '{"type":"local","path":"~/data/app.json"}');

  assert.match(configure('--backend', 'github', '--github-repo', 'acme/backlog', '--label-prefix', 'ops:'), /GitHub Issues/);
  assert.deepEqual(readJson(configPath).backend, { type: 'github', repository: 'acme/backlog', labelPrefix: 'ops:' });

  assert.throws(() => configure('--backend', 'firestore'), /firebase\.apiKey .*required by the firestore backend/s);
  assert.throws(() => configure('--backend', 'mongo'), /backend\.type must be one of firestore, local, github/);
});
