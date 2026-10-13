'use strict';

// GitHub-only behaviour: the issue mapping, human gate conventions (slash
// commands and approval labels, authorized by repository permission), issues
// opened in the GitHub UI, claim arbitration, and the REST transport.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBacklogAgent } = require('../lib/backlog-agent');
const { resolveAgent } = require('../lib/agents');
const { loadProjectConfig } = require('../lib/project-config');
const { resolveWorkKinds } = require('../lib/work-kinds');
const { createLocalStore } = require('../lib/store/local-store');
const { createGitHubStore } = require('../lib/store/github-store');
const { createGitHubTransport, resolveGitHubToken } = require('../lib/store/github-transport');
const model = require('../lib/store/github-model');
const { StoreTimestamp } = require('../lib/store/values');
const { createFakeGitHub } = require('./support/fake-github');

const config = loadProjectConfig();
const kinds = resolveWorkKinds({ feature: {}, bug: {}, task: { label: 'Task', prefix: 'TASK', deploys: false } });
const approvedNotes = 'Scope: release PR #5.\nCommands: deploy hosting.\nVerification: open the admin route.\nAcceptance: the page renders the change.';

function setup(t, { permissions = { owner: 'admin', dev: 'write', triager: 'triage', viewer: 'read' } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-github-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const github = createFakeGitHub({ permissions });
  const open = (overrides = {}) => createGitHubStore({
    repository: 'acme/app', transport: github, telemetry: createLocalStore({ file: path.join(dir, 'telemetry.json') }), kinds,
    defaultOwner: 'sol-agent', resolveOwner: (token) => resolveAgent(token).owner, settleMs: 0, ...overrides,
  });
  const store = open();
  const run = async (kindId, ...argv) => {
    const outputs = [];
    await createBacklogAgent({ store, config, kinds, kindId, env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac' }, log: (line) => outputs.push(JSON.parse(line)) }).run(argv);
    return outputs.at(-1);
  };
  return { github, store, open, run };
}

test('items map to issues: labels for lifecycle, a hidden fields block, comments for the thread', async (t) => {
  const { github, run } = setup(t);
  const created = await run('bug', 'create', '--as', 'sol', '--title', 'Crash', '--description', 'Steps: open --> tap', '--priority', 'high');
  assert.equal(created.id, '1');
  const issue = github.issue(1);
  assert.deepEqual(issue.labels.map((label) => label.name).sort(), ['pa:kind:bug', 'pa:priority:high', 'pa:status:open', 'pa:waiting:agent']);
  assert.ok(issue.body.startsWith('Steps: open --> tap\n\n<!-- project-admin:fields'), 'description stays readable above the block');
  assert.equal(issue.body.match(/-->/g).length, 2, 'only the description arrow and the block terminator remain');
  const { fields } = model.parseBody(issue.body);
  assert.equal(fields.assignedTo, 'sol-agent');
  assert.equal(fields.targetMachine, 'local-mac');
  assert.match(github.comments(1)[0].body, /^<!-- project-admin:message \{"author":"Codex Sol"\} -->\n\*\*Codex Sol:\*\* Created BUG-1\.$/);

  await run('bug', 'next', '--as', 'sol');
  await run(null, 'pr', '1', '--as', 'sol', '--url', 'https://github.com/acme/app/pull/9', '--number', '9', '--branch', 'fix/crash', '-m', 'Notes with --> arrows');
  const after = github.issue(1);
  assert.ok(after.labels.some((label) => label.name === 'pa:gate:pr_review'));
  assert.ok(!after.labels.some((label) => label.name === 'pa:claimed'), 'mutations release the claim');
  const shown = await run(null, 'show', '1');
  assert.equal(shown.description, 'Steps: open --> tap');
  assert.equal(shown.prNumber, 9);
  assert.equal(shown.branchName, 'fix/crash');
  assert.equal(shown.messages.at(-1).body, 'Notes with --> arrows');
});

test('slash commands from collaborators with write access drive the gates; others are refused in-thread', async (t) => {
  const { github, store, run } = setup(t);
  const bug = await run('bug', 'create', '--as', 'sol', '--title', 'Crash', '--description', 'It crashes');
  await run('bug', 'next', '--as', 'sol');
  await run(null, 'plan', bug.id, '--as', 'sol', '-m', 'Plan: guard it');

  github.human.comment(bug.id, 'viewer', '/approve plan');
  github.human.comment(bug.id, 'triager', '/approve');
  github.human.comment(bug.id, 'dev', '/approve deploy');
  github.human.comment(bug.id, 'owner', 'Looks fine, but no command here.');
  assert.equal((await run('bug', 'count', '--as', 'sol')).count, 0);
  let item = await store.items.get(bug.id);
  assert.equal(item.blockedReason, 'plan_review');
  const notes = item.messages.filter((message) => message.author === 'Project Admin').map((message) => message.body);
  assert.match(notes[0], /^Ignored \/approve plan from @viewer: approvals need write, maintain, or admin permission/);
  assert.match(notes[1], /^Ignored \/approve from @triager/);
  assert.match(notes[2], /^Could not apply \/approve deploy from @dev: the item is not waiting for deploy approval/);
  assert.ok(item.messages.some((message) => message.author === '@owner' && message.body === 'Looks fine, but no command here.'), 'plain comments are thread messages');

  github.human.comment(bug.id, 'dev', '/approve plan\nAlso add a regression test.');
  assert.equal((await run('bug', 'count', '--as', 'sol')).count, 1);
  item = await store.items.get(bug.id);
  assert.equal(item.waitingOn, 'agent');
  assert.equal(item.messages.at(-1).body, '✅ Approved — please continue. Also add a regression test.');
  assert.equal((await run('bug', 'count', '--as', 'sol')).count, 1, 'a processed command is not applied twice');
  assert.equal(item.messages.filter((message) => message.body.startsWith('✅')).length, 1);
});

test('approval labels count only for authorized actors and are removed once applied', async (t) => {
  const { github, store, run } = setup(t);
  const feature = await run('feature', 'create', '--as', 'sol', '--title', 'Export', '--description', 'CSV export');
  await run('feature', 'next', '--as', 'sol');
  await run(null, 'pr', feature.id, '--as', 'sol', '--url', 'https://github.com/acme/app/pull/5', '--number', '5', '--branch', 'feature/export', '-m', 'Ready');
  github.human.addLabel(feature.id, 'triager', 'pa:approved:pr');
  await store.sync();
  assert.equal((await store.items.get(feature.id)).blockedReason, 'pr_review');
  assert.ok(!github.issue(feature.id).labels.some((label) => label.name === 'pa:approved:pr'), 'the label is consumed either way');

  github.human.addLabel(feature.id, 'owner', 'pa:approved:pr');
  await store.sync();
  assert.equal((await store.items.get(feature.id)).waitingOn, 'agent');

  await run('feature', 'next', '--as', 'sol');
  await run(null, 'deploy-pending', feature.id, '--as', 'sol', '--targets', 'none', '--notes', approvedNotes, '-m', 'Release it');
  github.human.addLabel(feature.id, 'owner', 'pa:approved:deploy');
  assert.equal((await run(null, 'deploy-count', '--as', 'sonnet')).count, 1);
  const item = await store.items.get(feature.id);
  assert.deepEqual([item.deploymentApprovedTargets, item.deploymentApprovedBy], [['none'], 'github:owner']);
  assert.equal(item.deploymentApprovedNotes, approvedNotes);
});

test('acceptance, decline, close-no-deploy, and UI closes map to terminal states', async (t) => {
  const { github, store, run } = setup(t);
  const task = await run('task', 'create', '--as', 'sol', '--title', 'Audit', '--description', 'Audit deps', '--waiting', 'human');
  github.human.comment(task.id, 'owner', '/close-no-deploy');
  await store.sync();
  assert.match((await store.items.get(task.id)).messages.at(-1).body, /add a resolution note/);
  github.human.comment(task.id, 'owner', '/close-no-deploy Nothing to release; findings are in the thread.');
  await store.sync();
  assert.equal(github.issue(task.id).state, 'closed');
  assert.equal((await store.items.get(task.id)).status, 'closed');

  const declined = await run('feature', 'create', '--as', 'sol', '--title', 'Maybe', '--description', 'Later');
  github.human.comment(declined.id, 'owner', '/decline Not this quarter.');
  await store.sync();
  assert.deepEqual([github.issue(declined.id).state_reason, (await store.items.get(declined.id)).status], ['not_planned', 'declined']);

  const closedInUi = await run('bug', 'create', '--as', 'sol', '--title', 'Dupe', '--description', 'Duplicate');
  github.human.close(closedInUi.id, 'not_planned');
  const item = await store.items.get(closedInUi.id);
  assert.deepEqual([item.status, item.waitingOn], ['wont_fix', 'done']);
  assert.equal((await run('bug', 'count', '--as', 'sol')).count, 0);

  const accepted = await run('feature', 'create', '--as', 'sol', '--title', 'Ship', '--description', 'TestFlight');
  await store.items.update(accepted.id, {
    status: 'in_review', waitingOn: 'human', blockedReason: 'acceptance_review', deploymentApprovedTargets: ['testflight'],
    deploymentApprovedAt: StoreTimestamp.now(), deploymentBuild: '42', deploymentResult: 'Build 42 is VALID.',
  });
  github.human.comment(accepted.id, 'owner', '/accept Works on device.');
  await store.sync();
  assert.deepEqual([github.issue(accepted.id).state, (await store.items.get(accepted.id)).status], ['closed', 'shipped']);
});

test('issues opened in the GitHub UI with a kind label are adopted into triage', async (t) => {
  const { github, store, run } = setup(t);
  github.human.openIssue('dev', { title: 'Dark mode', body: 'Please add it', labels: ['pa:kind:feature', 'design'] });
  github.human.openIssue('dev', { title: 'Unrelated', body: 'No kind label' });
  assert.equal((await run('feature', 'count', '--as', 'sol')).count, 0, 'adopted issues wait for a human');
  const issue = github.issue(1);
  assert.deepEqual(issue.labels.map((label) => label.name).sort(), ['design', 'pa:gate:triage', 'pa:kind:feature', 'pa:priority:medium', 'pa:status:backlog', 'pa:waiting:human']);
  assert.deepEqual(github.issue(2).labels, [], 'issues without a kind label are left alone');
  github.human.comment(1, 'owner', '/assign terra');
  github.human.comment(1, 'owner', '/agent Go ahead.');
  assert.equal((await run('feature', 'count', '--as', 'terra')).count, 1);
  const item = await store.items.get('1');
  assert.deepEqual([item.assignedTo, item.status, item.description], ['terra-agent', 'in_progress', 'Please add it']);
});

test('claim arbitration: the earliest claim comment wins and losers withdraw', async (t) => {
  const { github, store, open, run } = setup(t);
  const task = await run('task', 'create', '--as', 'sol', '--title', 'Race', '--description', 'One winner');
  // A competitor's claim comment that landed first, inside the claim window.
  await github.request('POST', `/repos/acme/app/issues/${task.id}/comments`, { body: model.renderClaimComment({ token: 'other', agent: 'sol', runId: 'r0', at: new Date().toISOString() }) });
  assert.deepEqual(await run('task', 'next', '--as', 'sol'), { none: true });
  assert.equal(github.comments(task.id).filter((comment) => comment.body.includes('project-admin:claim')).length, 1, 'the loser deleted its own claim comment');
  assert.equal((await store.items.get(task.id)).claimedBy, undefined);

  // Stale claim comments (older than the window) do not block a new claim.
  const later = open({ now: () => StoreTimestamp.fromMillis(Date.now() + 11 * 60_000) });
  const outputs = [];
  await createBacklogAgent({ store: later, config, kinds, kindId: 'task', env: { PROJECT_ADMIN_MACHINE_ID: 'local-mac' }, log: (line) => outputs.push(JSON.parse(line)) }).run(['next', '--as', 'sol']);
  assert.equal(outputs[0].id, task.id);
  const claimed = await store.items.get(task.id);
  assert.equal(claimed.claimedBy, 'sol');
  assert.ok(claimed.claimFloor > 0, 'the winner records the claim floor for the next epoch');
  assert.ok(github.issue(task.id).labels.some((label) => label.name === 'pa:claimed'));
});

test('attachments and user management are refused with directions', async (t) => {
  const { store, run } = setup(t);
  const task = await run('task', 'create', '--as', 'sol', '--title', 'Shot', '--description', 'Screenshot');
  await assert.rejects(run(null, 'reply', task.id, '--as', 'sol', '-m', 'see', '--images', 'a.png'), /drag/);
  await assert.rejects(store.users.list(), /collaborators/);
  assert.equal(store.capabilities.atomicClaims, false);
  assert.equal(store.capabilities.dashboard, false);
});

test('parses slash commands and renders/parses store comments', () => {
  assert.deepEqual(model.parseCommand('/approve deploy ship it'), { verb: 'approve', target: 'deploy', note: 'ship it' });
  assert.deepEqual(model.parseCommand('/APPROVE\nmore context'), { verb: 'approve', target: '', note: 'more context' });
  assert.deepEqual(model.parseCommand('/agent'), { verb: 'agent', target: '', note: '' });
  assert.equal(model.parseCommand('please /approve'), null);
  const rendered = model.renderMessage({ author: 'Codex Sol', body: 'Done', imageUrls: ['https://x/y.png'] });
  const parsed = model.parseComment({ id: 7, body: rendered, created_at: '2026-01-01T00:00:00Z', user: { login: 'bot' } }, (iso) => StoreTimestamp.fromMillis(Date.parse(iso)));
  assert.deepEqual([parsed.storeAuthored, parsed.message.author, parsed.message.body, parsed.message.imageUrls], [true, 'Codex Sol', 'Done', ['https://x/y.png']]);
});

test('the REST transport sends the token and API version, and paginates', async () => {
  const requests = [];
  const pages = [Array.from({ length: 100 }, (_v, index) => ({ number: index })), [{ number: 100 }]];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[page - 1] || []) };
  };
  const transport = createGitHubTransport({ token: 'secret', fetchImpl });
  const all = await transport.paginate('/repos/acme/app/issues?state=open');
  assert.equal(all.length, 101);
  assert.equal(requests[0].url, 'https://api.github.com/repos/acme/app/issues?state=open&per_page=100&page=1');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
  const failing = createGitHubTransport({ token: 't', fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'Not Found' }) });
  await assert.rejects(failing.request('GET', '/repos/acme/app/issues/9'), (error) => error.status === 404);
  assert.equal(resolveGitHubToken({ GH_TOKEN: 'gh' }), 'gh');
  assert.equal(resolveGitHubToken({}, () => ({ status: 0, stdout: 'from-cli\n' })), 'from-cli');
  assert.throws(() => resolveGitHubToken({}, () => ({ status: 1, stdout: '' })), /gh auth login/);
});
