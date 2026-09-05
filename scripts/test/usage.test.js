'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { diagnoseClaudeUsage, parseClaudeUsage } = require('../agent-loops/parse-claude-usage');

test('parses Claude weekly usage and reset labels from accessibility output', () => {
  assert.deepEqual(
    parseClaudeUsage('\u001b[1mCurrent week ( all models ) : 60.5 % used  resets Sep 2 at 5:00pm\u001b[0m'),
    { usedPercent: 60.5, resetsLabel: 'Sep 2 at 5:00pm' }
  );
});

test('fails closed when Claude no longer exposes the expected weekly label', () => {
  assert.deepEqual(diagnoseClaudeUsage('Current session: 14% used'), { usage: null, error: 'missing_label' });
  assert.deepEqual(diagnoseClaudeUsage('Current week (all models)\nnot a value'), { usage: null, error: 'parse_error' });
});

test('extracts the shared Codex seven-day rate limit from the newest session', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-codex-usage-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const sessionDir = path.join(tempDir, 'sessions');
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'rollout.jsonl'), '{"rate_limits":{"primary":{"used_percent":37.5,"window_minutes":10080,"resets_at":1788220800}}}\n');
  const argsFile = path.join(tempDir, 'args.txt');
  const fakeLog = path.join(tempDir, 'log-run.js');
  fs.writeFileSync(fakeLog, `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, process.argv.slice(2).join(' '));`);

  const result = spawnSync('bash', [path.join(__dirname, '..', 'agent-loops', 'capture-codex-usage.sh')], {
    env: { ...process.env, CODEX_SESSIONS_DIR: sessionDir, CODEX_USAGE_LOG_RUN: fakeLog },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(argsFile, 'utf8'), /^usage --provider codex --used-percent 37\.5 --resets-at /);
});

test('refreshes usage even when a loop poll finds no work', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'agent-loops', 'run-loop.sh'), 'utf8');
  const noWorkBranch = runner.match(/if \[\[ "\$work_count" == "0" \]\]; then([\s\S]*?)return 0/)?.[1] || '';
  assert.match(noWorkBranch, /capture_usage/);
});
