# Project Admin lifecycle email functions

`notifyFeatureLifecycle` and `notifyBugLifecycle` send only action-required and
final-outcome messages. Delivery attempts are recorded in the admin-only
`notificationAttempts` Firestore collection and use the CloudEvent id as the
stable SMTP message id.

Before the first deployment:

1. Store the SMTP credentials without printing or writing them to the repo:

   ```sh
   eval "$(node scripts/project-env.js shell)"
   firebase functions:secrets:set EMAIL_USER --project "$PROJECT_ID"
   firebase functions:secrets:set EMAIL_PASS --project "$PROJECT_ID"
   ```
2. Deploy the two lifecycle functions named in `firebase.json`.
3. Verify a real lifecycle transition reaches the configured mailbox and that its matching
   `notificationAttempts` document is marked `sent` with provider `gmail_smtp`.

Messages authenticate as `EMAIL_USER`; their project name, fallback owner email,
and admin URL come from `functions/project-config.json`. Active users with the
`admin` role are notification recipients.
