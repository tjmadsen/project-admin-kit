'use strict';

// Behavioral coverage for the launchd-facing loop scripts. Each test builds a
// throwaway repository, stubs the CLIs run-loop.sh shells out to, runs the real
// script, and asserts on what the stubs recorded — so the composed command line
// (stdin handling, per-queue timeout and background-wait ceiling) is checked as
// executed rather than as source text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const AGENT_LOOPS = path.join(__dirname, '..');
const REPO = path.join(AGENT_LOOPS, '..', '..');
const REAL_NODE = process.execPath;
// What run-loop.sh and loop-wrapper.sh need to resolve agents from config.
const ROSTER_FILES = [
  'project-admin.config.json',
  'scripts/lib/agents.js',
  'scripts/lib/agent-roster.js',
  'scripts/lib/agent-defaults.json',
  'scripts/lib/project-config.js',
  'scripts/lib/work-kinds.js',
  'scripts/lib/work-kinds.defaults.json',
  'scripts/lib/deploy-targets.js',
  'scripts/lib/deploy-targets.defaults.json',
];

function copyRosterFiles(root) {
  for (const relative of ROSTER_FILES) write(path.join(root, relative), fs.readFileSync(path.join(REPO, relative)));
}

// A project config whose `agents` replace the built-in roster.
function writeConfig(root, agents, extra = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8'));
  delete config.agentAliases;
  const file = path.join(root, 'custom.config.json');
  write(file, JSON.stringify({ ...config, agents, ...extra }));
  return file;
}

function write(file, contents, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode ? { mode } : undefined);
}

// A checkout with just the pieces run-loop.sh touches, plus stub binaries on a
// private PATH that record how they were invoked.
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-run-loop-'));
  const record = path.join(root, 'record.txt');
  const bin = path.join(root, 'bin');

  for (const script of ['run-loop.sh', 'classify-run-result.js', 'confirmation-handoff.js', 'run-claims.js', 'headless-guard.py',
    'runners/claude.sh', 'runners/codex.sh', 'runners/grok.sh', 'runners/command.sh']) {
    write(path.join(root, 'scripts/agent-loops', script), fs.readFileSync(path.join(AGENT_LOOPS, script)), 0o755);
  }
  copyRosterFiles(root);
  for (const queue of ['feature', 'bug', 'deploy']) {
    write(path.join(root, `scripts/agent-loops/${queue}-loop-prompt.md`), `${queue} prompt for {{AGENT}}\n`);
  }

  // node: forward `-e` snippets and the pure classifier to the real binary,
  // answer the Firestore-backed CLIs from canned JSON.
  write(path.join(bin, 'node'), `#!/usr/bin/env bash
if [[ "\${1:-}" == "-e" ]]; then exec ${REAL_NODE} "$@"; fi
name="$(basename "\${1:-}")"
case "$name" in
  classify-run-result.js|agents.js|work-kinds.js) exec ${REAL_NODE} "$@" ;;
  log-run.js)
    echo "LOG_RUN_ARGV: $*" >> ${record}
    case "\${2:-}" in
      start) echo run-test-1 ;;
      handoff-status) echo ok ;;
      configured-agent) echo sonnet ;;
      *) : ;;
    esac ;;
  feature-agent.js|bug-agent.js|work-agent.js) echo '{"count":1,"topThinkingEffort":"medium"}' ;;
  *) : ;;
esac
`, 0o755);

  // timeout: record the wall it was given, then run the real command.
  write(path.join(bin, 'timeout'), `#!/usr/bin/env bash
echo "TIMEOUT_ARGS: $*" >> ${record}
shift 3
exec "$@"
`, 0o755);

  write(path.join(bin, 'codex'), `#!/usr/bin/env bash
{ echo "CODEX_ARGV: $*"; echo "CODEX_STDIN<<"; cat; echo ">>CODEX_STDIN"; } >> ${record}
`, 0o755);

  // A CLI the kit has never heard of, driven only by a `command` template.
  // Records each argv element on its own line so word splitting would show.
  write(path.join(bin, 'fake-cli'), `#!/usr/bin/env bash
{ echo "FAKE_ARGC: $#"; for arg in "$@"; do echo "FAKE_ARG: $arg"; done
  echo "FAKE_STDIN<<"; cat; echo ">>FAKE_STDIN"; } >> ${record}
`, 0o755);

  write(path.join(bin, 'claude'), `#!/usr/bin/env bash
{ echo "CLAUDE_CEILING: \${CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS:-unset}"
  echo "CLAUDE_ARGV: $*"
  echo "CLAUDE_STDIN<<"; cat; echo ">>CLAUDE_STDIN"; } >> ${record}
echo "\${PROJECT_ADMIN_TEST_AGENT_OUTPUT:-worked one item}"
sleep "\${PROJECT_ADMIN_TEST_AGENT_SLEEP:-0}"
exit "\${PROJECT_ADMIN_TEST_AGENT_EXIT:-0}"
`, 0o755);

  write(path.join(bin, 'notify-stub'), `#!/usr/bin/env bash
echo "NOTIFY: $*" >> ${record}
`, 0o755);

  return { root, record, bin };
}

function runLoop(sandbox, agent, queue, env = {}) {
  const result = spawnSync(path.join(sandbox.root, 'scripts/agent-loops/run-loop.sh'), [agent, queue, '--once'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox.bin}:/usr/bin:/bin`,
      HOME: sandbox.root,
      PROJECT_ADMIN_CODEX_USAGE_CAPTURE: '/usr/bin/true',
      PROJECT_ADMIN_CLAUDE_USAGE_CAPTURE: '/usr/bin/true',
      PROJECT_ADMIN_LOOP_NOTIFIER: path.join(sandbox.bin, 'notify-stub'),
      PROJECT_ADMIN_LOOP_AUTH_STAMP: path.join(sandbox.root, 'auth.stamp'),
      PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS: '',
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '',
      ...env,
    },
  });
  const record = fs.existsSync(sandbox.record) ? fs.readFileSync(sandbox.record, 'utf8') : '';
  return { ...result, record };
}

test('Codex takes the prompt on stdin with an immediate EOF and is rooted at the loop checkout', () => {
  const sandbox = makeSandbox();
  const { record } = runLoop(sandbox, 'sol', 'bug');
  assert.match(record, /CODEX_ARGV: .*-C \S+ -$/m, 'codex reads stdin via `-` and gets an explicit -C root');
  assert.doesNotMatch(record, /CODEX_ARGV: .*bug prompt/, 'the prompt is no longer a positional argument');
  assert.match(record, /CODEX_STDIN<<\nbug prompt for sol\n>>CODEX_STDIN/, 'the prompt arrives on stdin and stdin then closes');
});

test('Claude keeps the prompt as an argument but runs with stdin closed', () => {
  const sandbox = makeSandbox();
  const { record } = runLoop(sandbox, 'opus', 'bug');
  assert.match(record, /CLAUDE_ARGV: .*bug prompt for opus/, 'the prompt stays a positional argument');
  assert.match(record, /CLAUDE_STDIN<<\n>>CLAUDE_STDIN/, 'stdin is /dev/null, not launchd’s inherited descriptor');
});

test('only the deploy queue gets the six-hour wall and the ninety-minute background-wait ceiling', () => {
  const build = makeSandbox();
  assert.match(runLoop(build, 'opus', 'bug').record, /TIMEOUT_ARGS: --signal=TERM --kill-after=30s 14400 /);
  assert.match(runLoop(build, 'opus', 'bug').record, /CLAUDE_CEILING: 0/);

  const deploy = makeSandbox();
  const { record } = runLoop(deploy, 'configured', 'deploy');
  assert.match(record, /TIMEOUT_ARGS: --signal=TERM --kill-after=30s 21600 /);
  assert.match(record, /CLAUDE_CEILING: 5400000/);
});

test('an explicit environment override still wins over the deploy defaults', () => {
  const sandbox = makeSandbox();
  const { record } = runLoop(sandbox, 'configured', 'deploy', {
    PROJECT_ADMIN_LOOP_TIMEOUT_SECONDS: '900',
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '1000',
  });
  assert.match(record, /TIMEOUT_ARGS: --signal=TERM --kill-after=30s 900 /);
  assert.match(record, /CLAUDE_CEILING: 1000/);
});

test('records the actual effort and publishes a progress snapshot on the configured cadence', () => {
  const sandbox = makeSandbox();
  const { status, record } = runLoop(sandbox, 'opus', 'feature', {
    CLAUDE_EFFORT: 'xhigh',
    PROJECT_ADMIN_LOOP_PROGRESS_SECONDS: '5',
    PROJECT_ADMIN_TEST_AGENT_OUTPUT: 'Implementation complete; focused tests are running.',
    PROJECT_ADMIN_TEST_AGENT_SLEEP: '1',
  });
  assert.equal(status, 0);
  assert.match(record, /LOG_RUN_ARGV: .*start .*--effort xhigh/);
  assert.match(record, /LOG_RUN_ARGV: .*progress .*--summary Implementation complete; focused tests are running\./);
});

test('an expired session fails the run, names the reason, and notifies once per debounce window', () => {
  const sandbox = makeSandbox();
  const authEnv = { PROJECT_ADMIN_TEST_AGENT_EXIT: '1', PROJECT_ADMIN_TEST_AGENT_OUTPUT: 'OAuth session expired; please run /login' };
  const first = runLoop(sandbox, 'opus', 'bug', authEnv);
  assert.equal(first.status, 78, 'the run is classified as an auth failure rather than a generic exit 1');
  assert.match(first.stderr, /AUTH FAILURE/);
  assert.equal((first.record.match(/^NOTIFY: /gm) || []).length, 1);

  const second = runLoop(sandbox, 'sonnet', 'bug', authEnv);
  assert.equal(second.status, 78);
  assert.equal((second.record.match(/^NOTIFY: /gm) || []).length, 1, 'a concurrent loop reuses the shared stamp instead of alerting again');
});

test('a clean run is not mistaken for an auth failure', () => {
  const sandbox = makeSandbox();
  const { status, record } = runLoop(sandbox, 'opus', 'bug');
  assert.equal(status, 0);
  assert.doesNotMatch(record, /NOTIFY: /);
});

test('Codex runs are announced as unguarded and keep the configured sandbox; Claude runs are not', () => {
  const codex = runLoop(makeSandbox(), 'sol', 'bug');
  assert.match(codex.stderr, /WARNING sol uses the codex runner, which does not enforce headless-guard\.py.*sandbox: danger-full-access/);
  assert.match(codex.record, /CODEX_ARGV: exec --sandbox danger-full-access -m gpt-5\.6-sol -c model_reasoning_effort=medium /);

  const claude = runLoop(makeSandbox(), 'opus', 'bug');
  assert.doesNotMatch(claude.stderr, /WARNING/);
  assert.match(claude.record, /CLAUDE_ARGV: -p --model opus --effort medium --dangerously-skip-permissions --settings .*"PreToolUse".*"command":"python3 \S+\/headless-guard\.py"/);

  const sandbox = makeSandbox();
  const config = writeConfig(sandbox.root, [
    { token: 'careful', label: 'Careful Codex', runner: 'codex', model: 'gpt-x', sandbox: 'workspace-write' },
  ], { automation: { ...JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8')).automation, defaultWorkAgent: 'careful', defaultDeployAgent: 'careful' } });
  const careful = runLoop(sandbox, 'careful', 'feature', { PROJECT_ADMIN_CONFIG: config });
  assert.equal(careful.status, 0, careful.stderr);
  assert.match(careful.record, /CODEX_ARGV: exec --sandbox workspace-write -m gpt-x /);
});

test('runner env overrides still win and the recorded effort is the one the CLI gets', () => {
  const { record } = runLoop(makeSandbox(), 'terra', 'feature', { CODEX_MODEL: 'gpt-override', CODEX_EFFORT: 'low' });
  assert.match(record, /CODEX_ARGV: .*-m gpt-override -c model_reasoning_effort=low /);
  assert.match(record, /LOG_RUN_ARGV: .*start --agent terra .*--effort low/);
});

test('an alias resolves to its canonical agent before anything is recorded', () => {
  const { status, record } = runLoop(makeSandbox(), 'codex', 'bug');
  assert.equal(status, 0);
  assert.match(record, /LOG_RUN_ARGV: .*start --agent terra /);
  assert.match(record, /CODEX_STDIN<<\nbug prompt for terra\n>>CODEX_STDIN/);
});

test('an unknown agent is refused with the configured tokens in the usage line', () => {
  const { status, stderr, record } = runLoop(makeSandbox(), 'gemini', 'bug');
  assert.equal(status, 2);
  assert.match(stderr, /Usage: .*<sol\|terra\|luna\|opus\|sonnet\|fable\|grok\|configured>/);
  assert.doesNotMatch(record, /LOG_RUN_ARGV: .*start/);
});

test('a missing CLI fails before a run row is created', () => {
  const sandbox = makeSandbox();
  fs.rmSync(path.join(sandbox.bin, 'codex'));
  const { status, stderr, record } = runLoop(sandbox, 'sol', 'bug');
  assert.equal(status, 1);
  assert.match(stderr, /Codex CLI not found/);
  assert.doesNotMatch(record, /LOG_RUN_ARGV: .*start/);
});

function commandAgentSandbox(agent) {
  const sandbox = makeSandbox();
  const automation = { ...JSON.parse(fs.readFileSync(path.join(REPO, 'project-admin.config.json'), 'utf8')).automation, defaultWorkAgent: 'gem', defaultDeployAgent: 'gem' };
  const config = writeConfig(sandbox.root, [{ token: 'gem', label: 'Gemini', runner: 'command', model: 'gemini-pro', ...agent }], { automation });
  // A multi-line prompt proves the prompt stays one argument.
  write(path.join(sandbox.root, 'scripts/agent-loops/feature-loop-prompt.md'), 'line one for {{AGENT}}\nline two\n');
  return { sandbox, env: { PROJECT_ADMIN_CONFIG: config } };
}

test('a command-runner agent runs any CLI from its config template with the prompt as one argument', () => {
  const { sandbox, env } = commandAgentSandbox({
    command: ['fake-cli', '--model', '{{model}}', '--effort={{effort}}', '--cwd', '{{repo}}', '--prompt', '{{prompt}}'],
  });
  const { status, stderr, record } = runLoop(sandbox, 'gem', 'feature', env);
  assert.equal(status, 0, stderr);
  assert.match(stderr, /WARNING gem uses the command runner/);
  assert.match(record, /FAKE_ARGC: 7\n/);
  assert.match(record, /FAKE_ARG: --model\nFAKE_ARG: gemini-pro\nFAKE_ARG: --effort=medium\nFAKE_ARG: --cwd\nFAKE_ARG: \S+\nFAKE_ARG: --prompt\nFAKE_ARG: line one for gem\nline two\n/);
  assert.match(record, /FAKE_STDIN<<\n>>FAKE_STDIN/, 'stdin is closed when the prompt travels as an argument');
  assert.match(record, /TIMEOUT_ARGS: --signal=TERM --kill-after=30s 14400 /, 'the outer wall still wraps the adapter');
});

test('a command-runner agent can take the prompt on stdin or as a file path', () => {
  const stdin = commandAgentSandbox({ command: ['fake-cli', 'run'], promptVia: 'stdin' });
  const viaStdin = runLoop(stdin.sandbox, 'gem', 'feature', stdin.env);
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.match(viaStdin.record, /FAKE_ARGC: 1\n/);
  assert.match(viaStdin.record, /FAKE_STDIN<<\nline one for gem\nline two\n>>FAKE_STDIN/);

  const file = commandAgentSandbox({ command: ['fake-cli', '--prompt-file', '{{prompt_file}}'] });
  const viaFile = runLoop(file.sandbox, 'gem', 'feature', file.env);
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.record, /FAKE_ARG: \S+\/\.agent-logs\/feature-gem-run-test-1\.prompt\.md\n/);
});

test('the command runner propagates the CLI exit code and the usage hook is per agent', () => {
  const { sandbox, env } = commandAgentSandbox({
    command: ['fake-cli', '{{prompt}}'],
    usage: { provider: 'gemini', script: 'usage-hook.sh' },
  });
  write(path.join(sandbox.bin, 'fake-cli'), '#!/usr/bin/env bash\necho "boom"\nexit 3\n', 0o755);
  write(path.join(sandbox.root, 'usage-hook.sh'), `#!/usr/bin/env bash\necho "USAGE_HOOK: $PA_USAGE_PROVIDER" >> ${sandbox.record}\n`, 0o755);
  const { status, record } = runLoop(sandbox, 'gem', 'feature', env);
  assert.equal(status, 3);
  assert.match(record, /LOG_RUN_ARGV: .*finish .*--code 3/);
  assert.match(record, /USAGE_HOOK: gemini/);
});

// --- loop-wrapper.sh -------------------------------------------------------

function makeWrapperSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-wrapper-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const record = path.join(root, 'record.txt');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

  execFileSync('git', ['init', '--bare', '-b', 'master', origin], { encoding: 'utf8' });
  execFileSync('git', ['init', '-b', 'master', repo], { encoding: 'utf8' });
  git(repo, 'config', 'user.email', 'loop@example.com');
  git(repo, 'config', 'user.name', 'Loop Test');
  write(path.join(repo, 'scripts/agent-loops/loop-wrapper.sh'), fs.readFileSync(path.join(AGENT_LOOPS, 'loop-wrapper.sh')), 0o755);
  write(path.join(repo, 'scripts/agent-loops/run-loop.sh'), `#!/usr/bin/env bash
echo "RUN_LOOP: agent=$1 queue=$2 mode=$3 cwd=$PWD self=$0" >> ${record}
`, 0o755);
  write(path.join(repo, '.gitignore'), '.agent-worktrees/\nnode_modules/\n');
  copyRosterFiles(repo);
  fs.mkdirSync(path.join(repo, 'scripts/node_modules'), { recursive: true });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'master');
  git(repo, 'fetch', '-q', 'origin', 'master');
  return { root, repo, record };
}

function runWrapper(sandbox, agent, queue, env = {}) {
  const result = spawnSync(path.join(sandbox.repo, 'scripts/agent-loops/loop-wrapper.sh'), [agent, queue], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_ADMIN_LOOP_STATE_DIR: path.join(sandbox.root, 'state'),
      PROJECT_ADMIN_LOOP_QOS_FIXED: '1', // the re-exec is asserted from source; skip it here
      ...env,
    },
  });
  const record = fs.existsSync(sandbox.record) ? fs.readFileSync(sandbox.record, 'utf8') : '';
  return { ...result, record };
}

test('the wrapper runs each loop from its own worktree, never the primary checkout', () => {
  const sandbox = makeWrapperSandbox();
  const { status, record } = runWrapper(sandbox, 'opus', 'bug');
  assert.equal(status, 0);
  const worktree = path.join(sandbox.repo, '.agent-worktrees/loop-bug-opus');
  assert.ok(fs.existsSync(worktree), 'a dedicated per-(queue,token) worktree is created');
  assert.match(record, /RUN_LOOP: agent=opus queue=bug mode=--once/);
  assert.match(record, new RegExp(`self=${worktree}/scripts/agent-loops/run-loop\\.sh`), 'run-loop.sh comes from the worktree');
  assert.doesNotMatch(record, new RegExp(`cwd=${sandbox.repo}$`, 'm'), 'the loop never runs in the shared primary checkout');
  assert.ok(fs.existsSync(path.join(worktree, 'scripts/node_modules')), 'gitignored dependencies are linked into the worktree');
});

test('a second fire skips while the previous run still holds the (queue,token) lock', () => {
  const sandbox = makeWrapperSandbox();
  fs.mkdirSync(path.join(sandbox.root, 'state'), { recursive: true });
  fs.mkdirSync(path.join(sandbox.root, 'state/bug-loop-opus.lock'), { recursive: true });
  const { status, stdout, record } = runWrapper(sandbox, 'opus', 'bug');
  assert.equal(status, 0, 'a skipped fire is not an error');
  assert.match(stdout, /skip: a previous run still holds the lock/);
  assert.equal(record, '', 'no agent run is started while the lock is held');
});

test('the wrapper refreshes its worktree to the configured default branch on every fire', () => {
  const sandbox = makeWrapperSandbox();
  runWrapper(sandbox, 'opus', 'bug');
  const worktree = path.join(sandbox.repo, '.agent-worktrees/loop-bug-opus');
  fs.writeFileSync(path.join(worktree, 'scripts/agent-loops/run-loop.sh'), '#!/usr/bin/env bash\nexit 9\n');
  fs.writeFileSync(path.join(worktree, 'stray.txt'), 'left over from the last run');
  const { status, record } = runWrapper(sandbox, 'opus', 'bug');
  assert.equal(status, 0, 'the tampered runner was reset back to the committed one');
  assert.equal((record.match(/^RUN_LOOP: /gm) || []).length, 2);
  assert.ok(!fs.existsSync(path.join(worktree, 'stray.txt')), 'untracked leftovers are cleaned');
});

test('the wrapper rejects an unknown token or queue', () => {
  const sandbox = makeWrapperSandbox();
  const unknown = runWrapper(sandbox, 'nobody', 'bug');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /<sol\|terra\|luna\|opus\|sonnet\|fable\|grok\|configured>/);
  assert.equal(runWrapper(sandbox, 'opus', 'release').status, 2);
});

test('the wrapper canonicalizes an alias so it shares the agent\'s lock and worktree', () => {
  const sandbox = makeWrapperSandbox();
  const { status, record } = runWrapper(sandbox, 'codex', 'bug');
  assert.equal(status, 0);
  assert.match(record, /RUN_LOOP: agent=terra queue=bug/);
  assert.ok(fs.existsSync(path.join(sandbox.repo, '.agent-worktrees/loop-bug-terra')));
});

test('launchd points at the wrapper and the wrapper restores normal QoS once', () => {
  const wrapper = fs.readFileSync(path.join(AGENT_LOOPS, 'loop-wrapper.sh'), 'utf8');
  const plist = fs.readFileSync(path.join(AGENT_LOOPS, 'launchd.plist.template'), 'utf8');
  assert.match(wrapper, /PROJECT_ADMIN_LOOP_QOS_FIXED=1\n\s*exec taskpolicy -a "\$0" "\$@"/);
  assert.match(plist, /loop-wrapper\.sh/);
  assert.doesNotMatch(plist, /run-loop\.sh/, 'launchd no longer invokes the runner directly');
  assert.doesNotMatch(plist, /WorkingDirectory/, 'no launchd job starts in the shared primary checkout');
});
