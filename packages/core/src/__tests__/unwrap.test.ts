/**
 * Tests for the unwrap() helper and EngineResultError.
 *
 * @task T1725
 */

import { describe, expect, it } from 'vitest';
import { EngineResultError, engineError, engineSuccess, unwrap } from '../engine-result.js';
import type { ProblemDetails } from '../errors.js';

describe('unwrap()', () => {
  describe('success path', () => {
    it('returns data for a successful EngineResult', () => {
      const result = engineSuccess({ id: 'T1725', title: 'test task' });
      const data = unwrap(result);
      expect(data).toEqual({ id: 'T1725', title: 'test task' });
    });

    it('returns primitive data unchanged', () => {
      expect(unwrap(engineSuccess(42))).toBe(42);
      expect(unwrap(engineSuccess('hello'))).toBe('hello');
      expect(unwrap(engineSuccess(true))).toBe(true);
      expect(unwrap(engineSuccess(null))).toBeNull();
    });

    it('returns undefined data unchanged', () => {
      expect(unwrap(engineSuccess(undefined))).toBeUndefined();
    });
  });

  describe('failure path', () => {
    it('throws EngineResultError when result is a failure', () => {
      const result = engineError('E_NOT_FOUND', 'Task not found');
      expect(() => unwrap(result)).toThrow(EngineResultError);
    });

    it('preserves code field on thrown error', () => {
      const result = engineError('E_VALIDATION_ERROR', 'Invalid input');
      expect(() => unwrap(result)).toThrow(expect.objectContaining({ code: 'E_VALIDATION_ERROR' }));
    });

    it('preserves message field on thrown error', () => {
      const result = engineError('E_NOT_FOUND', 'Task T9999 not found');
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).message).toBe('Task T9999 not found');
    });

    it('preserves exitCode field when present', () => {
      const result = engineError('E_NOT_FOUND', 'Not found', { exitCode: 4 });
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).exitCode).toBe(4);
    });

    it('preserves details field when present', () => {
      const details = { field: 'title', expected: 'string', actual: 42 };
      const result = engineError('E_VALIDATION_ERROR', 'Field error', { details });
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).details).toEqual(details);
    });

    it('preserves fix field when present', () => {
      const result = engineError('E_NOT_FOUND', 'Not found', { fix: 'cleo show T9999' });
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).fix).toBe('cleo show T9999');
    });

    it('preserves alternatives field when present', () => {
      const alternatives = [{ action: 'List tasks', command: 'cleo find ""' }];
      const result = engineError('E_NOT_FOUND', 'Not found', { alternatives });
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).alternatives).toEqual(alternatives);
    });

    it('preserves problemDetails field when present', () => {
      const problemDetails: ProblemDetails = {
        type: 'urn:cleo:error:4',
        title: 'NOT_FOUND',
        status: 404,
        detail: 'Task not found',
        instance: 'urn:cleo:task:T9999',
        extensions: { code: 4, recoverable: true },
      };
      const result = engineError('E_NOT_FOUND', 'Task not found', { problemDetails });
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).problemDetails).toEqual(problemDetails);
    });

    it('sets error name to EngineResultError', () => {
      const result = engineError('E_NOT_FOUND', 'Not found');
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect((caught as EngineResultError).name).toBe('EngineResultError');
    });

    it('omits undefined optional fields (exitCode absent when not provided)', () => {
      const result = engineError('E_GENERAL', 'Error without optional fields');
      let caught: unknown;
      try {
        unwrap(result);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EngineResultError);
      expect((caught as EngineResultError).exitCode).toBeUndefined();
      expect((caught as EngineResultError).details).toBeUndefined();
      expect((caught as EngineResultError).fix).toBeUndefined();
      expect((caught as EngineResultError).alternatives).toBeUndefined();
      expect((caught as EngineResultError).problemDetails).toBeUndefined();
    });
  });
});

describe('EngineResultError', () => {
  it('is an instance of Error', () => {
    const result = engineError('E_NOT_FOUND', 'Not found');
    let caught: unknown;
    try {
      unwrap(result);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(EngineResultError);
  });
});
