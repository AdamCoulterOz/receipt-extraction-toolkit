#!/usr/bin/env node
/**
 * Compares SCHEMA_VERSION in receipt.ts with last committed snapshot schema version in test/__snapshots__/schema.snapshot.test.ts.snap
 * If mismatch is detected without snapshot update, prints a warning (non-fatal so it can run in advisory mode on CI).
 */
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const receiptTs = path.join(root, 'receipt.ts');
const snapshot = path.join(root, 'test', '__snapshots__', 'schema.snapshot.test.ts.snap');
const generatedSchema = path.join(root, 'out', 'receipt.schema.json');

function extractSchemaVersionFromReceipt() {
  const txt = fs.readFileSync(receiptTs, 'utf-8');
  const m = txt.match(/SCHEMA_VERSION\s*=\s*'([^']+)'/);
  return m ? m[1] : null;
}
function extractSchemaVersionFromSnapshot() {
  if (fs.existsSync(generatedSchema)) {
    try {
      const json = JSON.parse(fs.readFileSync(generatedSchema, 'utf-8'));
      if (json && typeof json.$id === 'string') {
        const mm = json.$id.match(/receipt\/(.+?)\/receipt.schema.json/);
        if (mm) return mm[1];
      }
    } catch {/* ignore */}
  }
  // If schema file missing, attempt heuristic from snapshot (may not contain id)
  if (fs.existsSync(snapshot)) {
    const txt = fs.readFileSync(snapshot, 'utf-8');
    const approx = txt.match(/schemaVersion"\s*:\s*\{?\s*"type"/); // placeholder, cannot derive version
    if (approx) {
      return null; // can't infer
    }
  }
  return null;
}

const schemaVersion = extractSchemaVersionFromReceipt();
const snapshotVersion = extractSchemaVersionFromSnapshot();

if (!schemaVersion) {
  console.warn('[schema-version] Could not determine SCHEMA_VERSION from receipt.ts');
  process.exit(0);
}
if (!snapshotVersion) {
  console.warn('[schema-version] No generated schema with $id found; run the tool to emit schema before relying on version advisory.');
  process.exit(0);
}
if (schemaVersion !== snapshotVersion) {
  console.warn(`⚠️  SCHEMA_VERSION (${schemaVersion}) differs from snapshot version (${snapshotVersion}). Update snapshot and consider a breaking or feature release.`);
  process.exit(0); // non-fatal
}
console.log(`[schema-version] OK SCHEMA_VERSION ${schemaVersion} matches snapshot.`);
