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
 * T1708: RFC 7807 problemDetails round-trip tests added — verifies that
 * cleoErrorToEngineError populates problemDetails with correct RFC 7807 fields.
 *
 * @task T374
 * @task T1708
 * @epic T335
 * @epic T1689
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

// ---------------------------------------------------------------------------
// RFC 7807 problemDetails round-trip tests (T1708)
// ---------------------------------------------------------------------------

describe('cleoErrorToEngineError — problemDetails (RFC 7807)', () => {
  it('populates problemDetails with correct RFC 7807 fields for a CleoError', () => {
    const err = makeCleoError(4, 'Task T42 not found');

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback');

    expect(result.success).toBe(false);
    expect(result.error?.problemDetails).toBeDefined();
    expect(result.error?.problemDetails?.type).toBe('https://cleocode.dev/errors/E_NOT_FOUND');
    expect(result.error?.problemDetails?.title).toBe('E_NOT_FOUND');
    expect(result.error?.problemDetails?.status).toBe(4); // exit code for E_NOT_FOUND
    expect(result.error?.problemDetails?.detail).toBe('Task T42 not found');
    expect(result.error?.problemDetails?.instance).toBeUndefined();
  });

  it('sets instance from meta.requestId when provided', () => {
    const err = makeCleoError(4, 'Task not found');
    const meta = { requestId: 'req-abc-123' };

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback', meta);

    expect(result.error?.problemDetails?.instance).toBe('req-abc-123');
  });

  it('omits instance field when meta.requestId is absent', () => {
    const err = makeCleoError(6, 'Validation failed');

    const result = cleoErrorToEngineError(err, 'E_GENERAL', 'fallback');

    expect(result.error?.problemDetails?.instance).toBeUndefined();
    expect('instance' in (result.error?.problemDetails ?? {})).toBe(false);
  });

  it('uses fallbackCode namespace URI when no numeric code maps', () => {
    // Plain Error with no .code property → fallback code path
    const err = new Error('Something exploded');

    const result = cleoErrorToEngineError(err, 'E_GENERAL', 'fallback message');

    expect(result.error?.problemDetails?.type).toBe('https://cleocode.dev/errors/E_GENERAL');
    expect(result.error?.problemDetails?.title).toBe('E_GENERAL');
    expect(result.error?.problemDetails?.detail).toBe('Something exploded');
  });

  it('populates problemDetails for string thrown values', () => {
    const result = cleoErrorToEngineError('raw string error', 'E_GENERAL', 'fallback');

    expect(result.error?.problemDetails?.type).toBe('https://cleocode.dev/errors/E_GENERAL');
    expect(result.error?.problemDetails?.detail).toBe('raw string error');
  });

  it('round-trip: EngineErrorPayload preserves all problemDetails fields end-to-end', () => {
    const err = makeCleoError(10, 'Parent task P1 not found', {
      fix: 'cleo show P1',
      details: { parentId: 'P1' },
    });
    const meta = { requestId: 'req-round-trip-001' };

    const result = cleoErrorToEngineError(err, 'E_NOT_INITIALIZED', 'fallback', meta);

    // Verify the full error payload
    expect(result.success).toBe(false);
    const { error } = result;
    expect(error?.code).toBe('E_PARENT_NOT_FOUND');
    expect(error?.exitCode).toBe(10);
    expect(error?.message).toBe('Parent task P1 not found');
    expect(error?.fix).toBe('cleo show P1');
    expect(error?.details).toEqual({ parentId: 'P1' });

    // RFC 7807 fields preserved in problemDetails
    const pd = error?.problemDetails;
    expect(pd?.type).toBe('https://cleocode.dev/errors/E_PARENT_NOT_FOUND');
    expect(pd?.title).toBe('E_PARENT_NOT_FOUND');
    expect(pd?.status).toBe(10);
    expect(pd?.detail).toBe('Parent task P1 not found');
    expect(pd?.instance).toBe('req-round-trip-001');
  });
});
