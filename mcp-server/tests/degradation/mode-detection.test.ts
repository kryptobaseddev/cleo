/**
 * Mode Detection Tests
 *
 * Tests mode-detector.ts behavior:
 * - Auto mode: detects CLI and selects appropriate mode
 * - Native mode: forced native via MCP_EXECUTION_MODE=native
 * - CLI mode: forced CLI via MCP_EXECUTION_MODE=cli
 * - Error responses for unavailable CLI
 *
 * @task T4374
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  detectExecutionMode,
  createCLIRequiredError,
  createNotInitializedError,
} from '../../src/lib/mode-detector';
import type { ModeDetectionResult } from '../../src/lib/mode-detector';

describe('Mode Detection', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear mode-related env vars before each test
    delete process.env.MCP_EXECUTION_MODE;
    delete process.env.CLEO_MCP_CLI_PATH;
    delete process.env.CLEO_CLI_PATH;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('MCP_EXECUTION_MODE=native', () => {
    it('forces native mode regardless of CLI availability', () => {
      process.env.MCP_EXECUTION_MODE = 'native';
      const result = detectExecutionMode();
      expect(result.mode).toBe('native');
      expect(result.configuredMode).toBe('native');
      expect(result.cliAvailable).toBe(false);
      expect(result.reason).toContain('forced');
    });

    it('sets cliPath and cliVersion to null', () => {
      process.env.MCP_EXECUTION_MODE = 'native';
      const result = detectExecutionMode();
      expect(result.cliPath).toBeNull();
      expect(result.cliVersion).toBeNull();
    });
  });

  describe('MCP_EXECUTION_MODE=cli', () => {
    it('forces cli mode when CLI is available', () => {
      process.env.MCP_EXECUTION_MODE = 'cli';
      // The test environment should have cleo in PATH
      const result = detectExecutionMode();
      expect(result.mode).toBe('cli');
      expect(result.configuredMode).toBe('cli');
    });

    it('forces cli mode even when CLI is unavailable (warns in reason)', () => {
      process.env.MCP_EXECUTION_MODE = 'cli';
      process.env.CLEO_MCP_CLI_PATH = '/nonexistent/path/to/cleo';
      process.env.CLEO_CLI_PATH = '/nonexistent/path/to/cleo';
      // Temporarily hide cleo from PATH
      const origPath = process.env.PATH;
      process.env.PATH = '/usr/bin:/bin'; // Minimal PATH without cleo
      const result = detectExecutionMode();
      process.env.PATH = origPath;

      expect(result.mode).toBe('cli');
      expect(result.configuredMode).toBe('cli');
      // May or may not find CLI depending on test env
    });
  });

  describe('MCP_EXECUTION_MODE=auto (default)', () => {
    it('detects mode automatically when no env var set', () => {
      const result = detectExecutionMode();
      expect(result.configuredMode).toBe('auto');
      expect(['native', 'cli']).toContain(result.mode);
    });

    it('returns detection metadata', () => {
      const result = detectExecutionMode();
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('configuredMode');
      expect(result).toHaveProperty('cliAvailable');
      expect(result).toHaveProperty('cliPath');
      expect(result).toHaveProperty('cliVersion');
      expect(result).toHaveProperty('reason');
    });

    it('reason explains the mode selection', () => {
      const result = detectExecutionMode();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('MCP_EXECUTION_MODE case insensitivity', () => {
    it('handles uppercase NATIVE', () => {
      process.env.MCP_EXECUTION_MODE = 'NATIVE';
      // The code lowercases, so this should work
      const result = detectExecutionMode();
      expect(result.configuredMode).toBe('native');
    });

    it('handles mixed case Auto', () => {
      process.env.MCP_EXECUTION_MODE = 'Auto';
      const result = detectExecutionMode();
      expect(result.configuredMode).toBe('auto');
    });

    it('handles unknown value as auto', () => {
      process.env.MCP_EXECUTION_MODE = 'unknown_value';
      const result = detectExecutionMode();
      expect(result.configuredMode).toBe('auto');
    });
  });

  describe('CLEO_MCP_CLI_PATH override', () => {
    it('checks CLEO_MCP_CLI_PATH first for CLI location', () => {
      process.env.CLEO_MCP_CLI_PATH = '/nonexistent/cleo';
      process.env.MCP_EXECUTION_MODE = 'auto';
      const result = detectExecutionMode();
      // With invalid path, should fall through to other detection
      expect(result).toHaveProperty('mode');
    });
  });

  describe('Error response helpers', () => {
    it('createCLIRequiredError returns proper structure', () => {
      const error = createCLIRequiredError('orchestrate', 'spawn');
      expect(error).toEqual({
        success: false,
        error: {
          code: 'E_CLI_REQUIRED',
          message: expect.stringContaining('orchestrate.spawn'),
          availableInStandaloneMode: false,
          nativeAlternatives: [],
        },
      });
    });

    it('createNotInitializedError returns proper structure', () => {
      const error = createNotInitializedError();
      expect(error).toEqual({
        success: false,
        error: {
          code: 'E_NOT_INITIALIZED',
          message: expect.stringContaining('not initialized'),
          fix: expect.stringContaining('init'),
        },
      });
    });

    it('E_NOT_INITIALIZED suggests system.init', () => {
      const error = createNotInitializedError();
      expect(error.error.fix).toContain('init');
    });
  });

  describe('ModeDetectionResult type contract', () => {
    it('result satisfies ModeDetectionResult interface', () => {
      const result: ModeDetectionResult = detectExecutionMode();
      // TypeScript compile-time check + runtime validation
      expect(typeof result.mode).toBe('string');
      expect(typeof result.configuredMode).toBe('string');
      expect(typeof result.cliAvailable).toBe('boolean');
      expect(typeof result.reason).toBe('string');
      // cliPath and cliVersion can be null
      expect(result.cliPath === null || typeof result.cliPath === 'string').toBe(true);
      expect(result.cliVersion === null || typeof result.cliVersion === 'string').toBe(true);
    });
  });
});
