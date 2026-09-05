'use strict';

function requiredSecret(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is not configured`);
  return normalized;
}

function buildGmailMessage({ emailUser, notificationId, notification, email }) {
  const user = requiredSecret(emailUser, 'EMAIL_USER');
  const messageDomain = user.split('@')[1] || 'project-admin.local';
  return {
    from: { name: notification.projectName || 'Project Admin', address: user },
    to: notification.recipients,
    subject: notification.subject,
    html: email.html,
    text: email.text,
    messageId: `<${notificationId}@${messageDomain}>`,
  };
}

async function sendLifecycleEmail({
  nodemailer,
  emailUser,
  emailPass,
  notificationId,
  notification,
  email,
}) {
  const user = requiredSecret(emailUser, 'EMAIL_USER');
  const pass = requiredSecret(emailPass, 'EMAIL_PASS');
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
  return transporter.sendMail(buildGmailMessage({
    emailUser: user,
    notificationId,
    notification,
    email,
  }));
}

module.exports = { buildGmailMessage, sendLifecycleEmail };
