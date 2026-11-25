/**
 * Tests for the atomicity guard (T889 / T894 / W3-3 / T9214 W4).
 *
 * Exhaustive role × scope matrix:
 * - orchestrator and lead roles always pass (regardless of file count).
 * - worker role requires 1..MAX_WORKER_FILES declared files.
 * - worker with scope: 'orchestrator-defer' passes and records atomicity_waiver.
 *
 * @task T889
 * @task T894
 * @task T9214
 */

import { describe, expect, it } from 'vitest';
import {
  ATOMIC_SCOPE_RULE,
  AtomicityViolationError,
  checkAtomicity,
  countScopedFiles,
  isAtomicScopeTestFile,
  MAX_WORKER_FILES,
} from '../atomicity.js';

describe('checkAtomicity — orchestrator role', () => {
  it('allows orchestrator with no declared files', () => {
    const result = checkAtomicity({ taskId: 'T100', role: 'orchestrator' });
    expect(result.allowed).toBe(true);
    expect(result.code).toBeUndefined();
  });

  it('allows orchestrator with 2 declared files', () => {
    const result = checkAtomicity({
      taskId: 'T101',
      role: 'orchestrator',
      declaredFiles: ['a.ts', 'b.ts'],
    });
    expect(result.allowed).toBe(true);
  });

  it('allows orchestrator with 10 declared files (well over worker cap)', () => {
    const result = checkAtomicity({
      taskId: 'T102',
      role: 'orchestrator',
      declaredFiles: Array.from({ length: 10 }, (_, i) => `f${i}.ts`),
    });
    expect(result.allowed).toBe(true);
  });
});

describe('checkAtomicity — lead role', () => {
  it('allows lead with no declared files', () => {
    const result = checkAtomicity({ taskId: 'T200', role: 'lead' });
    expect(result.allowed).toBe(true);
  });

  it('allows lead with 2 declared files', () => {
    const result = checkAtomicity({
      taskId: 'T201',
      role: 'lead',
      declaredFiles: ['a.ts', 'b.ts'],
    });
    expect(result.allowed).toBe(true);
  });

  it('allows lead with 10 declared files (well over worker cap)', () => {
    const result = checkAtomicity({
      taskId: 'T202',
      role: 'lead',
      declaredFiles: Array.from({ length: 10 }, (_, i) => `f${i}.ts`),
    });
    expect(result.allowed).toBe(true);
  });
});

describe('checkAtomicity — worker role', () => {
  it('rejects worker with no declared files (E_ATOMICITY_NO_SCOPE)', () => {
    const result = checkAtomicity({ taskId: 'T300', role: 'worker' });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_NO_SCOPE');
    expect(result.message).toContain('T300');
    expect(result.message).toContain('AC.files');
    expect(result.fixHint).toContain('T300');
    expect(result.fixHint).toContain('orchestrator-defer');
    expect(result.fixHint).toContain('--files');
    expect(result.meta).toEqual({ fileCount: 0, hasScope: false });
  });

  it('rejects worker with empty declaredFiles array (E_ATOMICITY_NO_SCOPE)', () => {
    const result = checkAtomicity({
      taskId: 'T301',
      role: 'worker',
      declaredFiles: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_NO_SCOPE');
  });

  it('allows worker with exactly 1 file', () => {
    const result = checkAtomicity({
      taskId: 'T302',
      role: 'worker',
      declaredFiles: ['packages/core/src/foo.ts'],
    });
    expect(result.allowed).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.meta).toEqual({ fileCount: 1, countedFileCount: 1, hasScope: true });
  });

  it(`allows worker at the cap (MAX_WORKER_FILES=${MAX_WORKER_FILES})`, () => {
    const files = Array.from({ length: MAX_WORKER_FILES }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T303',
      role: 'worker',
      declaredFiles: files,
    });
    expect(result.allowed).toBe(true);
    expect(result.meta).toEqual({
      fileCount: MAX_WORKER_FILES,
      countedFileCount: MAX_WORKER_FILES,
      hasScope: true,
    });
  });

  it(`rejects worker with ${MAX_WORKER_FILES + 1} files (E_ATOMICITY_VIOLATION)`, () => {
    const files = Array.from({ length: MAX_WORKER_FILES + 1 }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T304',
      role: 'worker',
      declaredFiles: files,
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_VIOLATION');
    expect(result.message).toContain(`${MAX_WORKER_FILES + 1} files`);
    expect(result.message).toContain(`max ${MAX_WORKER_FILES}`);
    expect(result.message).not.toContain('promote to lead');
    // T14633: the refusal states the rule that decided which files counted.
    expect(result.message).toContain(`Rule: ${ATOMIC_SCOPE_RULE}`);
  });

  it('T14633 — names routes that work for a leaf task with text ACs', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T305',
      role: 'worker',
      declaredFiles: files,
      parentId: 'T300',
      taskType: 'task',
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_VIOLATION');
    // Route 1: narrow. Route 2: siblings under the parent epic. Route 3: the
    // convert-to-children add carries --auto-decompose, because a plain
    // `cleo add --parent T305` is refused under a task with text ACs.
    expect(result.fixHint).toContain('cleo update T305 --files');
    expect(result.fixHint).toContain('cleo add "<title>" --parent T300 --relates T305');
    expect(result.fixHint).toContain('--parent T305 --auto-decompose');
    expect(result.fixHint).not.toMatch(/--parent T305(?! --auto-decompose)/);
    expect(result.fixHint).not.toContain('promote to lead');
    expect(result.meta).toEqual({ fileCount: 10, countedFileCount: 10, hasScope: true });
  });

  it('T14633 — a subtask refusal omits the convert-to-children route', () => {
    const result = checkAtomicity({
      taskId: 'T309',
      role: 'worker',
      declaredFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      parentId: 'T305',
      taskType: 'subtask',
    });
    expect(result.allowed).toBe(false);
    expect(result.fixHint).toContain('cleo update T309 --files');
    expect(result.fixHint).toContain('--parent T305 --relates T309');
    expect(result.fixHint).not.toContain('--auto-decompose');
  });

  it('T14633 — a test file paired with a declared source does not count; an orphan test counts', () => {
    expect(isAtomicScopeTestFile('packages/core/src/a.test.ts')).toBe(true);
    expect(isAtomicScopeTestFile('packages/core/src/a.spec.tsx')).toBe(true);
    expect(isAtomicScopeTestFile('packages/core/src/__tests__/helper.ts')).toBe(true);
    expect(isAtomicScopeTestFile('packages/core/src/attest.ts')).toBe(false);

    // One source file with three tests paired by stem: one counted file, allowed.
    const paired = [
      'packages/core/src/a.ts',
      'packages/core/src/a.test.ts',
      'packages/core/src/__tests__/a.test.ts',
      'packages/core/src/__tests__/a.spec.ts',
    ];
    expect(countScopedFiles(paired)).toBe(1);
    const allowed = checkAtomicity({ taskId: 'T310', role: 'worker', declaredFiles: paired });
    expect(allowed.allowed).toBe(true);
    expect(allowed.meta).toEqual({ fileCount: 4, countedFileCount: 1, hasScope: true });

    // Three sources plus tests that pair with none of them: every orphan counts.
    const orphans = ['a.ts', 'b.ts', 'c.ts', 'x.test.ts', 'y.test.ts', 'z.test.ts', 'w.test.ts'];
    expect(countScopedFiles(orphans)).toBe(7);
    const refusedOrphans = checkAtomicity({
      taskId: 'T312',
      role: 'worker',
      declaredFiles: orphans,
    });
    expect(refusedOrphans.allowed).toBe(false);
    expect(refusedOrphans.message).toContain('7 of which count');

    // A mix: a.test.ts pairs with a.ts, x.test.ts is an orphan.
    expect(countScopedFiles(['src/a.ts', 'src/__tests__/a.test.ts', 'src/x.test.ts'])).toBe(2);

    // Four test files and no source file: all four count, refused, rule stated.
    const testsOnly = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'];
    const refused = checkAtomicity({ taskId: 'T311', role: 'worker', declaredFiles: testsOnly });
    expect(refused.allowed).toBe(false);
    expect(refused.message).toContain('4 of which count');
    expect(refused.message).toContain(ATOMIC_SCOPE_RULE);
  });

  it('treats acFiles alias the same as declaredFiles', () => {
    const aliasResult = checkAtomicity({
      taskId: 'T306',
      role: 'worker',
      acFiles: ['a.ts', 'b.ts'],
    });
    expect(aliasResult.allowed).toBe(true);
    expect(aliasResult.meta?.fileCount).toBe(2);

    // And rejects the same way on overflow via the alias.
    const overflow = checkAtomicity({
      taskId: 'T307',
      role: 'worker',
      acFiles: Array.from({ length: MAX_WORKER_FILES + 2 }, (_, i) => `f${i}.ts`),
    });
    expect(overflow.allowed).toBe(false);
    expect(overflow.code).toBe('E_ATOMICITY_VIOLATION');
  });

  it('prefers declaredFiles over acFiles when both are provided', () => {
    const result = checkAtomicity({
      taskId: 'T308',
      role: 'worker',
      declaredFiles: ['canonical.ts'],
      acFiles: Array.from({ length: 10 }, (_, i) => `ignored${i}.ts`),
    });
    expect(result.allowed).toBe(true);
    expect(result.meta?.fileCount).toBe(1);
  });
});

describe('checkAtomicity — orchestrator-defer waiver (T9214)', () => {
  it('grants spawn when scope: orchestrator-defer and no files declared', () => {
    const result = checkAtomicity({
      taskId: 'T500',
      role: 'worker',
      scope: 'orchestrator-defer',
    });
    expect(result.allowed).toBe(true);
    expect(result.code).toBeUndefined();
    expect(result.atomicity_waiver).toBe('orchestrator-scope-tier1-call');
    expect(result.meta).toEqual({ fileCount: 0, hasScope: false });
  });

  it('records atomicity_waiver in the result envelope', () => {
    const result = checkAtomicity({
      taskId: 'T501',
      role: 'worker',
      scope: 'orchestrator-defer',
    });
    expect(result.atomicity_waiver).toBe('orchestrator-scope-tier1-call');
  });

  it('waiver does NOT suppress E_ATOMICITY_VIOLATION when files overflow', () => {
    // Overflow check still runs even when waiver is set — the waiver only
    // covers the missing-scope case, not the file-count cap violation.
    const files = Array.from({ length: MAX_WORKER_FILES + 1 }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T502',
      role: 'worker',
      scope: 'orchestrator-defer',
      declaredFiles: files,
    });
    // Worker has files but overflows — waiver does not apply here.
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_VIOLATION');
    expect(result.atomicity_waiver).toBeUndefined();
  });

  it('fixHint for E_ATOMICITY_NO_SCOPE includes child task ID and orchestrator-defer', () => {
    const result = checkAtomicity({ taskId: 'T503', role: 'worker' });
    expect(result.allowed).toBe(false);
    expect(result.fixHint).toContain('T503');
    expect(result.fixHint).toContain('orchestrator-defer');
  });

  it('waiver is a no-op for orchestrator role (already allowed)', () => {
    const result = checkAtomicity({
      taskId: 'T504',
      role: 'orchestrator',
      scope: 'orchestrator-defer',
    });
    expect(result.allowed).toBe(true);
    // Waiver field is absent — orchestrators are unconditionally allowed.
    expect(result.atomicity_waiver).toBeUndefined();
  });

  it('waiver is a no-op for lead role (already allowed)', () => {
    const result = checkAtomicity({
      taskId: 'T505',
      role: 'lead',
      scope: 'orchestrator-defer',
    });
    expect(result.allowed).toBe(true);
    expect(result.atomicity_waiver).toBeUndefined();
  });

  it('result without waiver does not carry atomicity_waiver field', () => {
    const result = checkAtomicity({
      taskId: 'T506',
      role: 'worker',
      declaredFiles: ['a.ts'],
    });
    expect(result.allowed).toBe(true);
    expect(result.atomicity_waiver).toBeUndefined();
  });
});

describe('AtomicityViolationError', () => {
  it('constructs from a rejected result with E_ATOMICITY_NO_SCOPE', () => {
    const result = checkAtomicity({ taskId: 'T400', role: 'worker' });
    expect(result.allowed).toBe(false);
    const err = new AtomicityViolationError(result);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('AtomicityViolationError');
    expect(err.code).toBe('E_ATOMICITY_NO_SCOPE');
    expect(err.exitCode).toBe(69);
    expect(err.message).toContain('T400');
    expect(err.fixHint).toContain('--files');
    expect(err.fixHint).toContain('orchestrator-defer');
    expect(err.meta).toEqual({ fileCount: 0, hasScope: false });
  });

  it('constructs from a rejected result with E_ATOMICITY_VIOLATION', () => {
    const files = Array.from({ length: 7 }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T401',
      role: 'worker',
      declaredFiles: files,
    });
    const err = new AtomicityViolationError(result);
    expect(err.code).toBe('E_ATOMICITY_VIOLATION');
    expect(err.exitCode).toBe(69);
    expect(err.meta?.fileCount).toBe(7);
  });

  it('throws TypeError when constructed from an allowed result', () => {
    const allowed = checkAtomicity({
      taskId: 'T402',
      role: 'worker',
      declaredFiles: ['ok.ts'],
    });
    expect(() => new AtomicityViolationError(allowed)).toThrow(TypeError);
  });
});
