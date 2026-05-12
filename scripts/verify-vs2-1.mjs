#!/usr/bin/env node
/**
 * Acceptance verifier for T9222: VS2-1 location — relocate verifier scripts to .cleo/verifiers/<TID>.mjs
 *
 * AC checks:
 *   1. .cleo/verifiers/ directory exists with .gitkeep
 *   2. backfill generator writes to .cleo/verifiers/<UPPER_TID>.mjs not scripts/
 *   3. cleo verify --acceptance-check resolves from .cleo/verifiers/ first, scripts/ as fallback
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const failures = [];

function pass(msg) { console.log('PASS:', msg); }
function fail(msg) { console.error('FAIL:', msg); failures.push(msg); }

// Check 1: .cleo/verifiers/ directory exists with .gitkeep
const gitkeepPath = join(REPO_ROOT, '.cleo', 'verifiers', '.gitkeep');
if (existsSync(gitkeepPath)) {
  pass('.cleo/verifiers/.gitkeep exists');
} else {
  fail('.cleo/verifiers/.gitkeep missing');
}

// Check 2: writeVerifierStub writes to .cleo/verifiers/<UPPER_TID>.mjs
const coreStubGenPath = join(REPO_ROOT, 'packages', 'core', 'src', 'tasks', 'verifier-stub-generator.ts');
if (existsSync(coreStubGenPath)) {
  const src = readFileSync(coreStubGenPath, 'utf8');
  if (src.includes('.cleo', 'verifiers') && src.includes('taskId.toUpperCase()')) {
    pass('writeVerifierStub targets .cleo/verifiers/<UPPER_TID>.mjs');
  } else {
    fail('writeVerifierStub does not target .cleo/verifiers/<UPPER_TID>.mjs');
  }
} else {
  fail('verifier-stub-generator.ts not found');
}

// Check 3: resolveVerifierScript checks .cleo/verifiers/ first
const verifyTsPath = join(REPO_ROOT, 'packages', 'cleo', 'src', 'cli', 'commands', 'verify.ts');
if (existsSync(verifyTsPath)) {
  const src = readFileSync(verifyTsPath, 'utf8');
  // The canonical path must appear before scripts/ in the candidates array
  const canonicalIdx = src.indexOf(".cleo', 'verifiers'");
  const scriptsIdx = src.indexOf("'scripts', `verify-");
  if (canonicalIdx !== -1 && scriptsIdx !== -1 && canonicalIdx < scriptsIdx) {
    pass('resolveVerifierScript checks .cleo/verifiers/ before scripts/');
  } else {
    fail('resolveVerifierScript does not prioritize .cleo/verifiers/ over scripts/');
  }
} else {
  fail('verify.ts not found');
}

// Final
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9222 — VS2-1 location');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
