'use strict';

// Uploads local files as work-item attachments so agent replies can carry the
// same imageUrls the admin console renders for human notes. Files land in the
// Firebase Storage bucket under the same work-item-attachments layout the
// admin app uses, with a download token so the URL works without sign-in.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadProjectConfig } = require('./project-config');

// Firebase Storage is the firestore backend's attachment store; the local
// backend copies files beside its JSON store (lib/store/local-store.js).
const BUCKET = process.env.PROJECT_ADMIN_STORAGE_BUCKET || loadProjectConfig().firebase?.storageBucket || '';
const MAX_ATTACHMENT_COUNT = 10;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const CONTENT_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.txt': 'text/plain',
});

function contentTypeFor(fileName) {
  const type = CONTENT_TYPES[path.extname(fileName).toLowerCase()];
  if (!type) throw new Error(`Unsupported attachment type for ${fileName}; use png, jpg, gif, webp, pdf, csv, or txt`);
  return type;
}

function safeFileName(fileName) {
  return path.basename(fileName).replace(/[^A-Za-z0-9._-]+/g, '_');
}

function parseAttachmentPaths(raw) {
  if (!raw || raw === true) return [];
  const files = String(raw).split(',').map((part) => part.trim()).filter(Boolean);
  if (files.length > MAX_ATTACHMENT_COUNT) throw new Error(`You can attach up to ${MAX_ATTACHMENT_COUNT} files`);
  return files;
}

function objectName({ uploader, kind, itemId, fileName }) {
  return `work-item-attachments/${uploader}/${kind}/${itemId}/${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

function downloadUrl(name, token, bucket = BUCKET) {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(name)}?alt=media&token=${token}`;
}

function multipartBody(metadata, contentType, bytes) {
  const boundary = `project-admin-attachment-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
    + `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, body: Buffer.concat([head, bytes, tail]) };
}

function readAttachment(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`Attachment not found: ${filePath}`);
  const bytes = fs.readFileSync(resolved);
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${filePath} exceeds 25 MB`);
  return { fileName: path.basename(resolved), contentType: contentTypeFor(resolved), bytes };
}

async function defaultAccessToken() {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Could not obtain a Google access token for the storage upload');
  return token;
}

async function uploadAttachment(file, target, { accessToken, fetchImpl = fetch, bucket = BUCKET }) {
  const token = crypto.randomUUID();
  const name = objectName({ ...target, fileName: file.fileName });
  const metadata = { name, contentType: file.contentType, metadata: { firebaseStorageDownloadTokens: token } };
  const { boundary, body } = multipartBody(metadata, file.contentType, file.bytes);
  const response = await fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!response.ok) throw new Error(`Upload of ${file.fileName} failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  return downloadUrl(name, token, bucket);
}

async function uploadAttachments(paths, target, options = {}) {
  const files = parseAttachmentPaths(paths).map(readAttachment);
  if (files.length === 0) return [];
  const accessToken = options.accessToken || await defaultAccessToken();
  const urls = [];
  for (const file of files) urls.push(await uploadAttachment(file, target, { ...options, accessToken }));
  return urls;
}

module.exports = {
  BUCKET, MAX_ATTACHMENT_COUNT, contentTypeFor, downloadUrl, multipartBody, objectName, parseAttachmentPaths,
  readAttachment, safeFileName, uploadAttachments,
};
