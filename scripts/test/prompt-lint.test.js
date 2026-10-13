'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDeployTargets, resolveDeployTargets } = require('../lib/deploy-targets');
const { loadWorkKinds } = require('../lib/work-kinds');

const repoRoot = path.resolve(__dirname, '..', '..');
// Every configured work kind has a loop prompt shim and a canonical runbook.
const kinds = loadWorkKinds();
const promptFor = (kind) => `scripts/agent-loops/${kind.id}-loop-prompt.md`;
const buildRunbooks = kinds.map((kind) => kind.runbook);
const releaseRunbooks = kinds.filter((kind) => kind.deploys).map((kind) => kind.runbook);

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// A deploy-target runbook names its preconditions, a time-bounded command
// block, the live proof to capture, and its known failures.
function assertTargetRunbook(relativePath, target) {
  const runbook = read(relativePath);
  assert.match(runbook, new RegExp('^# Target: `' + target + '`$', 'm'), `${relativePath} must open with its target heading`);
  assert.match(runbook, /Preconditions:/i, `${target} must name its preconditions`);
  assert.match(runbook, /```bash[\s\S]*?gtimeout/, `${target} must provide a time-bounded command block`);
  assert.match(runbook, /proof/i, `${target} must define live proof`);
  assert.match(runbook, /Known failure/i, `${target} must list known failures`);
}

test('every configured and built-in deploy target has a complete runbook', () => {
  const targets = [...loadDeployTargets(), ...resolveDeployTargets(undefined)];
  for (const target of targets) {
    assert.ok(fs.existsSync(path.join(repoRoot, target.runbook)), `${target.id} runbook ${target.runbook} must exist`);
    assertTargetRunbook(target.runbook, target.id);
  }
  // Example targets ship as documentation and must stay just as complete.
  const examples = path.join(repoRoot, 'docs/deploy-targets/examples');
  for (const file of fs.readdirSync(examples).filter((name) => name.endsWith('.md'))) {
    assertTargetRunbook(`docs/deploy-targets/examples/${file}`, path.basename(file, '.md'));
  }
});

test('the deploy runbook is generic and reads each approved target\'s runbook from config', () => {
  const runbook = read('.claude/commands/deploy-loop.md');
  assert.doesNotMatch(runbook, /^## Target:/m, 'per-target procedures live in their runbook files');
  assert.match(runbook, /node scripts\/lib\/deploy-targets\.js show/);
  assert.match(runbook, /deployments\.targets/);
  assert.match(runbook, /requiresHumanAcceptance/);
});

test('agent-loop prompts delegate to their canonical command files', () => {
  const entries = [
    ['scripts/agent-loops/deploy-loop-prompt.md', '.claude/commands/deploy-loop.md'],
    ...kinds.map((kind) => [promptFor(kind), kind.runbook]),
  ];

  for (const [promptPath, canonicalPath] of entries) {
    const prompt = read(promptPath);
    assert.match(prompt, new RegExp(canonicalPath.replaceAll('.', '\\.')));
    assert.ok(fs.existsSync(path.join(repoRoot, canonicalPath)), `${canonicalPath} must exist`);
  }
});

test('deploy instructions define the headless authorization and open handback contract', () => {
  for (const relativePath of [
    'scripts/agent-loops/deploy-loop-prompt.md',
    '.claude/commands/deploy-loop.md',
  ]) {
    const instructions = read(relativePath);
    assert.match(instructions, /you are headless/i, `${relativePath} must identify the worker as headless`);
    assert.match(instructions, /Firestore item thread is the only human channel/i);
    assert.match(instructions, /action-time\s+confirmation/i);
    assert.match(instructions, /Never re-ask for an already approved named action/i);
    assert.match(instructions, /what\s+is done, what remains, and concrete A\/B options/i);
    assert.match(instructions, /Always leave\s+the\s+item\s+in\s+a clear/i);
    assert.doesNotMatch(instructions, /Ask only for/i);
  }
});

test('every work-kind loop explains its only headless human channel', () => {
  for (const relativePath of [...kinds.map(promptFor), ...buildRunbooks]) {
    const instructions = read(relativePath);
    assert.match(instructions, /You are headless/i);
    assert.match(instructions, /Firestore item thread is the only human channel/i);
    assert.match(instructions, /prose question/i);
    assert.match(instructions, /`ask`/i);
  }
});

test('every build runbook carries the worktree pre-flight, branch reuse, and note throttle', () => {
  for (const runbook of buildRunbooks) {
    const text = read(runbook);
    assert.match(
      text,
      /scripts\/agent-loops\/provision-worktree\.sh \.agent-worktrees\//,
      `${runbook} must provision the worktree after git worktree add`
    );
    assert.match(text, /git worktree add \.agent-worktrees\//, `${runbook} must create the worktree explicitly`);
    assert.match(text, /auth\.env[\s\S]{0,80}node_modules/, `${runbook} must say what a fresh checkout is missing`);
    assert.match(
      text,
      /`branchName` is the durable cross-agent, cross-machine handle/,
      `${runbook} must state the branch-reuse doctrine`
    );
    assert.match(text, /Never recreate a branch/, `${runbook} must forbid recreating a recorded branch`);
    assert.match(text, /at most once\s+per ~20 minutes/, `${runbook} must bound progress notes to an interval`);
    assert.match(text, /material progress/, `${runbook} must limit notes to material progress`);
    assert.match(text, /lettered options/, `${runbook} must require concrete options when asking`);
    assert.match(text, /state (?:the owner|an administrator) can read at a glance/i, `${runbook} must state the clear-state invariant`);
  }
});

test('release handoffs use durable PR scope and preserve approval for mechanical conflict repair', () => {
  for (const runbook of releaseRunbooks) {
    const instructions = read(runbook);
    const releaseSection = instructions.slice(instructions.indexOf('deploy-pending'));
    assert.match(releaseSection, /PR number, recorded branch, approved targets\/surfaces/);
    assert.match(releaseSection, /Never make the grant conditional on the PR head equaling\s+a fixed SHA/i);
    assert.doesNotMatch(releaseSection, /headRefOid\s+equals|head SHA\s+to equal/i);
    assert.match(instructions, /set <id> --as <agent>[\s\S]{0,120}--status ready_for_deploy --waiting deployer --gate none/);
    assert.match(instructions, /git rev-list --no-merges <reviewed-head>\.\.HEAD --not origin\/\$DEFAULT_BRANCH/);
    assert.match(instructions, /If (?:resolving the\s+conflict|resolution) changes[\s\S]{0,220}(?:normal `pr` review|normal PR review)/i);
  }

  const deploy = read('.claude/commands/deploy-loop.md');
  assert.match(deploy, /set "\$ITEM_ID" --as "\$AGENT"[\s\S]{0,120}--status in_progress --waiting agent --gate none/);
  assert.match(deploy, /git range-diff/);
  assert.match(deploy, /git rev-list --no-merges[\s\S]{0,120}--not "?origin\/\$DEFAULT_BRANCH"?/);
  assert.match(deploy, /git show --cc --stat/);
  assert.match(deploy, /head SHA is audit evidence, not immutable release scope/i);
  assert.match(read('docs/deploy-targets/none.md'), /item-specific focused tests from\s+the merged deploy worktree/i);
});

test('AGENTS.md carries the runnable test matrix and CLAUDE.md defers to it', () => {
  const agents = read('AGENTS.md');
  for (const command of [
    'cd admin-app && npm test',
    'cd functions && npm test',
    'cd scripts && npm test',
    'firebase emulators:exec --only firestore,storage',
    'node scripts/work-agent.js --kind feature count --as terra',
  ]) {
    assert.ok(agents.includes(command), `AGENTS.md test matrix must list \`${command}\``);
  }
  assert.match(agents, /\| Suite \| Command \| Expect \|/, 'the matrix must be a table');
  assert.match(agents, /provision-worktree\.sh/, 'AGENTS.md must point at worktree provisioning');
  assert.match(agents, /\/usr\/sbin\/scutil/, 'AGENTS.md must record the PATH gotcha behind simulator host detection');
  assert.match(agents, /Autonomous fixing/, 'AGENTS.md must state the autonomous-fixing disposition');
  assert.match(read('CLAUDE.md'), /`AGENTS\.md` is the source of truth for the loop conventions/);
});

test('runbooks for kinds that never deploy contain no release handoff', () => {
  for (const kind of kinds.filter((entry) => !entry.deploys)) {
    const runbook = read(kind.runbook);
    assert.doesNotMatch(runbook, /node scripts\/[\w-]+\.js deploy-pending/, `${kind.runbook} must not hand off to the deploy loop`);
    assert.match(runbook, /close-no-deploy/, `${kind.runbook} must close through close-no-deploy`);
  }
});
