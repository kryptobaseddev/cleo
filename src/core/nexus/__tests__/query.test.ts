/**
 * Tests for NEXUS query module.
 * @task T4574
 * @epic T4540
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../../store/__tests__/test-db-helper.js';
import { closeAllDatabases, resetDbState } from '../../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../../store/sqlite-data-accessor.js';
import {
  getCurrentProject,
  getProjectFromQuery,
  parseQuery,
  resolveTask,
  validateSyntax,
} from '../query.js';
import { nexusRegister } from '../registry.js';

let testDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-query-test-'));
  const registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  await mkdir(registryDir, { recursive: true });
  await mkdir(join(projectDir, '.cleo'), { recursive: true });

  // Create tasks.db with test data
  resetDbState();
  const accessor = await createSqliteDataAccessor(projectDir);
  await seedTasks(accessor, [
    {
      id: 'T001',
      title: 'Auth module',
      description: 'Implement authentication module',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      labels: ['auth'],
    },
    {
      id: 'T002',
      title: 'API endpoint',
      description: 'Build API endpoint handler',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-01-02T00:00:00Z',
      depends: ['T001'],
    },
  ]);
  await accessor.close();
  resetDbState();

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_CURRENT_PROJECT'] = 'test-project';
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_CURRENT_PROJECT'];
  await closeAllDatabases();
  await rm(testDir, { recursive: true, force: true });
});

describe('validateSyntax', () => {
  it('accepts bare task IDs', () => {
    expect(validateSyntax('T001')).toBe(true);
    expect(validateSyntax('T1234')).toBe(true);
    expect(validateSyntax('T99999')).toBe(true);
  });

  it('accepts project:taskId format', () => {
    expect(validateSyntax('my-app:T001')).toBe(true);
    expect(validateSyntax('api_v2:T1234')).toBe(true);
  });

  it('accepts current project syntax', () => {
    expect(validateSyntax('.:T001')).toBe(true);
  });

  it('accepts wildcard syntax', () => {
    expect(validateSyntax('*:T001')).toBe(true);
  });

  it('rejects invalid formats', () => {
    expect(validateSyntax('')).toBe(false);
    expect(validateSyntax('T')).toBe(false);
    expect(validateSyntax('T1')).toBe(false); // Too short
    expect(validateSyntax('project T001')).toBe(false); // No colon
    expect(validateSyntax(':T001')).toBe(false); // Empty project
    expect(validateSyntax('project::T001')).toBe(false); // Double colon
  });
});

describe('parseQuery', () => {
  it('parses bare task ID with current project', () => {
    const result = parseQuery('T001', 'my-project');
    expect(result.project).toBe('my-project');
    expect(result.taskId).toBe('T001');
    expect(result.wildcard).toBe(false);
  });

  it('parses named project:taskId', () => {
    const result = parseQuery('my-app:T001');
    expect(result.project).toBe('my-app');
    expect(result.taskId).toBe('T001');
    expect(result.wildcard).toBe(false);
  });

  it('parses current project with dot', () => {
    const result = parseQuery('.:T001', 'current-proj');
    expect(result.project).toBe('current-proj');
    expect(result.taskId).toBe('T001');
    expect(result.wildcard).toBe(false);
  });

  it('parses wildcard', () => {
    const result = parseQuery('*:T001');
    expect(result.project).toBe('*');
    expect(result.taskId).toBe('T001');
    expect(result.wildcard).toBe(true);
  });

  it('throws on invalid syntax', () => {
    expect(() => parseQuery('invalid')).toThrow(/Invalid query syntax/);
  });

  it('uses NEXUS_CURRENT_PROJECT env for implicit project', () => {
    const result = parseQuery('T001');
    expect(result.project).toBe('test-project');
  });
});

describe('getCurrentProject', () => {
  it('returns NEXUS_CURRENT_PROJECT env when set', () => {
    process.env['NEXUS_CURRENT_PROJECT'] = 'override-project';
    expect(getCurrentProject()).toBe('override-project');
  });

  it('falls back to cwd directory name', () => {
    delete process.env['NEXUS_CURRENT_PROJECT'];
    const result = getCurrentProject();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('resolveTask', () => {
  it('resolves a named project task', async () => {
    await nexusRegister(projectDir, 'test-proj');

    const task = await resolveTask('test-proj:T001');
    expect(Array.isArray(task)).toBe(false);
    if (!Array.isArray(task)) {
      expect(task.id).toBe('T001');
      expect(task.title).toBe('Auth module');
      expect(task._project).toBe('test-proj');
    }
  });

  it('throws for non-existent task', async () => {
    await nexusRegister(projectDir, 'test-proj');

    await expect(resolveTask('test-proj:T999')).rejects.toThrow(/not found/i);
  });

  it('resolves wildcard across projects', async () => {
    await nexusRegister(projectDir, 'test-proj');

    const tasks = await resolveTask('*:T001');
    expect(Array.isArray(tasks)).toBe(true);
    if (Array.isArray(tasks)) {
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks[0].id).toBe('T001');
      expect(tasks[0]._project).toBe('test-proj');
    }
  });
});

describe('getProjectFromQuery', () => {
  it('extracts project from qualified query', () => {
    expect(getProjectFromQuery('my-app:T001')).toBe('my-app');
  });

  it('returns current project for bare task ID', () => {
    expect(getProjectFromQuery('T001')).toBe('test-project');
  });

  it('returns * for wildcard query', () => {
    expect(getProjectFromQuery('*:T001')).toBe('*');
  });
});
