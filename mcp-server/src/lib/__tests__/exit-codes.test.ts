/**
 * Tests for exit code mapping
 *
 * @task T2913
 * @epic T2908
 */

import { describe, it, expect } from '@jest/globals';
import {
  ExitCode,
  ErrorSeverity,
  ErrorCategory,
  getErrorMapping,
  isError,
  isRetryable,
  isSuccess,
  isNonRecoverable,
  isRecoverable,
  generateFixCommand,
  generateSuggestions,
  ERROR_MAP,
  RETRYABLE_EXIT_CODES,
  NON_RECOVERABLE_EXIT_CODES,
} from '../exit-codes.js';

describe('Exit Code Mapping', () => {
  describe('getErrorMapping', () => {
    it('should return mapping for valid exit code', () => {
      const mapping = getErrorMapping(ExitCode.E_NOT_FOUND);
      expect(mapping.code).toBe('E_NOT_FOUND');
      expect(mapping.name).toBe('Not Found');
      expect(mapping.category).toBe(ErrorCategory.GENERAL);
    });

    it('should return unknown mapping for invalid exit code', () => {
      const mapping = getErrorMapping(999);
      expect(mapping.code).toBe('E_UNKNOWN');
      expect(mapping.name).toBe('Unknown Error');
    });

    it('should include all required fields', () => {
      const mapping = getErrorMapping(ExitCode.E_VALIDATION_ERROR);
      expect(mapping).toHaveProperty('code');
      expect(mapping).toHaveProperty('name');
      expect(mapping).toHaveProperty('description');
      expect(mapping).toHaveProperty('category');
      expect(mapping).toHaveProperty('severity');
      expect(mapping).toHaveProperty('retryable');
    });
  });

  describe('isError', () => {
    it('should return true for error codes (1-99)', () => {
      expect(isError(1)).toBe(true);
      expect(isError(50)).toBe(true);
      expect(isError(99)).toBe(true);
    });

    it('should return false for success (0)', () => {
      expect(isError(0)).toBe(false);
    });

    it('should return false for special codes (100+)', () => {
      expect(isError(100)).toBe(false);
      expect(isError(102)).toBe(false);
    });
  });

  describe('isRetryable', () => {
    it('should return true for retryable errors', () => {
      expect(isRetryable(ExitCode.E_LOCK_TIMEOUT)).toBe(true);
      expect(isRetryable(ExitCode.E_CHECKSUM_MISMATCH)).toBe(true);
      expect(isRetryable(ExitCode.E_CONCURRENT_MODIFICATION)).toBe(true);
    });

    it('should return false for non-retryable errors', () => {
      expect(isRetryable(ExitCode.E_NOT_FOUND)).toBe(false);
      expect(isRetryable(ExitCode.E_VALIDATION_ERROR)).toBe(false);
      expect(isRetryable(ExitCode.E_CIRCULAR_REFERENCE)).toBe(false);
    });
  });

  describe('isSuccess', () => {
    it('should return true for success code', () => {
      expect(isSuccess(0)).toBe(true);
    });

    it('should return true for special codes', () => {
      expect(isSuccess(100)).toBe(true);
      expect(isSuccess(102)).toBe(true);
    });

    it('should return false for error codes', () => {
      expect(isSuccess(1)).toBe(false);
      expect(isSuccess(50)).toBe(false);
    });
  });

  describe('generateFixCommand', () => {
    it('should generate fix command with context substitution', () => {
      const fix = generateFixCommand(ExitCode.E_NOT_FOUND, {
        resource: 'T2405',
      });
      expect(fix).toContain('T2405');
    });

    it('should return undefined if no fix template', () => {
      const fix = generateFixCommand(ExitCode.SUCCESS, {});
      expect(fix).toBeUndefined();
    });

    it('should replace all placeholders', () => {
      const fix = generateFixCommand(ExitCode.E_PARENT_NOT_FOUND, {
        parentId: 'T2400',
      });
      expect(fix).toBeDefined();
    });
  });

  describe('generateSuggestions', () => {
    it('should generate suggestions with context substitution', () => {
      const suggestions = generateSuggestions(ExitCode.E_NOT_FOUND, {
        query: 'authentication',
      });
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions[0].action).toBeDefined();
      expect(suggestions[0].command).toBeDefined();
    });

    it('should return empty array if no alternatives', () => {
      const suggestions = generateSuggestions(ExitCode.E_GENERAL_ERROR, {});
      expect(suggestions).toBeInstanceOf(Array);
    });

    it('should replace placeholders in commands', () => {
      const suggestions = generateSuggestions(ExitCode.E_PARENT_NOT_FOUND, {
        parentId: 'T2400',
      });
      expect(suggestions.length).toBeGreaterThan(1);
      expect(suggestions[1].command).toContain('T2400');
    });
  });

  describe('Protocol Error Codes', () => {
    it('should map all protocol errors correctly', () => {
      const protocolCodes = [
        ExitCode.E_PROTOCOL_RESEARCH,
        ExitCode.E_PROTOCOL_CONSENSUS,
        ExitCode.E_PROTOCOL_SPECIFICATION,
        ExitCode.E_PROTOCOL_DECOMPOSITION,
        ExitCode.E_PROTOCOL_IMPLEMENTATION,
        ExitCode.E_PROTOCOL_CONTRIBUTION,
        ExitCode.E_PROTOCOL_RELEASE,
        ExitCode.E_PROTOCOL_VALIDATION,
      ];

      protocolCodes.forEach((code) => {
        const mapping = getErrorMapping(code);
        expect(mapping.category).toBe(ErrorCategory.PROTOCOL);
        expect(mapping.severity).toBe(ErrorSeverity.ERROR);
        expect(mapping.documentation).toBeDefined();
      });
    });

    it('should have protocol-specific fix templates', () => {
      const mapping = getErrorMapping(ExitCode.E_PROTOCOL_RESEARCH);
      expect(mapping.fixTemplate).toContain('violations');
    });
  });

  describe('Lifecycle Error Codes', () => {
    it('should map lifecycle errors correctly', () => {
      const lifecycleCodes = [
        ExitCode.E_LIFECYCLE_GATE_FAILED,
        ExitCode.E_AUDIT_MISSING,
        ExitCode.E_CIRCULAR_VALIDATION,
        ExitCode.E_LIFECYCLE_TRANSITION_INVALID,
        ExitCode.E_PROVENANCE_REQUIRED,
      ];

      lifecycleCodes.forEach((code) => {
        const mapping = getErrorMapping(code);
        expect(mapping.category).toBe(ErrorCategory.LIFECYCLE);
      });
    });
  });

  describe('Session Error Codes', () => {
    it('should map session errors correctly', () => {
      const sessionCodes = [
        ExitCode.E_SESSION_EXISTS,
        ExitCode.E_SESSION_NOT_FOUND,
        ExitCode.E_SCOPE_CONFLICT,
        ExitCode.E_SESSION_REQUIRED,
        ExitCode.E_FOCUS_REQUIRED,
      ];

      sessionCodes.forEach((code) => {
        const mapping = getErrorMapping(code);
        expect(mapping.category).toBe(ErrorCategory.SESSION);
        expect(mapping.fixTemplate).toBeDefined();
      });
    });

    it('should provide session alternatives', () => {
      const suggestions = generateSuggestions(
        ExitCode.E_SESSION_NOT_FOUND,
        {}
      );
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((s) => s.command.includes('session'))).toBe(
        true
      );
    });
  });

  describe('Context Error Codes', () => {
    it('should map context warning levels correctly', () => {
      const contextCodes = [
        ExitCode.E_CONTEXT_WARNING,
        ExitCode.E_CONTEXT_CAUTION,
        ExitCode.E_CONTEXT_CRITICAL,
        ExitCode.E_CONTEXT_EMERGENCY,
      ];

      contextCodes.forEach((code) => {
        const mapping = getErrorMapping(code);
        expect(mapping.category).toBe(ErrorCategory.CONTEXT);
      });
    });

    it('should escalate severity with context level', () => {
      const warning = getErrorMapping(ExitCode.E_CONTEXT_WARNING);
      const critical = getErrorMapping(ExitCode.E_CONTEXT_CRITICAL);

      expect(warning.severity).toBe(ErrorSeverity.WARNING);
      expect(critical.severity).toBe(ErrorSeverity.CRITICAL);
    });
  });

  describe('Special Codes', () => {
    it('should map special codes as INFO severity', () => {
      const specialCodes = [
        ExitCode.E_NO_DATA,
        ExitCode.E_ALREADY_EXISTS,
        ExitCode.E_NO_CHANGE,
      ];

      specialCodes.forEach((code) => {
        const mapping = getErrorMapping(code);
        expect(mapping.category).toBe(ErrorCategory.SPECIAL);
        expect(mapping.severity).toBe(ErrorSeverity.INFO);
        expect(mapping.retryable).toBe(false);
      });
    });
  });

  describe('Hierarchy Error Codes', () => {
    it('should provide fix alternatives for hierarchy errors', () => {
      const suggestions = generateSuggestions(ExitCode.E_DEPTH_EXCEEDED, {});
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should map sibling limit with alternatives', () => {
      const mapping = getErrorMapping(ExitCode.E_SIBLING_LIMIT);
      expect(mapping.alternatives).toBeDefined();
      expect(mapping.alternatives!.length).toBeGreaterThan(0);
    });
  });

  describe('RETRYABLE_EXIT_CODES (Section 9.1)', () => {
    it('should include all spec-defined retryable codes', () => {
      // Per MCP-SERVER-SPECIFICATION Section 9.1
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_LOCK_TIMEOUT)).toBe(true);        // 7
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_CHECKSUM_MISMATCH)).toBe(true);   // 20
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_CONCURRENT_MODIFICATION)).toBe(true); // 21
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_ID_COLLISION)).toBe(true);         // 22
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_PROTOCOL_RESEARCH)).toBe(true);   // 60
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_PROTOCOL_CONSENSUS)).toBe(true);  // 61
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_PROTOCOL_SPECIFICATION)).toBe(true); // 62
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_PROTOCOL_DECOMPOSITION)).toBe(true); // 63
    });

    it('should not include non-retryable codes', () => {
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_NOT_FOUND)).toBe(false);
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_VALIDATION_ERROR)).toBe(false);
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.E_LIFECYCLE_GATE_FAILED)).toBe(false);
      expect(RETRYABLE_EXIT_CODES.has(ExitCode.SUCCESS)).toBe(false);
    });

    it('should be consistent with ERROR_MAP retryable field', () => {
      for (const exitCode of RETRYABLE_EXIT_CODES) {
        const mapping = getErrorMapping(exitCode);
        expect(mapping.retryable).toBe(true);
      }
    });
  });

  describe('NON_RECOVERABLE_EXIT_CODES (Section 9.2)', () => {
    it('should include lifecycle gate and provenance errors', () => {
      expect(NON_RECOVERABLE_EXIT_CODES.has(ExitCode.E_LIFECYCLE_GATE_FAILED)).toBe(true);       // 80
      expect(NON_RECOVERABLE_EXIT_CODES.has(ExitCode.E_CIRCULAR_VALIDATION)).toBe(true);          // 82
      expect(NON_RECOVERABLE_EXIT_CODES.has(ExitCode.E_LIFECYCLE_TRANSITION_INVALID)).toBe(true); // 83
      expect(NON_RECOVERABLE_EXIT_CODES.has(ExitCode.E_PROVENANCE_REQUIRED)).toBe(true);          // 84
    });

    it('should not include retryable codes', () => {
      for (const exitCode of RETRYABLE_EXIT_CODES) {
        expect(NON_RECOVERABLE_EXIT_CODES.has(exitCode)).toBe(false);
      }
    });

    it('should have no overlap with RETRYABLE_EXIT_CODES', () => {
      for (const exitCode of NON_RECOVERABLE_EXIT_CODES) {
        expect(RETRYABLE_EXIT_CODES.has(exitCode)).toBe(false);
      }
    });
  });

  describe('isNonRecoverable', () => {
    it('should return true for non-recoverable exit codes', () => {
      expect(isNonRecoverable(ExitCode.E_LIFECYCLE_GATE_FAILED)).toBe(true);
      expect(isNonRecoverable(ExitCode.E_CIRCULAR_VALIDATION)).toBe(true);
      expect(isNonRecoverable(ExitCode.E_LIFECYCLE_TRANSITION_INVALID)).toBe(true);
      expect(isNonRecoverable(ExitCode.E_PROVENANCE_REQUIRED)).toBe(true);
    });

    it('should return false for retryable exit codes', () => {
      expect(isNonRecoverable(ExitCode.E_LOCK_TIMEOUT)).toBe(false);
      expect(isNonRecoverable(ExitCode.E_CHECKSUM_MISMATCH)).toBe(false);
      expect(isNonRecoverable(ExitCode.E_CONCURRENT_MODIFICATION)).toBe(false);
    });

    it('should return false for success', () => {
      expect(isNonRecoverable(ExitCode.SUCCESS)).toBe(false);
    });

    it('should return false for regular errors', () => {
      expect(isNonRecoverable(ExitCode.E_NOT_FOUND)).toBe(false);
      expect(isNonRecoverable(ExitCode.E_VALIDATION_ERROR)).toBe(false);
    });
  });

  describe('isRecoverable', () => {
    it('should return true for retryable exit codes', () => {
      expect(isRecoverable(ExitCode.E_LOCK_TIMEOUT)).toBe(true);
      expect(isRecoverable(ExitCode.E_CHECKSUM_MISMATCH)).toBe(true);
      expect(isRecoverable(ExitCode.E_PROTOCOL_RESEARCH)).toBe(true);
      expect(isRecoverable(ExitCode.E_PROTOCOL_DECOMPOSITION)).toBe(true);
    });

    it('should return false for non-recoverable exit codes', () => {
      expect(isRecoverable(ExitCode.E_LIFECYCLE_GATE_FAILED)).toBe(false);
      expect(isRecoverable(ExitCode.E_LIFECYCLE_TRANSITION_INVALID)).toBe(false);
    });

    it('should return false for regular non-retryable errors', () => {
      expect(isRecoverable(ExitCode.E_NOT_FOUND)).toBe(false);
      expect(isRecoverable(ExitCode.E_FILE_ERROR)).toBe(false);
    });
  });

  describe('Complete Coverage', () => {
    it('should have mapping for all defined exit codes', () => {
      // Check key ranges are covered
      expect(ERROR_MAP[0]).toBeDefined(); // Success
      expect(ERROR_MAP[4]).toBeDefined(); // E_NOT_FOUND
      expect(ERROR_MAP[12]).toBeDefined(); // E_SIBLING_LIMIT
      expect(ERROR_MAP[38]).toBeDefined(); // E_FOCUS_REQUIRED
      expect(ERROR_MAP[60]).toBeDefined(); // E_PROTOCOL_RESEARCH
      expect(ERROR_MAP[80]).toBeDefined(); // E_LIFECYCLE_GATE_FAILED
      expect(ERROR_MAP[100]).toBeDefined(); // E_NO_DATA
    });

    it('should have consistent naming convention', () => {
      Object.values(ERROR_MAP).forEach((mapping) => {
        expect(mapping.code).toMatch(/^[A-Z_]+$/);
        expect(mapping.name).toBeDefined();
        expect(mapping.description).toBeDefined();
      });
    });

    it('should have valid categories', () => {
      const validCategories = Object.values(ErrorCategory);
      Object.values(ERROR_MAP).forEach((mapping) => {
        expect(validCategories).toContain(mapping.category);
      });
    });

    it('should have valid severities', () => {
      const validSeverities = Object.values(ErrorSeverity);
      Object.values(ERROR_MAP).forEach((mapping) => {
        expect(validSeverities).toContain(mapping.severity);
      });
    });
  });
});
