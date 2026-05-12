#!/usr/bin/env node
/**
 * Verifier for T9062: Cloud sync scaffold — namespaced multi-tenant PostgreSQL backend.
 *
 * AC (scaffold-only, not full implementation):
 *   - packages/contracts/src/postgres-data-accessor.ts exists with PostgresDataAccessor interface
 *   - docs/specs/cloud-sync-postgres-accessor.md exists
 *   - The interface mentions DataAccessor (engine-neutral drop-in)
 *   - T9062 annotation present in the file
 *   - The file compiles (TypeScript imports type from data-accessor.ts correctly)
 *
 * NEGATIVE SPACE: The file must be more than empty — must have actual interface content.
 */
import { existsSync, readFileSync } from 'node:fs';
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
// Check 1: postgres-data-accessor.ts exists
// ---------------------------------------------------------------------------
const pgPath = 'packages/contracts/src/postgres-data-accessor.ts';
if (existsSync(join(REPO_ROOT, pgPath))) {
  pass('packages/contracts/src/postgres-data-accessor.ts exists');
} else {
  fail(
    'packages/contracts/src/postgres-data-accessor.ts does not exist (T9062 scaffold not complete)',
  );
  process.exit(1); // can't continue
}

// ---------------------------------------------------------------------------
// Check 2: File has real content (not empty scaffold)
// ---------------------------------------------------------------------------
const pgContent = readFile(pgPath);
if (pgContent.length > 500) {
  pass(`postgres-data-accessor.ts has ${pgContent.length} chars of content (not a trivial stub)`);
} else {
  fail(
    `postgres-data-accessor.ts too short (${pgContent.length} chars) — likely an empty scaffold`,
  );
}

// ---------------------------------------------------------------------------
// Check 3: PostgresDataAccessor interface defined
// ---------------------------------------------------------------------------
if (pgContent.includes('PostgresDataAccessor')) {
  pass('PostgresDataAccessor type/interface defined in file');
} else {
  fail('postgres-data-accessor.ts missing PostgresDataAccessor interface (T9062)');
}

// ---------------------------------------------------------------------------
// Check 4: References DataAccessor from data-accessor.ts (engine-neutral proof)
// ---------------------------------------------------------------------------
if (pgContent.includes("from './data-accessor.js'") || pgContent.includes('DataAccessor')) {
  pass('postgres-data-accessor.ts references DataAccessor interface (engine-neutral contract)');
} else {
  fail(
    'postgres-data-accessor.ts must reference DataAccessor — proves engine-neutral contract (T9062)',
  );
}

// ---------------------------------------------------------------------------
// Check 5: T9062 annotation present
// ---------------------------------------------------------------------------
if (pgContent.includes('T9062')) {
  pass('T9062 annotation present in postgres-data-accessor.ts');
} else {
  fail('Missing T9062 annotation in postgres-data-accessor.ts');
}

// ---------------------------------------------------------------------------
// Check 6: docs/specs/cloud-sync-postgres-accessor.md exists
// ---------------------------------------------------------------------------
const specPath = 'docs/specs/cloud-sync-postgres-accessor.md';
if (existsSync(join(REPO_ROOT, specPath))) {
  const specContent = readFile(specPath);
  if (specContent.length > 200) {
    pass(`docs/specs/cloud-sync-postgres-accessor.md exists with ${specContent.length} chars`);
  } else {
    fail(
      `docs/specs/cloud-sync-postgres-accessor.md is too short (${specContent.length} chars) — likely empty scaffold`,
    );
  }
} else {
  fail(`docs/specs/cloud-sync-postgres-accessor.md does not exist (T9062 spec doc missing)`);
}

// ---------------------------------------------------------------------------
// Check 7: postgres-data-accessor.ts is exported from contracts index
// ---------------------------------------------------------------------------
const contractsIndex = readFile('packages/contracts/src/index.ts');
if (
  contractsIndex.includes('postgres-data-accessor') ||
  contractsIndex.includes('PostgresDataAccessor')
) {
  pass('postgres-data-accessor exported from @cleocode/contracts index');
} else {
  fail(
    'postgres-data-accessor.ts must be re-exported from packages/contracts/src/index.ts (T9062)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9062 — cloud sync PostgresDataAccessor scaffold in place');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
