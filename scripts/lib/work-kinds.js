#!/usr/bin/env node
'use strict';

// Work item kinds are configuration. `project-admin.config.json#workKinds` names
// each kind (feature, bug, task, ...) and the handful of lifecycle switches the
// backlog CLI, rules, Functions, and admin console derive from it. Absent
// `workKinds` means the built-in feature + bug pair in work-kinds.defaults.json.

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, loadProjectConfig } = require('./project-config');
const BUILT_IN_KINDS = require('./work-kinds.defaults.json');

const WORK_ITEMS_COLLECTION = 'workItems';
// Pre-workKinds releases stored each kind in its own collection. Only the
// migration script and run-record fallbacks still read these names.
const LEGACY_COLLECTIONS = Object.freeze({ featureRequests: 'feature', bugs: 'bug' });
const KIND_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const PREFIX_PATTERN = /^[A-Z][A-Z0-9]*$/;
const ROUTE_PATTERN = /^[a-z][a-z0-9-]*$/;
const RESERVED_KIND_IDS = new Set(['deploy']);
const RESERVED_ROUTES = new Set(['loops', 'activity', 'users', 'operations']);
// Status names stay inside a fixed vocabulary so terminal-state checks in the
// contract, rules, notifications, and UI need no per-kind code.
const INITIAL_STATUSES = ['backlog', 'open'];
const DONE_STATUSES = ['shipped', 'closed'];
const DECLINED_STATUSES = ['declined', 'wont_fix'];
const ICONS = ['spark', 'bug', 'check'];
const TONES = ['green', 'amber', 'blue', 'violet'];
const STAT_DETAILS = ['queued', 'critical'];
const ALL_GATES = ['triage', 'question', 'plan_review', 'pr_review', 'deploy_approval', 'acceptance_review'];
const RULES_BEGIN = '// BEGIN GENERATED WORK KINDS';
const RULES_END = '// END GENERATED WORK KINDS';

function fail(id, field, problem) {
  throw new Error(`Invalid workKinds${id ? `.${id}` : ''}${field ? `.${field}` : ''}: ${problem}`);
}

function pascalCase(id) {
  return id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

// feature -> nextFeatureNumber and bug -> nextBugNumber are the legacy counter
// fields, so existing numbering continues without a counter migration.
function counterFieldFor(id) {
  return `next${pascalCase(id)}Number`;
}

function oneOf(id, field, value, allowed) {
  if (!allowed.includes(value)) fail(id, field, `must be one of ${allowed.join(', ')}`);
  return value;
}

function nonEmptyString(id, field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(id, field, 'must be a non-empty string');
  return value.trim();
}

function bool(id, field, value) {
  if (typeof value !== 'boolean') fail(id, field, 'must be true or false');
  return value;
}

function resolveKind(id, raw) {
  if (!KIND_ID_PATTERN.test(id)) fail(id, '', 'kind ids must match ^[a-z][a-z0-9-]*$');
  if (RESERVED_KIND_IDS.has(id)) fail(id, '', `"${id}" is reserved for the deploy queue`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(id, '', 'must be an object');
  const base = BUILT_IN_KINDS[id] || {};
  const merged = { ...base, ...raw, statuses: { ...base.statuses, ...raw.statuses }, copy: { ...base.copy, ...raw.copy } };
  const label = nonEmptyString(id, 'label', merged.label);
  const pluralLabel = nonEmptyString(id, 'pluralLabel', merged.pluralLabel ?? `${label}s`);
  const kind = {
    id,
    label,
    pluralLabel,
    shortLabel: nonEmptyString(id, 'shortLabel', merged.shortLabel ?? pluralLabel),
    prefix: nonEmptyString(id, 'prefix', merged.prefix),
    route: nonEmptyString(id, 'route', merged.route ?? `${id}s`),
    planReview: bool(id, 'planReview', merged.planReview ?? false),
    deploys: bool(id, 'deploys', merged.deploys ?? true),
    runbook: nonEmptyString(id, 'runbook', merged.runbook ?? `.claude/commands/${id}-loop.md`),
    statuses: {
      initial: oneOf(id, 'statuses.initial', merged.statuses.initial ?? 'open', INITIAL_STATUSES),
      done: oneOf(id, 'statuses.done', merged.statuses.done ?? 'closed', DONE_STATUSES),
      declined: oneOf(id, 'statuses.declined', merged.statuses.declined ?? 'declined', DECLINED_STATUSES),
    },
    icon: oneOf(id, 'icon', merged.icon ?? 'check', ICONS),
    tone: oneOf(id, 'tone', merged.tone ?? 'blue', TONES),
  };
  if (!PREFIX_PATTERN.test(kind.prefix)) fail(id, 'prefix', 'must be uppercase letters/digits, e.g. "FR"');
  if (!ROUTE_PATTERN.test(kind.route) || RESERVED_ROUTES.has(kind.route)) fail(id, 'route', 'must be a lowercase slug that is not an admin page');
  kind.copy = {
    eyebrow: nonEmptyString(id, 'copy.eyebrow', merged.copy.eyebrow ?? 'Work queue'),
    adminDescription: nonEmptyString(id, 'copy.adminDescription', merged.copy.adminDescription ?? `Plan, assign, and complete ${pluralLabel.toLowerCase()}.`),
    collaboratorDescription: nonEmptyString(id, 'copy.collaboratorDescription', merged.copy.collaboratorDescription ?? `Submit ${pluralLabel.toLowerCase()} and follow their progress.`),
    createLabel: nonEmptyString(id, 'copy.createLabel', merged.copy.createLabel ?? label.toLowerCase()),
    statDetail: oneOf(id, 'copy.statDetail', merged.copy.statDetail ?? 'queued', STAT_DETAILS),
  };
  // Derived lifecycle facts. Active statuses are the claimable ones; a kind
  // without plan review never investigates, and one that never deploys never
  // waits in ready_for_deploy.
  kind.counterField = counterFieldFor(id);
  kind.activeStatuses = [
    kind.statuses.initial,
    ...(kind.planReview ? ['investigating', 'plan_review'] : []),
    'in_progress', 'blocked', 'in_review',
    ...(kind.deploys ? ['ready_for_deploy'] : []),
  ];
  kind.terminalStatuses = [kind.statuses.done, kind.statuses.declined];
  kind.completedAtField = kind.statuses.done === 'shipped' ? 'shippedAt' : 'resolvedAt';
  kind.completeCommand = kind.statuses.done === 'shipped' ? 'ship' : 'resolve';
  kind.gates = ALL_GATES.filter((gate) => (gate !== 'plan_review' || kind.planReview) && (gate !== 'deploy_approval' || kind.deploys));
  return Object.freeze(kind);
}

// Returns the configured kinds in config order. Throws on any invalid entry so a
// typo fails at load instead of silently hiding a queue.
function resolveWorkKinds(rawKinds) {
  const source = rawKinds === undefined ? BUILT_IN_KINDS : rawKinds;
  if (!source || typeof source !== 'object' || Array.isArray(source)) fail('', '', 'must be an object keyed by kind id');
  const kinds = Object.entries(source).map(([id, raw]) => resolveKind(id, raw));
  if (kinds.length === 0) fail('', '', 'must configure at least one kind');
  for (const field of ['prefix', 'route']) {
    const seen = new Map();
    for (const kind of kinds) {
      const value = kind[field].toLowerCase();
      if (seen.has(value)) fail(kind.id, field, `duplicates ${seen.get(value)}`);
      seen.set(value, kind.id);
    }
  }
  return Object.freeze(kinds);
}

let cachedKinds;
function loadWorkKinds(config) {
  if (config) return resolveWorkKinds(config.workKinds);
  cachedKinds ||= resolveWorkKinds(loadProjectConfig().workKinds);
  return cachedKinds;
}

function kindById(kinds, id) {
  return kinds.find((kind) => kind.id === id) || null;
}

function requireKind(kinds, id) {
  const kind = kindById(kinds, id);
  if (!kind) throw new Error(`Unknown work kind "${id}". Configured kinds: ${kinds.map((entry) => entry.id).join(', ')}`);
  return kind;
}

function itemReference(kinds, item) {
  const prefix = kindById(kinds, item?.kind)?.prefix || String(item?.kind || 'item').toUpperCase();
  return `${prefix}-${item?.number ?? '?'}`;
}

function kindForReference(kinds, reference) {
  const match = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(String(reference || '').trim());
  if (!match) return null;
  return kinds.find((kind) => kind.prefix.toLowerCase() === match[1].toLowerCase()) || null;
}

function queueNames(kinds) {
  return [...kinds.map((kind) => kind.id), 'deploy'];
}

// ---- Generated rule blocks -------------------------------------------------
// Security rules cannot read JSON config, so the allowed kinds are rendered into
// a marked block in firestore.rules and storage.rules. `sync` rewrites them and
// scripts/test/work-kinds.test.js fails when they drift from the config.

function quote(value) { return `'${value}'`; }

function renderFirestoreRulesBlock(kinds) {
  const map = (field) => `{${kinds.map((kind) => `${quote(kind.id)}: ${quote(field(kind))}`).join(', ')}}`;
  return [
    `    ${RULES_BEGIN}: run \`npm run sync:work-kinds\` after editing workKinds.`,
    '    function workKindInitialStatuses() {',
    `      return ${map((kind) => kind.statuses.initial)};`,
    '    }',
    '',
    '    function workKindCounterFields() {',
    `      return ${map((kind) => kind.counterField)};`,
    '    }',
    '',
    '    function collaboratorCounterAdvanceIsValid() {',
    `      return ${kinds.map((kind) => `counterAdvancedByOne(${quote(kind.counterField)})`).join('\n        || ')};`,
    '    }',
    `    ${RULES_END}`,
  ].join('\n');
}

function renderStorageRulesBlock(kinds) {
  return [
    `    ${RULES_BEGIN}: run \`npm run sync:work-kinds\` after editing workKinds.`,
    '    function isWorkItemKind(kind) {',
    `      return kind in [${kinds.map((kind) => quote(kind.id)).join(', ')}];`,
    '    }',
    `    ${RULES_END}`,
  ].join('\n');
}

function replaceGeneratedBlock(text, block, file) {
  const start = text.indexOf(RULES_BEGIN);
  const end = text.indexOf(RULES_END);
  if (start === -1 || end === -1 || end < start) throw new Error(`${file} is missing the ${RULES_BEGIN} / ${RULES_END} markers`);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const lineEnd = text.indexOf('\n', end);
  return `${text.slice(0, lineStart)}${block}${lineEnd === -1 ? '' : text.slice(lineEnd)}`;
}

function jsonText(value) { return `${JSON.stringify(value, null, 2)}\n`; }

// Every file derived from workKinds, as [relative path, current text => next text].
function derivedFiles(kinds) {
  return [
    ['firestore.rules', (text, file) => replaceGeneratedBlock(text, renderFirestoreRulesBlock(kinds), file)],
    ['storage.rules', (text, file) => replaceGeneratedBlock(text, renderStorageRulesBlock(kinds), file)],
    ['extras/functions/project-config.json', (text) => jsonText({
      ...JSON.parse(text),
      workKinds: Object.fromEntries(kinds.map((kind) => [kind.id, { label: kind.label, prefix: kind.prefix, route: kind.route }])),
    })],
    ['extras/native-ios/ProjectAdminConfig.json', (text) => jsonText({
      ...JSON.parse(text),
      workItemRoutes: Object.fromEntries(kinds.map((kind) => [kind.route, kind.prefix])),
    })],
  ];
}

// Rewrites (or with write=false, only reports) every derived file that differs
// from the configured kinds. Missing optional surfaces (an install without
// extras/) are skipped.
function syncDerivedFiles({ root = ROOT, kinds = loadWorkKinds(), write = true } = {}) {
  const changed = [];
  for (const [relative, transform] of derivedFiles(kinds)) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) continue;
    const current = fs.readFileSync(file, 'utf8');
    const next = transform(current, relative);
    if (next === current) continue;
    changed.push(relative);
    if (write) fs.writeFileSync(file, next);
  }
  return changed;
}

function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  if (command === 'queues') {
    // run-loop.sh validates its queue argument against this list.
    console.log(queueNames(loadWorkKinds()).join('\n'));
  } else if (command === 'list') {
    console.log(JSON.stringify(loadWorkKinds(), null, 2));
  } else if (command === 'sync') {
    const changed = syncDerivedFiles();
    console.log(changed.length ? `Updated ${changed.join(', ')}` : 'Work-kind derived files are in sync.');
  } else if (command === 'check') {
    const stale = syncDerivedFiles({ write: false });
    if (stale.length) {
      console.error(`Out of sync with workKinds: ${stale.join(', ')}. Run npm run sync:work-kinds.`);
      process.exitCode = 1;
    }
  } else {
    console.error('Usage: work-kinds.js <queues|list|sync|check>');
    process.exitCode = 2;
  }
}

module.exports = {
  ALL_GATES,
  LEGACY_COLLECTIONS,
  WORK_ITEMS_COLLECTION,
  counterFieldFor,
  itemReference,
  kindById,
  kindForReference,
  loadWorkKinds,
  queueNames,
  renderFirestoreRulesBlock,
  renderStorageRulesBlock,
  requireKind,
  resolveWorkKinds,
  syncDerivedFiles,
};

if (require.main === module) main();
