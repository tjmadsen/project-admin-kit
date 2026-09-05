'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const attachments = require('../lib/attachments');

test('parses comma-separated attachment paths and enforces the admin count limit', () => {
  assert.deepEqual(attachments.parseAttachmentPaths(undefined), []);
  assert.deepEqual(attachments.parseAttachmentPaths(true), []);
  assert.deepEqual(attachments.parseAttachmentPaths(' a.png, b.jpg ,'), ['a.png', 'b.jpg']);
  assert.throws(() => attachments.parseAttachmentPaths(Array.from({ length: 11 }, (_v, i) => `${i}.png`).join(',')), /up to 10 files/);
});

test('maps supported extensions to the content types the storage rules accept', () => {
  assert.equal(attachments.contentTypeFor('shot.PNG'), 'image/png');
  assert.equal(attachments.contentTypeFor('report.pdf'), 'application/pdf');
  assert.throws(() => attachments.contentTypeFor('archive.zip'), /Unsupported attachment type/);
});

test('stores objects under the admin work-item-attachments layout with a token download url', () => {
  const name = attachments.objectName({ uploader: 'agent-fable', kind: 'feature', itemId: 'abc123', fileName: 'light matchup (1).png' });
  assert.match(name, /^work-item-attachments\/agent-fable\/feature\/abc123\/[0-9a-f-]{36}-light_matchup_1_\.png$/);
  assert.equal(
    attachments.downloadUrl('work-item-attachments/a/feature/b/c.png', 'tok', 'demo.appspot.com'),
    'https://firebasestorage.googleapis.com/v0/b/demo.appspot.com/o/work-item-attachments%2Fa%2Ffeature%2Fb%2Fc.png?alt=media&token=tok'
  );
});

test('builds a multipart/related body with metadata first and raw bytes second', () => {
  const { boundary, body } = attachments.multipartBody({ name: 'x' }, 'image/png', Buffer.from([1, 2, 3]));
  const text = body.toString('latin1');
  assert.ok(text.startsWith(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{"name":"x"}\r\n--${boundary}\r\nContent-Type: image/png\r\n\r\n`));
  assert.ok(text.endsWith(`\x01\x02\x03\r\n--${boundary}--\r\n`));
});

test('uploads each file with the firebase download token and returns usable urls', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-admin-attachments-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const first = path.join(tempDir, 'one.png');
  const second = path.join(tempDir, 'two.txt');
  fs.writeFileSync(first, Buffer.from([0x89, 0x50]));
  fs.writeFileSync(second, 'hello');
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return { ok: true, text: async () => '' }; };

  const urls = await attachments.uploadAttachments(`${first},${second}`, { uploader: 'agent-fable', kind: 'bug', itemId: 'item9' }, { accessToken: 'secret', fetchImpl, bucket: 'demo.appspot.com' });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://storage.googleapis.com/upload/storage/v1/b/demo.appspot.com/o?uploadType=multipart');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret');
  const metadata = JSON.parse(requests[0].init.body.toString('utf8').split('\r\n')[3]);
  assert.equal(metadata.contentType, 'image/png');
  assert.match(metadata.name, /^work-item-attachments\/agent-fable\/bug\/item9\/[0-9a-f-]{36}-one\.png$/);
  assert.equal(urls[0], attachments.downloadUrl(metadata.name, metadata.metadata.firebaseStorageDownloadTokens, 'demo.appspot.com'));
  assert.match(urls[1], /two\.txt\?alt=media&token=/);
});

test('fails clearly for missing files and rejected uploads', async () => {
  await assert.rejects(attachments.uploadAttachments('/nope/missing.png', { uploader: 'a', kind: 'feature', itemId: 'b' }, { accessToken: 't' }), /Attachment not found/);
  const tempFile = path.join(os.tmpdir(), `project-admin-att-${process.pid}.png`);
  fs.writeFileSync(tempFile, 'x');
  try {
    const fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'denied' });
    await assert.rejects(attachments.uploadAttachments(tempFile, { uploader: 'a', kind: 'feature', itemId: 'b' }, { accessToken: 't', fetchImpl }), /failed: 403 denied/);
  } finally { fs.rmSync(tempFile, { force: true }); }
});
