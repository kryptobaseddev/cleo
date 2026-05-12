#!/usr/bin/env node
/**
 * Verifier for T9190 (T9025-FU): Real CI workflow gate for pragma drift.
 *
 * AC checks:
 *   1. At least one .github/workflows/*.yml file contains a job/step that
 *      runs the pragma drift check (grep for 'pragma', 'sqlite-pragma', or
 *      the test file name 'pragma-drift-guard').
 *   2. The workflow triggers on pull_request (not just manual/push to main).
 *
 * Note: We do NOT simulate a pragma removal here because that would require
 * a live DB + running tests. The verifier checks the CI wiring is present.
 *
 * Exit 0 only if ALL checks pass.
 *
 * @task T9190
 * @see scripts/verify-t9190-fu.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

console.log('=== T9190 Verifier: CI workflow gate for pragma drift ===\n');

const failures = [];

function fail(msg) {
  console.error('FAIL:', msg);
  failures.push(msg);
}

function pass(msg) {
  console.log('PASS:', msg);
}

// ---------------------------------------------------------------------------
// Check 1: workflows directory exists
// ---------------------------------------------------------------------------

if (!existsSync(WORKFLOWS_DIR)) {
  fail(`.github/workflows/ directory not found at ${WORKFLOWS_DIR}`);
  process.exit(1);
}

const workflowFiles = readdirSync(WORKFLOWS_DIR).filter(
  (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
);
if (workflowFiles.length === 0) {
  fail('No workflow files found in .github/workflows/');
  process.exit(1);
}

pass(`Found ${workflowFiles.length} workflow file(s): ${workflowFiles.join(', ')}`);

// ---------------------------------------------------------------------------
// Check 2: At least one workflow file contains a pragma-drift gate step
// ---------------------------------------------------------------------------

const PRAGMA_DRIFT_PATTERNS = [
  /pragma.{0,10}drift/i,
  /sqlite.{0,10}pragma/i,
  /pragma-drift-guard/i,
  /verify-pragma/i,
  /sqlite-pragmas/i,
  /pragma.*ssot/i,
];

let pragmaGateFound = false;
let pragmaGateFile = null;
let pragmaGateContent = null;

for (const file of workflowFiles) {
  const content = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
  for (const pattern of PRAGMA_DRIFT_PATTERNS) {
    if (pattern.test(content)) {
      pragmaGateFound = true;
      pragmaGateFile = file;
      pragmaGateContent = content;
      break;
    }
  }
  if (pragmaGateFound) break;
}

if (!pragmaGateFound) {
  fail(
    `No workflow file contains a pragma-drift gate step.\n` +
      `  Searched patterns: ${PRAGMA_DRIFT_PATTERNS.map((p) => p.toString()).join(', ')}\n` +
      `  Files searched: ${workflowFiles.join(', ')}\n\n` +
      `  T9190 AC requires a CI job/step that runs the pragma drift check on every PR.\n` +
      `  The existing unit test in packages/core/src/__tests__/pragma-drift-guard.test.ts\n` +
      `  is NOT sufficient — it needs to be wired into a GitHub Actions job.\n\n` +
      `  Expected: Add a job like:\n` +
      `    pragma-drift:\n` +
      `      runs-on: ubuntu-latest\n` +
      `      steps:\n` +
      `        - uses: actions/checkout@v4\n` +
      `        - name: Check pragma drift\n` +
      `          run: pnpm --filter @cleocode/core run test -- pragma-drift-guard\n`,
  );
} else {
  pass(`Pragma drift gate found in: ${pragmaGateFile}`);
}

// ---------------------------------------------------------------------------
// Check 3: The workflow triggers on pull_request
// ---------------------------------------------------------------------------

if (pragmaGateContent) {
  if (!/pull_request/i.test(pragmaGateContent)) {
    fail(
      `Workflow ${pragmaGateFile} contains pragma-drift gate but does NOT trigger on pull_request.\n` +
        `  The gate must run on every PR, not just push to main.`,
    );
  } else {
    pass(`Workflow ${pragmaGateFile} triggers on pull_request`);
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n--- Summary ---');
if (failures.length > 0) {
  console.error(`\nFAILED: ${failures.length} check(s) failed:`);
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  process.exit(1);
} else {
  console.log('\nALL CHECKS PASSED. T9190 AC satisfied.');
  process.exit(0);
}
