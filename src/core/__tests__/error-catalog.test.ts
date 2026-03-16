import { describe, expect, it } from 'vitest';
import {
  ERROR_CATALOG,
  getAllErrorDefinitions,
  getErrorDefinition,
  getErrorDefinitionByLafsCode,
} from '../error-catalog.js';
import { CleoError, type ProblemDetails } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

describe('error-catalog', () => {
  describe('ERROR_CATALOG structure', () => {
    it('has entries for core exit codes', () => {
      expect(ERROR_CATALOG.has(ExitCode.SUCCESS)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.GENERAL_ERROR)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.INVALID_INPUT)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.NOT_FOUND)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.VALIDATION_ERROR)).toBe(true);
    });

    it('has entries for adapter error codes (95-99)', () => {
      expect(ERROR_CATALOG.has(ExitCode.ADAPTER_NOT_FOUND)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.ADAPTER_INIT_FAILED)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.ADAPTER_HOOK_FAILED)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.ADAPTER_SPAWN_FAILED)).toBe(true);
      expect(ERROR_CATALOG.has(ExitCode.ADAPTER_INSTALL_FAILED)).toBe(true);
    });

    it('every entry has valid LAFS category', () => {
      const validCategories = new Set([
        'INTERNAL', 'VALIDATION', 'NOT_FOUND', 'CONFLICT',
        'CONTRACT', 'PERMISSION', 'TRANSIENT',
      ]);
      for (const entry of ERROR_CATALOG.values()) {
        expect(validCategories.has(entry.category)).toBe(true);
      }
    });

    it('every entry has a valid HTTP status code', () => {
      for (const entry of ERROR_CATALOG.values()) {
        expect(entry.httpStatus).toBeGreaterThanOrEqual(200);
        expect(entry.httpStatus).toBeLessThanOrEqual(599);
      }
    });

    it('every entry has a LAFS code starting with E_CLEO_', () => {
      for (const entry of ERROR_CATALOG.values()) {
        expect(entry.lafsCode).toMatch(/^E_CLEO_/);
      }
    });

    it('LAFS codes are unique across catalog', () => {
      const codes = getAllErrorDefinitions().map((e) => e.lafsCode);
      const unique = new Set(codes);
      expect(unique.size).toBe(codes.length);
    });
  });

  describe('getErrorDefinition', () => {
    it('returns definition for known exit code', () => {
      const def = getErrorDefinition(ExitCode.NOT_FOUND);
      expect(def).toBeDefined();
      expect(def!.name).toBe('NOT_FOUND');
      expect(def!.httpStatus).toBe(404);
    });

    it('returns undefined for unknown exit code', () => {
      expect(getErrorDefinition(9999)).toBeUndefined();
    });
  });

  describe('getErrorDefinitionByLafsCode', () => {
    it('finds definition by LAFS code', () => {
      const def = getErrorDefinitionByLafsCode('E_CLEO_NOT_FOUND');
      expect(def).toBeDefined();
      expect(def!.code).toBe(ExitCode.NOT_FOUND);
    });

    it('returns undefined for unknown LAFS code', () => {
      expect(getErrorDefinitionByLafsCode('E_CLEO_NONEXISTENT')).toBeUndefined();
    });
  });

  describe('getAllErrorDefinitions', () => {
    it('returns all catalog entries as array', () => {
      const all = getAllErrorDefinitions();
      expect(all.length).toBe(ERROR_CATALOG.size);
    });
  });
});

describe('CleoError RFC 9457 ProblemDetails', () => {
  it('produces valid ProblemDetails shape', () => {
    const err = new CleoError(ExitCode.NOT_FOUND, 'Task T999 not found');
    const pd: ProblemDetails = err.toProblemDetails();

    expect(pd.type).toBe(`urn:cleo:error:${ExitCode.NOT_FOUND}`);
    expect(pd.title).toBe('NOT_FOUND');
    expect(pd.status).toBe(404);
    expect(pd.detail).toBe('Task T999 not found');
    expect(pd.extensions).toBeDefined();
    expect(pd.extensions!.lafsCode).toBe('E_CLEO_NOT_FOUND');
    expect(pd.extensions!.category).toBe('NOT_FOUND');
    expect(typeof pd.extensions!.recoverable).toBe('boolean');
  });

  it('includes fix in extensions when provided', () => {
    const err = new CleoError(ExitCode.INVALID_INPUT, 'Bad param', {
      fix: 'Check the task ID format',
    });
    const pd = err.toProblemDetails();
    expect(pd.extensions!.fix).toBe('Check the task ID format');
  });

  it('adapter errors produce correct ProblemDetails', () => {
    const err = new CleoError(ExitCode.ADAPTER_NOT_FOUND, 'Adapter cursor not found');
    const pd = err.toProblemDetails();
    expect(pd.status).toBe(404);
    expect(pd.extensions!.lafsCode).toBe('E_CLEO_ADAPTER_NOT_FOUND');
    expect(pd.extensions!.category).toBe('NOT_FOUND');
  });

  it('adapter init failure is marked recoverable', () => {
    const err = new CleoError(ExitCode.ADAPTER_INIT_FAILED, 'Init failed');
    const pd = err.toProblemDetails();
    expect(pd.status).toBe(500);
    expect(pd.extensions!.recoverable).toBe(true);
  });

  it('toLAFSError and toProblemDetails agree on category', () => {
    const err = new CleoError(ExitCode.CONCURRENT_SESSION, 'Conflict');
    const lafs = err.toLAFSError();
    const pd = err.toProblemDetails();
    expect(lafs.category).toBe(pd.extensions!.category);
  });

  it('toJSON produces backward-compatible shape', () => {
    const err = new CleoError(ExitCode.VALIDATION_ERROR, 'Invalid');
    const json = err.toJSON();
    expect(json.success).toBe(false);
    expect((json.error as Record<string, unknown>).code).toBe(ExitCode.VALIDATION_ERROR);
    expect((json.error as Record<string, unknown>).message).toBe('Invalid');
  });
});
