'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildGmailMessage, sendLifecycleEmail } = require('../lib/mailer');

const notification = {
  recipients: ['owner@example.com'],
  subject: '[Project Admin] FR-9 needs your action — PR review',
};
const email = {
  html: '<p>Review FR-9</p>',
  text: 'Review FR-9',
};

describe('Gmail lifecycle transport', () => {
  it('uses the authenticated Gmail account with project branding and a stable message id', () => {
    const message = buildGmailMessage({
      emailUser: 'shared@example.com',
      notificationId: 'event-9-action_required',
      notification,
      email,
    });

    assert.deepEqual(message.from, { name: 'Project Admin', address: 'shared@example.com' });
    assert.deepEqual(message.to, ['owner@example.com']);
    assert.equal(message.subject, notification.subject);
    assert.equal(message.html, email.html);
    assert.equal(message.text, email.text);
    assert.equal(message.messageId, '<event-9-action_required@example.com>');
  });

  it('creates the Gmail SMTP transport and returns its delivery result', async () => {
    const sentMessages = [];
    const transportOptions = [];
    const nodemailer = {
      createTransport(options) {
        transportOptions.push(options);
        return {
          async sendMail(message) {
            sentMessages.push(message);
            return { messageId: '<gmail-message-id>' };
          },
        };
      },
    };

    const result = await sendLifecycleEmail({
      nodemailer,
      emailUser: 'shared@example.com',
      emailPass: 'app-password',
      notificationId: 'event-9-action_required',
      notification,
      email,
    });

    assert.deepEqual(transportOptions, [{
      service: 'gmail',
      auth: { user: 'shared@example.com', pass: 'app-password' },
    }]);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].messageId, '<event-9-action_required@example.com>');
    assert.equal(result.messageId, '<gmail-message-id>');
  });

  it('fails before creating a transport when either credential is missing', async () => {
    const nodemailer = {
      createTransport() {
        assert.fail('transport must not be created without both secrets');
      },
    };

    await assert.rejects(
      sendLifecycleEmail({
        nodemailer,
        emailUser: 'shared@example.com',
        emailPass: '',
        notificationId: 'event-9-action_required',
        notification,
        email,
      }),
      /EMAIL_PASS is not configured/,
    );
  });
});
