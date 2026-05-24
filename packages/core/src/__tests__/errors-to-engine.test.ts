/**
 * Tests for the canonical {@link cleoErrorToEngineResult} helper that
 * preserves CleoError LAFS codes across engine-result wrappers.
 *
 * Generalizes the T9838-D fix (which only patched `tasks/update.ts`) to
 * every status-transition + DB-invariant catch block in the tasks domain.
 *
 * AC mapping:
 *  - AC1: wrapper extracts real LAFS code from CleoError (not blanket
 *    `E_NOT_INITIALIZED`).
 *  - AC2: non-CleoError exceptions fall through to `E_INTERNAL` by default
 *    (configurable via `fallbackCode`).
 *  - AC3: generalizes the T9838-D fix — covers `taskDelete`, `taskArchive`,
 *    `taskList`, `taskFind`, `taskShow`, and similar wrappers.
 *  - AC4: a DB-trigger error surfaces with the correct LAFS code (not
 *    `E_NOT_INITIALIZED`).
 *
 * @task T9940
 * @epic T9862
 */

import { ExitCode } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';

describe('cleoErrorToEngineResult (T9940 — canonical engine-error wrapper)', () => {
  describe('AC1 — extracts real LAFS code from CleoError', () => {
    it('VALIDATION_ERROR surfaces as E_CLEO_VALIDATION (not E_NOT_INITIALIZED)', () => {
      const err = new CleoError(ExitCode.VALIDATION_ERROR, "Cannot transition from 'done'");
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.code).toBe('E_CLEO_VALIDATION');
        expect(result.error.message).toBe("Cannot transition from 'done'");
      }
    });

    it('NOT_FOUND surfaces as E_CLEO_NOT_FOUND (not E_NOT_INITIALIZED)', () => {
      const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found');
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.code).toBe('E_CLEO_NOT_FOUND');
      }
    });

    it('PARENT_NOT_FOUND surfaces with the catalog LAFS code (not E_NOT_INITIALIZED)', () => {
      const err = new CleoError(ExitCode.PARENT_NOT_FOUND, 'Parent T100 missing');
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.code).toMatch(/^E_CLEO_/);
      }
    });

    it('forwards fix, alternatives, and details from the CleoError', () => {
      const err = new CleoError(ExitCode.INVALID_INPUT, 'Bad input', {
        fix: 'Use cleo show <id>',
        alternatives: [{ action: 'Search', command: 'cleo find x' }],
        details: { field: 'taskId', actual: '', expected: 'T###' },
      });
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.fix).toBe('Use cleo show <id>');
        expect(result.error.alternatives).toEqual([{ action: 'Search', command: 'cleo find x' }]);
        expect(result.error.details).toEqual({
          field: 'taskId',
          actual: '',
          expected: 'T###',
        });
        expect(result.error.exitCode).toBe(ExitCode.INVALID_INPUT);
      }
    });
  });

  describe('AC2 — non-CleoError values fall through to fallback', () => {
    it('plain Error falls through to E_INTERNAL by default (not E_NOT_INITIALIZED)', () => {
      const err = new Error('boom');
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INTERNAL');
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.message).toBe('boom');
      }
    });

    it('honours an explicit fallbackCode override', () => {
      const err = new Error('list failed');
      const result = cleoErrorToEngineResult(err, 'E_LIST_FAILED', 'Failed to list');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_LIST_FAILED');
      }
    });

    it('null falls through to E_INTERNAL with the supplied fallback message', () => {
      const result = cleoErrorToEngineResult(null, 'E_INTERNAL', 'Default message');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INTERNAL');
        expect(result.error.message).toBe('Default message');
      }
    });
  });

  describe('AC4 — DB trigger / invariant errors carry the real LAFS code', () => {
    it('a CleoError raised by a DB invariant trigger surfaces its catalog code', () => {
      // Simulate a T877-style trigger surfacing as a CleoError (the canonical
      // path now that update.ts is fixed). Before T9940 this was being
      // re-labelled E_NOT_INITIALIZED by every wrapper in the tasks domain.
      const err = new CleoError(
        ExitCode.VALIDATION_ERROR,
        "T877_INVARIANT_VIOLATION: status='cancelled' requires pipeline_stage='cancelled'",
      );
      const result = cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.code).toBe('E_CLEO_VALIDATION');
        expect(result.error.message).toContain('T877_INVARIANT_VIOLATION');
      }
    });

    it('a raw Error with a DB-trigger message still falls through with the supplied fallback', () => {
      // Some DB drivers throw plain `Error`, not `CleoError`. The fallback
      // is `E_INTERNAL` — never the misleading `E_NOT_INITIALIZED` from the
      // pre-T9940 wrappers.
      const err = new Error('SQLITE_CONSTRAINT_TRIGGER: T877');
      const result = cleoErrorToEngineResult(err);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INTERNAL');
        expect(result.error.code).not.toBe('E_NOT_INITIALIZED');
        expect(result.error.message).toContain('T877');
      }
    });
  });
});
