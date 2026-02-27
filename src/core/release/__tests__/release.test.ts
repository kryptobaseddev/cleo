/**
 * Tests for release management.
 * @task T4467
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createRelease,
  planRelease,
  shipRelease,
  listReleases,
  showRelease,
  getChangelog,
  validateVersion,
} from '../index.js';

let testDir: string;
let cleoDir: string;

const makeTodoFile = () => ({
  version: '1.0.0',
  project: { name: 'Test', phases: {}, releases: [] },
  lastUpdated: '2026-01-01T00:00:00Z',
  _meta: { schemaVersion: '2.10.0', specVersion: '0.1.0', checksum: 'abc123', configVersion: '2.0.0' },
  tasks: [
    { id: 'T001', title: 'Add auth', status: 'done', priority: 'high', type: 'task', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'T002', title: 'Fix login bug', status: 'done', priority: 'medium', type: 'task', labels: ['bug'], createdAt: '2026-01-01T00:00:00Z' },
    { id: 'T003', title: 'Refactor DB', status: 'pending', priority: 'low', type: 'task', createdAt: '2026-01-01T00:00:00Z' },
  ],
});

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-release-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

async function writeTodo() {
  await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(makeTodoFile()));
}

describe('validateVersion', () => {
  it('accepts valid version formats', () => {
    expect(() => validateVersion('1.0.0')).not.toThrow();
    expect(() => validateVersion('v2.3.4')).not.toThrow();
    expect(() => validateVersion('1.0.0-alpha.1')).not.toThrow();
    expect(() => validateVersion('2026.2.0')).not.toThrow();
  });

  it('rejects invalid version formats', () => {
    expect(() => validateVersion('abc')).toThrow();
    expect(() => validateVersion('1.0')).toThrow();
  });
});

describe('createRelease', () => {
  it('creates a release', async () => {
    await writeTodo();
    const release = await createRelease({ version: 'v1.1.0', tasks: ['T001'] });
    expect(release.version).toBe('1.1.0');
    expect(release.tasks).toContain('T001');
    expect(release.status).toBe('planned');
  });

  it('rejects duplicate release', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0' });
    await expect(createRelease({ version: '1.1.0' })).rejects.toThrow('already exists');
  });

  it('rejects invalid task IDs', async () => {
    await writeTodo();
    await expect(createRelease({ version: '1.1.0', tasks: ['T999'] })).rejects.toThrow('not found');
  });
});

describe('planRelease', () => {
  it('adds tasks to release', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0' });
    const release = await planRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    expect(release.tasks).toContain('T001');
    expect(release.tasks).toContain('T002');
  });

  it('removes tasks from release', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    const release = await planRelease({ version: '1.1.0', removeTasks: ['T001'] });
    expect(release.tasks).not.toContain('T001');
    expect(release.tasks).toContain('T002');
  });

  it('deduplicates tasks', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001'] });
    const release = await planRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    expect(release.tasks.filter(t => t === 'T001')).toHaveLength(1);
  });
});

describe('shipRelease', () => {
  it('ships a release in dry run mode', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    const result = await shipRelease({ version: '1.1.0', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.changelog).toBeDefined();
  });

  it('ships a release', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    const result = await shipRelease({ version: '1.1.0' });
    expect(result.dryRun).toBe(false);
    expect(result.release.status).toBe('released');
    expect(result.release.releasedAt).toBeDefined();
  });

  it('rejects already released', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001'] });
    await shipRelease({ version: '1.1.0' });
    await expect(shipRelease({ version: '1.1.0' })).rejects.toThrow('already released');
  });
});

describe('listReleases', () => {
  it('lists all releases', async () => {
    await writeTodo();
    await createRelease({ version: '1.0.0' });
    await createRelease({ version: '1.1.0' });
    const releases = await listReleases();
    expect(releases).toHaveLength(2);
  });
});

describe('showRelease', () => {
  it('shows release details with task info', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001'], notes: 'Test release' });
    const result = await showRelease('1.1.0');
    expect(result.version).toBe('1.1.0');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.title).toBe('Add auth');
    expect(result.notes).toBe('Test release');
  });
});

describe('getChangelog', () => {
  it('generates changelog from tasks', async () => {
    await writeTodo();
    await createRelease({ version: '1.1.0', tasks: ['T001', 'T002'] });
    const changelog = await getChangelog('1.1.0');
    expect(changelog).toContain('Add auth');
    expect(changelog).toContain('Fix login bug');
  });
});
