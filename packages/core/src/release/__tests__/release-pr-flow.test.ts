/**
 * Tests for T9095 — PR-required release flow surface that remains after
 * the legacy `releaseShip` monolith deletion in T9540.
 *
 * Validates:
 *   - Branch model config loading (feat-to-main default, feat-to-develop-to-main)
 *   - releasePrStatus returns error when gh CLI is unavailable
 *   - releasePrStatus returns error when version is missing
 *   - getReleaseBranchConfig returns correct prTargetBranch per model
 *
 * Historical note: the original middle describe block exercised
 * `releaseShip` dry-run / gate-failure / gh-cli-missing scenarios. T9540
 * (Phase 6 of T9499) deleted the `releaseShip` monolith, so that block was
 * removed alongside the function. Branch-model config + `releasePrStatus`
 * tests remain because they cover surviving surface area.
 *
 * @task T9095
 * @task T9540 — removed releaseShip describe block after deletion
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releasePrStatus } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReleaseBranchConfig, loadReleaseConfig } from '../release-config.js';

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

describe('T9095 — branch model config', () => {
  beforeEach(() => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-t9095-config-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    mkdirSync(CLEO_DIR, { recursive: true });
    // T9583 fix: loadReleaseConfig now normalizes cwd via getProjectRoot(),
    // which validates the project root and requires a `.git/` sibling next
    // to `.cleo/`. Without `.git/` the readConfigValueSync helpers swallow
    // E_INVALID_PROJECT_ROOT and return defaults, so the config overrides
    // written in these tests would never be loaded.
    mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('defaults to feat-to-main with release/ prefix and prRequired=true', () => {
    const config = loadReleaseConfig(TEST_ROOT);
    const branchCfg = getReleaseBranchConfig(config, TEST_ROOT);

    expect(branchCfg.branchModel).toBe('feat-to-main');
    expect(branchCfg.releaseBranchPrefix).toBe('release/');
    expect(branchCfg.prRequired).toBe(true);
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

describe('T9095 — releasePrStatus', () => {
  beforeEach(() => {
    TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-t9095-prstatus-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    mkdirSync(CLEO_DIR, { recursive: true });
    // T9583 fix: releasePrStatus walks the project root via getProjectRoot()
    // and now requires `.cleo/` + `.git/` siblings. Without `.git/` the
    // validator rejects the temp dir and getProjectRoot throws
    // E_INVALID_PROJECT_ROOT before the gh-CLI check is reached.
    mkdirSync(join(TEST_ROOT, '.git'), { recursive: true });
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
