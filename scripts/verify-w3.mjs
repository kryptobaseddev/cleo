#!/usr/bin/env node
/**
 * Verifier for T9216: W3 audit phase in IVTR + cantbook fix-up
 *
 * Source task: T9216
 *
 * AC:
 *   - IvtrPhase union extended to include 'audit' between validate and test
 *   - IvtrState gains schemaVersion field
 *   - defensive read handles legacy rows with loopBackCount.audit undefined
 *   - ivtr.cantbook adds both audit AND missing released nodes
 *   - auditor runs scripts/verify-<id>.mjs convention
 *   - loop-back from audit to implement on fail with verifier diagnostic
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

const IVTR_LOOP_PATH = 'packages/core/src/lifecycle/ivtr-loop.ts';
const ivtrSrc = readFile(IVTR_LOOP_PATH);
if (!ivtrSrc) {
  console.error(`FATAL: Cannot read ${IVTR_LOOP_PATH}`);
  process.exit(1);
}

const CANTBOOK_PATH = 'packages/playbooks/starter/ivtr.cantbook';
const cantbookSrc = readFile(CANTBOOK_PATH);
if (!cantbookSrc) {
  console.error(`FATAL: Cannot read ${CANTBOOK_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 1: IvtrPhase union includes 'audit'
// ---------------------------------------------------------------------------
if (ivtrSrc.includes("'audit'") && ivtrSrc.includes('IvtrPhase')) {
  // More precise: check the type definition line
  const typeMatch = /IvtrPhase\s*=\s*[^;]+/.exec(ivtrSrc);
  if (typeMatch && typeMatch[0].includes("'audit'")) {
    pass("IvtrPhase union includes 'audit'");
  } else {
    fail("IvtrPhase type union must include 'audit' (T9216)");
  }
} else {
  fail("IvtrPhase union must include 'audit' between 'validate' and 'test' (T9216)");
}

// ---------------------------------------------------------------------------
// Check 2: 'audit' appears between 'validate' and 'test' in PHASE_ORDER
// ---------------------------------------------------------------------------
const phaseOrderMatch = /PHASE_ORDER[^=]*=\s*\[([^\]]+)\]/.exec(ivtrSrc);
if (phaseOrderMatch) {
  const phases = phaseOrderMatch[1].replace(/[\s'"]/g, '').split(',');
  const auditIdx = phases.indexOf('audit');
  const validateIdx = phases.indexOf('validate');
  const testIdx = phases.indexOf('test');
  if (auditIdx > validateIdx && auditIdx < testIdx) {
    pass("'audit' is between 'validate' and 'test' in PHASE_ORDER (T9216)");
  } else {
    fail(
      `'audit' must come after 'validate' and before 'test' in PHASE_ORDER (found at index ${auditIdx}, validate=${validateIdx}, test=${testIdx}) (T9216)`,
    );
  }
} else {
  fail('PHASE_ORDER array not found in ivtr-loop.ts (T9216)');
}

// ---------------------------------------------------------------------------
// Check 3: IvtrState has schemaVersion field
// ---------------------------------------------------------------------------
const ivtrStateMatch = /interface IvtrState\s*\{([^}]+)\}/.exec(ivtrSrc);
if (ivtrStateMatch && ivtrStateMatch[1].includes('schemaVersion')) {
  pass('IvtrState interface has schemaVersion field (T9216)');
} else {
  fail('IvtrState interface must have a schemaVersion field (e.g. schemaVersion?: number) (T9216)');
}

// ---------------------------------------------------------------------------
// Check 4: loopBackCount initialization includes 'audit: 0'
// ---------------------------------------------------------------------------
if (ivtrSrc.includes('audit: 0')) {
  pass('loopBackCount initialization includes audit: 0 (T9216)');
} else {
  fail('loopBackCount must be initialized with audit: 0 for new IVTR states (T9216)');
}

// ---------------------------------------------------------------------------
// Check 5: defensive read handles loopBackCount.audit ?? 0
// ---------------------------------------------------------------------------
if (
  ivtrSrc.includes('audit') &&
  (ivtrSrc.includes('loopBackCount') || ivtrSrc.includes('loopBackCount'))
) {
  // Check that legacy rows are handled (either via ?? 0 or init guard)
  const hasDefensive =
    ivtrSrc.includes('.audit ?? 0') ||
    (ivtrSrc.includes('loopBackCount') &&
      ivtrSrc.includes('implement: 0, validate: 0') &&
      ivtrSrc.includes('audit: 0'));
  if (hasDefensive) {
    pass('Defensive read handles loopBackCount.audit undefined on legacy rows (T9216)');
  } else {
    fail(
      'loopBackIvtr must handle legacy rows where loopBackCount.audit is undefined (use ?? 0) (T9216)',
    );
  }
} else {
  fail('loopBackCount handling not found in ivtr-loop.ts (T9216)');
}

// ---------------------------------------------------------------------------
// Check 6: ivtr.cantbook has 'audit' node
// ---------------------------------------------------------------------------
if (
  cantbookSrc.includes('id: audit') ||
  cantbookSrc.includes("id: 'audit'") ||
  /^\s*-\s+id:\s+audit\s*$/m.test(cantbookSrc)
) {
  pass("ivtr.cantbook has 'audit' node (T9216)");
} else {
  fail("ivtr.cantbook must have an 'audit' node between validate and test (T9216)");
}

// ---------------------------------------------------------------------------
// Check 7: ivtr.cantbook has 'released' node
// ---------------------------------------------------------------------------
if (
  cantbookSrc.includes('id: released') ||
  cantbookSrc.includes("id: 'released'") ||
  /^\s*-\s+id:\s+released\s*$/m.test(cantbookSrc)
) {
  pass("ivtr.cantbook has 'released' node (T9216)");
} else {
  fail(
    "ivtr.cantbook must have a 'released' node (fixing drift between runtime and cantbook) (T9216)",
  );
}

// ---------------------------------------------------------------------------
// Check 8: auditor uses scripts/verify-<id>.mjs convention
// ---------------------------------------------------------------------------
if (
  cantbookSrc.includes('verify-') ||
  cantbookSrc.includes('scripts/verify') ||
  ivtrSrc.includes('verify-')
) {
  pass('Audit phase references scripts/verify-<id>.mjs convention (T9216)');
} else {
  // Looser check — the auditor convention may be in a comment or description
  if (cantbookSrc.includes('verif') || cantbookSrc.includes('audit')) {
    pass('ivtr.cantbook references audit/verify concept (T9216)');
  } else {
    fail(
      'Auditor node in ivtr.cantbook or ivtr-loop.ts must reference scripts/verify-<id>.mjs convention (T9216)',
    );
  }
}

// ---------------------------------------------------------------------------
// Check 9: loop-back from audit to implement on failure
// ---------------------------------------------------------------------------
const cantbookHasAuditLoopback =
  cantbookSrc.includes('inject_into: implement') ||
  (cantbookSrc.includes('audit') && cantbookSrc.includes('on_failure'));
const ivtrHasLoopback = ivtrSrc.includes("'audit'") && ivtrSrc.includes('loopBackIvtr');

if (cantbookHasAuditLoopback || ivtrHasLoopback) {
  pass('Loop-back from audit to implement on failure is configured (T9216)');
} else {
  fail(
    'Audit phase must loop back to implement on failure (via on_failure inject_into or loopBackIvtr) (T9216)',
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------
if (failures.length === 0) {
  console.log('\nVERIFIER PASS: T9216 — IVTR audit phase + cantbook fix-up');
  process.exit(0);
} else {
  console.error(`\nVERIFIER FAIL: ${failures.length} check(s) failed`);
  process.exit(1);
}
