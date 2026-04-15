/**
 * E2E tests for NEXUS discovery module.
 *
 * Covers: extractKeywords, searchAcrossProjects, discoverRelated.
 *
 * Split from nexus-e2e.test.ts (T659 rationalization).
 * @task WAVE-1D
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { resetNexusDbState } from '../../store/nexus-sqlite.js';
import { resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { invalidateGraphCache } from '../deps.js';
import { discoverRelated, extractKeywords, searchAcrossProjects } from '../discover.js';
import { nexusRegister } from '../registry.js';

// ── Test helpers ─────────────────────────────────────────────────────

/** Create a test project with tasks in SQLite (tasks.db). */
async function createTestProjectDb(
  dir: string,
  tasks: Array<Partial<Task> & { id: string }>,
): Promise<void> {
  await mkdir(join(dir, '.cleo'), { recursive: true });
  resetDbState();
  const accessor = await createSqliteDataAccessor(dir);
  await seedTasks(accessor, tasks);
  await accessor.close();
  resetDbState();
}

// ── Shared state ─────────────────────────────────────────────────────

let testDir: string;
let registryDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-e2e-discovery-'));
  registryDir = join(testDir, 'cleo-home');
  await mkdir(registryDir, { recursive: true });

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_CURRENT_PROJECT'] = 'e2e-project';
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];

  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  resetNexusDbState();
  resetDbState();
  invalidateGraphCache();
  await rm(testDir, { recursive: true, force: true });
});

// =====================================================================
// DISCOVERY MODULE
// =====================================================================

describe('discovery - extractKeywords', () => {
  it('extracts meaningful keywords from text', () => {
    const keywords = extractKeywords('the auth module for user login');
    expect(keywords).toContain('auth');
    expect(keywords).toContain('module');
    expect(keywords).toContain('user');
    expect(keywords).toContain('login');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('for');
  });

  it('filters short words (2 chars or less)', () => {
    const keywords = extractKeywords('an is to be or no');
    expect(keywords).toHaveLength(0);
  });

  it('handles empty string', () => {
    const keywords = extractKeywords('');
    expect(keywords).toHaveLength(0);
  });

  it('lowercases and removes special characters', () => {
    const keywords = extractKeywords('Authentication! Module: V2.0');
    expect(keywords).toContain('authentication');
    expect(keywords).toContain('module');
  });
});

describe('discovery - searchAcrossProjects', () => {
  let projADir: string;
  let projBDir: string;

  beforeEach(async () => {
    projADir = join(testDir, 'search-a');
    projBDir = join(testDir, 'search-b');
    await createTestProjectDb(projADir, [
      {
        id: 'T001',
        title: 'Auth API',
        status: 'active',
        description: 'Authentication API',
        labels: ['auth'],
      },
      {
        id: 'T002',
        title: 'User API',
        status: 'pending',
        description: 'User management',
        labels: ['user'],
      },
    ]);
    await createTestProjectDb(projBDir, [
      {
        id: 'T100',
        title: 'Auth UI',
        status: 'blocked',
        description: 'Auth login page',
        labels: ['auth'],
      },
      {
        id: 'T101',
        title: 'Dashboard',
        status: 'pending',
        description: 'Main dashboard',
        labels: ['ui'],
      },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(projADir, 'search-backend', 'read');
    await nexusRegister(projBDir, 'search-frontend', 'read');
  });

  it('searches by keyword across all projects', async () => {
    const result = await searchAcrossProjects('Auth');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeGreaterThanOrEqual(2);
      const titles = result.results.map((r) => r.title);
      expect(titles.some((t) => t.includes('Auth'))).toBe(true);
    }
  });

  it('searches by task ID pattern', async () => {
    const result = await searchAcrossProjects('T001');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0].id).toBe('T001');
    }
  });

  it('returns empty results for no match', async () => {
    const result = await searchAcrossProjects('zzz-no-match-xyz');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results).toHaveLength(0);
    }
  });

  it('respects limit parameter', async () => {
    const result = await searchAcrossProjects('Auth', undefined, 1);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeLessThanOrEqual(1);
    }
  });

  it('filters by project when projectFilter is specified', async () => {
    const result = await searchAcrossProjects('Auth', 'search-backend');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      for (const r of result.results) {
        expect(r._project).toBe('search-backend');
      }
    }
  });

  it('returns error for non-existent project filter', async () => {
    const result = await searchAcrossProjects('Auth', 'nonexistent-project');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('E_NOT_FOUND');
    }
  });

  it('handles wildcard query syntax (*:T001)', async () => {
    const result = await searchAcrossProjects('*:T001');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('discovery - discoverRelated', () => {
  let projADir: string;
  let projBDir: string;

  beforeEach(async () => {
    projADir = join(testDir, 'disc-a');
    projBDir = join(testDir, 'disc-b');
    await createTestProjectDb(projADir, [
      {
        id: 'T001',
        title: 'Auth module implementation',
        status: 'active',
        description: 'Build the authentication module',
        labels: ['auth', 'security'],
      },
      {
        id: 'T002',
        title: 'Database setup',
        status: 'done',
        description: 'Set up database',
        labels: ['db'],
      },
    ]);
    await createTestProjectDb(projBDir, [
      {
        id: 'T100',
        title: 'Auth UI component',
        status: 'blocked',
        description: 'UI for authentication flow',
        labels: ['auth', 'ui'],
      },
      {
        id: 'T101',
        title: 'Dashboard analytics',
        status: 'pending',
        description: 'Analytics dashboard',
        labels: ['ui'],
      },
    ]);
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';
    await nexusRegister(projADir, 'disc-backend', 'read');
    await nexusRegister(projBDir, 'disc-frontend', 'read');
  });

  it('discovers related tasks by labels', async () => {
    const result = await discoverRelated('disc-backend:T001', 'labels');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // T100 shares the 'auth' label with T001
      const authMatch = result.results.find((r) => r.taskId === 'T100');
      expect(authMatch).toBeDefined();
      expect(authMatch!.type).toBe('labels');
      expect(authMatch!.reason).toContain('auth');
    }
  });

  it('discovers related tasks by description keywords', async () => {
    const result = await discoverRelated('disc-backend:T001', 'description');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // T100 shares keywords like "auth", "authentication"
      const descMatch = result.results.find((r) => r.taskId === 'T100');
      expect(descMatch).toBeDefined();
      expect(descMatch!.type).toBe('description');
    }
  });

  it('auto method finds results by best match type', async () => {
    const result = await discoverRelated('disc-backend:T001', 'auto');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeGreaterThan(0);
      expect(result.method).toBe('auto');
    }
  });

  it('returns error for invalid query syntax', async () => {
    const result = await discoverRelated('invalid-syntax');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
    }
  });

  it('returns error for wildcard queries', async () => {
    const result = await discoverRelated('*:T001');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error.code).toBe('E_INVALID_INPUT');
      expect(result.error.message).toContain('Wildcard');
    }
  });

  it('respects limit parameter', async () => {
    const result = await discoverRelated('disc-backend:T001', 'auto', 1);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.results.length).toBeLessThanOrEqual(1);
    }
  });

  it('results are sorted by score descending', async () => {
    const result = await discoverRelated('disc-backend:T001', 'auto', 10);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i].score).toBeLessThanOrEqual(result.results[i - 1].score);
      }
    }
  });

  it('each result has correct shape', async () => {
    const result = await discoverRelated('disc-backend:T001', 'auto');

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      for (const r of result.results) {
        expect(r).toHaveProperty('project');
        expect(r).toHaveProperty('taskId');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('score');
        expect(r).toHaveProperty('type');
        expect(r).toHaveProperty('reason');
        expect(typeof r.score).toBe('number');
        expect(r.score).toBeGreaterThan(0);
      }
    }
  });
});
