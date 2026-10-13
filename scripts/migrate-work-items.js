#!/usr/bin/env node
'use strict';

// One-time upgrade from the per-kind featureRequests/bugs collections to the
// single workItems collection. Dry run by default; --apply writes.
//
//   npm run migrate:work-items            # report what would be copied
//   npm run migrate:work-items -- --apply # copy
//
// Each legacy document is copied to workItems/{same id} with its `kind` set and
// a `migratedFrom` marker (which also stops lifecycle Functions from treating
// the copy as a new item). Existing workItems documents are never overwritten,
// so re-running is safe. Legacy collections are left in place for rollback.

const { LEGACY_COLLECTIONS, WORK_ITEMS_COLLECTION, kindById, loadWorkKinds } = require('./lib/work-kinds');

async function migrateWorkItems({ db, FieldValue, kinds = loadWorkKinds(), apply = false, log = () => {} }) {
  const report = { apply, copied: [], alreadyMigrated: [], conflicts: [], skipped: [] };
  for (const [collection, kindId] of Object.entries(LEGACY_COLLECTIONS)) {
    const snapshot = await db.collection(collection).get();
    for (const document of snapshot.docs) {
      const entry = { id: document.id, from: collection, kind: kindId };
      if (!kindById(kinds, kindId)) {
        report.skipped.push({ ...entry, reason: `kind "${kindId}" is not configured in workKinds` });
        continue;
      }
      const target = db.collection(WORK_ITEMS_COLLECTION).doc(document.id);
      const existing = await target.get();
      if (existing.exists) {
        const data = existing.data();
        if (data.migratedFrom === collection && data.kind === kindId) report.alreadyMigrated.push(entry);
        else report.conflicts.push({ ...entry, reason: `workItems/${document.id} already holds a ${data.kind || 'kindless'} item` });
        continue;
      }
      if (apply) {
        await target.set({
          ...document.data(),
          kind: kindId,
          migratedFrom: collection,
          migratedAt: FieldValue.serverTimestamp(),
        });
      }
      report.copied.push(entry);
      log(`${apply ? 'copied' : 'would copy'} ${collection}/${document.id} -> ${WORK_ITEMS_COLLECTION}/${document.id} (${kindId})`);
    }
  }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const apply = argv.includes('--apply');
  const { FieldValue } = require('@google-cloud/firestore');
  const report = await migrateWorkItems({ db: require('./lib/firestore'), FieldValue, apply, log: (line) => console.error(line) });
  console.log(JSON.stringify({
    apply,
    copied: report.copied.length,
    alreadyMigrated: report.alreadyMigrated.length,
    conflicts: report.conflicts,
    skipped: report.skipped,
  }, null, 2));
  if (!apply && report.copied.length > 0) console.error('Dry run only. Re-run with --apply to write.');
  if (report.conflicts.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}

module.exports = { migrateWorkItems };
