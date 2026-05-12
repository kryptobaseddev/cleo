#!/usr/bin/env node
/**
 * Acceptance verifier for T9225: VS2-4 GC lifecycle hooks for verifier scripts
 *
 * AC checks:
 *   1. archive.ts calls archiveVerifier after task archive transaction
 *   2. delete.ts calls deleteVerifier after task delete transaction
 *   3. sqlite-backup.ts calls backupVerifiersDir in vacuumIntoBackupAll
 *   4. verifier-gc.ts exports archiveVerifier, deleteVerifier, backupVerifiersDir
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

// Check 1: verifier-gc.ts exists with archiveVerifier, deleteVerifier, backupVerifiersDir
const gcPath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'verifier-gc.ts');
if (existsSync(gcPath)) {
  const src = readFileSync(gcPath, 'utf8');
  const hasArchive = src.includes('archiveVerifier');
  const hasDelete = src.includes('deleteVerifier');
  const hasBackup = src.includes('backupVerifiersDir');
  if (hasArchive && hasDelete && hasBackup) {
    pass('verifier-gc.ts exports archiveVerifier, deleteVerifier, backupVerifiersDir');
  } else {
    fail(`verifier-gc.ts missing: archive=${hasArchive}, delete=${hasDelete}, backup=${hasBackup}`);
  }
} else {
  fail('verifier-gc.ts not found');
}

// Check 2: archive.ts calls archiveVerifier
const archivePath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'archive.ts');
if (existsSync(archivePath)) {
  const src = readFileSync(archivePath, 'utf8');
  if (src.includes('archiveVerifier') && src.includes('./verifier-gc.js')) {
    pass('archive.ts calls archiveVerifier from verifier-gc');
  } else {
    fail('archive.ts does not call archiveVerifier');
  }
} else {
  fail('archive.ts not found');
}

// Check 3: delete.ts calls deleteVerifier
const deletePath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'delete.ts');
if (existsSync(deletePath)) {
  const src = readFileSync(deletePath, 'utf8');
  if (src.includes('deleteVerifier') && src.includes('./verifier-gc.js')) {
    pass('delete.ts calls deleteVerifier from verifier-gc');
  } else {
    fail('delete.ts does not call deleteVerifier');
  }
} else {
  fail('delete.ts not found');
}

// Check 4: sqlite-backup.ts calls backupVerifiersDir
const sqliteBackupPath = join(REPO_ROOT, 'packages', 'core', 'src', 'store', 'sqlite-backup.ts');
if (existsSync(sqliteBackupPath)) {
  const src = readFileSync(sqliteBackupPath, 'utf8');
  if (src.includes('backupVerifiersDir')) {
    pass('sqlite-backup.ts calls backupVerifiersDir in vacuumIntoBackupAll');
  } else {
    fail('sqlite-backup.ts does not call backupVerifiersDir');
  }
} else {
  fail('sqlite-backup.ts not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9225 — VS2-4 GC lifecycle hooks');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
