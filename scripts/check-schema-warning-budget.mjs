#!/usr/bin/env node
/**
 * T9170 — Schema-warning budget gate.
 *
 * Reads a test-output log file (default: stdin) and fails (exit 1) if it
 * contains "Adding missing column" warnings outside the allowlisted
 * legacy-upgrade test files. The allowlist covers tests that INTENTIONALLY
 * exercise the ensureColumns() safety net to verify legacy-DB compatibility.
 *
 * Usage:
 *   pnpm exec vitest run 2>&1 | tee /tmp/test-output.log
 *   node scripts/check-schema-warning-budget.mjs /tmp/test-output.log
 *
 * Exits 0 if no forbidden warnings found; exits 1 otherwise with details.
 *
 * @task T9170
 */

import { readFileSync } from 'node:fs';

// Tests that intentionally exercise the legacy-upgrade ensureColumns path.
// These tests verify Scenario 3 reconciliation, baseline-bootstrap, and
// other historical-compat paths and MUST be allowed to emit the warning.
const ALLOWED_FILES = [
  't920-migration-guard.test.ts',
  'migration-reconcile.test.ts',
  'migration-safety.test.ts',
  'migration-baseline.test.ts',
  'migration-v3-columns.test.ts',
  'idempotent-migration.test.ts',
];

const FORBIDDEN_PATTERN = /Adding missing column/;

function readInput() {
  const arg = process.argv[2];
  if (!arg || arg === '-') {
    return readFileSync(0, 'utf-8'); // stdin
  }
  return readFileSync(arg, 'utf-8');
}

function findViolations(content) {
  const lines = content.split('\n');
  const violations = [];
  let currentTestFile = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track which test file is currently running (vitest reports this).
    const testFileMatch = line.match(/(\S+\.test\.[mc]?[jt]sx?)/);
    if (testFileMatch) {
      currentTestFile = testFileMatch[1];
    }
    if (FORBIDDEN_PATTERN.test(line)) {
      const isAllowed = ALLOWED_FILES.some((f) => currentTestFile?.includes(f));
      if (!isAllowed) {
        violations.push({
          line: i + 1,
          testFile: currentTestFile ?? '<unknown>',
          content: line.length > 200 ? `${line.slice(0, 200)}…` : line,
        });
      }
    }
  }
  return violations;
}

const content = readInput();
const violations = findViolations(content);

if (violations.length === 0) {
  console.log('T9170: schema-warning budget OK — zero "Adding missing column" outside allowlist.');
  process.exit(0);
}

console.error(
  `T9170: schema-warning budget exceeded — ${violations.length} "Adding missing column" warning(s) outside allowlist.`,
);
console.error('');
console.error('Allowed files (intentional legacy-upgrade tests):');
for (const f of ALLOWED_FILES) console.error(`  - ${f}`);
console.error('');
console.error('Violations (first 20):');
for (const v of violations.slice(0, 20)) {
  console.error(`  line ${v.line} (test: ${v.testFile}):`);
  console.error(`    ${v.content}`);
}
if (violations.length > 20) {
  console.error(`  … and ${violations.length - 20} more`);
}
console.error('');
console.error('Fix: investigate the migration chain for the affected DB.');
console.error('  - Add explicit forward migration for the missing column, OR');
console.error(
  '  - Add the test file to ALLOWED_FILES if it intentionally exercises legacy-upgrade.',
);
console.error('See packages/core/src/store/migration-manager.ts ensureColumns() for context.');

if (process.env.GITHUB_ACTIONS === 'true') {
  console.log(
    `::error::T9170: schema-warning budget exceeded — ${violations.length} forbidden 'Adding missing column' warnings`,
  );
}
process.exit(1);
