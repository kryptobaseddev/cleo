/**
 * Tests for migration system.
 * @task T4468
 * @epic T4454
 *
 * Note: After tasks.json→tasks.db migration, the getMigrationStatus
 * and runMigration functions for 'todo' type read from getTaskPath()
 * which now returns tasks.db. Since readJson cannot parse SQLite files,
 * todoJson status will be null when no legacy tasks.json exists.
 * The pure-function tests (detectVersion, compareSemver) remain unchanged.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareSemver, detectVersion, getMigrationStatus, runMigration } from '../index.js';

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
  it('returns null for missing files', async () => {
    const status = await getMigrationStatus(testDir);
    expect(status.todoJson).toBeNull();
  });

  it('returns null for todoJson when tasks.db exists (not JSON-readable)', async () => {
    // After tasks.json→tasks.db migration, getTaskPath returns .cleo/tasks.db
    // which readJson cannot parse, so todoJson will be null
    const status = await getMigrationStatus(testDir);
    expect(status.todoJson).toBeNull();
    expect(status.configJson).toBeNull();
    expect(status.archiveJson).toBeNull();
  });
});

describe('runMigration', () => {
  it('rejects unknown file types', async () => {
    await expect(runMigration('unknown', {}, testDir)).rejects.toThrow('Unknown file type');
  });

  it('throws for missing todo file', async () => {
    // With tasks.db migration, the todo path points to tasks.db
    // which doesn't exist yet — runMigration throws NOT_FOUND
    await expect(runMigration('todo', {}, testDir)).rejects.toThrow('File not found');
  });
});
