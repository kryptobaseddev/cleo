/**
 * Tests for release.ship composite operation.
 *
 * @task T5582
 * @epic T5576
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import { resetDbState } from '../../../store/sqlite.js';
import { releaseShip } from '../release-engine.js';

// Hoist mocks so they apply when the module is first imported
vi.mock('../../../core/release/changelog-writer.js', () => ({
  writeChangelogSection: vi.fn().mockResolvedValue(undefined),
  parseChangelogBlocks: vi.fn().mockReturnValue({ customBlocks: [], strippedContent: '' }),
}));

vi.mock('../../../core/release/guards.js', () => ({
  checkEpicCompleteness: vi.fn().mockResolvedValue({ hasIncomplete: false, epics: [], orphanTasks: [] }),
  checkDoubleListing: vi.fn().mockReturnValue({ hasDoubleListing: false, duplicates: [] }),
}));

vi.mock('../../../core/release/release-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/release/release-manifest.js')>();
  return {
    ...actual,
    runReleaseGates: vi.fn(),
    showManifestRelease: vi.fn(),
    generateReleaseChangelog: vi.fn(),
    listManifestReleases: vi.fn(),
    markReleasePushed: vi.fn(),
  };
});

const TEST_ROOT = join(process.cwd(), '.test-release-ship');
const CLEO_DIR = join(TEST_ROOT, '.cleo');

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'config.json'),
    JSON.stringify(config, null, 2),
    'utf-8',
  );
}

const SAMPLE_TASKS = [
  {
    id: 'T001',
    title: 'feat: Add feature A',
    description: 'Feature A implementation',
    status: 'done',
    priority: 'high',
    completedAt: '2026-02-01T00:00:00Z',
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

describe('release.ship', () => {
  beforeEach(async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    await setupTestDb();
    writeConfig({ release: { push: { enabled: true, requireCleanTree: false } } });
    // Re-apply default mock values after any per-test overrides
    const manifest = await import('../../../core/release/release-manifest.js');
    vi.mocked(manifest.runReleaseGates).mockResolvedValue({
      version: '2026.3.99',
      allPassed: true,
      gates: [],
      passedCount: 0,
      failedCount: 0,
    });
    vi.mocked(manifest.showManifestRelease).mockResolvedValue({ tasks: ['T001'], version: 'v2026.3.99' } as never);
    vi.mocked(manifest.generateReleaseChangelog).mockResolvedValue({
      changelog: '### Features\n- feat: Add feature A (T001)\n',
      taskCount: 1,
    } as never);
    vi.mocked(manifest.listManifestReleases).mockResolvedValue({ releases: [] } as never);
    vi.mocked(manifest.markReleasePushed).mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetDbState();
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('returns error when version is missing', async () => {
    const result = await releaseShip(
      { version: '', epicId: 'T5576' },
      TEST_ROOT,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/version is required/i);
  });

  it('returns error when epicId is missing', async () => {
    const result = await releaseShip(
      { version: '2026.3.99', epicId: '' },
      TEST_ROOT,
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.message).toMatch(/epicId is required/i);
  });

  it('dryRun returns what-would-happen without executing git ops', async () => {
    const result = await releaseShip(
      { version: '2026.3.99', epicId: 'T5576', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.version).toBe('2026.3.99');
    expect(data.epicId).toBe('T5576');
    expect(Array.isArray(data.wouldDo)).toBe(true);
    const steps = data.wouldDo as string[];
    expect(steps.some((s) => s.includes('git add CHANGELOG.md'))).toBe(true);
    expect(steps.some((s) => s.includes('git commit'))).toBe(true);
    expect(steps.some((s) => s.includes('git tag'))).toBe(true);
    expect(steps.some((s) => s.includes('git push'))).toBe(true);
  });

  it('gate failure returns error with gate details', async () => {
    // Override the default mock for this specific test
    const manifest = await import('../../../core/release/release-manifest.js');
    vi.mocked(manifest.runReleaseGates).mockResolvedValueOnce({
      version: '2026.3.99',
      allPassed: false,
      gates: [{ name: 'all-tasks-complete', status: 'failed', message: 'T002 is still active' }],
      passedCount: 0,
      failedCount: 1,
    });

    const result = await releaseShip(
      { version: '2026.3.99', epicId: 'T5576', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
    expect(result.error?.message).toMatch(/gates failed/i);
  });
});
