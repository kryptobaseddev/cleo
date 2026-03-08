/**
 * Release Engine Tests
 *
 * Tests native TypeScript release operations.
 *
 * @task T4476
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';
import { resetDbState } from '../../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import {
  releaseChangelog,
  releaseCommit,
  releaseGatesRun,
  releaseList,
  releasePrepare,
  releaseRollback,
  releaseShow,
  releaseTag,
} from '../release-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-release-engine');

const SAMPLE_TASKS = [
  {
    id: 'T001',
    title: 'feat: Add new feature',
    description: 'New feature',
    status: 'done',
    priority: 'high',
    completedAt: '2026-02-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'T002',
    title: 'fix: Bug fix',
    description: 'Fixed bug',
    status: 'done',
    priority: 'medium',
    completedAt: '2026-02-02T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'T003',
    title: 'docs: Update docs',
    description: 'Documentation',
    status: 'pending',
    priority: 'low',
    createdAt: '2026-01-01T00:00:00Z',
  },
];

async function setupTestDb(): Promise<void> {
  resetDbState();
  const accessor = await createSqliteDataAccessor(TEST_ROOT);
  await seedTasks(accessor, SAMPLE_TASKS);
  await accessor.close();
  resetDbState();
}

describe('Release Engine', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(() => {
    resetDbState();
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  describe('releasePrepare', () => {
    it('should prepare a release with specified tasks', async () => {
      const result = await releasePrepare('v1.0.0', ['T001', 'T002'], 'First release', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('v1.0.0');
      expect((result.data as any).taskCount).toBe(2);
    });

    it('should auto-discover completed tasks', async () => {
      const result = await releasePrepare('v1.0.0', undefined, undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskCount).toBe(2); // T001 and T002
    });

    it('should reject duplicate version', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      const result = await releasePrepare('v1.0.0', ['T002'], undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_VERSION_EXISTS');
    });

    it('should reject invalid version format', async () => {
      const result = await releasePrepare('not-a-version', ['T001'], undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_VERSION');
    });

    it('should normalize version with v prefix', async () => {
      const result = await releasePrepare('1.0.0', ['T001'], undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('v1.0.0');
    });
  });

  describe('releaseChangelog', () => {
    it('should generate changelog', async () => {
      await releasePrepare('v1.0.0', ['T001', 'T002'], undefined, TEST_ROOT);
      const result = await releaseChangelog('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.changelog).toContain('v1.0.0');
      expect(data.sections.features).toBe(1);
      expect(data.sections.fixes).toBe(1);
    });

    it('should return error for missing release', async () => {
      const result = await releaseChangelog('v9.9.9', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('releaseList', () => {
    it('should list releases', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      await releasePrepare('v1.1.0', ['T002'], undefined, TEST_ROOT);

      const result = await releaseList(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
      expect((result.data as any).filtered).toBe(2);
      expect(result.page).toEqual({ mode: 'none' });
    });

    it('should return empty list when no releases', async () => {
      const result = await releaseList(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(0);
    });

    it('should support status filtering with top-level page metadata', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      await releasePrepare('v1.1.0', ['T002'], undefined, TEST_ROOT);
      await releaseCommit('v1.0.0', TEST_ROOT);

      const result = await releaseList({ status: 'prepared', limit: 1 }, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).releases).toHaveLength(1);
      expect((result.data as any).total).toBe(2);
      expect((result.data as any).filtered).toBe(1);
      expect(result.page).toEqual({
        mode: 'offset',
        limit: 1,
        offset: 0,
        hasMore: false,
        total: 1,
      });
    });
  });

  describe('releaseShow', () => {
    it('should show release details', async () => {
      await releasePrepare('v1.0.0', ['T001'], 'Test notes', TEST_ROOT);
      const result = await releaseShow('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('v1.0.0');
      expect((result.data as any).notes).toBe('Test notes');
    });
  });

  describe('releaseCommit', () => {
    it('should mark release as committed', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      const result = await releaseCommit('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('committed');
    });

    it('should reject non-prepared release', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      await releaseCommit('v1.0.0', TEST_ROOT);
      const result = await releaseCommit('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_STATE');
    });
  });

  describe('releaseTag', () => {
    it('should mark release as tagged', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      const result = await releaseTag('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('tagged');
    });
  });

  describe('releaseGatesRun', () => {
    it('should run release gates', async () => {
      await releasePrepare('v1.0.0', ['T001', 'T002'], undefined, TEST_ROOT);
      await releaseChangelog('v1.0.0', TEST_ROOT);

      const result = await releaseGatesRun('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.gates).toBeDefined();
      expect(data.passedCount).toBeGreaterThan(0);
    });
  });

  describe('releaseRollback', () => {
    it('should rollback a release', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      await releaseTag('v1.0.0', TEST_ROOT);

      const result = await releaseRollback('v1.0.0', 'Bad release', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('rolled_back');
      expect((result.data as any).previousStatus).toBe('tagged');
    });
  });
});
