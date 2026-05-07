/**
 * Tests for T9095 — PR-required release ship flow + releasePrStatus command.
 *
 * Validates:
 *   - Branch model config loading (feat-to-main default, feat-to-develop-to-main)
 *   - releaseShip dry-run emits PR-flow steps
 *   - releaseShip fails hard when gh CLI is unavailable
 *   - releasePrStatus returns error when gh CLI is unavailable
 *   - releasePrStatus returns error when version is missing
 *   - getReleaseBranchConfig returns correct prTargetBranch per model
 *
 * @task T9095
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import {
  createSqliteDataAccessor,
  releasePrStatus,
  releaseShip,
  resetDbState,
} from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { getReleaseBranchConfig, loadReleaseConfig } from '../release-config.js';

// Hoist mocks so they apply when the module is first imported
vi.mock('../changelog-writer.js', () => ({
  writeChangelogSection: vi.fn().mockResolvedValue(undefined),
  parseChangelogBlocks: vi.fn().mockReturnValue({ customBlocks: [], strippedContent: '' }),
}));

vi.mock('../guards.js', () => ({
  checkEpicCompleteness: vi
    .fn()
    .mockResolvedValue({ hasIncomplete: false, epics: [], orphanTasks: [] }),
  checkDoubleListing: vi.fn().mockReturnValue({ hasDoubleListing: false, duplicates: [] }),
}));

vi.mock('../release-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...actual,
    runReleaseGates: vi.fn(),
    showManifestRelease: vi.fn(),
    generateReleaseChangelog: vi.fn(),
    listManifestReleases: vi.fn(),
    markReleasePushed: vi.fn(),
  };
});

vi.mock('../github-pr.js', () => ({
  isGhCliAvailable: vi.fn().mockReturnValue(false),
  buildPRBody: vi.fn().mockReturnValue('PR body'),
  createPullRequest: vi.fn(),
  formatManualPRInstructions: vi.fn().mockReturnValue('manual instructions'),
}));

let TEST_ROOT: string;
let CLEO_DIR: string;

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(join(CLEO_DIR, 'config.json'), JSON.stringify(config, null, 2), 'utf-8');
}

const SAMPLE_TASKS: Array<Partial<Task> & { id: string }> = [
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

describe('T9095 — branch model config', () => {
  beforeEach(async () => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-t9095-config-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    mkdirSync(CLEO_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('defaults to feat-to-main with release/ prefix and prRequired=true', () => {
    const config = loadReleaseConfig(TEST_ROOT);
    const branchCfg = getReleaseBranchConfig(config, TEST_ROOT);

    expect(branchCfg.branchModel).toBe('feat-to-main');
    expect(branchCfg.prRequired).toBe(true);
    expect(branchCfg.releaseBranchPrefix).toBe('release/');
    expect(branchCfg.prTargetBranch).toBe('main');
  });

  it('reads branchModel from config.json via dot-notation', () => {
    writeConfig({ release: { branchModel: 'feat-to-develop-to-main' } });
    const config = loadReleaseConfig(TEST_ROOT);
    const branchCfg = getReleaseBranchConfig(config, TEST_ROOT);

    expect(branchCfg.branchModel).toBe('feat-to-develop-to-main');
    expect(branchCfg.prTargetBranch).toBe('develop');
  });

  it('reads custom releaseBranchPrefix from config.json', () => {
    writeConfig({ release: { releaseBranchPrefix: 'rel/' } });
    const config = loadReleaseConfig(TEST_ROOT);
    const branchCfg = getReleaseBranchConfig(config, TEST_ROOT);

    expect(branchCfg.releaseBranchPrefix).toBe('rel/');
  });

  it('prRequired can be overridden to false via config', () => {
    writeConfig({ release: { prRequired: false } });
    const config = loadReleaseConfig(TEST_ROOT);
    const branchCfg = getReleaseBranchConfig(config, TEST_ROOT);

    expect(branchCfg.prRequired).toBe(false);
  });
});

describe('T9095 — releaseShip PR-required flow', () => {
  beforeEach(async () => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-t9095-ship-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    await setupTestDb();
    writeConfig({ release: { push: { enabled: true, requireCleanTree: false } } });

    const manifest = await import('@cleocode/core/internal');
    vi.mocked(manifest.runReleaseGates).mockResolvedValue({
      version: '2026.5.99',
      allPassed: true,
      gates: [],
      passedCount: 0,
      failedCount: 0,
      metadata: {
        channel: 'latest',
        requiresPR: false,
        targetBranch: 'main',
        currentBranch: 'main',
      },
    });
    vi.mocked(manifest.showManifestRelease).mockResolvedValue({
      tasks: ['T001'],
      version: 'v2026.5.99',
    } as never);
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
    vi.clearAllMocks();
  });

  it('dry-run shows PR-flow steps including gh pr create and merge', async () => {
    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T9095', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.version).toBe('2026.5.99');
    expect(data.epicId).toBe('T9095');
    expect(data.branchModel).toBe('feat-to-main');
    expect(data.prTargetBranch).toBe('main');
    expect(data.releaseBranch).toBe('release/v2026.5.99');
    expect(data.gitTag).toBe('v2026.5.99');

    const steps = data.wouldDo as string[];
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.some((s) => s.includes('git checkout -b release/v2026.5.99'))).toBe(true);
    expect(steps.some((s) => s.includes('gh pr create'))).toBe(true);
    expect(steps.some((s) => s.includes('gh pr merge'))).toBe(true);
    expect(steps.some((s) => s.includes('git tag'))).toBe(true);
    expect(steps.some((s) => s.includes('git push'))).toBe(true);
  });

  it('dry-run with feat-to-develop-to-main shows develop as PR target', async () => {
    writeConfig({
      release: {
        branchModel: 'feat-to-develop-to-main',
        push: { enabled: true, requireCleanTree: false },
      },
    });
    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T9095', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.branchModel).toBe('feat-to-develop-to-main');
    expect(data.prTargetBranch).toBe('develop');

    const steps = data.wouldDo as string[];
    expect(steps.some((s) => s.includes('--base develop'))).toBe(true);
  });

  it('fails with E_GENERAL when gh CLI is unavailable (non-dry-run)', async () => {
    // isGhCliAvailable is mocked to return false at module level
    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T9095', dryRun: false },
      TEST_ROOT,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_GENERAL');
    expect(result.error?.message).toMatch(/gh CLI is not available/i);
  });

  it('gate failure returns E_LIFECYCLE_GATE_FAILED before gh CLI check', async () => {
    const manifest = await import('@cleocode/core/internal');
    vi.mocked(manifest.runReleaseGates).mockResolvedValueOnce({
      version: '2026.5.99',
      allPassed: false,
      gates: [{ name: 'all-tasks-complete', status: 'failed', message: 'T002 is still active' }],
      passedCount: 0,
      failedCount: 1,
      metadata: {
        channel: 'latest',
        requiresPR: false,
        targetBranch: 'main',
        currentBranch: 'main',
      },
    });

    const result = await releaseShip(
      { version: '2026.5.99', epicId: 'T9095', dryRun: true },
      TEST_ROOT,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_GATE_FAILED');
    expect(result.error?.message).toMatch(/gates failed/i);
  });
});

describe('T9095 — releasePrStatus', () => {
  beforeEach(() => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-t9095-prstatus-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    mkdirSync(CLEO_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns E_INVALID_INPUT when version is empty', async () => {
    const result = await releasePrStatus('', TEST_ROOT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('returns E_GENERAL when gh CLI is not available', async () => {
    // isGhCliAvailable mock returns false
    const result = await releasePrStatus('2026.5.99', TEST_ROOT);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_GENERAL');
    expect(result.error?.message).toMatch(/gh CLI is not available/i);
  });
});
