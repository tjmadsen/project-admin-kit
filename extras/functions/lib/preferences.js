'use strict';

// Per-user delivery preferences for lifecycle notifications. Each
// adminUsers/{email} record may carry a `notifications` map with an `email`
// and a `push` map of event-type booleans. Missing keys fall back to the
// defaults below: push stays on for everything, email is limited to gate
// entries and final outcomes, and deployment progress never emails.
const EVENT_TYPES = ['action_required', 'deployment_failure', 'deployment_progress', 'final_outcome'];
const CHANNELS = ['email', 'push'];
const DEFAULT_PREFERENCES = Object.freeze({
  email: Object.freeze({
    action_required: true,
    deployment_failure: false,
    deployment_progress: false,
    final_outcome: true,
  }),
  push: Object.freeze({
    action_required: true,
    deployment_failure: true,
    deployment_progress: true,
    final_outcome: true,
  }),
});

// Repeated email for the same gate on the same item is suppressed inside this
// window; a bounce back to a gate re-emails only after it elapses.
const GATE_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function resolvePreferences(record) {
  const stored = record && typeof record.notifications === 'object' ? record.notifications : {};
  const resolved = {};
  for (const channel of CHANNELS) {
    const channelStored = stored?.[channel] && typeof stored[channel] === 'object' ? stored[channel] : {};
    resolved[channel] = {};
    for (const type of EVENT_TYPES) {
      const value = channelStored[type];
      resolved[channel][type] = typeof value === 'boolean' ? value : DEFAULT_PREFERENCES[channel][type];
    }
  }
  return resolved;
}

// A deployment failure that also enters a human gate still counts as an
// action-required event for anyone who muted failure alerts but kept gate
// entries on, so muting the noisier type never hides the gate itself.
function channelAllowed(preferences, channel, notification) {
  const channelPreferences = preferences[channel];
  if (channelPreferences[notification.type]) return true;
  return Boolean(notification.gateEntered) && channelPreferences.action_required === true;
}

function recipientsForChannel({ notification, channel, records }) {
  return notification.recipients.filter((recipient) => {
    const record = records instanceof Map ? records.get(normalizeEmail(recipient)) : records?.[normalizeEmail(recipient)];
    return channelAllowed(resolvePreferences(record), channel, notification);
  });
}

async function loadPreferenceRecords(db, recipients) {
  const emails = [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
  const records = new Map();
  if (emails.length === 0) return records;
  const snapshots = await db.getAll(...emails.map((email) => db.collection('adminUsers').doc(email)));
  snapshots.forEach((snapshot, index) => {
    records.set(emails[index], snapshot.exists ? snapshot.data() : null);
  });
  return records;
}

// Email dedupe key: gate entries and deployment failures share the gate they
// entered, and final outcomes share one key so a reopen/close bounce inside the
// window sends a single completion email.
function gateEmailKey(notification) {
  if (notification.type === 'final_outcome') return 'final_outcome';
  if (notification.type === 'deployment_progress') return null;
  return notification.gate || (notification.type === 'deployment_failure' ? 'question' : null);
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function emailSuppressedByGateWindow({ state, key, now = Date.now(), windowMs = GATE_EMAIL_WINDOW_MS }) {
  if (!key) return false;
  const last = toMillis(state?.gateEmails?.[key]);
  return last !== null && now - last < windowMs;
}

function gateStateDocumentId(workItemPath) {
  return String(workItemPath).replace(/[^a-zA-Z0-9_-]/g, '-');
}

// Decides which recipients get email and which get push for one notification,
// honoring per-user preferences first and then the per-item gate email window.
async function planDelivery({ db, notification, workItemPath, now = Date.now(), windowMs = GATE_EMAIL_WINDOW_MS }) {
  const records = await loadPreferenceRecords(db, notification.recipients);
  const push = recipientsForChannel({ notification, channel: 'push', records });
  let email = recipientsForChannel({ notification, channel: 'email', records });
  const key = gateEmailKey(notification);
  let stateReference = null;
  let suppressedReason = null;
  if (email.length > 0 && key) {
    stateReference = db.collection('notificationGateState').doc(gateStateDocumentId(workItemPath));
    const snapshot = await stateReference.get();
    if (emailSuppressedByGateWindow({ state: snapshot.exists ? snapshot.data() : null, key, now, windowMs })) {
      email = [];
      suppressedReason = 'gate_email_window';
    }
  } else if (email.length === 0 && notification.recipients.length > 0) {
    suppressedReason = 'recipient_preferences';
  }
  return { email, push, key, stateReference, suppressedReason };
}

module.exports = {
  CHANNELS,
  DEFAULT_PREFERENCES,
  EVENT_TYPES,
  GATE_EMAIL_WINDOW_MS,
  channelAllowed,
  emailSuppressedByGateWindow,
  gateEmailKey,
  gateStateDocumentId,
  loadPreferenceRecords,
  planDelivery,
  recipientsForChannel,
  resolvePreferences,
};
