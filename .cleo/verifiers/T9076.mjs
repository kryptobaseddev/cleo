#!/usr/bin/env node
/**
 * Verifier for T9076: W6 — Update all docs to reflect new taxonomy + ADR + system-wide attestation.
 *
 * AC:
 *   - ADR-066-task-taxonomy-consolidation.md exists and has Status: Accepted
 *   - AGENTS.md or project docs reference T9072 (--kind canonical) or ADR-066
 *   - The ADR has references to T9072 (rename) and T9075 (bug deletion)
 *   - AC-everywhere concept documented in ADR
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
// Check 1: ADR-066 exists
// ---------------------------------------------------------------------------
const adrPath = '.cleo/adrs/ADR-066-task-taxonomy-consolidation.md';
if (!existsSync(join(REPO_ROOT, adrPath))) {
  fail('.cleo/adrs/ADR-066-task-taxonomy-consolidation.md does not exist (T9076)');
  process.exit(1);
}

pass('ADR-066-task-taxonomy-consolidation.md exists');

// ---------------------------------------------------------------------------
// Check 2: ADR-066 has Status: Accepted (not Draft/Proposed)
// ---------------------------------------------------------------------------
const adrContent = readFile(adrPath);
if (adrContent.includes('Status**: Accepted') || adrContent.includes('Status: Accepted')) {
  pass('ADR-066 has Status: Accepted');
} else {
  fail('ADR-066 does not have Status: Accepted — must be accepted, not draft (T9076)');
}

// ---------------------------------------------------------------------------
// Check 3: ADR-066 references T9072 (rename) and T9075 (bug deletion)
// ---------------------------------------------------------------------------
if (adrContent.includes('T9072') && adrContent.includes('T9075')) {
  pass('ADR-066 references both T9072 (rename) and T9075 (bug deletion)');
} else {
  const missing = [];
  if (!adrContent.includes('T9072')) missing.push('T9072');
  if (!adrContent.includes('T9075')) missing.push('T9075');
  fail(`ADR-066 missing references to: ${missing.join(', ')} (T9076)`);
}

// ---------------------------------------------------------------------------
// Check 4: ADR-066 has actual content (not just a stub)
// ---------------------------------------------------------------------------
if (adrContent.length > 1000) {
  pass(`ADR-066 has substantial content (${adrContent.length} chars)`);
} else {
  fail(`ADR-066 is too short (${adrContent.length} chars) — likely an empty scaffold`);
}

// ---------------------------------------------------------------------------
// Check 5: ADR-066 covers --kind canonicality (the core taxonomy change)
// ---------------------------------------------------------------------------
if (
  adrContent.includes('--kind') &&
  (adrContent.includes('canonical') || adrContent.includes('Canonical'))
) {
  pass('ADR-066 documents --kind as the canonical flag');
} else {
  fail('ADR-066 must document --kind as the canonical flag (T9076 AC-everywhere)');
}

// ---------------------------------------------------------------------------
// Check 6: ADR-066 covers AC-everywhere concept
// ---------------------------------------------------------------------------
if (
  adrContent.includes('AC-everywhere') ||
  adrContent.includes('acceptance') ||
  adrContent.includes('AcceptanceCriteria')
) {
  pass('ADR-066 covers AC-everywhere or acceptance criteria concept');
} else {
  fail('ADR-066 must cover AC-everywhere concept (T9076)');
}

// ---------------------------------------------------------------------------
// Check 7: T9076 is self-referential (ADR documenting its own task)
// ---------------------------------------------------------------------------
if (adrContent.includes('T9076')) {
  pass('ADR-066 is self-referential (mentions T9076)');
} else {
  fail('ADR-066 should reference T9076 (the task that authored it)');
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log(
    '\nVERIFIER PASS: T9076 — taxonomy ADR-066 exists, accepted, and covers all required topics',
  );
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
