/**
 * Release Domain Handler Tests
 *
 * Tests all 7 release operations:
 * - Query: version, verify, changelog
 * - Mutate: bump, tag, publish, rollback
 *
 * @task T2934
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ReleaseHandler } from '../release.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';
import type { DomainResponse } from '../../lib/router.js';

describe('ReleaseHandler', () => {
  let handler: ReleaseHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    // Create mock executor
    mockExecutor = createMockExecutor();

    handler = new ReleaseHandler(mockExecutor);
  });

  // ===== Query Operations =====

  describe('Query Operations', () => {
    it('should get current version', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.2',
          major: 0,
          minor: 80,
          patch: 2,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('version', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect((result.data as any).version).toBe('0.80.2');
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'version',
        operation: '',
        flags: { json: true },
      });
    });

    it('should verify version consistency', async () => {
      const mockResponse = {
        success: true,
        data: {
          consistent: true,
          version: '0.80.2',
          files: [
            { file: 'VERSION', version: '0.80.2', consistent: true },
            { file: 'README.md', version: '0.80.2', consistent: true },
            { file: 'package.json', version: '0.80.2', consistent: true },
          ],
          errors: [],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('verify', {});

      expect(result.success).toBe(true);
      expect((result.data as any).consistent).toBe(true);
      expect((result.data as any).version).toBe('0.80.2');
      expect((result.data as any).files).toHaveLength(3);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'validate-version',
        operation: '',
        flags: { json: true },
        customCommand: './dev/validate-version.sh',
      });
    });

    it('should get changelog content', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.2',
          content: '# Changelog\n\n## [0.80.2] - 2026-02-03\n\n### Fixed\n- Bug fixes',
          sections: [
            {
              type: 'fix',
              entries: [{ taskId: 'T3000', message: 'Bug fix' }],
            },
          ],
          commitCount: 5,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('changelog', { version: '0.80.2' });

      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('0.80.2');
      expect((result.data as any).commitCount).toBe(5);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'changelog',
        operation: '',
        args: ['0.80.2'],
        flags: { json: true },
        customCommand: 'cat CHANGELOG.md',
      });
    });

    it('should require version for changelog', async () => {
      const result = await handler.query('changelog', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('version is required');
    });

    it('should handle unknown query operations', async () => {
      const result = await handler.query('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('Unknown query operation');
    });
  });

  // ===== Mutate Operations =====

  describe('Mutate Operations', () => {
    it('should bump version (patch)', async () => {
      const mockResponse = {
        success: true,
        data: {
          oldVersion: '0.80.2',
          newVersion: '0.80.3',
          type: 'patch',
          filesUpdated: ['VERSION', 'README.md', 'package.json'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('bump', { type: 'patch' });

      expect(result.success).toBe(true);
      expect((result.data as any).oldVersion).toBe('0.80.2');
      expect((result.data as any).newVersion).toBe('0.80.3');
      expect((result.data as any).type).toBe('patch');
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'bump-version',
        operation: '',
        args: ['patch'],
        flags: { json: true },
        customCommand: './dev/bump-version.sh',
      });
    });

    it('should bump version (minor)', async () => {
      const mockResponse = {
        success: true,
        data: {
          oldVersion: '0.80.2',
          newVersion: '0.81.0',
          type: 'minor',
          filesUpdated: ['VERSION', 'README.md', 'package.json'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('bump', { type: 'minor' });

      expect(result.success).toBe(true);
      expect((result.data as any).newVersion).toBe('0.81.0');
      expect((result.data as any).type).toBe('minor');
    });

    it('should bump version (major)', async () => {
      const mockResponse = {
        success: true,
        data: {
          oldVersion: '0.80.2',
          newVersion: '1.0.0',
          type: 'major',
          filesUpdated: ['VERSION', 'README.md', 'package.json'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('bump', { type: 'major' });

      expect(result.success).toBe(true);
      expect((result.data as any).newVersion).toBe('1.0.0');
      expect((result.data as any).type).toBe('major');
    });

    it('should require type for bump', async () => {
      const result = await handler.mutate('bump', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('type is required');
    });

    it('should validate bump type', async () => {
      const result = await handler.mutate('bump', { type: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('Invalid type');
      expect(result.error?.message).toContain('Must be patch, minor, or major');
    });

    it('should create git tag', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.3',
          tagName: 'v0.80.3',
          created: '2026-02-03T12:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('tag', {
        version: '0.80.3',
        message: 'Release v0.80.3',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).tagName).toBe('v0.80.3');
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'git',
        operation: 'tag',
        args: ['-a', 'v0.80.3', '-m', 'Release v0.80.3'],
        flags: { json: true },
        customCommand: 'git',
      });
    });

    it('should create git tag with default message', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.3',
          tagName: 'v0.80.3',
          created: '2026-02-03T12:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('tag', { version: '0.80.3' });

      expect(result.success).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'git',
        operation: 'tag',
        args: ['-a', 'v0.80.3', '-m', 'Release v0.80.3'],
        flags: { json: true },
        customCommand: 'git',
      });
    });

    it('should require version for tag', async () => {
      const result = await handler.mutate('tag', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('version is required');
    });

    it('should publish release', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.3',
          type: 'patch',
          commitHash: 'abc123',
          tagName: 'v0.80.3',
          pushed: false,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('publish', { type: 'patch' });

      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('0.80.3');
      expect((result.data as any).pushed).toBe(false);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'release-version',
        operation: '',
        args: ['patch'],
        flags: { json: true },
        customCommand: './dev/release-version.sh',
      });
    });

    it('should publish release with push', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.3',
          type: 'patch',
          commitHash: 'abc123',
          tagName: 'v0.80.3',
          pushed: true,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('publish', { type: 'patch', push: true });

      expect(result.success).toBe(true);
      expect((result.data as any).pushed).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'release-version',
        operation: '',
        args: ['patch'],
        flags: { json: true, push: true },
        customCommand: './dev/release-version.sh',
      });
    });

    it('should require type for publish', async () => {
      const result = await handler.mutate('publish', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('type is required');
    });

    it('should validate publish type', async () => {
      const result = await handler.mutate('publish', { type: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('Invalid type');
    });

    it('should rollback release', async () => {
      const mockResponse = {
        success: true,
        data: {
          version: '0.80.3',
          rolledBack: 'v0.80.3',
          restoredVersion: '0.80.2',
          reason: 'Critical bug found',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      // Mock both git commands
      (mockExecutor.execute as any)
        .mockResolvedValueOnce({ success: true }) // git tag -d
        .mockResolvedValueOnce(mockResponse); // git push --delete

      const result = await handler.mutate('rollback', {
        version: '0.80.3',
        reason: 'Critical bug found',
      });

      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('0.80.3');
      expect((result.data as any).reason).toBe('Critical bug found');
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(1, {
        domain: 'git',
        operation: 'tag',
        args: ['-d', 'v0.80.3'],
        customCommand: 'git',
      });
      expect(mockExecutor.execute).toHaveBeenNthCalledWith(2, {
        domain: 'git',
        operation: 'push',
        args: ['--delete', 'origin', 'v0.80.3'],
        flags: { json: true },
        customCommand: 'git',
      });
    });

    it('should require version for rollback', async () => {
      const result = await handler.mutate('rollback', { reason: 'Bug' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('version is required');
    });

    it('should require reason for rollback', async () => {
      const result = await handler.mutate('rollback', { version: '0.80.3' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('reason is required');
    });

    it('should handle unknown mutate operations', async () => {
      const result = await handler.mutate('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('Unknown mutate operation');
    });
  });

  // ===== Error Handling =====

  describe('Error Handling', () => {
    it('should handle executor errors', async () => {
      const mockError = {
        success: false,
        error: {
          code: 'E_VALIDATION_FAILED',
          exitCode: 6,
          message: 'Version mismatch detected',
        },
        exitCode: 6,
        stdout: '',
        stderr: 'Version mismatch',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockError);

      const result = await handler.query('verify', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VALIDATION_FAILED');
      expect(result.error?.message).toBe('Version mismatch detected');
    });

    it('should handle unexpected errors', async () => {
      (mockExecutor.execute as any).mockRejectedValue(new Error('Git command failed'));

      const result = await handler.mutate('tag', { version: '0.80.3' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Git command failed');
    });
  });

  // ===== Supported Operations =====

  describe('getSupportedOperations', () => {
    it('should return all supported operations', () => {
      const ops = handler.getSupportedOperations();

      expect(ops.query).toEqual(['version', 'verify', 'changelog']);
      expect(ops.mutate).toEqual([
        'bump', 'tag', 'publish', 'rollback',
        'prepare', 'changelog', 'commit', 'push', 'gates.run',
      ]);
    });
  });

  // ===== Handler Without Executor =====

  describe('Handler Without Executor', () => {
    it('should return error when executor is not provided for query', async () => {
      const handlerNoExecutor = new ReleaseHandler();

      const result = await handlerNoExecutor.query('version', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_CLI_REQUIRED');
      expect(result.error?.message).toContain('requires the CLEO CLI');
    });

    it('should return error when executor is not provided for mutate', async () => {
      const handlerNoExecutor = new ReleaseHandler();

      const result = await handlerNoExecutor.mutate('bump', { type: 'patch' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_CLI_REQUIRED');
      expect(result.error?.message).toContain('requires the CLEO CLI');
    });
  });
});
