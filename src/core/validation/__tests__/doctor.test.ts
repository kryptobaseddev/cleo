/**
 * Tests for doctor health checks and utilities.
 * @task T4528
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isTempProject,
  categorizeProjects,
  getProjectCategoryName,
  formatProjectHealthSummary,
  getProjectGuidance,
  getUserJourneyStage,
  getJourneyGuidance,
} from '../doctor/utils.js';
import {
  checkCliInstallation,
  checkCliVersion,
  checkDocsAccessibility,
  calculateHealthStatus,
} from '../doctor/checks.js';
import {
  initCacheFile,
  loadCache,
  getCacheFilePath,
  clearEntireCache,
  CACHE_VERSION,
} from '../doctor/project-cache.js';

// ============================================================================
// Doctor Utils
// ============================================================================

describe('isTempProject', () => {
  it('detects temp directory patterns', () => {
    expect(isTempProject('/home/user/.temp/project')).toBe(true);
    expect(isTempProject('/tmp/test-project')).toBe(true);
    expect(isTempProject('/home/user/bats-run-12345/test')).toBe(true);
  });

  it('returns false for regular projects', () => {
    expect(isTempProject('/home/user/my-project')).toBe(false);
    expect(isTempProject('/mnt/projects/cleo')).toBe(false);
  });
});

describe('categorizeProjects', () => {
  it('separates active, temp, and orphaned', () => {
    const projects = [
      { name: 'active', path: '/home/user/project', status: 'healthy' as const, isTemp: false },
      { name: 'temp', path: '/tmp/test', status: 'healthy' as const, isTemp: true },
      { name: 'orphaned', path: '/missing/path', status: 'orphaned' as const, isTemp: false, isOrphaned: true },
    ];

    const result = categorizeProjects(projects);
    expect(result.active).toHaveLength(1);
    expect(result.temp).toHaveLength(1);
    expect(result.orphaned).toHaveLength(1);
  });
});

describe('getProjectCategoryName', () => {
  it('returns human-readable names', () => {
    expect(getProjectCategoryName('active')).toBe('Active Projects');
    expect(getProjectCategoryName('temp')).toBe('Temporary/Test Projects');
    expect(getProjectCategoryName('orphaned')).toBe('Orphaned Projects');
  });
});

describe('formatProjectHealthSummary', () => {
  it('formats summary string', () => {
    const summary = formatProjectHealthSummary({
      total: 10,
      healthy: 7,
      warnings: 2,
      failed: 1,
      orphaned: 0,
      temp: 3,
    });
    expect(summary).toContain('Total Projects: 10');
    expect(summary).toContain('Healthy Projects: 7');
  });
});

describe('getProjectGuidance', () => {
  it('returns all-healthy guidance when no issues', () => {
    const guidance = getProjectGuidance(0, 0, 0, 0);
    expect(guidance).toHaveLength(1);
    expect(guidance[0]).toContain('healthy');
  });

  it('includes cleanup suggestion for many temp projects', () => {
    const guidance = getProjectGuidance(0, 0, 15, 0);
    expect(guidance.some(g => g.includes('clean-temp'))).toBe(true);
  });
});

describe('getUserJourneyStage', () => {
  it('detects new user', () => {
    expect(getUserJourneyStage(false, 0, true)).toBe('new-user');
  });

  it('detects cleanup needed', () => {
    expect(getUserJourneyStage(true, 15, true)).toBe('cleanup-needed');
  });

  it('detects setup agents needed', () => {
    expect(getUserJourneyStage(true, 0, false)).toBe('setup-agents-needed');
  });

  it('detects maintenance mode', () => {
    expect(getUserJourneyStage(true, 0, true)).toBe('maintenance-mode');
  });
});

describe('getJourneyGuidance', () => {
  it('returns guidance for each stage', () => {
    expect(getJourneyGuidance('new-user')).toHaveLength(4);
    expect(getJourneyGuidance('cleanup-needed')).toHaveLength(3);
    expect(getJourneyGuidance('maintenance-mode')).toHaveLength(2);
  });
});

// ============================================================================
// Doctor Checks
// ============================================================================

describe('doctor checks', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-doctor-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('checkCliInstallation passes when dir exists', async () => {
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    const result = checkCliInstallation(join(tempDir, '.cleo'));
    expect(result.status).toBe('passed');
  });

  it('checkCliInstallation fails when dir missing', () => {
    const result = checkCliInstallation(join(tempDir, 'nonexistent'));
    expect(result.status).toBe('failed');
    expect(result.fix).toContain('install.sh');
  });

  it('checkCliVersion passes with valid version format', async () => {
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(join(cleoDir, 'VERSION'), '1.2.3\n');
    const result = checkCliVersion(cleoDir);
    expect(result.status).toBe('passed');
    expect(result.details['version']).toBe('1.2.3');
  });

  it('checkCliVersion fails with invalid version', async () => {
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(join(cleoDir, 'VERSION'), 'invalid');
    const result = checkCliVersion(cleoDir);
    expect(result.status).toBe('failed');
  });

  it('checkDocsAccessibility fails when file missing', () => {
    const result = checkDocsAccessibility(join(tempDir, 'nonexistent'));
    expect(result.status).toBe('failed');
  });

  it('checkDocsAccessibility passes when file readable', async () => {
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(join(cleoDir, 'templates'), { recursive: true });
    await writeFile(join(cleoDir, 'templates', 'CLEO-INJECTION.md'), '# CLEO');
    const result = checkDocsAccessibility(cleoDir);
    expect(result.status).toBe('passed');
  });
});

describe('calculateHealthStatus', () => {
  it('returns 0 for all passed', () => {
    const checks = [
      { id: 'a', category: 'c', status: 'passed' as const, message: '', details: {}, fix: null },
    ];
    expect(calculateHealthStatus(checks)).toBe(0);
  });

  it('returns 50 for warnings', () => {
    const checks = [
      { id: 'a', category: 'c', status: 'warning' as const, message: '', details: {}, fix: null },
    ];
    expect(calculateHealthStatus(checks)).toBe(50);
  });

  it('returns 52 for failures', () => {
    const checks = [
      { id: 'a', category: 'c', status: 'failed' as const, message: '', details: {}, fix: null },
    ];
    expect(calculateHealthStatus(checks)).toBe(52);
  });
});

// ============================================================================
// Project Cache
// ============================================================================

describe('project cache', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-cache-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('initCacheFile creates valid cache', () => {
    const cacheFile = join(tempDir, 'cache.json');
    const cache = initCacheFile(cacheFile);
    expect(cache.version).toBe(CACHE_VERSION);
    expect(cache.projects).toEqual({});
  });

  it('loadCache returns null for missing file', () => {
    expect(loadCache(join(tempDir, 'nonexistent.json'))).toBeNull();
  });

  it('loadCache returns cached data', () => {
    const cacheFile = join(tempDir, 'cache.json');
    initCacheFile(cacheFile);
    const loaded = loadCache(cacheFile);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(CACHE_VERSION);
  });

  it('clearEntireCache resets to empty', () => {
    const cacheFile = join(tempDir, 'cache.json');
    initCacheFile(cacheFile);
    clearEntireCache(cacheFile);
    const loaded = loadCache(cacheFile);
    expect(loaded!.projects).toEqual({});
  });
});
