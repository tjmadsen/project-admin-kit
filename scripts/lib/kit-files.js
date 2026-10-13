'use strict';

// Shared by scripts/install-into.js, scripts/create-project-admin.js, and
// scripts/kit-upgrade.js: which files make up a kit (kit-manifest.json), how to
// copy them, and the lock that records the upstream version each kit-owned
// file came from (docs/UPGRADING.md).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANIFEST = 'kit-manifest.json';
const LOCK = '.project-admin/kit-lock.json';

// A small glob: `**` spans directories, `*` and `?` stay within one segment.
function globToRegExp(glob) {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function matcher(globs = []) {
  const patterns = globs.map(globToRegExp);
  return (relative) => patterns.some((pattern) => pattern.test(relative));
}

function readManifest(root) {
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing; is ${root} a Project Admin kit?`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// The generated admin bundle lives at public/<adminPath>; it is rebuilt, never
// copied or merged.
function generatedPaths(root) {
  const paths = ['public/admin/**'];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'project-admin.config.json'), 'utf8'));
    const adminPath = String(config.project?.adminPath || '').replace(/^\/+|\/+$/g, '');
    if (adminPath) paths.push(`public/${adminPath}/**`);
  } catch {
    // No readable config: only the default bundle path is excluded.
  }
  return paths;
}

// classify(relative) -> 'project' | 'kit' | null, from one or more manifests
// (the upstream's plus the local one, so a project can claim extra paths).
function classifier(...manifests) {
  const project = matcher(manifests.flatMap((manifest) => manifest?.projectOwned || []));
  const kit = matcher(manifests.flatMap((manifest) => manifest?.kitOwned || []));
  return (relative) => (project(relative) ? 'project' : kit(relative) ? 'kit' : null);
}

function git(cwd, args, options = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: options.encoding ?? 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    if (options.allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function isGitWorkTree(dir) {
  return git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true })?.trim() === 'true';
}

function walk(root, relative = '', out = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    if (entry.isDirectory()) walk(root, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

// Every file of the kit at `root` (tracked or untracked-but-not-ignored when it
// is a git checkout, otherwise a directory walk), minus excluded and generated
// paths and, unless withExtras, extras/.
function listKitFiles(root, { withExtras = true, manifest = readManifest(root) } = {}) {
  const listed = isGitWorkTree(root)
    ? git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']).split('\0').filter(Boolean)
    : walk(root);
  const excluded = matcher([...(manifest.exclude || []), ...generatedPaths(root), ...(withExtras ? [] : ['extras/**'])]);
  return [...new Set(listed)]
    .filter((relative) => !excluded(relative))
    // Regular files only: deleted-but-tracked paths and symlinks are skipped.
    .filter((relative) => fs.lstatSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile())
    .sort();
}

// Git's blob id, so a lock entry can be read back from any clone of the
// upstream repository with `git cat-file blob <id>`.
function blobId(content) {
  return crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

function copyFile(sourceRoot, destRoot, relative) {
  const source = path.join(sourceRoot, relative);
  const dest = path.join(destRoot, relative);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, fs.statSync(source).mode & 0o777);
}

// Where a kit came from: a git URL/path plus commit, or a plain directory.
function describeSource(root, { source, ref } = {}) {
  const commit = isGitWorkTree(root) ? git(root, ['rev-parse', 'HEAD'], { allowFailure: true })?.trim() || null : null;
  const origin = isGitWorkTree(root) ? git(root, ['remote', 'get-url', 'origin'], { allowFailure: true })?.trim() : null;
  return { source: source || origin || root, ref: ref || null, commit };
}

function lockEntries(root, files, classify) {
  const entries = {};
  for (const relative of files) {
    if (classify(relative) !== 'kit') continue;
    entries[relative] = blobId(fs.readFileSync(path.join(root, relative)));
  }
  return entries;
}

function writeLock(kitRoot, lock) {
  const file = path.join(kitRoot, LOCK);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`);
  return file;
}

function readLock(kitRoot) {
  const file = path.join(kitRoot, LOCK);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// Build a lock describing `files` of `sourceRoot` as the base for the next
// upgrade of the kit at `kitRoot`.
function lockFor(sourceRoot, files, { source, ref, withExtras, now = new Date() } = {}) {
  const manifest = readManifest(sourceRoot);
  return {
    $comment: 'Written by the kit installer/scaffolder/upgrader; the base for the next 3-way `npm run kit:upgrade`. Commit it; do not edit by hand.',
    kitVersion: manifest.version,
    ...describeSource(sourceRoot, { source, ref }),
    withExtras: Boolean(withExtras),
    updatedAt: now.toISOString(),
    files: lockEntries(sourceRoot, files, classifier(manifest)),
  };
}

// Copy this kit's files into an empty `dest`, point its config at the product
// (layout.productRoot, omitted for the default "."), drop the Functions entry
// from firebase.json when extras are left out, and write the lock.
function installKit(sourceRoot, dest, { withExtras = true, productRoot = '.', source, ref } = {}) {
  if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) throw new Error(`${dest} already exists and is not empty`);
  const files = listKitFiles(sourceRoot, { withExtras });
  for (const relative of files) copyFile(sourceRoot, dest, relative);

  const configFile = path.join(dest, 'project-admin.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (productRoot === '.') delete config.layout;
  else config.layout = { productRoot };
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  const firebaseFile = path.join(dest, 'firebase.json');
  if (!withExtras && fs.existsSync(firebaseFile)) {
    const firebase = JSON.parse(fs.readFileSync(firebaseFile, 'utf8'));
    delete firebase.functions;
    fs.writeFileSync(firebaseFile, `${JSON.stringify(firebase, null, 2)}\n`);
  }
  const lock = lockFor(sourceRoot, files, { source, ref, withExtras });
  writeLock(dest, lock);
  return { files, lock };
}

module.exports = {
  LOCK,
  MANIFEST,
  blobId,
  classifier,
  copyFile,
  describeSource,
  git,
  globToRegExp,
  installKit,
  isGitWorkTree,
  listKitFiles,
  lockFor,
  matcher,
  readLock,
  readManifest,
  writeLock,
};
