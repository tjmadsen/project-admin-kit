'use strict';

// How a work item maps onto a GitHub issue, and how a human drives its gates
// from the GitHub UI. Pure functions only; github-store.js does the I/O.
//
//   issue number      -> item id and number (FR-12 is issue #12)
//   title             -> title
//   body              -> description, plus a hidden `project-admin:fields`
//                        block (JSON) the store owns: assignedTo, lease,
//                        branchName, prUrl, deployment snapshot/evidence, ...
//   labels            -> <prefix>kind:<kind>, status:<status>,
//                        waiting:<waitingOn>, gate:<blockedReason>,
//                        priority:<priority>, plus <prefix>claimed
//   comments          -> thread messages (store-authored ones carry a hidden
//                        author marker; any other comment is a human message)
//   open/closed       -> closed exactly when the status is terminal

const {
  assertClosableWithoutDeployment,
  deploymentTargetsFor,
  missingDeploymentEvidence,
  validateDeploymentNotes,
} = require('../deployment-contract');
const { decode, encode } = require('./values');

// Fields the labels and the issue itself carry; everything else is in the block.
const LABEL_FIELDS = ['kind', 'status', 'waitingOn', 'blockedReason', 'priority'];
const ISSUE_FIELDS = ['title', 'description', 'number', 'messages', 'createdAt', 'updatedAt'];
const FIELDS_START = '<!-- project-admin:fields';
const FIELDS_END = '-->';
const MESSAGE_MARKER = /^<!-- project-admin:message (\{.*?\}) -->\n?/;
const CLAIM_MARKER = /^<!-- project-admin:claim (\{.*?\}) -->/;
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
// Label a human adds in the GitHub UI -> the slash command it stands for.
const APPROVAL_LABELS = Object.freeze({ plan: 'approve plan', pr: 'approve pr', deploy: 'approve deploy', acceptance: 'accept' });
const HUMAN_GATES = ['triage', 'question', 'plan_review', 'pr_review'];

function labelNames(issue) {
  return (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name));
}

function labelsFor(prefix, item) {
  return [
    `${prefix}kind:${item.kind}`,
    item.status && `${prefix}status:${item.status}`,
    item.waitingOn && `${prefix}waiting:${item.waitingOn}`,
    item.blockedReason && `${prefix}gate:${item.blockedReason}`,
    item.priority && `${prefix}priority:${item.priority}`,
    item.claimedBy && `${prefix}claimed`,
  ].filter(Boolean);
}

function parseLabels(prefix, names) {
  const parsed = { approvals: [] };
  const keys = { kind: 'kind', status: 'status', waiting: 'waitingOn', gate: 'blockedReason', priority: 'priority' };
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const [group, ...rest] = name.slice(prefix.length).split(':');
    const value = rest.join(':');
    if (keys[group] && value) parsed[keys[group]] = value;
    if (group === 'approved' && APPROVAL_LABELS[value]) parsed.approvals.push(value);
  }
  return parsed;
}

// JSON inside an HTML comment: "-->" can only occur inside a string, where
// ">" decodes back to ">".
function renderBody(description, fields) {
  const json = JSON.stringify(encode(fields), null, 1).replace(/-->/g, '--\\u003e');
  return `${String(description || '').trim()}\n\n${FIELDS_START}\n${json}\n${FIELDS_END}\n`;
}

function parseBody(body) {
  const text = String(body || '');
  const start = text.lastIndexOf(FIELDS_START);
  if (start === -1) return { description: text.trim(), fields: null };
  const end = text.indexOf(FIELDS_END, start + FIELDS_START.length);
  if (end === -1) return { description: text.trim(), fields: null };
  let fields = null;
  try { fields = decode(JSON.parse(text.slice(start + FIELDS_START.length, end))); } catch { fields = null; }
  return { description: text.slice(0, start).trim(), fields };
}

function fieldsOf(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !LABEL_FIELDS.includes(key) && !ISSUE_FIELDS.includes(key) && key !== 'id'));
}

function renderMessage(message) {
  const meta = { author: message.author };
  if (message.authorEmail) meta.authorEmail = message.authorEmail;
  if (message.imageUrls?.length) meta.imageUrls = message.imageUrls;
  const images = (message.imageUrls || []).map((url) => `\n- ${url}`).join('');
  return `<!-- project-admin:message ${JSON.stringify(meta).replace(/-->/g, '--\\u003e')} -->\n**${message.author}:** ${message.body}${images ? `\n\nAttachments:${images}` : ''}`;
}

// A comment is a claim marker, a store-authored message, or a human message.
function parseComment(comment, toTimestamp) {
  const body = String(comment.body || '');
  const claim = body.match(CLAIM_MARKER);
  if (claim) {
    try { return { type: 'claim', id: comment.id, ...JSON.parse(claim[1]) }; } catch { return { type: 'claim', id: comment.id }; }
  }
  const createdAt = toTimestamp(comment.created_at);
  const marker = body.match(MESSAGE_MARKER);
  if (marker) {
    let meta = {};
    try { meta = JSON.parse(marker[1]); } catch { meta = {}; }
    const rest = body.slice(marker[0].length);
    const prefix = `**${meta.author}:** `;
    const [text] = (rest.startsWith(prefix) ? rest.slice(prefix.length) : rest).split('\n\nAttachments:\n- ');
    const message = { author: meta.author || 'agent', body: text, createdAt, commentId: comment.id };
    if (meta.authorEmail) message.authorEmail = meta.authorEmail;
    if (Array.isArray(meta.imageUrls)) message.imageUrls = meta.imageUrls;
    return { type: 'message', storeAuthored: true, message };
  }
  const login = comment.user?.login || 'unknown';
  return { type: 'message', storeAuthored: false, login, message: { author: `@${login}`, body, createdAt, commentId: comment.id } };
}

function renderClaimComment({ token, agent, runId, at }) {
  return `<!-- project-admin:claim ${JSON.stringify({ token, agent, runId: runId || null, at })} -->\nClaimed by \`${agent}\`${runId ? ` (run ${runId})` : ''}.`;
}

// Issue -> work item. Issues a human opened in the GitHub UI with only a kind
// label start in triage, waiting on a human, as console-created items do.
function decodeIssue(issue, { prefix, kinds, defaults, toTimestamp }) {
  const labels = parseLabels(prefix, labelNames(issue));
  const kind = kinds.find((entry) => entry.id === labels.kind);
  if (!kind || issue.pull_request) return null;
  const { description, fields } = parseBody(issue.body);
  const adopted = !labels.status;
  const item = {
    kind: kind.id,
    number: issue.number,
    title: issue.title,
    description,
    priority: labels.priority || 'medium',
    status: labels.status || kind.statuses.initial,
    waitingOn: labels.waitingOn || (adopted ? 'human' : 'agent'),
    blockedReason: labels.blockedReason || (adopted ? 'triage' : null),
    assignedTo: defaults.assignedTo,
    thinkingEffort: 'xhigh',
    targetMachine: 'any',
    deploymentTargets: [],
    deploymentType: 'none',
    ...(fields || {}),
    createdAt: toTimestamp(issue.created_at),
    updatedAt: toTimestamp(issue.updated_at),
  };
  // Closing or reopening in the UI wins over stale labels.
  if (issue.state === 'closed' && !kind.terminalStatuses.includes(item.status)) {
    Object.assign(item, { status: issue.state_reason === 'not_planned' ? kind.statuses.declined : kind.statuses.done, waitingOn: 'done', blockedReason: null });
  }
  return { item, kind, adopted, approvals: labels.approvals };
}

function issueStateFor(item, kind) {
  if (!kind.terminalStatuses.includes(item.status)) return { state: 'open' };
  return { state: 'closed', state_reason: item.status === kind.statuses.declined ? 'not_planned' : 'completed' };
}

// Parses "/approve deploy", "/agent please also ...", "/decline not now".
function parseCommand(body) {
  const firstLine = String(body || '').trim().split('\n')[0].trim();
  const match = firstLine.match(/^\/(approve|accept|agent|decline|close-no-deploy|assign)\b\s*(.*)$/i);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  let rest = match[2].trim();
  const remainder = String(body).trim().split('\n').slice(1).join('\n').trim();
  if (verb === 'approve') {
    const target = rest.split(/\s+/)[0]?.toLowerCase();
    if (['plan', 'pr', 'deploy'].includes(target)) return { verb, target, note: rest.slice(target.length).trim() || remainder };
    return { verb, target: '', note: rest || remainder };
  }
  if (remainder) rest = rest ? `${rest}\n${remainder}` : remainder;
  return { verb, target: '', note: rest };
}

const clearClaim = { claimedBy: null, claimRunId: null, leaseExpiresAt: null };

// Applies one human command to an item. Returns { patch, messages } or throws
// with the reason the command does not apply; the caller reports it.
function applyHumanCommand(item, kind, command, { actor, now, resolveOwner }) {
  const by = `@${actor}`;
  const note = (text) => [{ author: by, body: text, createdAt: now }];
  const toAgent = (body) => ({ patch: { waitingOn: 'agent', status: 'in_progress', blockedReason: null, ...clearClaim }, messages: note(body) });
  const gate = item.waitingOn === 'human' ? (item.blockedReason || 'question') : null;
  switch (command.verb) {
    case 'approve': {
      if (command.target === 'deploy') {
        if (!kind.deploys) throw new Error(`${kind.pluralLabel} never deploy`);
        if (gate !== 'deploy_approval') throw new Error('the item is not waiting for deploy approval');
        const targets = deploymentTargetsFor(item, false);
        if (targets.length === 0) throw new Error('no deployment targets are recorded; the agent must run deploy-pending first');
        const notes = validateDeploymentNotes(item.deploymentNotes);
        if (item.prNumber && Number(item.deploymentNotesPrNumber || 0) !== Number(item.prNumber)) {
          throw new Error(`the deploy notes were written for PR #${item.deploymentNotesPrNumber || '?'}, not the current PR #${item.prNumber}`);
        }
        return {
          patch: {
            waitingOn: 'deployer', status: 'ready_for_deploy', blockedReason: null,
            deploymentApprovedTargets: targets, deploymentApprovedNotes: notes,
            deploymentApprovedAt: now, deploymentApprovedBy: `github:${actor}`,
            deploymentEvidence: {}, deploymentResult: '', deploymentVerifiedAt: null, ...clearClaim,
          },
          messages: note(`Approved deployment of ${targets.join(', ')}.${command.note ? ` ${command.note}` : ''}`),
        };
      }
      const expected = { plan: ['plan_review'], pr: ['pr_review'], '': HUMAN_GATES }[command.target];
      if (!gate || !expected.includes(gate)) throw new Error(`the item is not waiting for ${command.target ? `${command.target} approval` : 'an approval'} (gate: ${gate || 'none'})`);
      return toAgent(`✅ Approved — please continue.${command.note ? ` ${command.note}` : ''}`);
    }
    case 'accept': {
      if (gate !== 'acceptance_review') throw new Error('the item is not waiting for acceptance');
      const targets = deploymentTargetsFor(item, true);
      const missing = missingDeploymentEvidence(item, targets).filter((target) => !(target === 'testflight' && item.deploymentBuild && item.deploymentResult));
      if (targets.length === 0 || missing.length > 0) throw new Error(`verification evidence is missing for: ${missing.join(', ') || 'the approved targets'}`);
      return {
        patch: { status: kind.statuses.done, waitingOn: 'done', blockedReason: null, [kind.completedAtField]: now, deploymentAcceptedAt: now, resolution: `Accepted by ${by} after deployment verification.`, ...clearClaim },
        messages: note(`Accepted.${command.note ? ` ${command.note}` : ''}`),
      };
    }
    case 'agent':
      if (item.waitingOn !== 'human' && item.waitingOn !== 'hold') throw new Error(`the item is waiting on ${item.waitingOn}, not a human`);
      return toAgent(command.note || 'Returned to the agent.');
    case 'decline':
      if (kind.terminalStatuses.includes(item.status)) throw new Error(`the item is already ${item.status}`);
      return { patch: { status: kind.statuses.declined, waitingOn: 'done', blockedReason: null, resolution: command.note || `Declined by ${by}.`, ...clearClaim }, messages: note(`Declined.${command.note ? ` ${command.note}` : ''}`) };
    case 'close-no-deploy': {
      if (!command.note) throw new Error('add a resolution note after /close-no-deploy');
      assertClosableWithoutDeployment(item);
      return {
        patch: { status: kind.statuses.done, [kind.completedAtField]: now, waitingOn: 'done', blockedReason: null, resolution: command.note, ...clearClaim },
        messages: note(`Closed without deployment: ${command.note}`),
      };
    }
    case 'assign': {
      const owner = resolveOwner(command.note.split(/\s+/)[0]);
      return { patch: { assignedTo: owner }, messages: note(`Assigned to ${owner}.`) };
    }
    default:
      throw new Error(`unknown command /${command.verb}`);
  }
}

module.exports = {
  APPROVAL_LABELS, CLAIM_MARKER, FIELDS_START, HUMAN_GATES, ISSUE_FIELDS, LABEL_FIELDS, WRITE_PERMISSIONS,
  applyHumanCommand, decodeIssue, fieldsOf, issueStateFor, labelNames, labelsFor, parseBody, parseCommand,
  parseComment, parseLabels, renderBody, renderClaimComment, renderMessage,
};
