/**
 * ADR Manifest Generator (thin wrapper)
 *
 * MANIFEST.jsonl is now regenerated automatically by `ct adr sync` /
 * admin.adr.sync. This script exists for standalone dev use only.
 *
 * Usage: npm run adr:manifest
 *        (equivalent to: ct adr sync)
 *
 * @see src/core/adrs/sync.ts — canonical implementation
 * @see ADR-017 §5.5 — DB vs MANIFEST roles
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAdrsToDb } from '../src/core/adrs/sync.js';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = await syncAdrsToDb(PROJECT_ROOT);
console.log(`Synced ${result.inserted + result.updated} ADRs, MANIFEST.jsonl updated.`);
if (result.errors.length > 0) {
  for (const e of result.errors) console.error(`  ERROR ${e.file}: ${e.error}`);
  process.exit(1);
}
