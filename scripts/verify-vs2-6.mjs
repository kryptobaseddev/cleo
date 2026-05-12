#!/usr/bin/env node
/**
 * Acceptance verifier for T9227: VS2-6 migrate 22 existing scripts/verify-*.mjs
 *
 * AC checks:
 *   1. 21+ existing scripts/verify-t*.mjs moved to .cleo/verifiers/<TID>.mjs
 *   2. migrate-verifiers.mjs script exists
 *   3. No TID-based verify scripts remain in scripts/
 *   4. .cleo/verifiers/ has at least 21 TID-based files
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) {
  console.log('PASS:', msg);
}
function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

// Check 1: migrate-verifiers.mjs exists
const migratePath = join(REPO_ROOT, 'scripts', 'migrate-verifiers.mjs');
if (existsSync(migratePath)) {
  pass('scripts/migrate-verifiers.mjs exists');
} else {
  fail('scripts/migrate-verifiers.mjs not found');
}

// Check 2: .cleo/verifiers/ has TID-based files
const verifiersDir = join(REPO_ROOT, '.cleo', 'verifiers');
if (existsSync(verifiersDir)) {
  const verifiers = readdirSync(verifiersDir).filter((f) => f.match(/^T\d+\.mjs$/));
  if (verifiers.length >= 21) {
    pass(`.cleo/verifiers/ has ${verifiers.length} TID-based verifier files (>= 21 required)`);
  } else {
    fail(`.cleo/verifiers/ has only ${verifiers.length} TID-based files (need >= 21)`);
  }
} else {
  fail('.cleo/verifiers/ directory not found');
}

// Check 3: No TID-based scripts remain in scripts/
const scriptsDir = join(REPO_ROOT, 'scripts');
if (existsSync(scriptsDir)) {
  const tidScripts = readdirSync(scriptsDir).filter((f) => f.match(/^verify-t\d+.*\.mjs$/i));
  if (tidScripts.length === 0) {
    pass('No TID-based verify scripts remain in scripts/');
  } else {
    fail(`TID-based verify scripts still in scripts/: ${tidScripts.join(', ')}`);
  }
} else {
  fail('scripts/ directory not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9227 — VS2-6 migrate verifier scripts');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
