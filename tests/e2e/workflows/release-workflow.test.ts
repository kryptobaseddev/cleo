import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock engine imports (all domain handlers need these)
vi.mock('../../../src/dispatch/lib/engine.js', () => ({
  releasePrepare: vi.fn(),
  releaseTag: vi.fn(),
  releasePush: vi.fn(),
  releaseRollback: vi.fn(),
}));

// Import mocked functions
import {
  releasePrepare,
  releasePush,
  releaseRollback,
  releaseTag,
} from '../../../src/dispatch/lib/engine.js';

// Mock paths
vi.mock('../../../src/core/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/paths.js')>();
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// Mock CLI output
vi.mock('../../../src/cli/renderers/index.js', () => ({
  cliOutput: vi.fn(),
  cliError: vi.fn(),
}));

// Mock security module
vi.mock('../../../src/mcp/lib/security.js', () => ({
  sanitizeParams: vi.fn((p: Record<string, unknown>) => p),
}));

describe('Release Workflow E2E Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  describe('11.3 Release Workflow', () => {
    it('should execute full release workflow: verify -> bump -> tag -> publish', async () => {
      // Step 1: Prepare release (pipeline.release.prepare)
      vi.mocked(releasePrepare).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.4',
          tasks: ['T001', 'T002'],
          notes: 'Release v0.80.4',
          created: '2026-02-06T12:00:00Z',
        },
      });

      const bumpResult = await dispatchRaw('mutate', 'pipeline', 'release.prepare', {
        version: '0.80.4',
        tasks: ['T001', 'T002'],
        notes: 'Release v0.80.4',
      });

      expect(bumpResult.success).toBe(true);
      expect(bumpResult.data).toMatchObject({
        version: '0.80.4',
        tasks: ['T001', 'T002'],
        notes: 'Release v0.80.4',
      });
      expect(releasePrepare).toHaveBeenCalledWith(
        '0.80.4',
        ['T001', 'T002'],
        'Release v0.80.4',
        expect.any(String),
      );

      // Step 2: Create tag (pipeline.release.tag)
      vi.mocked(releaseTag).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.4',
          tagName: 'v0.80.4',
          tagged: '2026-02-06T12:00:00Z',
        },
      });

      const tagResult = await dispatchRaw('mutate', 'pipeline', 'release.tag', {
        version: '0.80.4',
      });

      expect(tagResult.success).toBe(true);
      expect(tagResult.data).toMatchObject({
        version: '0.80.4',
        tagName: 'v0.80.4',
      });
      expect(releaseTag).toHaveBeenCalledWith('0.80.4', expect.any(String));

      // Step 3: Publish release (pipeline.release.push)
      vi.mocked(releasePush).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.4',
          pushed: true,
          remote: 'origin',
        },
      });

      const publishResult = await dispatchRaw('mutate', 'pipeline', 'release.push', {
        version: '0.80.4',
        remote: 'origin',
        explicitPush: true,
      });

      expect(publishResult.success).toBe(true);
      expect(publishResult.data).toMatchObject({
        version: '0.80.4',
        pushed: true,
      });
      expect(releasePush).toHaveBeenCalledWith('0.80.4', 'origin', expect.any(String), {
        explicitPush: true,
      });
    });

    it('should handle version validation failure during release', async () => {
      // Mock the engine to return an error (simulating validation failure)
      vi.mocked(releasePrepare).mockResolvedValueOnce({
        success: false,
        error: {
          code: 'E_INVALID_VERSION',
          message: 'Invalid version format: invalid-version',
        },
      });

      const result = await dispatchRaw('mutate', 'pipeline', 'release.prepare', {
        version: 'invalid-version',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_VERSION');
    });

    it('should reject cleo_query on release domain', async () => {
      // Release operations are mutate-only in the pipeline domain
      // Query operations should be rejected as invalid
      const result = await dispatchRaw('query', 'pipeline', 'release.prepare', {
        version: '0.80.4',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle rollback scenario with reason', async () => {
      vi.mocked(releaseRollback).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.4',
          rolledBack: true,
          reason: 'Critical regression found',
          deleted: true,
        },
      });

      const result = await dispatchRaw('mutate', 'pipeline', 'release.rollback', {
        version: '0.80.4',
        reason: 'Critical regression found',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        version: '0.80.4',
        rolledBack: true,
        reason: 'Critical regression found',
        deleted: true,
      });
      expect(releaseRollback).toHaveBeenCalledWith(
        '0.80.4',
        'Critical regression found',
        expect.any(String),
      );
    });
  });
});
