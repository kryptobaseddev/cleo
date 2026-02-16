/**
 * Tests for CLI executor
 *
 * @task T2914
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { exec } from 'child_process';

// Mock child_process with factory to ensure proper auto-mock
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

const mockExec = exec as unknown as Mock;

// Import executor AFTER mock setup (vitest hoists vi.mock anyway)
const { CLIExecutor, createExecutor } = await import('../executor.js');

describe('executor', () => {
  let executor: CLIExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new CLIExecutor('cleo', 5000, 3);
  });

  describe('execute', () => {
    it('should execute successful command', async () => {
      const mockStdout = JSON.stringify({
        success: true,
        data: { taskId: 'T2914', title: 'Test Task' },
      });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['T2914'],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ taskId: 'T2914', title: 'Test Task' });
      expect(result.exitCode).toBe(0);
    });

    it('should handle error responses', async () => {
      const mockStdout = JSON.stringify({
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          exitCode: 4,
          message: 'Task not found',
          fix: 'Verify task ID exists',
        },
      });

      const error = new Error('Command failed') as any;
      error.code = 4;
      error.stdout = mockStdout;
      error.stderr = '';

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(error, '', '');
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['T9999'],
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
      expect(result.error?.exitCode).toBe(4);
      expect(result.error?.message).toBe('Task not found');
      expect(result.error?.fix).toBe('Verify task ID exists');
    });

    it('should handle timeout', async () => {
      const error = new Error('Timeout') as any;
      error.killed = true;
      error.stdout = '';
      error.stderr = '';

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        setTimeout(() => callback?.(error), 100);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'list',
        timeout: 50,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_TIMEOUT');
      expect(result.error?.message).toMatch(/timed out/i);
    });

    it('should retry on retryable errors', async () => {
      let attempts = 0;

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        attempts++;

        if (attempts < 3) {
          // Retryable error (exit code 7)
          const error = new Error('Retryable') as any;
          error.code = 7;
          error.stdout = JSON.stringify({
            success: false,
            error: { code: 'E_RETRYABLE', exitCode: 7, message: 'Try again' },
          });
          error.stderr = '';
          callback?.(error, '', '');
        } else {
          // Success on 3rd attempt
          const mockStdout = JSON.stringify({ success: true, data: { result: 'ok' } });
          callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        }

        return {} as any;
      });

      // Mock sleep to avoid delays in tests
      vi.spyOn(executor as any, 'sleep').mockResolvedValue(undefined);

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'list',
        maxRetries: 3,
      });

      expect(attempts).toBe(3);
      expect(result.success).toBe(true);
      // Executor unwraps single-key payloads: {result:'ok'} → 'ok'
      expect(result.data).toBe('ok');
    });

    it('should not retry on non-retryable errors', async () => {
      let attempts = 0;

      const mockStdout = JSON.stringify({
        success: false,
        error: { code: 'E_NOT_FOUND', exitCode: 4, message: 'Not found' },
      });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        attempts++;
        const error = new Error('Not found') as any;
        error.code = 4;
        error.stdout = mockStdout;
        error.stderr = '';
        callback?.(error, '', '');
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['T9999'],
        maxRetries: 3,
      });

      expect(attempts).toBe(1); // Should not retry
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });

    it('should handle session binding', async () => {
      const mockStdout = JSON.stringify({ success: true, data: {} });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        // Verify CLEO_SESSION environment variable is set
        expect(opts?.env).toHaveProperty('CLEO_SESSION', 'session_123');
        callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        return {} as any;
      });

      await executor.execute({
        domain: 'tasks',
        operation: 'list',
        sessionId: 'session_123',
      });
    });

    it('should handle empty output with zero exit code', async () => {
      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(null, { stdout: '', stderr: '' } as any);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'complete',
        args: ['T2914'],
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it('should handle non-JSON output', async () => {
      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(null, { stdout: 'Plain text output', stderr: '' } as any);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'system',
        operation: 'version',
      });

      expect(result.success).toBe(true);
      expect(result.data).toBe('Plain text output');
    });

    it('should include execution duration', async () => {
      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        const mockStdout = JSON.stringify({ success: true, data: {} });
        setTimeout(() => {
          callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        }, 100);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'list',
      });

      expect(result.duration).toBeGreaterThan(0);
    });

    it('should handle buffer overflow', async () => {
      const error = new Error('Buffer overflow') as any;
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      error.stdout = '';
      error.stderr = '';

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(error);
        return {} as any;
      });

      const result = await executor.execute({
        domain: 'tasks',
        operation: 'list',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_OUTPUT_TOO_LARGE');
      expect(result.error?.fix).toContain('--limit');
    });

    it('should respect custom working directory', async () => {
      const mockStdout = JSON.stringify({ success: true, data: {} });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        expect(opts?.cwd).toBe('/custom/path');
        callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        return {} as any;
      });

      await executor.execute({
        domain: 'tasks',
        operation: 'list',
        cwd: '/custom/path',
      });
    });
  });

  describe('getVersion', () => {
    it('should get CLI version', async () => {
      const mockStdout = JSON.stringify({
        success: true,
        data: { version: '0.80.1' },
      });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        return {} as any;
      });

      const version = await executor.getVersion();
      expect(version).toBe('0.80.1');
    });

    it('should throw on version failure', async () => {
      const error = new Error('Command not found') as any;
      error.code = 127;
      error.stdout = '';
      error.stderr = 'cleo: command not found';

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(error);
        return {} as any;
      });

      await expect(executor.getVersion()).rejects.toThrow('Failed to get CLI version');
    });
  });

  describe('testConnection', () => {
    it('should return true when CLI is accessible', async () => {
      const mockStdout = JSON.stringify({
        success: true,
        data: { version: '0.80.1' },
      });

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(null, { stdout: mockStdout, stderr: '' } as any);
        return {} as any;
      });

      const connected = await executor.testConnection();
      expect(connected).toBe(true);
    });

    it('should return false when CLI is not accessible', async () => {
      const error = new Error('Command not found') as any;
      error.code = 127;
      error.stdout = '';
      error.stderr = '';

      mockExec.mockImplementation((cmd: any, opts: any, callback: any) => {
        callback?.(error);
        return {} as any;
      });

      const connected = await executor.testConnection();
      expect(connected).toBe(false);
    });
  });

  describe('createExecutor', () => {
    it('should create executor with defaults', () => {
      const exec = createExecutor('cleo');
      expect(exec).toBeInstanceOf(CLIExecutor);
    });

    it('should create executor with custom config', () => {
      const exec = createExecutor('cleo', 10000, 5);
      expect(exec).toBeInstanceOf(CLIExecutor);
    });
  });
});
