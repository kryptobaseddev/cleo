#!/usr/bin/env node
/**
 * Verifier for T9065: Cross-link DocsAccessor with T1824 (Decision Storage Consolidation) + T1825.
 *
 * AC:
 *   - packages/core/src/__tests__/docs-accessor-adr-roundtrip.test.ts exists
 *   - The test file references T1824 and T1825
 *   - docs-accessor-impl.ts has a comment referencing T9065 or T1824
 *   - The test documents ADR storage model alignment (filesystem + index)
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
// Check 1: docs-accessor-adr-roundtrip.test.ts exists
// ---------------------------------------------------------------------------
const testPath = 'packages/core/src/__tests__/docs-accessor-adr-roundtrip.test.ts';
if (!existsSync(join(REPO_ROOT, testPath))) {
  fail(`${testPath} does not exist (T9065 cross-link not implemented)`);
  process.exit(1);
}

pass('docs-accessor-adr-roundtrip.test.ts exists');

// ---------------------------------------------------------------------------
// Check 2: Test file references T1824 and T1825 (cross-link)
// ---------------------------------------------------------------------------
const testContent = readFile(testPath);
if (testContent.includes('T1824') && testContent.includes('T1825')) {
  pass('Test file references both T1824 and T1825 (cross-link documented)');
} else {
  const missing = [];
  if (!testContent.includes('T1824')) missing.push('T1824');
  if (!testContent.includes('T1825')) missing.push('T1825');
  fail(`Test file missing references to: ${missing.join(', ')} (T9065 cross-link incomplete)`);
}

// ---------------------------------------------------------------------------
// Check 3: Test file documents ADR storage model alignment
// ---------------------------------------------------------------------------
if (testContent.includes('filesystem') && testContent.includes('storeDoc')) {
  pass('Test file documents ADR storage model (filesystem + index via storeDoc)');
} else {
  fail('Test file must document the ADR storage model alignment (filesystem + llmtxt index) per T9065');
}

// ---------------------------------------------------------------------------
// Check 4: docs-accessor-impl.ts has T9065 or T1824 cross-link reference
// ---------------------------------------------------------------------------
const implPath = 'packages/core/src/store/docs-accessor-impl.ts';
if (existsSync(join(REPO_ROOT, implPath))) {
  const implContent = readFile(implPath);
  if (implContent.includes('T9065') || implContent.includes('T1824') || implContent.includes('T9064')) {
    pass('docs-accessor-impl.ts has cross-link reference (T9065/T1824/T9064)');
  } else {
    fail('docs-accessor-impl.ts missing cross-link reference to T9065 or T1824 (T9065)');
  }
} else {
  fail(`${implPath} does not exist`);
}

// ---------------------------------------------------------------------------
// Check 5: Test file has actual test logic (not just comments)
// ---------------------------------------------------------------------------
if (testContent.includes('it(') || testContent.includes('test(')) {
  pass('Test file has actual test cases (not just documentation comments)');
} else {
  fail('Test file has no test cases — must have at least one it() or test() block (T9065)');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9065 — DocsAccessor cross-linked with T1824 + T1825 decision');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
