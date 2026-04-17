/**
 * Tests for the atomicity guard (T889 / T894 / W3-3).
 *
 * Exhaustive role × scope matrix:
 * - orchestrator and lead roles always pass (regardless of file count).
 * - worker role requires 1..MAX_WORKER_FILES declared files.
 *
 * @task T889
 * @task T894
 */

import { describe, expect, it } from 'vitest';
import { AtomicityViolationError, checkAtomicity, MAX_WORKER_FILES } from '../atomicity.js';

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
    expect(result.meta).toEqual({ fileCount: 1, hasScope: true });
  });

  it(`allows worker at the cap (MAX_WORKER_FILES=${MAX_WORKER_FILES})`, () => {
    const files = Array.from({ length: MAX_WORKER_FILES }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T303',
      role: 'worker',
      declaredFiles: files,
    });
    expect(result.allowed).toBe(true);
    expect(result.meta).toEqual({ fileCount: MAX_WORKER_FILES, hasScope: true });
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
  });

  it('rejects worker with 10 files and suggests split count in fix hint', () => {
    const files = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const result = checkAtomicity({
      taskId: 'T305',
      role: 'worker',
      declaredFiles: files,
    });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe('E_ATOMICITY_VIOLATION');
    // 10 files / 3 per worker = 4 subtasks (ceil)
    const expectedSplits = Math.ceil(10 / MAX_WORKER_FILES);
    expect(result.fixHint).toContain(`${expectedSplits} subtasks`);
    expect(result.fixHint).toContain('cleo add --parent T305');
    expect(result.meta).toEqual({ fileCount: 10, hasScope: true });
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
