import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock engine imports (all domain handlers need these)
vi.mock('../../../src/dispatch/lib/engine.js', () => ({
  releaseShip: vi.fn(),
  releaseRollback: vi.fn(),
  releaseCancel: vi.fn(),
  releaseList: vi.fn(),
  releaseShow: vi.fn(),
}));

// Import mocked functions
import {
  releaseRollback,
  releaseShip,
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
    it('should execute full release workflow via release.ship', async () => {
      // T5615: prepare/changelog/commit/tag/push consolidated into release.ship
      vi.mocked(releaseShip).mockResolvedValueOnce({
        success: true,
        data: {
          version: '0.80.4',
          epicId: 'T001',
          shipped: true,
          tagName: 'v0.80.4',
          pushed: true,
        },
      });

      const shipResult = await dispatchRaw('mutate', 'pipeline', 'release.ship', {
        version: '0.80.4',
        epicId: 'T001',
        remote: 'origin',
      });

      expect(shipResult.success).toBe(true);
      expect(shipResult.data).toMatchObject({
        version: '0.80.4',
        shipped: true,
      });
      expect(releaseShip).toHaveBeenCalledWith(
        { version: '0.80.4', epicId: 'T001', remote: 'origin', dryRun: undefined, bump: undefined },
        expect.any(String),
      );
    });

    it('should handle version validation failure during release', async () => {
      // Mock the engine to return an error (simulating validation failure)
      vi.mocked(releaseShip).mockResolvedValueOnce({
        success: false,
        error: {
          code: 'E_INVALID_VERSION',
          message: 'Invalid version format: invalid-version',
        },
      });

      const result = await dispatchRaw('mutate', 'pipeline', 'release.ship', {
        version: 'invalid-version',
        epicId: 'T001',
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
