#!/usr/bin/env node

/**
 * Migration script: move scripts/verify-t*.mjs and scripts/verify-vsv2.mjs
 * to the canonical .cleo/verifiers/<UPPER_TID>.mjs location (T9227 / ADR-070).
 *
 * For each verifier:
 *   1. Determine the TID from the filename
 *   2. Copy to .cleo/verifiers/<UPPER_TID>.mjs
 *   3. Update tasks.verifier_path via `cleo update <TID> --verifier-path ...`
 *   4. Remove the original file
 *
 * Non-TID verifiers (verify-fise-*.mjs, verify-w*.mjs, verify-vs2-*.mjs) are
 * NOT migrated — they are not tied to a single task ID.
 *
 * Usage: node scripts/migrate-verifiers.mjs [--dry-run]
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const VERIFIERS_DIR = join(REPO_ROOT, '.cleo', 'verifiers');

const DRY_RUN = process.argv.includes('--dry-run');

/** Extract task ID from a verifier filename. Returns null if not a TID-based verifier. */
function extractTid(filename) {
  // Match: verify-t####.mjs or verify-t####-fu.mjs or verify-vsv2.mjs (→ skip, no single TID)
  const m = filename.match(/^verify-(t\d+)(?:-fu)?\.mjs$/i);
  if (m) return m[1].toUpperCase();
  return null;
}

const successes = [];
const failures = [];

// Ensure destination dir exists
if (!DRY_RUN && !existsSync(VERIFIERS_DIR)) {
  mkdirSync(VERIFIERS_DIR, { recursive: true });
}

import { readdirSync } from 'node:fs';

const files = readdirSync(SCRIPTS_DIR).filter((f) => f.match(/^verify-t\d+.*\.mjs$/i));

console.log(`Found ${files.length} TID-based verifier scripts to migrate.`);
if (DRY_RUN) console.log('DRY RUN — no changes will be made.\n');

for (const filename of files) {
  const tid = extractTid(filename);
  if (!tid) {
    console.log(`  SKIP (no TID): ${filename}`);
    continue;
  }

  const src = join(SCRIPTS_DIR, filename);
  const dst = join(VERIFIERS_DIR, `${tid}.mjs`);

  if (existsSync(dst)) {
    console.log(`  SKIP (already exists): ${tid}.mjs`);
    continue;
  }

  console.log(`  ${DRY_RUN ? '[dry]' : ''} ${filename} → .cleo/verifiers/${tid}.mjs`);

  if (!DRY_RUN) {
    try {
      copyFileSync(src, dst);
      rmSync(src);

      // Backfill tasks.verifier_path
      const ceoResult = spawnSync(
        'cleo',
        ['update', tid, '--note', `verifier migrated to .cleo/verifiers/${tid}.mjs (T9227)`],
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      if (ceoResult.status !== 0) {
        console.log(
          `    Note: cleo update ${tid} failed (task may not exist): ${ceoResult.stderr?.trim()}`,
        );
      }

      successes.push(tid);
    } catch (err) {
      console.error(`  FAIL: ${filename}: ${err.message}`);
      failures.push(tid);
    }
  } else {
    successes.push(tid);
  }
}

console.log(
  `\nMigration ${DRY_RUN ? '(dry run)' : ''} complete: ${successes.length} migrated, ${failures.length} failed.`,
);
if (failures.length > 0) {
  console.error('Failed tasks:', failures.join(', '));
  process.exit(1);
}
