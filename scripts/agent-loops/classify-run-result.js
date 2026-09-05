#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { CONFIRMATION_REQUEST_REASON, confirmationRequestFrom } = require('./confirmation-handoff');

const CLAUDE_BACKGROUND_TERMINATION = /Background tasks still running after \d+s; terminating\./i;

function classifyRunResult(rawExitCode, output = '') {
  const exitCode = Number(rawExitCode);
  if (!Number.isInteger(exitCode) || exitCode < 0) throw new Error(`Invalid exit code: ${rawExitCode}`);

  if (exitCode === 0 && CLAUDE_BACKGROUND_TERMINATION.test(output)) {
    return {
      exitCode: 70,
      reason: 'Claude terminated background tasks before the lifecycle handoff completed',
    };
  }
  if (exitCode === 0 && confirmationRequestFrom(output)) {
    return { exitCode: 0, reason: '', confirmationRequested: true };
  }
  if (exitCode === 0) return { exitCode: 0, reason: '' };
  if (exitCode === 124) return { exitCode, reason: 'Worker exceeded the four-hour loop timeout' };
  if (exitCode === 137 || exitCode === 143) return { exitCode, reason: 'Worker was terminated before the lifecycle handoff completed' };
  return { exitCode, reason: `Worker exited with code ${exitCode} before the lifecycle handoff completed` };
}

function tailFile(file, maxBytes = 64 * 1024) {
  const size = fs.statSync(file).size;
  const length = Math.min(size, maxBytes);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

if (require.main === module) {
  const result = classifyRunResult(process.argv[2], tailFile(process.argv[3]));
  const reason = result.reason || (result.confirmationRequested ? CONFIRMATION_REQUEST_REASON : '');
  const confirmationRequested = result.confirmationRequested ? 'confirmation' : '';
  process.stdout.write(`${result.exitCode}\t${reason.replace(/[\t\r\n]+/g, ' ')}\t${confirmationRequested}`);
}

module.exports = { CLAUDE_BACKGROUND_TERMINATION, classifyRunResult };
