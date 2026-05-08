#!/usr/bin/env node
/**
 * Verifier for T9022: Wire applyPerfPragmas into read-only/inspection DB opens.
 *
 * AC: applyPerfPragmas (with enableWal:false) is called for read-only/inspection
 * DB open sites. Non-zero call count required — scaffold/no-op fails.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

function readFile(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: backup-pack.ts has applyPerfPragmas with enableWal:false for reads
// ---------------------------------------------------------------------------
const backupPack = readFile('packages/core/src/store/backup-pack.ts');
const backupReadOnlyCalls =
  backupPack.match(/applyPerfPragmas\(db,\s*\{[^}]*enableWal:\s*false[^}]*\}/g) || [];
if (backupReadOnlyCalls.length >= 2) {
  pass(`backup-pack.ts has ${backupReadOnlyCalls.length} read-only applyPerfPragmas calls`);
} else {
  fail(
    `backup-pack.ts must have >= 2 read-only applyPerfPragmas(db, {enableWal:false}) calls, found ${backupReadOnlyCalls.length}`,
  );
}

// ---------------------------------------------------------------------------
// Check 2: backup-unpack.ts has applyPerfPragmas with enableWal:false for reads
// ---------------------------------------------------------------------------
const backupUnpack = readFile('packages/core/src/store/backup-unpack.ts');
const unpackReadOnlyCalls =
  backupUnpack.match(/applyPerfPragmas\(db,\s*\{[^}]*enableWal:\s*false[^}]*\}/g) || [];
if (unpackReadOnlyCalls.length >= 1) {
  pass(`backup-unpack.ts has ${unpackReadOnlyCalls.length} read-only applyPerfPragmas calls`);
} else {
  fail(
    `backup-unpack.ts must have >= 1 read-only applyPerfPragmas(db, {enableWal:false}) call, found ${unpackReadOnlyCalls.length}`,
  );
}

// ---------------------------------------------------------------------------
// Check 3: atomic.ts has applyPerfPragmas for inspection path
// ---------------------------------------------------------------------------
const atomic = readFile('packages/core/src/store/atomic.ts');
const atomicReadOnlyCalls =
  atomic.match(/applyPerfPragmas\(db,\s*\{[^}]*enableWal:\s*false[^}]*\}/g) || [];
if (atomicReadOnlyCalls.length >= 1) {
  pass(`atomic.ts has ${atomicReadOnlyCalls.length} read-only applyPerfPragmas calls`);
} else {
  fail(
    `atomic.ts must have >= 1 applyPerfPragmas call with enableWal:false for inspection path, found ${atomicReadOnlyCalls.length}`,
  );
}

// ---------------------------------------------------------------------------
// Check 4: T9022 references in at least one of these files (not scaffolded only)
// ---------------------------------------------------------------------------
const t9022Refs = [backupPack, backupUnpack, atomic].filter((f) => f.includes('T9022'));
if (t9022Refs.length >= 1) {
  pass(`T9022 referenced in ${t9022Refs.length} read-only open files`);
} else {
  fail('No T9022 task reference found in read-only DB open files — implementation may be missing');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9022 — applyPerfPragmas wired into read-only/inspection DB opens');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
