/**
 * Tests for migration system.
 * @task T4468
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectVersion,
  compareSemver,
  getMigrationStatus,
  runMigration,
} from '../index.js';

let testDir: string;
let cleoDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-migrate-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

describe('detectVersion', () => {
  it('detects from _meta.schemaVersion', () => {
    expect(detectVersion({ _meta: { schemaVersion: '2.10.0' } })).toBe('2.10.0');
  });

  it('falls back to .version', () => {
    expect(detectVersion({ version: '1.0.0' })).toBe('1.0.0');
  });

  it('returns 0.0.0 for unknown', () => {
    expect(detectVersion({})).toBe('0.0.0');
  });
});

describe('compareSemver', () => {
  it('compares equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
  });

  it('compares minor versions', () => {
    expect(compareSemver('1.1.0', '1.2.0')).toBe(-1);
    expect(compareSemver('1.2.0', '1.1.0')).toBe(1);
  });

  it('compares patch versions', () => {
    expect(compareSemver('1.0.1', '1.0.2')).toBe(-1);
    expect(compareSemver('1.0.2', '1.0.1')).toBe(1);
  });
});

describe('getMigrationStatus', () => {
  it('reports status for existing files', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '1.0.0',
        _meta: { schemaVersion: '2.6.0', checksum: 'abc', configVersion: '2.0.0' },
        project: { name: 'Test', phases: {} },
        tasks: [],
        lastUpdated: '2026-01-01T00:00:00Z',
      }),
    );
    const status = await getMigrationStatus();
    expect(status.todoJson).not.toBeNull();
    expect(status.todoJson!.current).toBe('2.6.0');
    expect(status.todoJson!.needsMigration).toBe(true);
  });

  it('returns null for missing files', async () => {
    const status = await getMigrationStatus();
    expect(status.todoJson).toBeNull();
  });
});

describe('runMigration', () => {
  it('runs migrations on todo.json', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '1.0.0',
        _meta: { schemaVersion: '2.6.0', checksum: 'abc', configVersion: '2.0.0' },
        project: { name: 'Test', phases: {} },
        tasks: [
          { id: 'T001', title: 'Test', status: 'pending', priority: 'medium', type: 'task', createdAt: '2026-01-01T00:00:00Z' },
        ],
        lastUpdated: '2026-01-01T00:00:00Z',
      }),
    );
    const result = await runMigration('todo');
    expect(result.success).toBe(true);
    expect(result.migrationsApplied.length).toBeGreaterThan(0);
    expect(result.toVersion).toBe('2.10.0');
  });

  it('supports dry run', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '1.0.0',
        _meta: { schemaVersion: '2.6.0', checksum: 'abc', configVersion: '2.0.0' },
        project: { name: 'Test', phases: {} },
        tasks: [],
        lastUpdated: '2026-01-01T00:00:00Z',
      }),
    );
    const result = await runMigration('todo', { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
  });

  it('rejects unknown file types', async () => {
    await expect(runMigration('unknown')).rejects.toThrow('Unknown file type');
  });

  it('returns no-op for current version', async () => {
    await writeFile(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '1.0.0',
        _meta: { schemaVersion: '2.10.0', checksum: 'abc', configVersion: '2.0.0' },
        project: { name: 'Test', phases: {} },
        tasks: [],
        lastUpdated: '2026-01-01T00:00:00Z',
      }),
    );
    const result = await runMigration('todo');
    expect(result.migrationsApplied).toHaveLength(0);
  });
});
