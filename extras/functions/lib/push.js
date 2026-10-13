'use strict';

const MAX_FCM_TOKENS = 500;
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

function uniqueStrings(values) {
  return [...new Set(values.map((value) => (
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  )).filter(Boolean))];
}

function chunks(values, size = MAX_FCM_TOKENS) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function buildPushMessage(notification, tokens) {
  return {
    tokens,
    notification: {
      title: `${notification.reference} — ${notification.title}`,
      body: notification.action,
    },
    data: {
      primaryUrl: notification.primaryUrl,
      reference: notification.reference,
      kind: notification.kind,
      type: notification.type,
      gate: notification.gate || '',
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };
}

async function registrationsForRecipients(db, recipients) {
  const emails = uniqueStrings(recipients);
  if (emails.length === 0) return [];
  const snapshot = await db.collection('pushDeviceTokens').where('email', 'in', emails).get();
  return snapshot.docs.map((document) => ({
    reference: document.ref,
    token: document.data()?.token,
  })).filter((registration) => (
    typeof registration.token === 'string' && registration.token.length > 0
  ));
}

async function pruneInvalidRegistrations(db, registrations) {
  if (registrations.length === 0) return;
  for (const batchRegistrations of chunks(registrations)) {
    const batch = db.batch();
    for (const registration of batchRegistrations) batch.delete(registration.reference);
    await batch.commit();
  }
}

async function sendLifecyclePush({ db, messaging, notification }) {
  const registrations = await registrationsForRecipients(db, notification.recipients);
  const registrationsByToken = new Map();
  for (const registration of registrations) {
    const matches = registrationsByToken.get(registration.token) || [];
    matches.push(registration);
    registrationsByToken.set(registration.token, matches);
  }

  const tokenGroups = chunks([...registrationsByToken.keys()]);
  let deliveredCount = 0;
  const invalidRegistrations = [];
  const retryableErrors = [];

  for (const tokens of tokenGroups) {
    const response = await messaging.sendEachForMulticast(buildPushMessage(notification, tokens));
    deliveredCount += response.successCount;
    response.responses.forEach((sendResponse, index) => {
      if (sendResponse.success) return;
      const code = sendResponse.error?.code || 'messaging/unknown-error';
      if (INVALID_TOKEN_CODES.has(code)) {
        invalidRegistrations.push(...(registrationsByToken.get(tokens[index]) || []));
      } else {
        retryableErrors.push(code);
      }
    });
  }

  await pruneInvalidRegistrations(db, invalidRegistrations);
  if (retryableErrors.length > 0) {
    throw new Error(`FCM delivery failed for ${retryableErrors.length} device(s): ${uniqueStrings(retryableErrors).join(', ')}`);
  }

  return {
    registeredTokenCount: registrationsByToken.size,
    deliveredCount,
    invalidTokenCount: invalidRegistrations.length,
  };
}

async function deliverIndependently(deliveries) {
  const results = await Promise.allSettled(deliveries.map((delivery) => delivery()));
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} lifecycle notification provider(s) failed`);
  }
  return results.map((result) => result.value);
}

module.exports = {
  MAX_FCM_TOKENS,
  buildPushMessage,
  deliverIndependently,
  registrationsForRecipients,
  sendLifecyclePush,
};
