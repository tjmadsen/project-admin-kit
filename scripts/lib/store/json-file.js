'use strict';

// A single-machine document database in one JSON file. The repository's
// Node floor is 20 (.nvmrc), where node:sqlite does not exist, so this uses no
// native dependency: every transaction takes an exclusive lockfile
// (open(..., 'wx')), reads the file, applies the change, writes a temp file,
// fsyncs it, and renames it over the original. Rename is atomic on one
// filesystem, so readers never see a torn file, and the lock serializes
// writers across processes (the CLI, the loops, and the local server).
//
// File shape: { "version": 1, "collections": { "<name>": { "<id>": {doc} } } }
// with timestamps encoded as {"$ts": ISO} (see values.js).

const fs = require('node:fs');
const path = require('node:path');
const { decode, encode } = require('./values');

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function emptyData() { return { version: 1, collections: {} }; }

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function createJsonFileDatabase(file) {
  const lockFile = `${file}.lock`;

  function readRaw() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return emptyData();
      throw new Error(`Cannot read the local store at ${file}: ${error.message}`);
    }
  }

  function read() {
    const raw = readRaw();
    if (raw.version !== 1 || !raw.collections) throw new Error(`Unsupported local store format in ${file}`);
    return { version: 1, collections: decode(raw.collections) };
  }

  function writeAtomic(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const handle = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(handle, `${JSON.stringify({ version: 1, collections: encode(data.collections) }, null, 1)}\n`);
      fs.fsyncSync(handle);
    } finally { fs.closeSync(handle); }
    fs.renameSync(temp, file);
  }

  // A lock left by a crashed writer is broken when its pid is gone or it is
  // older than any sane transaction.
  function breakStaleLock() {
    try {
      const [pidText] = fs.readFileSync(lockFile, 'utf8').split(' ');
      const pid = Number(pidText);
      // mtime, not the recorded start: a lock read between its creation and
      // its first write is empty but not stale.
      const age = Date.now() - fs.statSync(lockFile).mtimeMs;
      if ((Number.isInteger(pid) && pid > 0 && !processAlive(pid)) || age > LOCK_STALE_MS) fs.rmSync(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async function acquire() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeSync(handle, `${process.pid} ${Date.now()}`);
        fs.closeSync(handle);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt % 20 === 19) breakStaleLock();
        if (Date.now() > deadline) throw new Error(`Timed out waiting for the local store lock ${lockFile}`);
        await sleep(5 + Math.floor(Math.random() * 20));
      }
    }
  }

  // Serializes writers. `operation(data)` mutates `data.collections` in place
  // and returns a value; nothing is written if it throws or returns with
  // `data.dirty` unset.
  async function transaction(operation) {
    await acquire();
    try {
      const data = read();
      data.dirty = false;
      const result = await operation(data);
      if (data.dirty) writeAtomic(data);
      return result;
    } finally {
      fs.rmSync(lockFile, { force: true });
    }
  }

  function collection(data, name) {
    data.collections[name] ||= {};
    return data.collections[name];
  }

  return { file, read, transaction, collection };
}

module.exports = { createJsonFileDatabase };
