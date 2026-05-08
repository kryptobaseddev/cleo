#!/usr/bin/env node
/**
 * Verifier for T9023: Wire applyPerfPragmas into one-shot writer DB opens.
 *
 * AC: applyPerfPragmas is called for write/one-shot DB open paths (no enableWal:false).
 * Must check agent-registry-accessor, cross-db-cleanup, conduit-sqlite, open-cleo-db.
 */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
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
// Check 1: agent-registry-accessor.ts has applyPerfPragmas for writes
// ---------------------------------------------------------------------------
const agentReg = readFile('packages/core/src/store/agent-registry-accessor.ts');
const agentRegCalls = (agentReg.match(/applyPerfPragmas\(/g) || []);
if (agentRegCalls.length >= 2) {
  pass(`agent-registry-accessor.ts has ${agentRegCalls.length} applyPerfPragmas calls`);
} else {
  fail(`agent-registry-accessor.ts must have >= 2 applyPerfPragmas calls (T9023 wires writer opens), found ${agentRegCalls.length}`);
}

// ---------------------------------------------------------------------------
// Check 2: cross-db-cleanup.ts has applyPerfPragmas for one-shot writes
// ---------------------------------------------------------------------------
const crossDb = readFile('packages/core/src/store/cross-db-cleanup.ts');
const crossDbCalls = (crossDb.match(/applyPerfPragmas\(/g) || []);
if (crossDbCalls.length >= 1) {
  pass(`cross-db-cleanup.ts has ${crossDbCalls.length} applyPerfPragmas calls`);
} else {
  fail(`cross-db-cleanup.ts must have >= 1 applyPerfPragmas call for one-shot writer path (T9023), found ${crossDbCalls.length}`);
}

// ---------------------------------------------------------------------------
// Check 3: conduit-sqlite.ts has applyPerfPragmas for writer paths
// ---------------------------------------------------------------------------
const conduit = readFile('packages/core/src/store/conduit-sqlite.ts');
const conduitCalls = (conduit.match(/applyPerfPragmas\(/g) || []);
if (conduitCalls.length >= 2) {
  pass(`conduit-sqlite.ts has ${conduitCalls.length} applyPerfPragmas calls`);
} else {
  fail(`conduit-sqlite.ts must have >= 2 applyPerfPragmas calls (T9023), found ${conduitCalls.length}`);
}

// ---------------------------------------------------------------------------
// Check 4: open-cleo-db.ts imports and calls applyPerfPragmas
// ---------------------------------------------------------------------------
const openCleoDb = readFile('packages/core/src/store/open-cleo-db.ts');
if (openCleoDb.includes("import { applyPerfPragmas }") && openCleoDb.includes('applyPerfPragmas(')) {
  pass('open-cleo-db.ts imports and calls applyPerfPragmas');
} else {
  fail('open-cleo-db.ts must import and call applyPerfPragmas for canonical DB open path (T9023)');
}

// ---------------------------------------------------------------------------
// Check 5: T9023 task reference exists in these writer files
// ---------------------------------------------------------------------------
const t9023Refs = [agentReg, crossDb, conduit].filter(f => f.includes('T9023'));
if (t9023Refs.length >= 1) {
  pass(`T9023 referenced in ${t9023Refs.length} writer open files`);
} else {
  fail('No T9023 task reference found in writer DB open files — implementation may be missing');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9023 — applyPerfPragmas wired into one-shot writer DB opens');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
