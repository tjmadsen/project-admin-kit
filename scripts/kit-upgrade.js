#!/usr/bin/env node
'use strict';

// Pull upstream kit fixes into a project without publishing anything
// (docs/UPGRADING.md):
//
//   npm run kit:upgrade -- --from <git-url-or-path> [--ref <tag|branch|sha>] [--dry-run] [--allow-dirty]
//
// The upstream kit is cloned at --ref into a temporary directory (a local path
// without --ref is read in place, uncommitted files included). Every
// kit-owned file (kit-manifest.json) is then compared three ways: the base
// recorded in .project-admin/kit-lock.json, this project's copy, and upstream.
//
//   unchanged locally        take upstream (updated / added / removed)
//   unchanged upstream       keep the local edit
//   changed on both sides    `git merge-file`; overlapping edits are written
//                            with conflict markers, listed, and exit 1
//
// Project-owned files (config, .firebaserc, firebase.json, the machine roster,
// public/, README.md, ...) are never read or written. The lock is rewritten to
// the new upstream versions so the next upgrade merges from here. Works the
// same for an embedded or separate kit: paths are relative to the kit
// directory, wherever it sits (docs/LAYOUTS.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  LOCK, blobId, classifier, describeSource, git, isGitWorkTree, listKitFiles, readLock, readManifest, writeLock,
} = require('./lib/kit-files');

const USAGE = 'Usage: npm run kit:upgrade -- --from <git-url-or-path> [--ref <tag|branch|sha>] [--dry-run] [--allow-dirty]';

function parseArgs(argv) {
  const options = { dryRun: false, allowDirty: false, kit: path.resolve(__dirname, '..') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--from', '--ref', '--kit'].includes(arg)) {
      if (argv[index + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++index];
    } else throw new Error(`Unknown argument ${arg}\n${USAGE}`);
  }
  options.kit = path.resolve(options.kit);
  return options;
}

function isLocalPath(from) {
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(from) && !/^[^/]+@[^:]+:/.test(from) && fs.existsSync(from);
}

// Returns { root, objects, cleanup }: the upstream kit's files and a git
// repository whose object store can resolve the lock's base blob ids.
function fetchUpstream(from, ref) {
  if (isLocalPath(from) && !ref) {
    const root = path.resolve(from);
    return { root, objects: isGitWorkTree(root) ? root : null, cleanup() {} };
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-kit-upgrade-'));
  const root = path.join(temp, 'kit');
  const clone = spawnSync('git', ['clone', '--quiet', '--no-checkout', from, root], { encoding: 'utf8' });
  if (clone.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`Could not clone ${from}: ${clone.stderr.trim()}`);
  }
  const target = ref || 'HEAD';
  const checkout = spawnSync('git', ['-C', root, 'checkout', '--quiet', target], { encoding: 'utf8' });
  if (checkout.status !== 0) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw new Error(`Could not check out ${target} from ${from}: ${checkout.stderr.trim()}`);
  }
  return { root, objects: root, cleanup: () => fs.rmSync(temp, { recursive: true, force: true }) };
}

function readBlob(objects, id) {
  if (!objects || !id) return null;
  const result = spawnSync('git', ['-C', objects, 'cat-file', 'blob', id], { maxBuffer: 256 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : null;
}

const isBinary = (buffer) => buffer.includes(0);

// git merge-file: exit 0 clean, >0 conflict count, <0 (255) error.
function mergeText(ours, base, theirs) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-merge-'));
  try {
    const files = ['ours', 'base', 'theirs'].map((name) => path.join(temp, name));
    [ours, base, theirs].forEach((content, index) => fs.writeFileSync(files[index], content));
    const result = spawnSync('git', ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'upstream', ...files], { maxBuffer: 256 * 1024 * 1024 });
    if (result.status === null || result.status >= 128) throw new Error(`git merge-file failed: ${String(result.stderr).trim()}`);
    return { content: result.stdout, conflicts: result.status };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// One action per kit-owned path; nothing is written here.
function planUpgrade({ kitRoot, upstreamRoot, objects, lock, withExtras }) {
  const upstreamManifest = readManifest(upstreamRoot);
  const localManifest = fs.existsSync(path.join(kitRoot, 'kit-manifest.json')) ? readManifest(kitRoot) : null;
  const classify = classifier(upstreamManifest, localManifest);
  const upstreamFiles = listKitFiles(upstreamRoot, { withExtras, manifest: upstreamManifest }).filter((relative) => classify(relative) === 'kit');
  const base = lock?.files || {};
  const paths = [...new Set([...upstreamFiles, ...Object.keys(base)])].sort();
  const upstreamSet = new Set(upstreamFiles);
  const plan = [];
  for (const relative of paths) {
    if (classify(relative) === 'project') continue;
    if (!withExtras && relative.startsWith('extras/')) continue;
    const localFile = path.join(kitRoot, relative);
    const ours = fs.existsSync(localFile) ? fs.readFileSync(localFile) : null;
    const theirs = upstreamSet.has(relative) ? fs.readFileSync(path.join(upstreamRoot, relative)) : null;
    const baseId = base[relative] || null;
    const oursId = ours && blobId(ours);
    const theirsId = theirs && blobId(theirs);
    const mode = theirs ? fs.statSync(path.join(upstreamRoot, relative)).mode & 0o777 : null;
    const entry = { path: relative, theirsId, mode };

    if (!theirs) {
      if (!ours) continue;
      if (lock && oursId === baseId) plan.push({ ...entry, action: 'remove' });
      else plan.push({ ...entry, action: 'keep-removed-upstream', note: 'removed upstream; kept because it differs from the recorded base' });
      continue;
    }
    if (!ours) {
      if (!baseId) plan.push({ ...entry, action: 'add', content: theirs });
      else if (baseId === theirsId) plan.push({ ...entry, action: 'skip-deleted', note: 'deleted locally; unchanged upstream' });
      else plan.push({ ...entry, action: 'conflict', note: 'deleted locally but changed upstream; restore it from upstream or keep it deleted', content: null });
      continue;
    }
    if (oursId === theirsId) { plan.push({ ...entry, action: 'unchanged' }); continue; }
    if (baseId && oursId === baseId) { plan.push({ ...entry, action: 'update', content: theirs }); continue; }
    if (baseId && theirsId === baseId) { plan.push({ ...entry, action: 'keep-local' }); continue; }

    // Changed on both sides (or no recorded base): a three-way merge.
    const baseContent = readBlob(objects, baseId);
    if (isBinary(ours) || isBinary(theirs) || (baseContent && isBinary(baseContent))) {
      plan.push({ ...entry, action: 'conflict', note: `binary file changed on both sides; upstream copy written to ${relative}.upstream`, sidecar: theirs });
      continue;
    }
    const { content, conflicts } = mergeText(ours, baseContent || Buffer.alloc(0), theirs);
    if (conflicts === 0) plan.push({ ...entry, action: 'merge', content });
    else {
      const why = !baseId ? 'no recorded base (no kit-lock entry)' : !baseContent ? `base ${baseId.slice(0, 12)} not found upstream` : `${conflicts} conflicting hunk${conflicts === 1 ? '' : 's'}`;
      plan.push({ ...entry, action: 'conflict', note: `${why}; resolve the markers`, content });
    }
  }
  return { plan, upstreamFiles, upstreamManifest };
}

function applyPlan(kitRoot, plan) {
  for (const entry of plan) {
    const file = path.join(kitRoot, entry.path);
    if (entry.action === 'remove') fs.rmSync(file, { force: true });
    if (['add', 'update', 'merge', 'conflict'].includes(entry.action) && entry.content) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, entry.content);
      if (entry.mode) fs.chmodSync(file, entry.mode);
    }
    if (entry.sidecar) fs.writeFileSync(`${file}.upstream`, entry.sidecar);
  }
}

const LABELS = {
  add: 'added', update: 'updated', merge: 'merged', remove: 'removed', conflict: 'CONFLICT',
  'keep-local': 'kept local edit', 'keep-removed-upstream': 'kept', 'skip-deleted': 'left deleted',
};

function main(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv);
  if (options.help) { log(USAGE); return 0; }
  const kitRoot = options.kit;
  readManifest(kitRoot); // fail early outside a kit
  const lock = readLock(kitRoot);
  const from = options.from || lock?.source;
  if (!from) throw new Error(`--from is required (no source recorded in ${LOCK})\n${USAGE}`);
  if (!options.dryRun && !options.allowDirty && isGitWorkTree(kitRoot)) {
    const dirty = git(kitRoot, ['status', '--porcelain', '--', '.']).trim();
    if (dirty) throw new Error(`${kitRoot} has uncommitted changes; commit or stash them first (or pass --allow-dirty):\n${dirty}`);
  }
  if (!lock) log(`Warning: no ${LOCK}; every kit file that differs from upstream is treated as a conflict.`);
  const withExtras = lock?.withExtras ?? fs.existsSync(path.join(kitRoot, 'extras'));

  const upstream = fetchUpstream(from, options.ref);
  try {
    const { plan, upstreamFiles, upstreamManifest } = planUpgrade({ kitRoot, upstreamRoot: upstream.root, objects: upstream.objects, lock, withExtras });
    const fromVersion = lock?.kitVersion || readManifest(kitRoot).version || 'unknown';
    log(`${options.dryRun ? 'Dry run: ' : ''}Project Admin Kit ${fromVersion} -> ${upstreamManifest.version} from ${from}${options.ref ? ` (${options.ref})` : ''}`);
    const changes = plan.filter((entry) => entry.action !== 'unchanged');
    for (const entry of changes) log(`  ${LABELS[entry.action].padEnd(15)} ${entry.path}${entry.note ? `  (${entry.note})` : ''}`);
    const count = (action) => plan.filter((entry) => entry.action === action).length;
    log(`${count('unchanged')} unchanged, ${count('add')} added, ${count('update')} updated, ${count('merge')} merged, ${count('remove')} removed, ${count('conflict')} conflicts.`);
    const conflicts = plan.filter((entry) => entry.action === 'conflict');
    if (options.dryRun) {
      log('Nothing was written.');
      return 0;
    }
    applyPlan(kitRoot, plan);
    const files = {};
    for (const relative of upstreamFiles) files[relative] = blobId(fs.readFileSync(path.join(upstream.root, relative)));
    writeLock(kitRoot, {
      $comment: 'Written by the kit installer/scaffolder/upgrader; the base for the next 3-way `npm run kit:upgrade`. Commit it; do not edit by hand.',
      kitVersion: upstreamManifest.version,
      ...describeSource(upstream.root, { source: from, ref: options.ref }),
      withExtras,
      updatedAt: new Date().toISOString(),
      files,
    });
    if (conflicts.length) {
      log(`\n${conflicts.length} file${conflicts.length === 1 ? '' : 's'} need${conflicts.length === 1 ? 's' : ''} manual resolution:`);
      for (const entry of conflicts) log(`  ${entry.path}`);
      log('Resolve the <<<<<<< local / >>>>>>> upstream markers, then run the checks below.');
    }
    log('\nNext: npm run sync:work-kinds, npm run install:all, the test matrix in AGENTS.md, and review `git diff` before committing.');
    return conflicts.length ? 1 : 0;
  } finally {
    upstream.cleanup();
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { main, parseArgs, planUpgrade };
