#!/usr/bin/env node
'use strict';

const { loadProjectConfig, resolveBackend } = require('./lib/project-config');
const { openStore } = require('./lib/store');
const { loadWorkKinds } = require('./lib/work-kinds');

function parseArgs(argv) {
  const command = argv[0];
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    flags[argv[index].slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return { command, flags };
}

function emailId(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('A valid --email address is required');
  return email;
}

// Adds a zero counter for each configured kind that has none yet. Existing
// numbering is never reset, so re-running bootstrap is safe.
async function initializeCounters(store, kinds) {
  const current = (await store.system.get('counters')) || {};
  const missing = Object.fromEntries(kinds.filter((kind) => current[kind.counterField] === undefined).map((kind) => [kind.counterField, 0]));
  await store.system.merge('counters', { ...missing, updatedAt: store.serverTimestamp() });
}

async function add(store, flags, config) {
  const email = emailId(flags.email || config.admin.ownerEmail);
  const role = flags.role || 'admin';
  if (!['admin', 'collaborator'].includes(role)) throw new Error('--role must be admin or collaborator');
  await store.users.merge(email, {
    email,
    displayName: String(flags.name || (email === config.admin.ownerEmail.toLowerCase() ? config.admin.ownerName : email.split('@')[0])).trim(),
    role,
    active: true,
    createdBy: 'bootstrap-cli',
    createdAt: store.serverTimestamp(),
    updatedAt: store.serverTimestamp(),
  });
  // Sequential: the local store serializes writers on one lockfile anyway.
  await store.system.merge('projectConfig', {
    defaultWorkOwner: `${config.automation.defaultWorkAgent}-agent`,
    defaultMachineId: config.automation.defaultMachineId,
    updatedAt: store.serverTimestamp(),
  });
  await initializeCounters(store, loadWorkKinds(config));
  await store.system.merge('agentLoopConfig', {
    deployAgent: config.automation.defaultDeployAgent,
    updatedAt: store.serverTimestamp(),
  });
  console.log(JSON.stringify({ ok: true, email, role, backend: store.backend }));
}

async function list(store) {
  console.log(JSON.stringify(await store.users.list(), null, 2));
}

async function setActive(store, flags, active) {
  const email = emailId(flags.email);
  await store.users.merge(email, { email, active, updatedAt: store.serverTimestamp() });
  console.log(JSON.stringify({ ok: true, email, active }));
}

async function remove(store, flags) {
  const email = emailId(flags.email);
  await store.users.remove(email);
  console.log(JSON.stringify({ ok: true, email, removed: true }));
}

async function main({ argv = process.argv.slice(2), config = loadProjectConfig(), store = null } = {}) {
  const { command, flags } = parseArgs(argv);
  // GitHub has no user table: repository collaborators with write access are
  // the access list, and issue numbers need no counters.
  if (resolveBackend(config).type === 'github') {
    if (!['add', 'list', 'activate', 'suspend', 'remove'].includes(command)) throw new Error('Usage: admin-users.js <add|list|activate|suspend|remove>');
    console.log(JSON.stringify({ ok: true, backend: 'github', skipped: true, message: `Nothing to bootstrap: the github backend authorizes people who have write, maintain, or admin permission on ${resolveBackend(config).repository}. Manage access in the repository's collaborator settings.` }));
    return;
  }
  store ||= openStore({ config });
  if (command === 'add') return add(store, flags, config);
  if (command === 'list') return list(store);
  if (command === 'activate') return setActive(store, flags, true);
  if (command === 'suspend') return setActive(store, flags, false);
  if (command === 'remove') return remove(store, flags);
  throw new Error('Usage: admin-users.js <add|list|activate|suspend|remove> [--email user@example.com] [--name Name] [--role admin|collaborator]');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { main };
