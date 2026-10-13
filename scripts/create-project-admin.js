#!/usr/bin/env node
'use strict';

// Scaffold a new project from this kit (docs/UPGRADING.md):
//
//   node scripts/create-project-admin.js <dir> [--no-extras] [--no-git] [--source <git-url>] [configure flags...]
//   npx github:<owner>/<repo> <dir> [...]        (the package's `bin`; nothing is published)
//
// Copies the kit into a new directory (without node_modules, .git, or the
// generated admin bundle), records .project-admin/kit-lock.json so
// `npm run kit:upgrade` can merge later upstream fixes, runs `git init`, and
// runs `npm run configure` with every flag it does not recognize itself.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installKit } = require('./lib/kit-files');

const KIT_ROOT = path.resolve(__dirname, '..');
const USAGE = 'Usage: create-project-admin <dir> [--no-extras] [--no-git] [--source <git-url>] [configure flags, e.g. --name "My App" --backend local --owner-email you@example.com]';

function parseArgs(argv) {
  const options = { withExtras: true, git: true, configure: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-extras') options.withExtras = false;
    else if (arg === '--no-git') options.git = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--source') options.source = argv[++index];
    else if (!arg.startsWith('--') && options.dir === undefined) options.dir = arg;
    else options.configure.push(arg);
  }
  if (!options.help && !options.dir) throw new Error(USAGE);
  return options;
}

function main(argv = process.argv.slice(2), log = console.log) {
  const options = parseArgs(argv);
  if (options.help) { log(USAGE); return 0; }
  const dest = path.resolve(options.dir);
  fs.mkdirSync(dest, { recursive: true });
  const { files, lock } = installKit(KIT_ROOT, dest, { withExtras: options.withExtras, source: options.source });
  log(`Copied Project Admin Kit ${lock.kitVersion} (${files.length} files${options.withExtras ? '' : ', without extras'}) to ${dest}`);

  if (options.git && !fs.existsSync(path.join(dest, '.git'))) {
    const init = spawnSync('git', ['init', '--quiet', '-b', 'main', dest], { encoding: 'utf8' });
    if (init.status === 0) log('Initialized a git repository (branch main); nothing is committed yet.');
    else log(`git init failed (${init.stderr.trim()}); run it yourself.`);
  }

  // configure.js resolves the config from its own directory; a stray
  // PROJECT_ADMIN_CONFIG would point it somewhere else.
  const { PROJECT_ADMIN_CONFIG, PROJECT_ADMIN_PRODUCT_ROOT, ...env } = process.env;
  const configure = spawnSync(process.execPath, [path.join(dest, 'scripts/configure.js'), ...options.configure], { cwd: dest, env, encoding: 'utf8' });
  if (configure.stdout) log(configure.stdout.trim());
  if (configure.status !== 0) {
    console.error(configure.stderr.trim());
    console.error(`The kit was copied, but configure failed. Fix the flags and run \`npm run configure -- ...\` in ${dest}.`);
    return 1;
  }
  log(`\nNext: cd ${options.dir} && npm run install:all${options.withExtras ? ' (and npm run install:extras)' : ''}, then npm test.`);
  log('Pull later kit fixes with: npm run kit:upgrade -- --from <kit git URL or path> [--ref <tag>] (docs/UPGRADING.md).');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = { main, parseArgs };
