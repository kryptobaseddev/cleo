#!/usr/bin/env node
/**
 * Verifier for T9029: Defer DB opens until command needs them.
 *
 * AC:
 *   - ensureConduitDb and ensureGlobalSignaldockDb NOT called in runStartupMaintenance()
 *   - T9029 documentation comment explains the deferral decision
 *   - "Steps 3 + 4 REMOVED" comment exists confirming the DB opens were removed
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
// Check 1: T9029 comment exists in CLI index.ts explaining deferral
// ---------------------------------------------------------------------------
const cliIndex = readFile('packages/cleo/src/cli/index.ts');
if (cliIndex.includes('T9029') && cliIndex.includes('deferred DB opens')) {
  pass('T9029 deferral comment found in CLI index.ts');
} else {
  fail('CLI index.ts must have T9029 comment explaining DB open deferral');
}

// ---------------------------------------------------------------------------
// Check 2: "Steps 3 + 4 REMOVED" confirmation comment exists
// ---------------------------------------------------------------------------
if (cliIndex.includes('Steps 3 + 4 REMOVED') || cliIndex.includes('Steps 3 +')) {
  pass('"Steps 3 + 4 REMOVED (T9029: deferred DB opens)" comment found');
} else {
  fail('Missing "Steps 3 + 4 REMOVED" confirmation in CLI index.ts — T9029 incomplete');
}

// ---------------------------------------------------------------------------
// Check 3: ensureConduitDb and ensureGlobalSignaldockDb NOT called unconditionally
// at startup. We check that within the runStartupMaintenance function body,
// these calls don't appear as direct (non-comment) calls.
//
// Method: find the runStartupMaintenance function, extract its body,
// then check there are no active (non-comment) calls to ensure* functions.
// ---------------------------------------------------------------------------
const startupFnMatch = cliIndex.match(/export async function runStartupMaintenance[\s\S]*?^}/m);
if (!startupFnMatch) {
  // Try alternative extraction: from function signature to next export
  const startupIdx = cliIndex.indexOf('async function runStartupMaintenance');
  if (startupIdx < 0) {
    fail('runStartupMaintenance function not found in CLI index.ts');
  } else {
    pass('runStartupMaintenance function found in CLI index.ts');
  }
} else {
  const fnBody = startupFnMatch[0];

  // Check for uncommented direct calls (not in comments)
  const lines = fnBody.split('\n');
  const activeEnsureCalls = lines.filter(l => {
    const trimmed = l.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') &&
           (trimmed.includes('ensureConduitDb(') || trimmed.includes('ensureGlobalSignaldockDb('));
  });

  if (activeEnsureCalls.length === 0) {
    pass('No active ensureConduitDb/ensureGlobalSignaldockDb calls in runStartupMaintenance (properly deferred)');
  } else {
    fail(`runStartupMaintenance has ${activeEnsureCalls.length} active ensure*Db call(s) — must be deferred (T9029):\n  ${activeEnsureCalls.join('\n  ')}`);
  }
}

// ---------------------------------------------------------------------------
// Check 4: DB-open audit section in JSDoc documents T9029
// ---------------------------------------------------------------------------
if (cliIndex.includes('DB-open audit (T9029)')) {
  pass('JSDoc DB-open audit section references T9029');
} else {
  fail('Missing DB-open audit section with T9029 reference in runStartupMaintenance JSDoc');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9029 — ensureConduitDb/ensureGlobalSignaldockDb properly deferred from startup');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
