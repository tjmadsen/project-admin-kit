'use strict';

const { initializeApp } = require('firebase-admin/app');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { defineSecret, defineString } = require('firebase-functions/params');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const nodemailer = require('nodemailer');
const { sendLifecycleEmail } = require('./lib/mailer');
const { buildNotification, notificationIdFor, renderEmail } = require('./lib/notifications');
const { planDelivery } = require('./lib/preferences');
const { deliverIndependently, sendLifecyclePush } = require('./lib/push');
const projectConfig = require('./project-config.json');

initializeApp();

const emailUser = defineSecret('EMAIL_USER');
const emailPass = defineSecret('EMAIL_PASS');
const adminEmail = defineString('PROJECT_ADMIN_OWNER_EMAIL', { default: projectConfig.ownerEmail });
const adminBaseUrl = defineString('PROJECT_ADMIN_BASE_URL', { default: projectConfig.adminBaseUrl });
const projectName = defineString('PROJECT_ADMIN_NAME', { default: projectConfig.projectName });
const db = getFirestore();
const messaging = getMessaging();

async function reserveAttempt(id, provider, notification, event, workItemPath) {
  const reference = db.collection('notificationAttempts').doc(id);
  const shouldSend = await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    if (snapshot.data()?.state === 'sent') return false;
    transaction.set(reference, {
      eventId: event.id,
      eventType: notification.type,
      workItemPath,
      reference: notification.reference,
      gate: notification.gate,
      recipients: notification.recipients,
      subject: notification.subject,
      provider,
      state: 'sending',
      attempts: Number(snapshot.data()?.attempts || 0) + 1,
      lastAttemptAt: FieldValue.serverTimestamp(),
      createdAt: snapshot.exists ? snapshot.data().createdAt : FieldValue.serverTimestamp(),
      error: FieldValue.delete(),
    }, { merge: true });
    return true;
  });
  return { reference, shouldSend };
}

async function deliverEmail(notification, event, workItemPath) {
  const notificationId = notificationIdFor(event.id, notification.type);
  const attempt = await reserveAttempt(notificationId, 'gmail_smtp', notification, event, workItemPath);
  if (!attempt.shouldSend) return;
  const email = renderEmail(notification);
  try {
    const result = await sendLifecycleEmail({
      nodemailer,
      emailUser: emailUser.value(),
      emailPass: emailPass.value(),
      notificationId,
      notification,
      email,
    });
    await attempt.reference.set({
      state: 'sent',
      provider: 'gmail_smtp',
      providerMessageId: result.messageId || null,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await attempt.reference.set({
      state: 'failed',
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

async function deliverPush(notification, event, workItemPath) {
  const notificationId = `${notificationIdFor(event.id, notification.type)}-push`;
  const attempt = await reserveAttempt(
    notificationId,
    'firebase_cloud_messaging',
    notification,
    event,
    workItemPath,
  );
  if (!attempt.shouldSend) return;
  try {
    const result = await sendLifecyclePush({ db, messaging, notification });
    await attempt.reference.set({
      state: 'sent',
      provider: 'firebase_cloud_messaging',
      registeredTokenCount: result.registeredTokenCount,
      deliveredCount: result.deliveredCount,
      invalidTokenCount: result.invalidTokenCount,
      outcome: result.registeredTokenCount === 0 ? 'no_registered_devices' : 'completed',
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  } catch (error) {
    await attempt.reference.set({
      state: 'failed',
      error: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    throw error;
  }
}

async function recordSuppressed(notification, event, workItemPath, channel, reason) {
  const notificationId = `${notificationIdFor(event.id, notification.type)}${channel === 'push' ? '-push' : ''}`;
  const reference = db.collection('notificationAttempts').doc(notificationId);
  // A retried event whose email already went out is suppressed by the gate
  // window on the second pass; keep the original sent record intact.
  if ((await reference.get()).data()?.state === 'sent') return;
  await reference.set({
    eventId: event.id,
    eventType: notification.type,
    workItemPath,
    reference: notification.reference,
    gate: notification.gate,
    recipients: notification.recipients,
    subject: notification.subject,
    provider: channel === 'push' ? 'firebase_cloud_messaging' : 'gmail_smtp',
    state: 'suppressed',
    suppressedReason: reason,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// Each recipient's adminUsers/{email}.notifications preferences decide which
// channel carries the event, and one email per item per gate is enforced by
// notificationGateState/<item>. Push delivery is never throttled.
async function deliver(notification, event, workItemPath) {
  const plan = await planDelivery({ db, notification, workItemPath });
  const deliveries = [];
  if (plan.email.length > 0) {
    deliveries.push(async () => {
      await deliverEmail({ ...notification, recipients: plan.email }, event, workItemPath);
      if (plan.stateReference && plan.key) {
        await plan.stateReference.set({
          workItemPath,
          reference: notification.reference,
          gateEmails: { [plan.key]: FieldValue.serverTimestamp() },
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });
  } else {
    deliveries.push(() => recordSuppressed(notification, event, workItemPath, 'email', plan.suppressedReason || 'recipient_preferences'));
  }
  if (plan.push.length > 0) {
    deliveries.push(() => deliverPush({ ...notification, recipients: plan.push }, event, workItemPath));
  } else {
    deliveries.push(() => recordSuppressed(notification, event, workItemPath, 'push', 'recipient_preferences'));
  }
  await deliverIndependently(deliveries);
}

function lifecycleHandler(collectionId) {
  return async (event) => {
    const before = event.data?.before.exists ? event.data.before.data() : null;
    const after = event.data?.after.exists ? event.data.after.data() : null;
    const adminSnapshot = await db.collection('adminUsers').where('role', '==', 'admin').get();
    const adminEmails = adminSnapshot.docs
      .map((document) => document.data())
      .filter((user) => user.active === true)
      .map((user) => user.email);
    const notification = buildNotification({
      before,
      after,
      kind: after?.kind || before?.kind,
      workKinds: projectConfig.workKinds,
      adminEmail: adminEmail.value(),
      adminEmails,
      adminBaseUrl: adminBaseUrl.value(),
      projectName: projectName.value(),
    });
    if (notification) await deliver(notification, event, `${collectionId}/${event.params.itemId}`);
  };
}

const triggerOptions = {
  region: 'us-central1',
  retry: true,
  timeoutSeconds: 60,
  secrets: [emailUser, emailPass],
};

// One trigger covers every configured work kind; labels and routes come from
// project-config.json#workKinds.
exports.notifyWorkItemLifecycle = onDocumentWritten(
  { ...triggerOptions, document: 'workItems/{itemId}' },
  lifecycleHandler('workItems'),
);
