/**
 * Tests for error handler
 *
 * @task T2913
 * @epic T2908
 */

import { describe, it, expect, jest } from '@jest/globals';
import {
  handleCLIError,
  isRecoverable,
  formatErrorForMCP,
  addErrorContext,
  createErrorContext,
  retryOperation,
  type CLIErrorContext,
  type CLIError,
  type RetryResult,
} from '../error-handler.js';
import { ExitCode, ErrorCategory, ErrorSeverity } from '../exit-codes.js';

describe('Error Handler', () => {
  describe('createErrorContext', () => {
    it('should create basic error context', () => {
      const context = createErrorContext('add', ['--title', 'Test']);
      expect(context.command).toBe('add');
      expect(context.args).toEqual(['--title', 'Test']);
    });

    it('should include stderr and stdout', () => {
      const context = createErrorContext(
        'list',
        [],
        'Error: not found',
        'No tasks'
      );
      expect(context.stderr).toBe('Error: not found');
      expect(context.stdout).toBe('No tasks');
    });

    it('should include additional details', () => {
      const context = createErrorContext('show', ['T2405'], undefined, undefined, {
        taskId: 'T2405',
      });
      expect(context.details).toEqual({ taskId: 'T2405' });
    });
  });

  describe('addErrorContext', () => {
    it('should merge additional details', () => {
      const context = createErrorContext('update', ['T2405'], undefined, undefined, {
        taskId: 'T2405',
      });
      const updated = addErrorContext(context, { field: 'title' });
      expect(updated.details).toEqual({ taskId: 'T2405', field: 'title' });
    });

    it('should not modify original context', () => {
      const original = createErrorContext('list', []);
      const updated = addErrorContext(original, { filter: 'pending' });
      expect(original.details).toBeUndefined();
      expect(updated.details).toEqual({ filter: 'pending' });
    });
  });

  describe('handleCLIError', () => {
    it('should handle E_NOT_FOUND error', () => {
      const context: CLIErrorContext = {
        command: 'show',
        args: ['T9999'],
        stderr: 'Error: Task T9999 not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);

      expect(error.code).toBe('E_NOT_FOUND');
      expect(error.exitCode).toBe(4);
      expect(error.category).toBe(ErrorCategory.GENERAL);
      expect(error.severity).toBe(ErrorSeverity.ERROR);
      expect(error.retryable).toBe(false);
    });

    it('should extract task ID from stderr', () => {
      const context: CLIErrorContext = {
        command: 'update',
        args: ['T2405'],
        stderr: 'Error: Task T2405 not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);

      expect(error.context?.taskId).toBe('T2405');
    });

    it('should extract parent ID from stderr', () => {
      const context: CLIErrorContext = {
        command: 'add',
        args: ['--parent', 'T2400'],
        stderr: 'Error: parent T2400 not found',
      };
      const error = handleCLIError(ExitCode.E_PARENT_NOT_FOUND, context);

      expect(error.context?.parentId).toBe('T2400');
    });

    it('should extract session ID from stderr', () => {
      const context: CLIErrorContext = {
        command: 'session',
        args: ['resume', 'session_123'],
        stderr: 'Error: session session_123 not found',
      };
      const error = handleCLIError(ExitCode.E_SESSION_NOT_FOUND, context);

      expect(error.context?.sessionId).toBe('session_123');
    });

    it('should generate fix command with context', () => {
      const context: CLIErrorContext = {
        command: 'focus',
        args: ['set', 'T2405'],
        stderr: 'Error: session required',
      };
      const error = handleCLIError(ExitCode.E_SESSION_REQUIRED, context);

      expect(error.fix).toBeDefined();
      expect(error.fix).toContain('session start');
    });

    it('should generate alternatives', () => {
      const context: CLIErrorContext = {
        command: 'show',
        args: ['T9999'],
        stderr: 'Error: not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);

      expect(error.alternatives).toBeDefined();
      expect(error.alternatives!.length).toBeGreaterThan(0);
    });

    it('should handle protocol violations', () => {
      const context: CLIErrorContext = {
        command: 'complete',
        args: ['T2405'],
        stderr: 'Error: research protocol violations: missing key_findings',
        details: { violations: 'missing key_findings' },
      };
      const error = handleCLIError(ExitCode.E_PROTOCOL_RESEARCH, context);

      expect(error.category).toBe(ErrorCategory.PROTOCOL);
      expect(error.documentation).toBeDefined();
    });

    it('should handle lifecycle gate failures', () => {
      const context: CLIErrorContext = {
        command: 'spawn',
        args: ['T2405'],
        stderr: 'Error: lifecycle gate failed: missing research',
        details: { missingStages: 'research' },
      };
      const error = handleCLIError(ExitCode.E_LIFECYCLE_GATE_FAILED, context);

      expect(error.category).toBe(ErrorCategory.LIFECYCLE);
      expect(error.context?.missingStages).toBe('research');
    });

    it('should extract percentage from context warnings', () => {
      const context: CLIErrorContext = {
        command: 'context',
        args: ['check'],
        stderr: 'Warning: context usage at 75%',
      };
      const error = handleCLIError(ExitCode.E_CONTEXT_WARNING, context);

      expect(error.context?.percentage).toBe('75');
    });
  });

  describe('isRecoverable', () => {
    it('should return true for recoverable errors', () => {
      expect(isRecoverable(ExitCode.E_NOT_FOUND)).toBe(true);
      expect(isRecoverable(ExitCode.E_VALIDATION_ERROR)).toBe(true);
      expect(isRecoverable(ExitCode.E_PARENT_NOT_FOUND)).toBe(true);
    });

    it('should return false for context errors', () => {
      expect(isRecoverable(ExitCode.E_CONTEXT_WARNING)).toBe(false);
      expect(isRecoverable(ExitCode.E_CONTEXT_CRITICAL)).toBe(false);
    });

    it('should return false for locked verification', () => {
      expect(isRecoverable(ExitCode.E_VERIFICATION_LOCKED)).toBe(false);
    });

    it('should return false for cascade failures', () => {
      expect(isRecoverable(ExitCode.E_CASCADE_FAILED)).toBe(false);
    });

    it('should return false for circular references', () => {
      expect(isRecoverable(ExitCode.E_CIRCULAR_REFERENCE)).toBe(false);
    });

    it('should return false for file errors', () => {
      expect(isRecoverable(ExitCode.E_FILE_ERROR)).toBe(false);
    });

    it('should return false for invalid lifecycle transitions', () => {
      expect(isRecoverable(ExitCode.E_LIFECYCLE_TRANSITION_INVALID)).toBe(
        false
      );
    });
  });

  describe('formatErrorForMCP', () => {
    it('should format error for MCP response', () => {
      const context: CLIErrorContext = {
        command: 'show',
        args: ['T9999'],
        stderr: 'Error: not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);
      const formatted = formatErrorForMCP(error);

      expect(formatted.success).toBe(false);
      expect(formatted.error.code).toBe('E_NOT_FOUND');
      expect(formatted.error.exitCode).toBe(4);
      expect(formatted.error.message).toBeDefined();
    });

    it('should include details with severity and category', () => {
      const context: CLIErrorContext = {
        command: 'update',
        args: ['T2405'],
        stderr: 'Validation error',
      };
      const error = handleCLIError(ExitCode.E_VALIDATION_ERROR, context);
      const formatted = formatErrorForMCP(error);

      expect(formatted.error.details).toBeDefined();
      expect(formatted.error.details?.severity).toBe(ErrorSeverity.ERROR);
      expect(formatted.error.details?.category).toBe(ErrorCategory.GENERAL);
      expect(formatted.error.details?.retryable).toBe(false);
      expect(formatted.error.details?.recoverable).toBeDefined();
    });

    it('should include fix command', () => {
      const context: CLIErrorContext = {
        command: 'focus',
        args: ['set'],
        stderr: 'Session required',
      };
      const error = handleCLIError(ExitCode.E_SESSION_REQUIRED, context);
      const formatted = formatErrorForMCP(error);

      expect(formatted.error.fix).toBeDefined();
    });

    it('should include alternatives', () => {
      const context: CLIErrorContext = {
        command: 'show',
        args: ['T9999'],
        stderr: 'Not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);
      const formatted = formatErrorForMCP(error);

      expect(formatted.error.alternatives).toBeDefined();
      expect(formatted.error.alternatives!.length).toBeGreaterThan(0);
    });
  });

  describe('Context Extraction', () => {
    it('should extract epic ID', () => {
      const context: CLIErrorContext = {
        command: 'session',
        args: ['start'],
        stderr: 'Error: invalid epic: T2400',
      };
      const error = handleCLIError(ExitCode.E_SCOPE_INVALID, context);

      expect(error.context?.epicId).toBe('T2400');
    });

    it('should extract gate name', () => {
      const context: CLIErrorContext = {
        command: 'gate',
        args: ['pass'],
        stderr: 'Error: invalid gate: implemented',
      };
      const error = handleCLIError(ExitCode.E_INVALID_GATE, context);

      expect(error.context?.gateName).toBe('implemented');
    });

    it('should extract agent name', () => {
      const context: CLIErrorContext = {
        command: 'spawn',
        args: ['T2405'],
        stderr: 'Error: invalid agent: unknown_agent',
      };
      const error = handleCLIError(ExitCode.E_INVALID_AGENT, context);

      expect(error.context?.agentName).toBe('unknown_agent');
    });

    it('should extract query string', () => {
      const context: CLIErrorContext = {
        command: 'find',
        args: ['"authentication"'],
        stderr: 'Error: no results for query "authentication"',
      };
      const error = handleCLIError(5, context); // E_SEARCH_NO_RESULTS

      expect(error.context?.query).toBe('authentication');
    });

    it('should extract resource name', () => {
      const context: CLIErrorContext = {
        command: 'restore',
        args: ['backup123'],
        stderr: 'Error: resource backup123 not found',
      };
      const error = handleCLIError(ExitCode.E_NOT_FOUND, context);

      expect(error.context?.resource).toBe('backup123');
    });

    it('should extract violations', () => {
      const context: CLIErrorContext = {
        command: 'validate',
        args: ['T2405'],
        stderr: 'Error: violations: missing @task tags',
      };
      const error = handleCLIError(
        ExitCode.E_PROTOCOL_IMPLEMENTATION,
        context
      );

      expect(error.context?.violations).toBeDefined();
    });
  });

  describe('retryOperation (Section 9.1)', () => {
    /**
     * Helper to create a CLIError with an exit code
     */
    function makeCLIError(exitCode: number, message = 'test error'): CLIError {
      const err = new Error(message) as CLIError;
      err.exitCode = exitCode;
      return err;
    }

    it('should return result on first success', async () => {
      const fn = jest.fn<() => Promise<string>>().mockResolvedValue('ok');

      const result = await retryOperation(fn);

      expect(result.result).toBe('ok');
      expect(result.attempts).toBe(1);
      expect(result.retriedExitCodes).toEqual([]);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable exit code and succeed', async () => {
      const fn = jest.fn<() => Promise<string>>();
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_LOCK_TIMEOUT));
      fn.mockResolvedValueOnce('recovered');

      const result = await retryOperation(fn);

      expect(result.result).toBe('recovered');
      expect(result.attempts).toBe(2);
      expect(result.retriedExitCodes).toEqual([ExitCode.E_LOCK_TIMEOUT]);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry up to maxAttempts and then throw', async () => {
      const err = makeCLIError(ExitCode.E_CHECKSUM_MISMATCH);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn, 3)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-retryable errors', async () => {
      const err = makeCLIError(ExitCode.E_NOT_FOUND);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should never retry non-recoverable errors (Section 9.2)', async () => {
      const err = makeCLIError(ExitCode.E_LIFECYCLE_GATE_FAILED);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should never retry lifecycle transition invalid', async () => {
      const err = makeCLIError(ExitCode.E_LIFECYCLE_TRANSITION_INVALID);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should never retry provenance required', async () => {
      const err = makeCLIError(ExitCode.E_PROVENANCE_REQUIRED);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw immediately for errors without exitCode', async () => {
      const err = new Error('generic error');
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should track multiple retried exit codes', async () => {
      const fn = jest.fn<() => Promise<string>>();
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_CONCURRENT_MODIFICATION));
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_ID_COLLISION));
      fn.mockResolvedValueOnce('success');

      const result = await retryOperation(fn, 3);

      expect(result.result).toBe('success');
      expect(result.attempts).toBe(3);
      expect(result.retriedExitCodes).toEqual([
        ExitCode.E_CONCURRENT_MODIFICATION,
        ExitCode.E_ID_COLLISION,
      ]);
    });

    it('should retry protocol violations (60-63)', async () => {
      const fn = jest.fn<() => Promise<string>>();
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_PROTOCOL_RESEARCH));
      fn.mockResolvedValueOnce('fixed');

      const result = await retryOperation(fn);

      expect(result.result).toBe('fixed');
      expect(result.attempts).toBe(2);
      expect(result.retriedExitCodes).toEqual([ExitCode.E_PROTOCOL_RESEARCH]);
    });

    it('should respect custom maxAttempts', async () => {
      const err = makeCLIError(ExitCode.E_LOCK_TIMEOUT);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn, 1)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should default to 3 max attempts', async () => {
      const err = makeCLIError(ExitCode.E_LOCK_TIMEOUT);
      const fn = jest.fn<() => Promise<string>>().mockRejectedValue(err);

      await expect(retryOperation(fn)).rejects.toThrow(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should use exponential backoff timing', async () => {
      // Use fake timers for this test
      jest.useFakeTimers();

      const fn = jest.fn<() => Promise<string>>();
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_LOCK_TIMEOUT));
      fn.mockRejectedValueOnce(makeCLIError(ExitCode.E_LOCK_TIMEOUT));
      fn.mockResolvedValueOnce('done');

      const promise = retryOperation(fn, 3);

      // Advance past first backoff (2^1 * 1000 = 2000ms)
      await jest.advanceTimersByTimeAsync(2000);
      // Advance past second backoff (2^2 * 1000 = 4000ms)
      await jest.advanceTimersByTimeAsync(4000);

      const result = await promise;
      expect(result.result).toBe('done');
      expect(result.attempts).toBe(3);

      jest.useRealTimers();
    });
  });
});
