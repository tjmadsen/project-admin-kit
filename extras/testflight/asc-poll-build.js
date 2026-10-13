#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const KEY_ID = process.env.PROJECT_ADMIN_ASC_KEY_ID;
const ISSUER_ID = process.env.PROJECT_ADMIN_ASC_ISSUER_ID;
const BUNDLE_ID = process.env.PROJECT_ADMIN_IOS_BUNDLE_ID;
const KEY_PATH = process.env.PROJECT_ADMIN_ASC_KEY_PATH || path.join(process.env.HOME, '.appstoreconnect', 'private_keys', `AuthKey_${KEY_ID}.p8`);
const TARGET = process.argv[2];
const CHECK_ONLY = TARGET === '--check';
const CHECK_PUSH_CAPABILITY = TARGET === '--check-push-capability';
const MAX_MINUTES = Number(process.argv[3] || 45);
const POLL_SECONDS = Number(process.argv[4] || 60);

if (!TARGET) { console.error('Usage: asc-poll-build.js <build-number> [max-minutes] [poll-seconds] | --check | --check-push-capability'); process.exit(1); }
if (!KEY_ID || !ISSUER_ID || !BUNDLE_ID) { console.error('Set PROJECT_ADMIN_ASC_KEY_ID, PROJECT_ADMIN_ASC_ISSUER_ID, and PROJECT_ADMIN_IOS_BUNDLE_ID'); process.exit(1); }

const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token() {
  const now = Math.floor(Date.now() / 1000);
  const input = `${encode({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${encode({ iss: ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}
async function api(route) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${route}`, { headers: { Authorization: `Bearer ${token()}` } });
  const body = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 240)}`);
  return JSON.parse(body);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  if (CHECK_PUSH_CAPABILITY) {
    const bundleIds = await api(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
    const bundleId = bundleIds.data?.[0]?.id;
    if (!bundleId) throw new Error(`No Apple bundle identifier found for ${BUNDLE_ID}`);
    const capabilities = await api(`/v1/bundleIds/${bundleId}/bundleIdCapabilities`);
    const capability = capabilities.data?.find((entry) => entry.attributes?.capabilityType === 'PUSH_NOTIFICATIONS');
    if (!capability) {
      throw new Error(`Push Notifications capability is not enabled for ${BUNDLE_ID}`);
    }
    console.log(`Push Notifications capability enabled: ${BUNDLE_ID} (${bundleId})`);
    process.exit(0);
  }
  const apps = await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`);
  const appId = apps.data?.[0]?.id;
  if (!appId) throw new Error(`No App Store Connect app found for ${BUNDLE_ID}`);
  if (CHECK_ONLY) { console.log(`App Store Connect ready: ${BUNDLE_ID} (${appId})`); process.exit(0); }
  const rounds = Math.max(1, Math.ceil((MAX_MINUTES * 60) / POLL_SECONDS));
  for (let index = 0; index < rounds; index += 1) {
    const builds = await api(`/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(TARGET)}&limit=1`);
    const build = builds.data?.[0];
    const state = build?.attributes?.processingState || 'NOT_FOUND';
    console.log(`[${new Date().toISOString()}] build ${TARGET} -> ${state}`);
    if (state === 'VALID') { console.log(`VALID id=${build.id}`); process.exit(0); }
    if (state === 'INVALID' || state === 'FAILED') process.exit(2);
    if (index + 1 < rounds) await sleep(POLL_SECONDS * 1000);
  }
  process.exit(3);
})().catch((error) => { console.error(`App Store Connect poll failed: ${error.message}`); process.exit(1); });
