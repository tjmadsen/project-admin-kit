#!/usr/bin/env node
'use strict';

// Install this kit next to an existing product repository without publishing
// or downloading anything (docs/LAYOUTS.md):
//
//   node scripts/install-into.js <product-repo> [--mode embedded|separate] [--dir <path>] [--with-extras]
//
//   embedded (default)  copy the kit into <product-repo>/<dir> (default ops) with
//                       layout.productRoot pointing back at the repository root
//   separate            copy the kit to <dir> (default <product-repo>-admin, a
//                       sibling; relative to the current directory) as its own
//                       repository with layout.productRoot pointing at the product
//
// node_modules, .git, the generated admin bundle, and (without --with-extras)
// extras/ are left out. The copy gets a .project-admin/kit-lock.json so
// `npm run kit:upgrade` can later 3-way merge upstream fixes into it.

const fs = require('node:fs');
const path = require('node:path');
const { git, installKit, isGitWorkTree } = require('./lib/kit-files');

const KIT_ROOT = path.resolve(__dirname, '..');
const USAGE = 'Usage: node scripts/install-into.js <product-repo> [--mode embedded|separate] [--dir <path>] [--with-extras] [--source <git-url>]';

function parseArgs(argv) {
  const options = { mode: 'embedded', withExtras: false };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--with-extras') options.withExtras = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--mode', '--dir', '--source'].includes(arg)) {
      if (argv[index + 1] === undefined) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++index];
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else positional.push(arg);
  }
  if (!options.help && positional.length !== 1) throw new Error(USAGE);
  if (!['embedded', 'separate'].includes(options.mode)) throw new Error('--mode must be embedded or separate');
  options.product = positional[0];
  return options;
}

// Loops create .agent-worktrees/ at the product root; keep it out of commits.
function ignoreAgentWorktrees(product) {
  const file = path.join(product, '.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/^\/?\.agent-worktrees\/?$/m.test(current)) return false;
  fs.writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Project Admin agent worktrees (docs/LAYOUTS.md)\n.agent-worktrees/\n`);
  return true;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const product = path.resolve(options.product);
  if (!fs.existsSync(product) || !fs.statSync(product).isDirectory()) throw new Error(`No such product repository: ${product}`);
  const productReal = fs.realpathSync(product);
  const productIsGit = isGitWorkTree(productReal);
  const productTop = productIsGit ? fs.realpathSync(git(productReal, ['rev-parse', '--show-toplevel']).trim()) : productReal;

  const dest = options.mode === 'embedded'
    ? path.resolve(productTop, options.dir || 'ops')
    : path.resolve(options.dir || `${productTop}-admin`);
  const relativeToProduct = path.relative(productTop, dest);
  const inside = relativeToProduct && !relativeToProduct.startsWith('..') && !path.isAbsolute(relativeToProduct);
  if (options.mode === 'embedded' && !inside) throw new Error(`--dir must be a subdirectory of ${productTop} for an embedded install`);
  if (options.mode === 'separate' && (inside || relativeToProduct === '')) throw new Error('--dir must be outside the product repository for a separate install');

  fs.mkdirSync(dest, { recursive: true });
  // layout.productRoot is relative to the kit directory, so the pair can be
  // cloned anywhere as long as they keep their relative position.
  const productRoot = path.relative(fs.realpathSync(dest), productTop).split(path.sep).join('/');
  const { files, lock } = installKit(KIT_ROOT, dest, { withExtras: options.withExtras, productRoot, source: options.source });
  const ignored = ignoreAgentWorktrees(productTop);

  console.log(`Installed Project Admin Kit ${lock.kitVersion} (${files.length} files, ${options.mode} layout${options.withExtras ? ', with extras' : ''}) into ${dest}`);
  console.log(`layout.productRoot = "${productRoot}" -> ${productTop}`);
  if (ignored) console.log(`Added .agent-worktrees/ to ${path.join(productTop, '.gitignore')}`);
  if (!productIsGit) console.log(`Warning: ${productTop} is not a git repository yet; agent loops need one with an origin remote.`);
  console.log('\nNext steps:');
  const relativeDest = path.relative(process.cwd(), dest);
  console.log(`  cd ${!relativeDest ? '.' : relativeDest.startsWith('..') ? dest : relativeDest}`);
  console.log('  npm run configure -- --name "<Product>" --repo <owner>/<product-repo> --owner-email <you@example.com> [--backend local|github ...]');
  console.log('  npm run install:all && npm test');
  if (options.mode === 'embedded') {
    console.log(`  git -C ${productTop} add ${path.relative(productTop, dest)} .gitignore   # commit the kit into the product repository`);
    console.log(`  Claude Code slash commands live in ${path.relative(productTop, dest)}/.claude/commands; link them into ${productTop}/.claude/commands to use them there.`);
  } else {
    console.log(`  git init && git add -A && git commit -m "Add Project Admin Kit"   # the kit is its own repository`);
  }
  console.log('See docs/LAYOUTS.md in the kit for hosting the admin bundle in each layout.');
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
