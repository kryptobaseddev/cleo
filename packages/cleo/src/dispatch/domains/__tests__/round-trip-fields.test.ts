/**
 * Round-trip field-preservation tests for the EngineResult ↔ LafsEnvelope
 * ↔ DispatchResponse conversion pipeline.
 *
 * Regression guard for the silent field-loss bug where exitCode, details, fix,
 * alternatives, and problemDetails were dropped during the typed-dispatch
 * round-trip (wrapCoreResult → envelopeToEngineResult → wrapResult).
 *
 * @task T1712 — W2.E fix EngineResult round-trip field-loss bug
 * @epic T1689
 */

import { engineError, engineSuccess } from '@cleocode/core';
import { describe, expect, it } from 'vitest';
import { wrapCoreResult } from '../../adapters/typed.js';
import { envelopeToEngineResult, wrapResult } from '../_base.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GATEWAY = 'query';
const DOMAIN = 'tasks';
const OPERATION = 'show';
const START_TIME = Date.now();

/** Minimal ProblemDetails shape used in assertions. */
const PROBLEM_DETAILS = {
  type: 'https://cleo.dev/errors/not-found',
  title: 'Task Not Found',
  status: 404,
  detail: 'Task T9999 does not exist.',
};

// ---------------------------------------------------------------------------
// Suite 1: envelopeToEngineResult (LafsEnvelope → EngineResult)
// ---------------------------------------------------------------------------

describe('envelopeToEngineResult — field preservation', () => {
  it('preserves code and message on the minimal error path', () => {
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found' },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_NOT_FOUND');
    expect(result.error.message).toBe('not found');
  });

  it('preserves exitCode', () => {
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found', exitCode: 4 },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.exitCode).toBe(4);
  });

  it('preserves details', () => {
    const details = { taskId: 'T9999', reason: 'deleted' };
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found', details },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.details).toEqual(details);
  });

  it('preserves fix', () => {
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found', fix: 'cleo find T9999' },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.fix).toBe('cleo find T9999');
  });

  it('preserves alternatives', () => {
    const alternatives = [{ action: 'search', command: 'cleo find T9999' }];
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found', alternatives },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.alternatives).toEqual(alternatives);
  });

  it('preserves problemDetails', () => {
    const envelope = {
      success: false as const,
      error: { code: 'E_NOT_FOUND', message: 'not found', problemDetails: PROBLEM_DETAILS },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.problemDetails).toEqual(PROBLEM_DETAILS);
  });

  it('preserves all fields simultaneously', () => {
    const alternatives = [{ action: 'search', command: 'cleo find T9999' }];
    const details = { taskId: 'T9999' };
    const envelope = {
      success: false as const,
      error: {
        code: 'E_NOT_FOUND',
        message: 'not found',
        exitCode: 4,
        details,
        fix: 'cleo find T9999',
        alternatives,
        problemDetails: PROBLEM_DETAILS,
      },
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('E_NOT_FOUND');
    expect(result.error.message).toBe('not found');
    expect(result.error.exitCode).toBe(4);
    expect(result.error.details).toEqual(details);
    expect(result.error.fix).toBe('cleo find T9999');
    expect(result.error.alternatives).toEqual(alternatives);
    expect(result.error.problemDetails).toEqual(PROBLEM_DETAILS);
  });

  it('success branch preserves data and page', () => {
    const page = { mode: 'offset' as const, limit: 10, offset: 0, total: 1, hasMore: false };
    const envelope = {
      success: true as const,
      data: { id: 'T1' },
      page,
    };
    const result = envelopeToEngineResult(envelope);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toEqual({ id: 'T1' });
    expect(result.page).toEqual(page);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: wrapCoreResult (EngineResult → LafsEnvelope) field preservation
// ---------------------------------------------------------------------------

describe('wrapCoreResult — field preservation', () => {
  it('preserves exitCode on the LafsEnvelope error', () => {
    const engineResult = engineError('E_NOT_FOUND', 'not found', { exitCode: 4 });
    const envelope = wrapCoreResult(engineResult, 'tasks.show');
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect((envelope.error as Record<string, unknown>)['exitCode']).toBe(4);
  });

  it('preserves details on the LafsEnvelope error', () => {
    const details = { taskId: 'T9999' };
    const engineResult = engineError('E_NOT_FOUND', 'not found', { details });
    const envelope = wrapCoreResult(engineResult, 'tasks.show');
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.details).toEqual(details);
  });

  it('preserves fix on the LafsEnvelope error', () => {
    const engineResult = engineError('E_NOT_FOUND', 'not found', { fix: 'cleo find T9999' });
    const envelope = wrapCoreResult(engineResult, 'tasks.show');
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.fix).toBe('cleo find T9999');
  });

  it('preserves alternatives on the LafsEnvelope error', () => {
    const alternatives = [{ action: 'search', command: 'cleo find T9999' }];
    const engineResult = engineError('E_NOT_FOUND', 'not found', { alternatives });
    const envelope = wrapCoreResult(engineResult, 'tasks.show');
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.alternatives).toEqual(alternatives);
  });

  it('preserves problemDetails on the LafsEnvelope error', () => {
    const engineResult = engineError('E_NOT_FOUND', 'not found', {
      problemDetails: PROBLEM_DETAILS,
    });
    const envelope = wrapCoreResult(engineResult, 'tasks.show');
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect((envelope.error as Record<string, unknown>)['problemDetails']).toEqual(PROBLEM_DETAILS);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Full round-trip EngineResult → LafsEnvelope → EngineResult → DispatchResponse
// ---------------------------------------------------------------------------

describe('full round-trip: EngineResult → wrapCoreResult → envelopeToEngineResult → wrapResult', () => {
  it('error round-trip preserves all fields end-to-end', () => {
    const alternatives = [{ action: 'search tasks', command: 'cleo find T9999' }];
    const details = { taskId: 'T9999', scope: 'global' };

    // Step 1: construct EngineResult with all fields populated
    const original = engineError('E_NOT_FOUND', 'Task T9999 not found', {
      exitCode: 4,
      details,
      fix: 'cleo find T9999',
      alternatives,
      problemDetails: PROBLEM_DETAILS,
    });

    // Step 2: EngineResult → LafsEnvelope (typed-dispatch path)
    const envelope = wrapCoreResult(original, 'tasks.show');

    // Step 3: LafsEnvelope → EngineResult (domain bridge path)
    const restored = envelopeToEngineResult(envelope);

    // Step 4: EngineResult → DispatchResponse (wrapResult path)
    const response = wrapResult(restored, GATEWAY, DOMAIN, OPERATION, START_TIME);

    // Assert byte-equal at every error field
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_NOT_FOUND');
    expect(response.error?.message).toBe('Task T9999 not found');
    expect(response.error?.exitCode).toBe(4);
    expect(response.error?.details).toEqual(details);
    expect(response.error?.fix).toBe('cleo find T9999');
    expect(response.error?.alternatives).toEqual(alternatives);
    expect(response.error?.problemDetails).toEqual(PROBLEM_DETAILS);
  });

  it('success round-trip preserves data', () => {
    const data = { id: 'T1', title: 'Do the thing' };

    // Step 1: construct successful EngineResult
    const original = engineSuccess(data);

    // Step 2: EngineResult → LafsEnvelope (typed-dispatch path)
    const envelope = wrapCoreResult(original, 'tasks.show');

    // Step 3: LafsEnvelope → EngineResult (domain bridge path)
    const restored = envelopeToEngineResult(envelope);

    // Step 4: EngineResult → DispatchResponse
    const response = wrapResult(restored, GATEWAY, DOMAIN, OPERATION, START_TIME);

    expect(response.success).toBe(true);
    expect(response.data).toEqual(data);
    expect(response.error).toBeUndefined();
  });

  it('error round-trip with only code+message (minimal path) does not inject undefined fields', () => {
    const original = engineError('E_INTERNAL', 'something went wrong');
    const envelope = wrapCoreResult(original, 'tasks.show');
    const restored = envelopeToEngineResult(envelope);
    const response = wrapResult(restored, GATEWAY, DOMAIN, OPERATION, START_TIME);

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INTERNAL');
    expect(response.error?.message).toBe('something went wrong');
    expect(response.error?.exitCode).toBeUndefined();
    expect(response.error?.details).toBeUndefined();
    expect(response.error?.fix).toBeUndefined();
    expect(response.error?.alternatives).toBeUndefined();
    expect(response.error?.problemDetails).toBeUndefined();
  });
});
