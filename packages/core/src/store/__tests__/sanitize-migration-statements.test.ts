/**
 * Unit tests for sanitizeMigrationStatements (T1159).
 *
 * Verifies that the runtime guard correctly filters whitespace-only SQL
 * statement chunks produced when drizzle-orm splits migration files on
 * "--> statement-breakpoint" markers. A trailing marker yields an array
 * ending in "\n" (or similar whitespace-only chunk); session.run() crashes
 * on those chunks with "Failed to run the query '\n'".
 */

import type { MigrationMeta } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';
import { sanitizeMigrationStatements } from '../migration-manager.js';

/** Helper to build a minimal MigrationMeta object. */
function makeMeta(sql: string[], overrides?: Partial<MigrationMeta>): MigrationMeta {
  return {
    sql,
    folderMillis: 1_700_000_000_000,
    hash: 'abc123',
    bps: true,
    name: '0000_test_migration',
    ...overrides,
  };
}

describe('sanitizeMigrationStatements', () => {
  it('filters a trailing "\\n" chunk produced by a trailing statement-breakpoint marker', () => {
    const migration = makeMeta(['CREATE TABLE foo (id INTEGER PRIMARY KEY)', '\n']);
    const result = sanitizeMigrationStatements([migration]);
    expect(result).toHaveLength(1);
    expect(result[0]?.sql).toEqual(['CREATE TABLE foo (id INTEGER PRIMARY KEY)']);
  });

  it('filters a whitespace-only "  " chunk (spaces only)', () => {
    const migration = makeMeta(['INSERT INTO foo VALUES (1)', '  ']);
    const result = sanitizeMigrationStatements([migration]);
    expect(result[0]?.sql).toEqual(['INSERT INTO foo VALUES (1)']);
  });

  it('filters a tab-only chunk', () => {
    const migration = makeMeta(['ALTER TABLE foo ADD COLUMN bar TEXT', '\t\t']);
    const result = sanitizeMigrationStatements([migration]);
    expect(result[0]?.sql).toEqual(['ALTER TABLE foo ADD COLUMN bar TEXT']);
  });

  it('preserves legitimate multi-statement migrations without whitespace chunks', () => {
    const sql = [
      'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      'CREATE INDEX idx_users_name ON users(name)',
      'INSERT INTO schema_meta (key, value) VALUES ("version", "1")',
    ];
    const migration = makeMeta(sql);
    const result = sanitizeMigrationStatements([migration]);
    expect(result[0]?.sql).toEqual(sql);
  });

  it('returns an empty array for an empty migrations array', () => {
    const result = sanitizeMigrationStatements([]);
    expect(result).toEqual([]);
  });

  it('preserves all non-sql fields (hash, folderMillis, name, bps)', () => {
    const migration = makeMeta(['SELECT 1', '\n'], {
      hash: 'deadbeef',
      folderMillis: 9_999_999_999_999,
      name: '0042_special_migration',
      bps: false,
    });
    const result = sanitizeMigrationStatements([migration]);
    const out = result[0];
    expect(out?.hash).toBe('deadbeef');
    expect(out?.folderMillis).toBe(9_999_999_999_999);
    expect(out?.name).toBe('0042_special_migration');
    expect(out?.bps).toBe(false);
    expect(out?.sql).toEqual(['SELECT 1']);
  });

  it('handles a migration where ALL sql chunks are whitespace (returns empty sql array)', () => {
    const migration = makeMeta(['\n', '  ', '\t']);
    const result = sanitizeMigrationStatements([migration]);
    expect(result[0]?.sql).toEqual([]);
  });

  it('handles multiple migrations, filtering each independently', () => {
    const m1 = makeMeta(['CREATE TABLE a (id INTEGER)', '\n'], { hash: 'h1', name: 'mig1' });
    const m2 = makeMeta(['CREATE TABLE b (id INTEGER)', 'CREATE INDEX idx ON b(id)'], {
      hash: 'h2',
      name: 'mig2',
    });
    const m3 = makeMeta(['\r\n', '\t  '], { hash: 'h3', name: 'mig3' });
    const result = sanitizeMigrationStatements([m1, m2, m3]);
    expect(result[0]?.sql).toEqual(['CREATE TABLE a (id INTEGER)']);
    expect(result[1]?.sql).toEqual(['CREATE TABLE b (id INTEGER)', 'CREATE INDEX idx ON b(id)']);
    expect(result[2]?.sql).toEqual([]);
  });

  it('does not mutate the original migration objects', () => {
    const sql = ['CREATE TABLE foo (id INTEGER)', '\n'];
    const migration = makeMeta(sql);
    sanitizeMigrationStatements([migration]);
    // Original array must remain unchanged
    expect(migration.sql).toEqual(sql);
  });
});
