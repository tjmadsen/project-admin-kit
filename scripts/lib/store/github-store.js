'use strict';

// The `github` BacklogStore: work items are GitHub Issues (see github-model.js
// for the mapping). Loop telemetry - runs, machines, usage, the deploy-agent
// choice - is not shown on GitHub, so it lives in a small local JSON store in
// the state directory, and there is no admin dashboard for this backend.
//
// Atomicity. GitHub has no compare-and-swap for issues, so writes are
// read-modify-write and a concurrent edit of the same issue can be lost. Claims
// use a best-effort protocol instead of a transaction:
//
//   1. read the issue and decide eligibility (lease open, owner, deps);
//   2. post a claim comment carrying a random token;
//   3. wait `settleMs`, then list the issue's comments: among claim comments
//      newer than the issue's recorded `claimFloor` (and younger than
//      `claimWindowMs`), the lowest comment id wins - GitHub assigns comment
//      ids in creation order, so every claimant computes the same winner;
//   4. losers delete their comment and back off; the winner re-reads the
//      issue, re-checks eligibility and that no other claim completed
//      meanwhile, then writes the lease and the new floor.
//
// The remaining race window: a claimant whose comment listing (step 3) does
// not yet include a competitor's earlier comment, i.e. GitHub's comment list
// lagging by more than `settleMs`. Then two claimants can both proceed. Run one
// poller per queue per repository (the default machine roster) to make this
// practically impossible; a double claim is visible as two "Claimed by"
// comments on the issue.

const crypto = require('node:crypto');
const {
  APPROVAL_LABELS, WRITE_PERMISSIONS, applyHumanCommand, decodeIssue, fieldsOf, issueStateFor, labelNames, labelsFor,
  parseCommand, parseComment, renderBody, renderClaimComment, renderMessage,
} = require('./github-model');
const { StoreTimestamp, applyUpdate, serverTimestamp } = require('./values');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createGitHubStore({
  repository, labelPrefix = 'pa:', transport, telemetry, kinds, defaultOwner, resolveOwner,
  settleMs = 2000, claimWindowMs = 10 * 60_000, now = () => StoreTimestamp.now(), log = () => {},
}) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository || '')) throw new Error(`The github backend needs backend.repository (or repository.slug) as owner/repo, got "${repository}"`);
  const repo = `/repos/${repository}`;
  const toTimestamp = (iso) => (iso ? StoreTimestamp.fromMillis(Date.parse(iso)) : null);
  const decodeOptions = { prefix: labelPrefix, kinds, defaults: { assignedTo: defaultOwner }, toTimestamp };
  const kindOf = (id) => kinds.find((kind) => kind.id === id);
  const issueNumber = (id) => (/^\d+$/.test(String(id)) ? Number(id) : null);

  async function fetchIssue(id) {
    const number = issueNumber(id);
    if (number === null) return null;
    try {
      return await transport.request('GET', `${repo}/issues/${number}`);
    } catch (error) {
      if (error.status === 404 || error.status === 410) return null;
      throw error;
    }
  }
  const fetchComments = (number) => transport.paginate(`${repo}/issues/${number}/comments`);
  const messagesFrom = (comments) => comments.map((comment) => parseComment(comment, toTimestamp)).filter((entry) => entry.type === 'message').map((entry) => entry.message);

  async function readItem(id, { withComments = true } = {}) {
    const issue = await fetchIssue(id);
    if (!issue) return null;
    const decoded = decodeIssue(issue, decodeOptions);
    if (!decoded) return null;
    const comments = withComments ? await fetchComments(issue.number) : [];
    return { issue, comments, ...decoded, item: { ...decoded.item, messages: messagesFrom(comments) } };
  }

  // Writes title/body/labels/state in one PATCH (labels replace the whole set,
  // so labels outside the prefix are carried over), then posts each message.
  async function writeItem(issue, item, messages = []) {
    const kind = kindOf(item.kind);
    const foreign = labelNames(issue).filter((name) => !name.startsWith(labelPrefix));
    const keepApprovals = labelNames(issue).filter((name) => name.startsWith(`${labelPrefix}approved:`));
    const { messages: _thread, ...rest } = item;
    await transport.request('PATCH', `${repo}/issues/${issue.number}`, {
      title: item.title,
      body: renderBody(item.description, fieldsOf(rest)),
      labels: [...foreign, ...keepApprovals, ...labelsFor(labelPrefix, item)],
      ...issueStateFor(item, kind),
    });
    for (const message of messages) await postMessage(issue.number, message);
  }
  const postMessage = (number, message) => transport.request('POST', `${repo}/issues/${number}/comments`, { body: renderMessage(message) });

  async function update(id, patch, { messages = [] } = {}) {
    const current = await readItem(id, { withComments: false });
    if (!current) throw new Error(`No document to update: workItems/${id}`);
    const next = applyUpdate(current.item, patch, now());
    await writeItem(current.issue, next, messages);
  }

  // Not atomic on GitHub (see the header): read, decide, write.
  async function transact(id, decide) {
    const current = await readItem(id);
    const outcome = await decide(current ? current.item : null, { getMany });
    if (!outcome) return null;
    if (outcome.patch) {
      if (!current) throw new Error(`No document to update: workItems/${id}`);
      await writeItem(current.issue, applyUpdate(current.item, outcome.patch, now()), outcome.messages || []);
    }
    return outcome.result ?? null;
  }

  async function claim(id, decide) {
    const first = await readItem(id);
    if (!first) return null;
    const initial = await decide(first.item, { getMany });
    if (!initial?.patch) return null;
    const floor = Number(first.item.claimFloor || 0);
    const token = crypto.randomUUID();
    const posted = await transport.request('POST', `${repo}/issues/${first.issue.number}/comments`, {
      body: renderClaimComment({ token, agent: initial.patch.claimedBy, runId: initial.patch.claimRunId, at: new Date(now().toMillis()).toISOString() }),
    });
    const withdraw = async (reason) => {
      log(`claim of #${first.issue.number} withdrawn: ${reason}`);
      await transport.request('DELETE', `${repo}/issues/comments/${posted.id}`).catch(() => undefined);
      return null;
    };
    if (settleMs > 0) await sleep(settleMs);

    const comments = await fetchComments(first.issue.number);
    const cutoff = now().toMillis() - claimWindowMs;
    const competing = comments.map((comment) => parseComment(comment, toTimestamp))
      .filter((entry) => entry.type === 'claim' && entry.id > floor && !(Date.parse(entry.at || '') < cutoff))
      .sort((a, b) => a.id - b.id);
    if (competing[0]?.id !== posted.id) return withdraw(`claim comment ${competing[0]?.id} precedes ${posted.id}`);

    const second = await readItem(id, { withComments: false });
    if (!second || Number(second.item.claimFloor || 0) !== floor) return withdraw('another claim completed first');
    const item = { ...second.item, messages: messagesFrom(comments) };
    const outcome = await decide(item, { getMany });
    if (!outcome?.patch) return withdraw('no longer eligible');
    const patch = { ...outcome.patch, claimFloor: Math.max(...competing.map((entry) => entry.id)), claimToken: token };
    await writeItem(second.issue, applyUpdate(item, patch, now()), outcome.messages || []);
    return outcome.result ?? null;
  }

  async function getMany(ids) {
    const rows = [];
    for (const id of ids) {
      const current = await readItem(id, { withComments: false });
      if (current) rows.push({ id: String(current.issue.number), ...current.item });
    }
    return rows;
  }

  // Human gates. Slash commands in comments and approval labels from people
  // with write, maintain, or admin permission become the same lifecycle
  // transitions the console's buttons make. Runs before every listing, over
  // the open issues updated since the previous sync.
  const permissionCache = new Map();
  async function canWrite(login) {
    if (!permissionCache.has(login)) {
      const permission = await transport.request('GET', `${repo}/collaborators/${encodeURIComponent(login)}/permission`)
        .then((result) => result?.permission || 'none')
        .catch((error) => { if (error.status === 404) return 'none'; throw error; });
      permissionCache.set(login, WRITE_PERMISSIONS.has(permission));
    }
    return permissionCache.get(login);
  }

  async function syncIssue(issue) {
    const decoded = decodeIssue(issue, decodeOptions);
    if (!decoded) return false;
    const { kind } = decoded;
    let item = decoded.item;
    const lastCommandId = Number(item.lastCommandId || 0);
    const messages = [];
    let changed = decoded.adopted;
    let maxCommandId = lastCommandId;
    const removeLabels = [];
    const actions = [];

    if (Number(issue.comments || 0) > 0) {
      for (const comment of await fetchComments(issue.number)) {
        if (comment.id <= lastCommandId) continue;
        const parsed = parseComment(comment, toTimestamp);
        if (parsed.type !== 'message' || parsed.storeAuthored) continue;
        const command = parseCommand(comment.body);
        if (!command) continue;
        maxCommandId = Math.max(maxCommandId, comment.id);
        actions.push({ actor: parsed.login, command, source: `/${command.verb}${command.target ? ` ${command.target}` : ''}` });
      }
    }
    if (decoded.approvals.length > 0) {
      const events = await transport.paginate(`${repo}/issues/${issue.number}/events`);
      for (const approval of decoded.approvals) {
        const label = `${labelPrefix}approved:${approval}`;
        const event = events.filter((entry) => entry.event === 'labeled' && entry.label?.name === label).at(-1);
        removeLabels.push(label);
        const [verb, target = ''] = APPROVAL_LABELS[approval].split(' ');
        actions.push({ actor: event?.actor?.login || 'unknown', command: { verb, target, note: '' }, source: `label ${label}` });
      }
    }

    for (const { actor, command, source } of actions) {
      changed = true;
      if (!await canWrite(actor)) {
        messages.push({ author: 'Project Admin', body: `Ignored ${source} from @${actor}: approvals need write, maintain, or admin permission on ${repository}.`, createdAt: now() });
        continue;
      }
      try {
        const result = applyHumanCommand(item, kind, command, { actor, now: now(), resolveOwner });
        item = applyUpdate(item, result.patch, now());
        messages.push(...result.messages);
      } catch (error) {
        messages.push({ author: 'Project Admin', body: `Could not apply ${source} from @${actor}: ${error.message}.`, createdAt: now() });
      }
    }
    if (!changed) return false;
    item = { ...item, lastCommandId: maxCommandId };
    const current = { ...issue, labels: labelNames(issue).filter((name) => !removeLabels.includes(name)) };
    await writeItem(current, item, messages);
    return true;
  }

  async function sync() {
    const state = (await telemetry.system.get('githubSync')) || {};
    const startedAt = new Date(now().toMillis()).toISOString();
    // A minute of overlap absorbs clock skew; re-processing is idempotent
    // because commands older than lastCommandId are skipped.
    const since = state.lastSyncAt ? `&since=${encodeURIComponent(new Date(Date.parse(state.lastSyncAt) - 60_000).toISOString())}` : '';
    const issues = await transport.paginate(`${repo}/issues?state=open${since}`);
    let applied = 0;
    for (const issue of issues) if (await syncIssue(issue)) applied += 1;
    await telemetry.system.merge('githubSync', { lastSyncAt: startedAt });
    return { scanned: issues.length, applied };
  }

  async function list({ kind = null, waitingOn = null, limit = 300 } = {}) {
    await sync();
    const labels = [kind && `${labelPrefix}kind:${kind}`, waitingOn && `${labelPrefix}waiting:${waitingOn}`].filter(Boolean);
    const state = waitingOn && waitingOn !== 'done' ? 'open' : 'all';
    const query = `${repo}/issues?state=${state}${labels.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
    const issues = await transport.paginate(query, { max: limit == null ? Infinity : limit * 2 });
    return issues.map((issue) => decodeIssue(issue, decodeOptions)).filter(Boolean)
      .map(({ item }) => ({ id: String(item.number), ...item }))
      .filter((item) => (!kind || item.kind === kind) && (!waitingOn || item.waitingOn === waitingOn))
      .slice(0, limit ?? undefined);
  }

  const unsupported = (what) => async () => {
    throw new Error(`${what} is not available with the github backend; repository collaborators are the access list, managed in GitHub settings`);
  };

  return {
    backend: 'github',
    repository,
    capabilities: { atomicClaims: false, dashboard: false, attachments: 'none', users: false },
    now,
    fromMillis: (millis) => StoreTimestamp.fromMillis(millis),
    serverTimestamp,
    sync,

    items: {
      // GitHub numbers the issue; that number is the item number for every kind.
      async create(kind, build) {
        const draft = build(0);
        const { messages: _draftMessages, ...draftFields } = draft;
        const issue = await transport.request('POST', `${repo}/issues`, {
          title: draft.title,
          body: renderBody(draft.description, fieldsOf(draftFields)),
          labels: labelsFor(labelPrefix, draft),
        });
        const data = applyUpdate({}, build(issue.number), now());
        for (const message of data.messages || []) await postMessage(issue.number, message);
        return { id: String(issue.number), number: issue.number };
      },
      async get(id) { return (await readItem(id))?.item ?? null; },
      getMany,
      list,
      update,
      transact,
      claim,
    },
    runs: telemetry.runs,
    machines: telemetry.machines,
    system: telemetry.system,
    users: { get: unsupported('User management'), list: unsupported('User management'), merge: unsupported('User management'), remove: unsupported('User management') },
    attachments: {
      async upload(paths) {
        if (!paths || paths === true) return [];
        throw new Error('--images is not supported with the github backend; attach files by dragging them into the issue comment box on GitHub');
      },
    },
  };
}

module.exports = { createGitHubStore };
