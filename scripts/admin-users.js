#!/usr/bin/env node
'use strict';

const { FieldValue } = require('@google-cloud/firestore');
const db = require('./lib/firestore');
const { loadProjectConfig } = require('./lib/project-config');

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

async function add(flags) {
  const config = loadProjectConfig();
  const email = emailId(flags.email || config.admin.ownerEmail);
  const role = flags.role || 'admin';
  if (!['admin', 'collaborator'].includes(role)) throw new Error('--role must be admin or collaborator');
  await db.collection('adminUsers').doc(email).set({
    email,
    displayName: String(flags.name || (email === config.admin.ownerEmail.toLowerCase() ? config.admin.ownerName : email.split('@')[0])).trim(),
    role,
    active: true,
    createdBy: 'bootstrap-cli',
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await Promise.all([
    db.collection('system').doc('projectConfig').set({
      defaultWorkOwner: `${config.automation.defaultWorkAgent}-agent`,
      defaultMachineId: config.automation.defaultMachineId,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('system').doc('counters').set({
      nextFeatureNumber: 0,
      nextBugNumber: 0,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
    db.collection('system').doc('agentLoopConfig').set({
      deployAgent: config.automation.defaultDeployAgent,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }),
  ]);
  console.log(JSON.stringify({ ok: true, email, role }));
}

async function list() {
  const snapshot = await db.collection('adminUsers').orderBy('email').get();
  console.log(JSON.stringify(snapshot.docs.map((document) => ({ id: document.id, ...document.data() })), null, 2));
}

async function setActive(flags, active) {
  const email = emailId(flags.email);
  await db.collection('adminUsers').doc(email).set({ email, active, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(JSON.stringify({ ok: true, email, active }));
}

async function remove(flags) {
  const email = emailId(flags.email);
  await db.collection('adminUsers').doc(email).delete();
  console.log(JSON.stringify({ ok: true, email, removed: true }));
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'add') return add(flags);
  if (command === 'list') return list();
  if (command === 'activate') return setActive(flags, true);
  if (command === 'suspend') return setActive(flags, false);
  if (command === 'remove') return remove(flags);
  throw new Error('Usage: admin-users.js <add|list|activate|suspend|remove> [--email user@example.com] [--name Name] [--role admin|collaborator]');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
