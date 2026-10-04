/**
 * readMigrationFilesCached: drizzle's answer, read once per folder content
 * state (T13126).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readSpy } = vi.hoisted(() => ({ readSpy: vi.fn() }));

vi.mock('drizzle-orm/migrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm/migrator')>();
  readSpy.mockImplementation(actual.readMigrationFiles);
  return { ...actual, readMigrationFiles: readSpy };
});

import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readMigrationFilesCached } from '../migration-files.js';
import { resolveCorePackageMigrationsFolder } from '../resolve-migrations-folder.js';

let root: string;

/** Write `<root>/<name>/migration.sql`. */
function writeMigration(name: string, sql: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'migration.sql'), sql);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-migration-files-'));
  readSpy.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('readMigrationFilesCached', () => {
  it("returns drizzle's readMigrationFiles answer for a shipped lineage", () => {
    const folder = resolveCorePackageMigrationsFolder('drizzle-cleo-project');
    expect(readMigrationFilesCached(folder)).toEqual(
      readMigrationFiles({ migrationsFolder: folder }),
    );
  });

  it('reads and hashes a folder once while its contents are unchanged', () => {
    writeMigration('20260101000000_one', 'CREATE TABLE a (id INTEGER);');
    const first = readMigrationFilesCached(root);
    const second = readMigrationFilesCached(root);
    expect(readSpy).toHaveBeenCalledOnce();
    expect(second).toEqual(first);
  });

  it('re-reads when a migration is added or rewritten', () => {
    writeMigration('20260101000000_one', 'CREATE TABLE a (id INTEGER);');
    const before = readMigrationFilesCached(root);

    writeMigration('20260102000000_two', 'CREATE TABLE b (id INTEGER);');
    const added = readMigrationFilesCached(root);
    expect(added.map((m) => m.name)).toEqual(['20260101000000_one', '20260102000000_two']);

    writeMigration('20260101000000_one', 'CREATE TABLE a (id INTEGER, name TEXT);');
    const rewritten = readMigrationFilesCached(root);
    expect(rewritten[0]?.hash).not.toBe(before[0]?.hash);
    expect(readSpy).toHaveBeenCalledTimes(3);
  });

  it('hands every caller its own array', () => {
    writeMigration('20260101000000_one', 'CREATE TABLE a (id INTEGER);');
    readMigrationFilesCached(root).length = 0; // the read
    readMigrationFilesCached(root).length = 0; // a cache hit
    expect(readMigrationFilesCached(root)).toHaveLength(1);
  });

  it('throws for a missing folder and caches nothing', () => {
    const missing = join(root, 'absent');
    expect(() => readMigrationFilesCached(missing)).toThrow();
    expect(() => readMigrationFilesCached(missing)).toThrow();
    expect(readSpy).toHaveBeenCalledTimes(2);
  });
});
