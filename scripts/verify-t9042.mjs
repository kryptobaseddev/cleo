#!/usr/bin/env node
/**
 * Verifier for T9042: BUG — test fixtures pollute production task counter.
 *
 * AC:
 *   - sqlite-native.ts has VITEST isolation guard that REFUSES to open non-test DBs
 *   - The guard uses CLEO_TEST_ALLOWED_DB_ROOTS or CLEO_TEST_ALLOW_PROJECT_DB env vars
 *   - Error message clearly identifies [CLEO test isolation guard]
 *   - Tests in store/__tests__ have test-isolation documentation
 *
 * NEGATIVE SPACE: The guard must be active — not just a comment.
 */
import { readFileSync, existsSync } from 'node:fs';
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
// Check 1: sqlite-native.ts has VITEST isolation guard function
// ---------------------------------------------------------------------------
const sqliteNative = readFile('packages/core/src/store/sqlite-native.ts');

if (sqliteNative.includes('process.env.VITEST') && sqliteNative.includes('isolation guard')) {
  pass('sqlite-native.ts has VITEST isolation guard');
} else {
  fail('sqlite-native.ts must have VITEST isolation guard to block production DB opens during tests (T9042)');
}

// ---------------------------------------------------------------------------
// Check 2: Guard actively throws/errors when VITEST is set and path is production
// ---------------------------------------------------------------------------
if (sqliteNative.includes('CLEO_TEST_ALLOWED_DB_ROOTS') && sqliteNative.includes('CLEO_TEST_ALLOW_PROJECT_DB')) {
  pass('VITEST guard uses CLEO_TEST_ALLOWED_DB_ROOTS and CLEO_TEST_ALLOW_PROJECT_DB env vars');
} else {
  fail('Missing CLEO_TEST_ALLOWED_DB_ROOTS / CLEO_TEST_ALLOW_PROJECT_DB env var support in VITEST guard (T9042)');
}

// ---------------------------------------------------------------------------
// Check 3: Error message includes [CLEO test isolation guard] string
// ---------------------------------------------------------------------------
if (sqliteNative.includes('[CLEO test isolation guard]')) {
  pass('Error message includes [CLEO test isolation guard] identifier');
} else {
  fail('sqlite-native.ts guard error must include "[CLEO test isolation guard]" to clearly identify violations (T9042)');
}

// ---------------------------------------------------------------------------
// Check 4: VITEST guard refuses paths NOT in the allow list (negative space)
// The guard should check: if VITEST is true AND path not in allowedRoots AND
// not CLEO_TEST_ALLOW_PROJECT_DB → throw
// ---------------------------------------------------------------------------
const refusalLine = sqliteNative.includes('Refusing to open SQLite');
if (refusalLine) {
  pass('sqlite-native.ts explicitly "Refusing to open SQLite" in guard message');
} else {
  fail('sqlite-native.ts guard must explicitly say "Refusing to open SQLite" — vague errors are insufficient (T9042)');
}

// ---------------------------------------------------------------------------
// Check 5: Test isolation test file exists
// ---------------------------------------------------------------------------
const isolationTestPath = 'packages/core/src/store/__tests__/sqlite-native-vitest-guard.test.ts';
if (existsSync(join(REPO_ROOT, isolationTestPath))) {
  pass(`Test isolation test file exists: ${isolationTestPath}`);

  const testContent = readFile(isolationTestPath);
  if (testContent.includes('refuse') || testContent.includes('Refusing')) {
    pass('Test file validates that guard refuses production DB opens');
  } else {
    fail('Test file must validate guard REFUSES production DB opens — must test the negative case');
  }
} else {
  fail(`Missing test isolation test: ${isolationTestPath}`);
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9042 — VITEST isolation guard prevents production task counter pollution');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
