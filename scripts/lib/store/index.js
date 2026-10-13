'use strict';

// BacklogStore: every persistence operation the backlog CLI, loop telemetry,
// access bootstrap, and attachments need, behind one small interface with
// three implementations chosen by project-admin.config.json `backend`:
//
//   firestore (default)  firestore-store.js  Firestore + Firebase Storage
//   local                local-store.js      one JSON file on this machine
//   github               github-store.js     GitHub Issues (+ local telemetry)
//
// Interface (all methods async unless noted):
//
//   backend                    'firestore' | 'local' | 'github'
//   capabilities               { atomicClaims, dashboard, attachments, users }
//   now() / fromMillis(ms)     sync; Timestamp-like values with toMillis()/toDate()
//   serverTimestamp()          sync; sentinel resolved to commit time
//
//   items.create(kind, build)  build(number) -> document; allocates the kind's
//                              next number atomically; -> { id, number }
//   items.get(id)              -> document | null (with `messages`)
//   items.getMany(ids)         -> [{ id, ...document }] (missing ids omitted)
//   items.list({ kind, waitingOn, limit })
//                              -> [{ id, ...document }]; the queue query
//   items.update(id, patch, { messages })
//                              top-level field replace + append messages;
//                              throws when the item does not exist
//   items.transact(id, decide) decide(document | null, tx) returns null (no
//                              write) or { patch, messages, result }; tx.getMany
//                              reads other items in the same snapshot
//   items.claim(id, decide)    transact for leases: at most one concurrent
//                              claimant writes (atomic on firestore and local;
//                              best effort on github, see github-store.js)
//
//   runs.create(data) -> id, runs.get(id), runs.merge(id, data),
//   runs.listByStatus(status)                      agentLoopRuns
//   machines.merge(id, data)                       agentMachines
//   system.get(name), system.merge(name, data)     system/{counters,
//                                                  agentLoopConfig, agentLoopUsage,
//                                                  projectConfig, ...}
//   users.get/list/merge/remove                    adminUsers (not on github)
//   attachments.upload(paths, target) -> urls      Storage, files, or refused
//
// `merge` follows Firestore set(..., { merge: true }): nested maps merge key
// by key. `update`/`patch` follow Firestore update(): each top-level key is
// replaced. Messages are { author, body, createdAt, imageUrls?, authorEmail? }.

const os = require('node:os');
const path = require('node:path');
const { loadProjectConfig, resolveBackend } = require('../project-config');

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

// Per-project state lives under ~/<automation.stateDirectory>/<slug>/, shared by
// every worktree of the repository (a path inside the checkout would give each
// agent worktree its own backlog).
function stateDirectoryFor(config, { env = process.env, home = env.HOME || os.homedir() } = {}) {
  const base = expandHome(config.automation?.stateDirectory || '.project-admin', home);
  return path.resolve(home, base, config.project?.slug || 'project');
}

function localStorePath(config, { env = process.env, home = env.HOME || os.homedir() } = {}) {
  if (env.PROJECT_ADMIN_LOCAL_STORE) return path.resolve(env.PROJECT_ADMIN_LOCAL_STORE);
  const configured = resolveBackend(config).path;
  if (configured) return path.resolve(home, expandHome(configured, home));
  return path.join(stateDirectoryFor(config, { env, home }), 'store.json');
}

function githubTelemetryPath(config, options = {}) {
  const env = options.env || process.env;
  if (env.PROJECT_ADMIN_GITHUB_TELEMETRY) return path.resolve(env.PROJECT_ADMIN_GITHUB_TELEMETRY);
  return path.join(stateDirectoryFor(config, options), 'github-telemetry.json');
}

// Opens the configured store. `overrides` lets tests inject a database,
// transport, or file path without touching the environment.
function openStore({ config = loadProjectConfig(), env = process.env, overrides = {} } = {}) {
  const backend = resolveBackend(config);
  if (backend.type === 'local') {
    const { createLocalStore } = require('./local-store');
    return createLocalStore({ file: overrides.file || localStorePath(config, { env }) });
  }
  if (backend.type === 'github') {
    const { createGitHubStore } = require('./github-store');
    const { createLocalStore } = require('./local-store');
    const { createGitHubTransport } = require('./github-transport');
    const { resolveAgent } = require('../agents');
    const { loadWorkKinds } = require('../work-kinds');
    return createGitHubStore({
      repository: backend.repository,
      labelPrefix: backend.labelPrefix,
      transport: overrides.transport || createGitHubTransport({ token: env.GITHUB_TOKEN || env.GH_TOKEN }),
      telemetry: createLocalStore({ file: overrides.file || githubTelemetryPath(config, { env }) }),
      kinds: loadWorkKinds(config),
      defaultOwner: resolveAgent(config.automation.defaultWorkAgent).owner,
      resolveOwner: (token) => resolveAgent(token).owner,
      ...(overrides.settleMs === undefined ? {} : { settleMs: overrides.settleMs }),
      ...(env.PROJECT_ADMIN_GITHUB_SETTLE_MS ? { settleMs: Number(env.PROJECT_ADMIN_GITHUB_SETTLE_MS) } : {}),
    });
  }
  const { FieldValue, Timestamp } = require('@google-cloud/firestore');
  const { createFirestoreStore } = require('./firestore-store');
  return createFirestoreStore({ db: overrides.db || require('../firestore'), FieldValue, Timestamp });
}

module.exports = { githubTelemetryPath, localStorePath, openStore, stateDirectoryFor };
