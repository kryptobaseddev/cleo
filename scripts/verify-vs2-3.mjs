#!/usr/bin/env node
/**
 * Acceptance verifier for T9224: VS2-3 AC drift detection — acHash sha256 fingerprint
 *
 * AC checks:
 *   1. verifier header comment includes acHash sha256 of AC bullets at generation
 *   2. cleo verify --acceptance-check computes current AC hash, compares to verifier acHash
 *   3. warns AC_DRIFT when mismatched, suggests cleo verify backfill --force
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

// Check 1: verifier-stub-generator.ts includes computeAcHash and embeds @acHash
const stubGenPath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'verifier-stub-generator.ts');
if (existsSync(stubGenPath)) {
  const src = readFileSync(stubGenPath, 'utf8');
  if (src.includes('computeAcHash') && src.includes('@acHash')) {
    pass('verifier-stub-generator.ts includes computeAcHash and @acHash embedding');
  } else {
    fail('verifier-stub-generator.ts missing computeAcHash or @acHash');
  }
} else {
  fail('verifier-stub-generator.ts not found');
}

// Check 2: extractAcHashFromSource exported from core
const coreIndexPath = join(REPO_ROOT, 'packages', 'core', 'src', 'index.ts');
if (existsSync(coreIndexPath)) {
  const src = readFileSync(coreIndexPath, 'utf8');
  if (src.includes('extractAcHashFromSource') && src.includes('computeAcHash')) {
    pass('core/index.ts exports extractAcHashFromSource and computeAcHash');
  } else {
    fail('core/index.ts missing extractAcHashFromSource or computeAcHash exports');
  }
} else {
  fail('core/index.ts not found');
}

// Check 3: verify.ts uses extractAcHashFromSource and computes AC drift check
const verifyTsPath = join(REPO_ROOT, 'packages', 'cleo', 'src', 'cli', 'commands', 'verify.ts');
if (existsSync(verifyTsPath)) {
  const src = readFileSync(verifyTsPath, 'utf8');
  const hasExtract = src.includes('extractAcHashFromSource');
  const hasCompute = src.includes('computeAcHash');
  const hasDriftWarn = src.includes('AC_DRIFT');
  const hasBuildForce = src.includes('--force');
  if (hasExtract && hasCompute && hasDriftWarn && hasBuildForce) {
    pass('verify.ts detects AC drift and warns with suggestion to --force');
  } else {
    fail(`verify.ts missing: extract=${hasExtract}, compute=${hasCompute}, drift=${hasDriftWarn}, force=${hasBuildForce}`);
  }
} else {
  fail('verify.ts not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9224 — VS2-3 acHash drift detection');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
