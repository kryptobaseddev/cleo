/**
 * Release Engine Tests
 *
 * Tests native TypeScript release operations.
 *
 * @task T4476
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  releasePrepare,
  releaseChangelog,
  releaseList,
  releaseShow,
  releaseCommit,
  releaseTag,
  releaseGatesRun,
  releaseRollback,
} from '../release-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-release-engine');
const CLEO_DIR = join(TEST_ROOT, '.cleo');

function writeTodoJson(tasks: any[]): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'todo.json'),
    JSON.stringify({ tasks, _meta: { schemaVersion: '2.6.0' } }, null, 2),
    'utf-8'
  );
}

const SAMPLE_TASKS = [
  { id: 'T001', title: 'feat: Add new feature', description: 'New feature', status: 'done', priority: 'high', completedAt: '2026-02-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T002', title: 'fix: Bug fix', description: 'Fixed bug', status: 'done', priority: 'medium', completedAt: '2026-02-02T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T003', title: 'docs: Update docs', description: 'Documentation', status: 'pending', priority: 'low', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
];

describe('Release Engine', () => {
  beforeEach(() => {
    writeTodoJson(SAMPLE_TASKS);
  });

  afterEach(() => {
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

      const result = releaseList(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(2);
    });

    it('should return empty list when no releases', () => {
      const result = releaseList(TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).total).toBe(0);
    });
  });

  describe('releaseShow', () => {
    it('should show release details', async () => {
      await releasePrepare('v1.0.0', ['T001'], 'Test notes', TEST_ROOT);
      const result = releaseShow('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).version).toBe('v1.0.0');
      expect((result.data as any).notes).toBe('Test notes');
    });
  });

  describe('releaseCommit', () => {
    it('should mark release as committed', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      const result = releaseCommit('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('committed');
    });

    it('should reject non-prepared release', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      releaseCommit('v1.0.0', TEST_ROOT);
      const result = releaseCommit('v1.0.0', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_STATE');
    });
  });

  describe('releaseTag', () => {
    it('should mark release as tagged', async () => {
      await releasePrepare('v1.0.0', ['T001'], undefined, TEST_ROOT);
      const result = releaseTag('v1.0.0', TEST_ROOT);
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
      releaseTag('v1.0.0', TEST_ROOT);

      const result = releaseRollback('v1.0.0', 'Bad release', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).status).toBe('rolled_back');
      expect((result.data as any).previousStatus).toBe('tagged');
    });
  });
});
