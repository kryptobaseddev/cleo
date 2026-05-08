#!/usr/bin/env node
/**
 * Verifier for T9054: Drop vestigial multi-engine polymorphism in getAccessor / createDataAccessor.
 *
 * AC:
 *   - createDataAccessor has NO engine parameter (dropped)
 *   - getAccessor exists ONLY as deprecated re-export pointing to createDataAccessor
 *   - No 'engine' parameter in createDataAccessor signature
 *   - T9054 annotation on the deprecated getAccessor
 *
 * NEGATIVE SPACE: Must verify getAccessor is deprecated — not fully removed,
 * must verify no engine param, not just "engine exists somewhere".
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
// Check 1: data-accessor.ts createDataAccessor has NO engine parameter
// ---------------------------------------------------------------------------
const dataAccessor = readFile('packages/core/src/store/data-accessor.ts');

// Extract the createDataAccessor function signature
const createFnMatch = dataAccessor.match(/export async function createDataAccessor\([^)]*\)/);
if (createFnMatch) {
  const signature = createFnMatch[0];
  if (!signature.includes('engine')) {
    pass(`createDataAccessor signature has no engine parameter: ${signature}`);
  } else {
    fail(`createDataAccessor still has engine parameter: ${signature} (T9054 — must be removed)`);
  }
} else {
  fail('createDataAccessor not found in data-accessor.ts');
}

// ---------------------------------------------------------------------------
// Check 2: getAccessor exists ONLY as @deprecated re-export
// ---------------------------------------------------------------------------
if (dataAccessor.includes('@deprecated') && dataAccessor.includes('getAccessor')) {
  pass('getAccessor is marked @deprecated in data-accessor.ts');
} else {
  fail('getAccessor must be marked @deprecated (T9054 — it was renamed to getTaskAccessor)');
}

// getAccessor must just call createDataAccessor (not have its own logic)
const getAccessorMatch = dataAccessor.match(/export async function getAccessor[\s\S]*?\n}/);
if (getAccessorMatch) {
  const fnBody = getAccessorMatch[0];
  if (fnBody.includes('createDataAccessor') && fnBody.length < 300) {
    pass('getAccessor is a thin deprecated wrapper around createDataAccessor');
  } else {
    fail('getAccessor must be a simple createDataAccessor re-export, not independent logic (T9054)');
  }
} else {
  // It's possible getAccessor was removed entirely — that's also acceptable per T9054
  if (!dataAccessor.includes('getAccessor')) {
    pass('getAccessor fully removed (acceptable per T9054)');
  } else {
    fail('getAccessor function not properly structured in data-accessor.ts');
  }
}

// ---------------------------------------------------------------------------
// Check 3: T9054 annotation exists on the deprecated function or module
// ---------------------------------------------------------------------------
if (dataAccessor.includes('T9054')) {
  pass('T9054 annotation found in data-accessor.ts');
} else {
  fail('Missing T9054 annotation in data-accessor.ts');
}

// ---------------------------------------------------------------------------
// Check 4: getTaskAccessor exists as the canonical replacement
// ---------------------------------------------------------------------------
if (dataAccessor.includes('export async function getTaskAccessor')) {
  pass('getTaskAccessor exists as canonical replacement for getAccessor');
} else {
  fail('getTaskAccessor must exist as canonical replacement for deprecated getAccessor (T9054)');
}

// ---------------------------------------------------------------------------
// Check 5: No multi-engine switch/if-else on 'engine' in data-accessor.ts
// (negative space: the old polymorphism must be gone)
// ---------------------------------------------------------------------------
const engineSwitchMatches = (dataAccessor.match(/(?:switch|if).*engine/g) || []);
if (engineSwitchMatches.length === 0) {
  pass('No engine switch/if-else in data-accessor.ts (multi-engine polymorphism removed)');
} else {
  fail(`data-accessor.ts still has ${engineSwitchMatches.length} engine switch/if-else — vestigial polymorphism not removed (T9054)`);
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9054 — vestigial multi-engine polymorphism dropped; getAccessor deprecated');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
