'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildNotification, notificationIdFor, renderEmail } = require('../lib/notifications');

const adminEmail = 'owner@example.com';
const adminBaseUrl = 'https://example.com/admin';
const base = {
  number: 9,
  title: 'Improve the Email Updates',
  description: 'Make lifecycle email useful.',
  priority: 'medium',
  status: 'in_progress',
  waitingOn: 'agent',
  blockedReason: null,
  assignedTo: 'sol-agent',
  createdByEmail: 'logan@example.com',
  messages: [],
};

function notification(before, after, kind = 'feature', workKinds) {
  return buildNotification({ before, after, kind, workKinds, adminEmail, adminBaseUrl });
}

describe('lifecycle notification matrix', () => {
  it('emails the owner when a new item enters triage', () => {
    const result = notification(null, { ...base, status: 'backlog', waitingOn: 'human', blockedReason: 'triage' });
    assert.equal(result.type, 'action_required');
    assert.deepEqual(result.recipients, [adminEmail]);
    assert.match(result.subject, /FR-9 needs your action — new-item triage/);
  });

  it('emails the owner and requester for a question without duplicate copies', () => {
    const after = { ...base, status: 'blocked', waitingOn: 'human', blockedReason: 'question', messages: [{ body: 'Which cadence?' }] };
    assert.deepEqual(notification(base, after).recipients, [adminEmail, 'logan@example.com']);
    assert.deepEqual(notification(base, { ...after, createdByEmail: 'owner@example.com' }).recipients, [adminEmail]);
  });

  it('does not email for progress or repeated writes inside the same gate', () => {
    assert.equal(notification(base, { ...base, messages: [{ body: 'Commit pushed' }] }), null);
    const waiting = { ...base, status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', prUrl: 'https://github.com/owner/repository/pull/9' };
    assert.equal(notification(waiting, { ...waiting, priority: 'high' }), null);
  });

  it('covers every human approval gate', () => {
    const transitions = [
      ['plan_review', 'plan_review', {}],
      ['pr_review', 'in_review', { prUrl: 'https://github.com/owner/repository/pull/9' }],
      ['deploy_approval', 'ready_for_deploy', {}],
      ['acceptance_review', 'in_review', {}],
    ];
    for (const [gate, status, extra] of transitions) {
      const result = notification(base, { ...base, ...extra, status, waitingOn: 'human', blockedReason: gate });
      assert.equal(result.gate, gate);
      assert.deepEqual(result.recipients, [adminEmail]);
    }
  });

  it('shows every approved deployment target in approval notifications', () => {
    const result = notification(base, {
      ...base,
      status: 'ready_for_deploy',
      waitingOn: 'human',
      blockedReason: 'deploy_approval',
      deploymentType: 'mixed',
      deploymentTargets: ['firebase_hosting'],
      deploymentApprovedTargets: ['firebase_hosting', 'firebase_functions'],
    });
    assert.equal(result.deploymentType, 'firebase_hosting + firebase_functions');
    assert.match(renderEmail(result).text, /Release: firebase hosting \+ firebase functions/);
  });

  it('emails only the requester when an item reaches a final outcome', () => {
    const result = notification(base, { ...base, status: 'shipped', waitingOn: 'done', resolution: 'Live and verified.' });
    assert.equal(result.type, 'final_outcome');
    assert.deepEqual(result.recipients, ['logan@example.com']);
    assert.match(result.subject, /completed — shipped/);
  });

  it('promotes a deployment blocker to an immediate owner-only alert', () => {
    const result = notification(base, {
      ...base,
      status: 'blocked',
      waitingOn: 'human',
      blockedReason: 'question',
      messages: [{ body: 'Firebase deployment failed: missing credential.' }],
    });
    assert.equal(result.type, 'deployment_failure');
    assert.deepEqual(result.recipients, [adminEmail]);
    assert.match(result.subject, /deployment failed/);
  });

  it('builds an exact admin deep link for features and bugs', () => {
    const feature = notification(base, { ...base, status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review', prUrl: 'https://github.com/owner/repository/pull/9' });
    assert.equal(feature.primaryUrl, 'https://example.com/admin/features?item=FR-9&gate=pr_review');
    const bug = notification({ ...base, number: 12 }, { ...base, number: 12, status: 'plan_review', waitingOn: 'human', blockedReason: 'plan_review' }, 'bug');
    assert.equal(bug.primaryUrl, 'https://example.com/admin/bugs?item=BUG-12&gate=plan_review');
  });

  it('uses configured kind labels, prefixes, and routes', () => {
    const workKinds = { ...require('../project-config.json').workKinds, chore: { label: 'Chore', prefix: 'CH', route: 'chores' } };
    const chore = notification(base, { ...base, kind: 'chore', status: 'in_review', waitingOn: 'human', blockedReason: 'pr_review' }, 'chore', workKinds);
    assert.equal(chore.reference, 'CH-9');
    assert.equal(chore.kind, 'chore');
    assert.equal(chore.kindLabel, 'Chore');
    assert.equal(chore.primaryUrl, 'https://example.com/admin/chores?item=CH-9&gate=pr_review');
    assert.match(renderEmail(chore).text, /^Project · Chore\n/);
    const bug = notification(base, { ...base, status: 'closed', waitingOn: 'done' }, 'bug', workKinds);
    assert.match(bug.subject, /BUG-9 completed — closed/);
  });

  it('stays silent for documents copied by the workItems migration', () => {
    const migrated = { ...base, status: 'shipped', waitingOn: 'done', migratedFrom: 'featureRequests' };
    assert.equal(notification(null, migrated), null);
    assert.equal(notification(null, { ...base, status: 'backlog', waitingOn: 'human', blockedReason: 'triage', migratedFrom: 'featureRequests' }), null);
  });

  it('derives a stable delivery id from the Firestore event', () => {
    assert.equal(notificationIdFor('event/with/slashes', 'action_required'), 'event-with-slashes-action_required');
    assert.equal(notificationIdFor('event/with/slashes', 'action_required'), notificationIdFor('event/with/slashes', 'action_required'));
    assert.notEqual(notificationIdFor('event-one', 'action_required'), notificationIdFor('event-two', 'action_required'));
  });
});

describe('branded email rendering', () => {
  it('includes one primary admin action and escapes thread content', () => {
    const result = notification(base, {
      ...base,
      status: 'blocked',
      waitingOn: 'human',
      blockedReason: 'question',
      messages: [{ body: '<script>alert("no")</script>' }],
    });
    const email = renderEmail(result);
    assert.match(email.text, /Open FR-9: https:\/\/example.com\/admin\/features\?item=FR-9&gate=question/);
    assert.doesNotMatch(email.html, /<script>/);
    assert.match(email.html, /&lt;script&gt;/);
    assert.match(email.html, /Open FR-9 in Project Admin/);
  });
});
