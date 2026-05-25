#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = process.cwd();
const specPath = resolve(root, '.cleo/rcasd/T10554/specification/completion-criteria-spec.md');
const outPath = resolve(root, '.cleo/rcasd/T10554/specification/completion-criteria-spec.vitest.json');
const spec = readFileSync(specPath, 'utf8');

const checks = [
  {
    name: 'AC1 row-shape rules define allowed kinds and error codes',
    terms: [
      '## 4. AC kind row-shape rules (AC1)',
      "| `behavior` |",
      "| `test` |",
      "| `doc` |",
      "| `migration` |",
      "| `qa` |",
      "| `research` |",
      "| `release` |",
      "| `generic` |",
      'E_AC_KIND_MISSING',
      'E_AC_KIND_UNKNOWN',
      'E_AC_SHAPE_REQUIRED_FIELD',
      'E_AC_EVIDENCE_MISSING',
      'E_AC_EVIDENCE_KIND_INVALID',
      'completionCriteria.validateAcRowShape',
    ],
  },
  {
    name: 'AC2 cancelled child policy specifies rollup treatment and diagnostics',
    terms: [
      '## 5. Cancelled child policy (AC2)',
      'MUST NOT count as `done`',
      'excluded_cancelled',
      'E_PARENT_CANCELLED_CHILD_UNRESOLVED',
      'E_PARENT_CANCELLED_CHILD_HIDDEN',
      'E_PARENT_CANCELLED_CHILD_DOUBLE_COUNTED',
      'completionCriteria.validateCancelledChildPolicy',
    ],
  },
  {
    name: 'AC3 done parent reopen policy specifies material triggers and event contract',
    terms: [
      '## 6. Done parent reopen policy (AC3)',
      "eventType: 'parent-reopened'",
      "| 'child_regressed'",
      "| 'child_added'",
      "| 'cancelled_child_unresolved'",
      "| 'ac_added_or_reactivated'",
      "| 'evidence_invalidated'",
      "| 'waiver_expired_or_revoked'",
      'E_DONE_PARENT_REOPEN_REQUIRED',
      'E_DONE_PARENT_REOPEN_EVENT_MISSING',
      'E_DONE_PARENT_REOPEN_SPURIOUS',
      'completionCriteria.validateDoneParentReopenPolicy',
    ],
  },
  {
    name: 'AC4 waiver/replacement semantics specify immutable audit and conflict rules',
    terms: [
      '## 7. Waiver and replacement semantics (AC4)',
      'interface AcWaiver',
      'interface AcReplacement',
      'MUST NOT erase the original AC row',
      'MUST NOT be both `waived` and `replaced`',
      'E_AC_WAIVER_REQUIRED_FIELD',
      'E_AC_WAIVER_EXPIRED',
      'E_AC_WAIVER_SCOPE_INVALID',
      'E_AC_REPLACEMENT_REQUIRED_FIELD',
      'E_AC_REPLACEMENT_TARGET_MISSING',
      'E_AC_REPLACEMENT_CHAIN_INVALID',
      'E_AC_STATE_CONFLICT',
      'completionCriteria.validateWaiverReplacementSemantics',
    ],
  },
];

const assertionResults = checks.map((check) => {
  const missing = check.terms.filter((term) => !spec.includes(term));
  return {
    ancestorTitles: ['T10554 Completion Criteria RFC 2119 spec'],
    fullName: `T10554 Completion Criteria RFC 2119 spec ${check.name}`,
    title: check.name,
    status: missing.length === 0 ? 'passed' : 'failed',
    failureMessages: missing.map((term) => `Missing required term: ${term}`),
    location: null,
  };
});

const failed = assertionResults.filter((r) => r.status !== 'passed');
const now = new Date().toISOString();
const result = {
  numTotalTestSuites: 1,
  numPassedTestSuites: failed.length === 0 ? 1 : 0,
  numFailedTestSuites: failed.length === 0 ? 0 : 1,
  numPendingTestSuites: 0,
  numTotalTests: assertionResults.length,
  numPassedTests: assertionResults.length - failed.length,
  numFailedTests: failed.length,
  numPendingTests: 0,
  numTodoTests: 0,
  success: failed.length === 0,
  startTime: Date.parse(now),
  testResults: [
    {
      name: specPath,
      status: failed.length === 0 ? 'passed' : 'failed',
      startTime: Date.parse(now),
      endTime: Date.parse(now),
      assertionResults,
      message: failed.flatMap((r) => r.failureMessages).join('\n'),
    },
  ],
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ success: result.success, output: outPath, passed: result.numPassedTests, failed: result.numFailedTests }, null, 2));
process.exit(result.success ? 0 : 1);
