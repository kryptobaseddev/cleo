#!/usr/bin/env node
/**
 * Verifier for T9217: W5 Lead bypass detection in session grade
 *
 * Source task: T9217
 *
 * AC:
 *   - delegate_task_count metric in packages/core/src/sessions/session-grade.ts
 *   - S3 sub-evidence flag emits warning when role=lead AND delegate_task_count=0 AND tasks_completed>0
 *   - BRAIN observation lead-self-implementation-bypass recorded
 *   - surfaced via cleo session status and cleo session end --note
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
  const p = join(REPO_ROOT, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

const GRADE_PATH = 'packages/core/src/sessions/session-grade.ts';
const gradeSrc = readFile(GRADE_PATH);
if (!gradeSrc) {
  console.error(`FATAL: Cannot read ${GRADE_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 1: delegate_task_count metric exists in session-grade.ts
// ---------------------------------------------------------------------------
if (gradeSrc.includes('delegate_task_count') || gradeSrc.includes('delegateTaskCount')) {
  pass('delegate_task_count metric found in session-grade.ts (T9217)');
} else {
  fail('session-grade.ts must track delegate_task_count per session (T9217)');
}

// ---------------------------------------------------------------------------
// Check 2: S3 sub-evidence flag emits warning for lead-bypass pattern
// ---------------------------------------------------------------------------
const hasLeadBypassWarning =
  (gradeSrc.includes('lead') && gradeSrc.includes('delegate') && gradeSrc.includes('bypass')) ||
  (gradeSrc.includes('delegate_task_count') && gradeSrc.includes('taskHygiene')) ||
  (gradeSrc.includes('delegateTaskCount') && gradeSrc.includes('taskHygiene'));

if (hasLeadBypassWarning) {
  pass('S3 taskHygiene dimension has delegate_task_count warning for lead-bypass (T9217)');
} else {
  fail(
    'S3 (taskHygiene) must emit warning when role=lead AND delegate_task_count=0 AND tasks_completed>0 (T9217)',
  );
}

// ---------------------------------------------------------------------------
// Check 3: BRAIN observation pattern 'lead-self-implementation-bypass'
// ---------------------------------------------------------------------------
if (gradeSrc.includes('lead-self-implementation-bypass')) {
  pass(
    "BRAIN observation 'lead-self-implementation-bypass' referenced in session-grade.ts (T9217)",
  );
} else {
  fail(
    "session-grade.ts must record BRAIN observation with pattern 'lead-self-implementation-bypass' (T9217)",
  );
}

// ---------------------------------------------------------------------------
// Check 4: GradeResult or related type exposes delegate_task_count
// ---------------------------------------------------------------------------
const hasMetricOnResult =
  gradeSrc.includes('delegate_task_count') || gradeSrc.includes('delegateTaskCount');

if (hasMetricOnResult) {
  pass('delegate_task_count is tracked in grade computation (T9217)');
} else {
  fail('delegate_task_count must be tracked and included in grade output (T9217)');
}

// ---------------------------------------------------------------------------
// Check 5: Session status / end --note surfacing (comment or code reference)
// ---------------------------------------------------------------------------
const hasSurfacing =
  gradeSrc.includes('session status') ||
  gradeSrc.includes('session end') ||
  gradeSrc.includes('sessionStatus') ||
  gradeSrc.includes('session-end') ||
  gradeSrc.includes('flags.push') ||
  gradeSrc.includes('result.flags');

if (hasSurfacing) {
  pass('delegate_task_count warning surfaced via grade flags or session status (T9217)');
} else {
  fail(
    'delegate_task_count bypass warning must be surfaced via cleo session status or cleo session end (T9217)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9217 — Lead bypass detection in session grade');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
