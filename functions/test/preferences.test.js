'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_PREFERENCES,
  EVENT_TYPES,
  GATE_EMAIL_WINDOW_MS,
  channelAllowed,
  emailSuppressedByGateWindow,
  gateEmailKey,
  gateStateDocumentId,
  planDelivery,
  recipientsForChannel,
  resolvePreferences,
} = require('../lib/preferences');
const { buildNotification } = require('../lib/notifications');

const adminEmail = 'owner@example.com';
const requester = 'logan@example.com';
const base = {
  number: 108,
  title: 'Reduce Email Volume',
  priority: 'medium',
  status: 'in_progress',
  waitingOn: 'agent',
  blockedReason: null,
  assignedTo: 'opus-agent',
  createdByEmail: requester,
  messages: [],
};

function notification(before, after) {
  return buildNotification({ before, after, collectionId: 'featureRequests', adminEmail, adminBaseUrl: 'https://mfl-live.com/admin' });
}

const questionGate = notification(base, { ...base, status: 'blocked', waitingOn: 'human', blockedReason: 'question', messages: [{ body: 'Which option?' }] });
const failure = notification(base, { ...base, status: 'blocked', waitingOn: 'human', blockedReason: 'question', messages: [{ body: 'Firebase deployment failed: missing credential.' }] });
const active = { ...base, status: 'ready_for_deploy', waitingOn: 'deployer', deploymentStartedAt: '2026-09-14T18:00:00.000Z', messages: [{ body: 'Build started.' }] };
// This kit's lifecycle triggers do not emit deployment_progress yet; the
// preference model still accepts it so a project that adds progress alerts
// gets push-only delivery by default.
const progress = { ...notification(base, { ...active, status: 'blocked', waitingOn: 'human', blockedReason: 'question' }), type: 'deployment_progress', gate: null, gateEntered: false, recipients: [adminEmail] };
const shipped = notification(base, { ...base, status: 'shipped', waitingOn: 'done' });

function fakeDatabase({ users = {}, gateState = null } = {}) {
  const state = { writes: [] };
  const userDoc = (email) => ({ id: email, collectionId: 'adminUsers' });
  return {
    state,
    collection(name) {
      if (name === 'adminUsers') return { doc: userDoc };
      assert.equal(name, 'notificationGateState');
      return {
        doc(id) {
          state.gateDocumentId = id;
          return {
            async get() { return { exists: gateState !== null, data: () => gateState }; },
            async set(values) { state.writes.push(values); },
          };
        },
      };
    },
    async getAll(...references) {
      state.loaded = references.map((reference) => reference.id);
      return references.map((reference) => ({
        exists: Object.hasOwn(users, reference.id),
        data: () => users[reference.id],
      }));
    },
  };
}

describe('per-user notification preferences', () => {
  it('defaults to push for everything and email for gate entries and outcomes only', () => {
    const resolved = resolvePreferences(null);
    assert.deepEqual(resolved, {
      email: { action_required: true, deployment_failure: false, deployment_progress: false, final_outcome: true },
      push: { action_required: true, deployment_failure: true, deployment_progress: true, final_outcome: true },
    });
    assert.deepEqual(Object.keys(DEFAULT_PREFERENCES.email), EVENT_TYPES);
  });

  it('honors stored booleans and ignores malformed values', () => {
    const resolved = resolvePreferences({ notifications: { email: { action_required: false, deployment_progress: 'yes' }, push: 'nope' } });
    assert.equal(resolved.email.action_required, false);
    assert.equal(resolved.email.deployment_progress, false);
    assert.equal(resolved.push.action_required, true);
  });

  it('never emails deployment progress by default but still pushes it', () => {
    const defaults = resolvePreferences(null);
    assert.equal(channelAllowed(defaults, 'email', progress), false);
    assert.equal(channelAllowed(defaults, 'push', progress), true);
  });

  it('treats a deployment failure that enters a gate as an action-required email', () => {
    const defaults = resolvePreferences(null);
    assert.equal(failure.type, 'deployment_failure');
    assert.equal(failure.gateEntered, true);
    assert.equal(channelAllowed(defaults, 'email', failure), true);
    const muted = resolvePreferences({ notifications: { email: { action_required: false } } });
    assert.equal(channelAllowed(muted, 'email', failure), false);
  });

  it('filters recipients per channel using each person’s own record', () => {
    const records = new Map([
      [adminEmail, { notifications: { email: { action_required: false }, push: { action_required: true } } }],
      [requester, null],
    ]);
    assert.deepEqual(recipientsForChannel({ notification: questionGate, channel: 'email', records }), [requester]);
    assert.deepEqual(recipientsForChannel({ notification: questionGate, channel: 'push', records }), [adminEmail, requester]);
  });

  it('keys the email window by gate, shares it between failures and gate entries, and skips progress', () => {
    assert.equal(gateEmailKey(questionGate), 'question');
    assert.equal(gateEmailKey(failure), 'question');
    assert.equal(gateEmailKey(shipped), 'final_outcome');
    assert.equal(gateEmailKey(progress), null);
    assert.equal(gateStateDocumentId('featureRequests/abc/DEF'), 'featureRequests-abc-DEF');
  });

  it('suppresses a repeat email inside 24 hours and allows it afterwards', () => {
    const now = Date.parse('2026-09-14T22:00:00.000Z');
    const recent = { gateEmails: { question: new Date(now - 60 * 60 * 1000) } };
    const stale = { gateEmails: { question: { toMillis: () => now - GATE_EMAIL_WINDOW_MS - 1 } } };
    assert.equal(emailSuppressedByGateWindow({ state: recent, key: 'question', now }), true);
    assert.equal(emailSuppressedByGateWindow({ state: stale, key: 'question', now }), false);
    assert.equal(emailSuppressedByGateWindow({ state: recent, key: 'pr_review', now }), false);
    assert.equal(emailSuppressedByGateWindow({ state: null, key: 'question', now }), false);
  });
});

describe('delivery planning', () => {
  it('emails and pushes a first gate entry to everyone with default preferences', async () => {
    const db = fakeDatabase();
    const plan = await planDelivery({ db, notification: questionGate, workItemPath: 'featureRequests/item-1' });
    assert.deepEqual(db.state.loaded, [adminEmail, requester]);
    assert.deepEqual(plan.email, [adminEmail, requester]);
    assert.deepEqual(plan.push, [adminEmail, requester]);
    assert.equal(plan.key, 'question');
    assert.equal(db.state.gateDocumentId, 'featureRequests-item-1');
    assert.equal(plan.suppressedReason, null);
  });

  it('drops email for a bounce back into the same gate within the window but keeps push', async () => {
    const now = Date.now();
    const db = fakeDatabase({ gateState: { gateEmails: { question: new Date(now - 5 * 60 * 1000) } } });
    const plan = await planDelivery({ db, notification: questionGate, workItemPath: 'featureRequests/item-1', now });
    assert.deepEqual(plan.email, []);
    assert.deepEqual(plan.push, [adminEmail, requester]);
    assert.equal(plan.suppressedReason, 'gate_email_window');
  });

  it('sends deployment progress as push only without touching the gate window', async () => {
    const db = fakeDatabase();
    const plan = await planDelivery({ db, notification: progress, workItemPath: 'featureRequests/item-1' });
    assert.deepEqual(plan.email, []);
    assert.deepEqual(plan.push, [adminEmail]);
    assert.equal(plan.stateReference, null);
    assert.equal(plan.suppressedReason, 'recipient_preferences');
  });

  it('lets the owner switch off action-required email entirely while push continues', async () => {
    const db = fakeDatabase({ users: { [adminEmail]: { notifications: { email: { action_required: false, final_outcome: false } } } } });
    const plan = await planDelivery({ db, notification: failure, workItemPath: 'bugs/item-2' });
    assert.deepEqual(plan.email, []);
    assert.deepEqual(plan.push, [adminEmail]);
  });

  it('lets a requester mute completion push while keeping the completion email', async () => {
    const db = fakeDatabase({ users: { [requester]: { notifications: { push: { final_outcome: false } } } } });
    const plan = await planDelivery({ db, notification: shipped, workItemPath: 'featureRequests/item-3' });
    assert.deepEqual(plan.email, [requester]);
    assert.deepEqual(plan.push, []);
    assert.equal(plan.key, 'final_outcome');
  });
});
