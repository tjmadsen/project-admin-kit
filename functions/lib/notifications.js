'use strict';

const REVIEW_GATES = new Set([
  'triage', 'question', 'plan_review', 'pr_review', 'deploy_approval', 'acceptance_review',
]);
const TERMINAL_STATUSES = new Set(['shipped', 'closed', 'declined', 'wont_fix']);
const GATE_LABELS = {
  triage: 'new-item triage',
  question: 'agent question',
  plan_review: 'plan review',
  pr_review: 'PR review',
  deploy_approval: 'deploy approval',
  acceptance_review: 'hands-on acceptance',
};
const ACTION_COPY = {
  triage: 'Review the new item and route it to an agent.',
  question: 'Review the question, add an answer, and return the item to the agent.',
  plan_review: 'Review the implementation plan and approve it or request changes.',
  pr_review: 'Review the completed implementation and approve its release direction or request changes.',
  deploy_approval: 'Review the exact release scope and approve or decline the deployment.',
  acceptance_review: 'Try the deployed build, then accept it or request another implementation pass.',
};

function effectiveGate(item) {
  if (!item || item.waitingOn !== 'human') return null;
  if (REVIEW_GATES.has(item.blockedReason)) return item.blockedReason;
  if (!item.assignedTo) return 'triage';
  if (item.status === 'plan_review') return 'plan_review';
  if (item.status === 'in_review' && item.prUrl) return 'pr_review';
  if (item.status === 'ready_for_deploy') return 'deploy_approval';
  if (item.status === 'blocked') return 'question';
  return 'triage';
}

function latestMessage(item) {
  const messages = Array.isArray(item?.messages) ? item.messages : [];
  return messages.at(-1) || null;
}

function messageBody(item) {
  const body = latestMessage(item)?.body?.trim();
  return body || item?.resolution?.trim() || item?.deploymentResult?.trim() || item?.description?.trim() || 'No additional details were provided.';
}

// A deployment failure alerts once per entry into the question gate. Later
// thread messages while the item still sits at that gate are ordinary
// progress and never re-alert (FR-108: one stuck item used to send 26 copies).
function hasNewDeploymentFailure(before, after) {
  if (effectiveGate(after) !== 'question' || effectiveGate(before) === 'question') return false;
  const afterMessage = latestMessage(after)?.body?.trim() || '';
  const details = `${after?.deploymentResult || ''}\n${afterMessage}`;
  const deploymentContext = /(deploy|release|testflight|firebase|hosting|function|vercel|cloud run|app store)/i.test(details);
  const failureContext = /(fail|failed|failure|blocked|error|timed out|timeout|missing credential|could not|did not reach)/i.test(details);
  return deploymentContext && failureContext;
}

function referenceFor(collectionId, item) {
  return `${collectionId === 'bugs' ? 'BUG' : 'FR'}-${item.number ?? '?'}`;
}

function kindFor(collectionId) {
  return collectionId === 'bugs' ? 'bug' : 'feature';
}

function dedupeEmails(emails) {
  const seen = new Set();
  return emails.filter((email) => {
    const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).map((email) => email.trim().toLowerCase());
}

function ownerLabel(owner) {
  if (!owner) return 'Unassigned';
  const token = owner.replace(/-agent$/, '').replaceAll('-', ' ');
  return token.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function deploymentTypeFor(item) {
  if (Array.isArray(item?.deploymentApprovedTargets) && item.deploymentApprovedTargets.length > 0) return item.deploymentApprovedTargets.join(' + ');
  if (Array.isArray(item?.deploymentTargets) && item.deploymentTargets.length > 0) return item.deploymentTargets.join(' + ');
  return item?.deploymentType || null;
}

function itemUrl(adminBaseUrl, collectionId, reference, gate) {
  const route = collectionId === 'bugs' ? 'bugs' : 'features';
  const base = String(adminBaseUrl || 'https://example.com/admin').replace(/\/$/, '');
  const url = new URL(`${base}/${route}`);
  url.searchParams.set('item', reference);
  if (gate) url.searchParams.set('gate', gate);
  return url.toString();
}

function notificationIdFor(eventId, type) {
  return `${eventId}-${type}`.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function buildNotification({ before, after, collectionId, adminEmail, adminEmails, adminBaseUrl, projectName = 'Project' }) {
  if (!after) return null;
  const reference = referenceFor(collectionId, after);
  const previousGate = effectiveGate(before);
  const gate = effectiveGate(after);
  const previousStatus = before?.status;
  const status = after.status;
  const requester = after.createdByEmail;
  let type;
  let recipients;
  let reason;
  let action;
  let subject;
  const administrators = dedupeEmails([...(adminEmails || []), adminEmail]);

  if (TERMINAL_STATUSES.has(status) && status !== previousStatus) {
    type = 'final_outcome';
    recipients = dedupeEmails([requester || administrators[0]]);
    reason = `${reference} was marked ${status.replaceAll('_', ' ')}.`;
    action = 'No action is required. The complete history remains available in the admin console.';
    subject = `[${projectName}] ${reference} completed — ${status.replaceAll('_', ' ')}`;
  } else if (hasNewDeploymentFailure(before, after)) {
    type = 'deployment_failure';
    recipients = administrators;
    reason = `The release workflow reported a failure for ${reference}.`;
    action = 'Review the blocker and decide whether to retry or return the item to an agent.';
    subject = `[${projectName}] ${reference} deployment failed`;
  } else if (gate && gate !== previousGate) {
    type = 'action_required';
    recipients = dedupeEmails([...administrators, gate === 'question' ? requester : null]);
    reason = `${reference} entered ${GATE_LABELS[gate]}.`;
    action = ACTION_COPY[gate];
    subject = `[${projectName}] ${reference} needs your action — ${GATE_LABELS[gate]}`;
  } else {
    return null;
  }

  if (recipients.length === 0) return null;
  return {
    type,
    kind: kindFor(collectionId),
    reference,
    gate: type === 'action_required' ? gate : null,
    gateEntered: Boolean(gate && gate !== previousGate),
    recipients,
    subject,
    reason,
    action,
    title: after.title || 'Untitled work item',
    priority: after.priority || 'medium',
    owner: ownerLabel(after.assignedTo),
    latestUpdate: messageBody(after),
    primaryUrl: itemUrl(adminBaseUrl, collectionId, reference, type === 'action_required' ? gate : null),
    prUrl: typeof after.prUrl === 'string' && /^https:\/\//i.test(after.prUrl) ? after.prUrl : null,
    deploymentType: deploymentTypeFor(after),
    deploymentBuild: after.deploymentBuild || null,
    projectName,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function truncate(value, length = 1800) {
  const normalized = String(value).trim();
  return normalized.length > length ? `${normalized.slice(0, length - 1)}…` : normalized;
}

function renderEmail(notification) {
  const update = truncate(notification.latestUpdate);
  const context = [
    notification.prUrl ? `PR: ${notification.prUrl}` : null,
    notification.deploymentType ? `Release: ${notification.deploymentType.replaceAll('_', ' ')}` : null,
    notification.deploymentBuild ? `Build: ${notification.deploymentBuild}` : null,
  ].filter(Boolean);
  const text = [
    notification.projectName,
    '',
    `${notification.reference} — ${notification.title}`,
    notification.reason,
    '',
    `Action: ${notification.action}`,
    '',
    'Newest update:',
    update,
    '',
    `Priority: ${notification.priority}`,
    `Owner: ${notification.owner}`,
    ...context,
    '',
    `Open ${notification.reference}: ${notification.primaryUrl}`,
  ].join('\n');
  const secondary = notification.prUrl
    ? `<p style="margin:18px 0 0"><a href="${escapeHtml(notification.prUrl)}" style="color:#176443">View linked pull request</a></p>`
    : '';
  const release = [
    notification.deploymentType ? `Release: ${notification.deploymentType.replaceAll('_', ' ')}` : null,
    notification.deploymentBuild ? `Build: ${notification.deploymentBuild}` : null,
  ].filter(Boolean).map((line) => `<span style="margin-right:18px">${escapeHtml(line)}</span>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f6f4;color:#17231c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(notification.reason)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;margin:auto;background:#fff;border:1px solid #dce6df;border-radius:16px;overflow:hidden"><tr><td style="padding:24px 28px;background:#123d2c;color:#fff"><div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.75">${escapeHtml(notification.projectName)}</div><h1 style="margin:8px 0 0;font-size:24px;line-height:1.25">${escapeHtml(notification.reference)} — ${escapeHtml(notification.title)}</h1></td></tr><tr><td style="padding:28px"><p style="margin:0 0 12px;font-size:17px;line-height:1.5"><strong>${escapeHtml(notification.reason)}</strong></p><p style="margin:0 0 24px;line-height:1.5">${escapeHtml(notification.action)}</p><a href="${escapeHtml(notification.primaryUrl)}" style="display:inline-block;padding:13px 20px;border-radius:8px;background:#1f7a50;color:#fff;text-decoration:none;font-weight:700">Open ${escapeHtml(notification.reference)} in ${escapeHtml(notification.projectName)} Admin</a><div style="margin:28px 0 0;padding:18px;background:#f3f6f4;border-radius:10px"><div style="margin-bottom:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#557064">Newest update</div><div style="white-space:pre-wrap;line-height:1.5">${escapeHtml(update)}</div></div><p style="margin:18px 0 0;color:#557064;font-size:14px">Priority: <strong>${escapeHtml(notification.priority)}</strong> &nbsp; Owner: <strong>${escapeHtml(notification.owner)}</strong></p>${release ? `<p style="margin:8px 0 0;color:#557064;font-size:14px">${release}</p>` : ''}${secondary}</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

module.exports = {
  buildNotification,
  effectiveGate,
  hasNewDeploymentFailure,
  itemUrl,
  notificationIdFor,
  renderEmail,
};
