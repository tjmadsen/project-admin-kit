'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  MAX_FCM_TOKENS,
  buildPushMessage,
  deliverIndependently,
  sendLifecyclePush,
} = require('../lib/push');

const notification = {
  reference: 'BUG-3',
  title: 'Does the iOS app support push notifications',
  action: 'Review the completed implementation.',
  primaryUrl: 'https://example.com/admin/bugs?item=BUG-3&gate=pr_review',
  kind: 'bug',
  type: 'action_required',
  gate: 'pr_review',
  recipients: ['owner@example.com', 'collaborator@example.com', 'owner@example.com'],
};

function fakeDatabase(documents) {
  const state = { query: null, deleted: [] };
  return {
    state,
    collection(name) {
      assert.equal(name, 'pushDeviceTokens');
      return {
        where(field, operator, values) {
          state.query = { field, operator, values };
          return {
            async get() {
              return {
                docs: documents.map((document) => ({
                  ref: { path: `pushDeviceTokens/${document.id}` },
                  data: () => document,
                })),
              };
            },
          };
        },
      };
    },
    batch() {
      const pending = [];
      return {
        delete(reference) { pending.push(reference.path); },
        async commit() { state.deleted.push(...pending); },
      };
    },
  };
}

describe('lifecycle push payloads', () => {
  it('reuses lifecycle action copy and routes taps to the exact admin item', () => {
    const message = buildPushMessage(notification, ['token-one']);
    assert.deepEqual(message.tokens, ['token-one']);
    assert.equal(message.notification.title, `${notification.reference} — ${notification.title}`);
    assert.equal(message.notification.body, notification.action);
    assert.equal(message.data.primaryUrl, notification.primaryUrl);
    assert.equal(message.data.gate, 'pr_review');
    assert.equal(message.apns.payload.aps.sound, 'default');
  });
});

describe('FCM lifecycle delivery', () => {
  it('targets the deduplicated recipient matrix, batches tokens, and prunes invalid devices', async () => {
    const documents = Array.from({ length: MAX_FCM_TOKENS + 1 }, (_, index) => ({
      id: `device-${index}`,
      token: `token-${index}`,
    }));
    const db = fakeDatabase(documents);
    const messages = [];
    const messaging = {
      async sendEachForMulticast(message) {
        messages.push(message);
        return {
          successCount: message.tokens.length - (messages.length === 1 ? 1 : 0),
          responses: message.tokens.map((_, index) => (
            messages.length === 1 && index === 4
              ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
              : { success: true }
          )),
        };
      },
    };

    const result = await sendLifecyclePush({ db, messaging, notification });

    assert.deepEqual(db.state.query, {
      field: 'email',
      operator: 'in',
      values: ['owner@example.com', 'collaborator@example.com'],
    });
    assert.equal(messages.length, 2);
    assert.equal(messages[0].tokens.length, MAX_FCM_TOKENS);
    assert.equal(messages[1].tokens.length, 1);
    assert.deepEqual(db.state.deleted, ['pushDeviceTokens/device-4']);
    assert.deepEqual(result, {
      registeredTokenCount: MAX_FCM_TOKENS + 1,
      deliveredCount: MAX_FCM_TOKENS,
      invalidTokenCount: 1,
    });
  });

  it('treats transient provider failures as retryable after processing invalid tokens', async () => {
    const db = fakeDatabase([{ id: 'invalid', token: 'bad' }, { id: 'retry', token: 'later' }]);
    const messaging = {
      async sendEachForMulticast() {
        return {
          successCount: 0,
          responses: [
            { success: false, error: { code: 'messaging/invalid-registration-token' } },
            { success: false, error: { code: 'messaging/internal-error' } },
          ],
        };
      },
    };
    await assert.rejects(
      sendLifecyclePush({ db, messaging, notification }),
      /messaging\/internal-error/,
    );
    assert.deepEqual(db.state.deleted, ['pushDeviceTokens/invalid']);
  });

  it('succeeds without calling FCM when recipients have no registered devices', async () => {
    const db = fakeDatabase([]);
    let calls = 0;
    const result = await sendLifecyclePush({
      db,
      messaging: { async sendEachForMulticast() { calls += 1; } },
      notification,
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, { registeredTokenCount: 0, deliveredCount: 0, invalidTokenCount: 0 });
  });
});

describe('provider independence', () => {
  it('attempts push even when email fails, then reports the failed provider', async () => {
    const calls = [];
    await assert.rejects(
      deliverIndependently([
        async () => { calls.push('email'); throw new Error('SMTP unavailable'); },
        async () => { calls.push('push'); return 'sent'; },
      ]),
      /1 lifecycle notification provider\(s\) failed/,
    );
    assert.deepEqual(calls.sort(), ['email', 'push']);
  });

  it('attempts email even when push fails', async () => {
    const calls = [];
    await assert.rejects(deliverIndependently([
      async () => { calls.push('email'); return 'sent'; },
      async () => { calls.push('push'); throw new Error('FCM unavailable'); },
    ]));
    assert.deepEqual(calls.sort(), ['email', 'push']);
  });
});
