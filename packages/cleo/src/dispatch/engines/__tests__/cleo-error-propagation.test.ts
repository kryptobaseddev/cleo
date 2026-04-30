/**
 * Tests for FIX-1.5 (T374): CleoError rich envelope propagation through engine catch blocks.
 *
 * Verifies that `cleoErrorToEngineError` correctly forwards .fix, .details,
 * and .alternatives from caught CleoError instances.
 *
 * After T1568 Wave 5, task-engine.ts was deleted. The end-to-end tests that
 * tested taskShow/taskComplete error propagation have been removed since those
 * functions now live in core and use a different (simpler) error-mapping path.
 * The unit tests for cleoErrorToEngineError are preserved here.
 *
 * @task T374
 * @epic T335
 */

import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { cleoErrorToEngineError } from '../_error.js';

// ---------------------------------------------------------------------------
// Helper: build a CleoError-shaped object (structural type, avoids circular dep)
// ---------------------------------------------------------------------------

function makeCleoError(
  numericCode: number,
  message: string,
  options?: {
    fix?: string;
    details?: Record<string, unknown>;
    alternatives?: Array<{ action: string; command: string }>;
  },
): Error & {
  code: number;
  fix?: string;
  details?: Record<string, unknown>;
  alternatives?: Array<{ action: string; command: string }>;
} {
  const err = new Error(message) as Error & {
    code: number;
    fix?: string;
    details?: Record<string, unknown>;
    alternatives?: Array<{ action: string; command: string }>;
  };
  err.code = numericCode;
  if (options?.fix !== undefined) err.fix = options.fix;
  if (options?.details !== undefined) err.details = options.details;
  if (options?.alternatives !== undefined) err.alternatives = options.alternatives;
  return err;
}

// ---------------------------------------------------------------------------
// Unit tests for cleoErrorToEngineError helper
// ---------------------------------------------------------------------------

describe('cleoErrorToEngineError', () => {
  it('forwards fix, details, and alternatives from a full CleoError', () => {
    const err = makeCleoError(4, 'Task T999 not found', {
      fix: "Use 'cleo find T999' to search",
      details: { taskId: 'T999', scope: 'global' },
      alternatives: [{ action: 'search', command: 'cleo find T999' }],
    });

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND'); // numeric 4 → 'E_NOT_FOUND'
    expect(result.error?.message).toBe('Task T999 not found');
    expect(result.error?.fix).toBe("Use 'cleo find T999' to search");
    expect(result.error?.details).toEqual({ taskId: 'T999', scope: 'global' });
    expect(result.error?.alternatives).toEqual([{ action: 'search', command: 'cleo find T999' }]);
  });

  it('includes only fix when alternatives and details are absent', () => {
    const err = makeCleoError(4, 'Not found', {
      fix: 'cleo find <query>',
    });

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback');

    expect(result.success).toBe(false);
    expect(result.error?.fix).toBe('cleo find <query>');
    expect(result.error?.alternatives).toBeUndefined();
    expect(result.error?.details).toBeUndefined();
  });

  it('uses fallback code and message for a plain Error with no code', () => {
    const err = new Error('Something went wrong');

    const result = cleoErrorToEngineError(
      err,
      'E_NOT_INITIALIZED',
      'Task database not initialized',
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_INITIALIZED');
    expect(result.error?.message).toBe('Something went wrong'); // message comes from err
    expect(result.error?.fix).toBeUndefined();
    expect(result.error?.alternatives).toBeUndefined();
    expect(result.error?.details).toBeUndefined();
  });

  it('uses fallback message when err.message is absent', () => {
    // Some non-Error throws don't have a message
    const result = cleoErrorToEngineError({}, 'E_GENERAL', 'Operation failed');

    expect(result.error?.message).toBe('Operation failed');
  });

  it('maps all known numeric exit codes to their canonical string codes', () => {
    // Spot check a few important mappings
    const cases: Array<[number, string]> = [
      [2, 'E_INVALID_INPUT'],
      [4, 'E_NOT_FOUND'],
      [6, 'E_VALIDATION'],
      [10, 'E_PARENT_NOT_FOUND'],
      [14, 'E_CIRCULAR_DEP'],
      [30, 'E_SESSION_EXISTS'],
      [31, 'E_SESSION_NOT_FOUND'],
    ];

    for (const [numericCode, expectedStringCode] of cases) {
      const err = makeCleoError(numericCode, `Error with code ${numericCode}`);
      const result = cleoErrorToEngineError(err, 'E_FALLBACK', 'fallback message');
      expect(result.error?.code, `code ${numericCode}`).toBe(expectedStringCode);
    }
  });
});
