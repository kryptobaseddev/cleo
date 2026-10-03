/**
 * `cleo doctor migrations` report (T12796): journal count, head, per-lineage
 * applied / pending, drift, and a journal rebuilt on a store that already held
 * its schema (T13104). Temp stores only.
 *
 * @task T12796
 * @task T13104
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../store/dual-scope-db.js';
import { runBracketedMigrations } from '../../store/migration-runner.js';
import { inspectJournal } from '../migrations.js';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');
const folderOf = (l: string) => join(MIGRATIONS, l);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-doctor-migrations-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('inspectJournal', () => {
  it('reports a missing store and a fully migrated one', () => {
    expect(
      inspectJournal('project', join(dir, 'none.db'), ['drizzle-cleo-project'], folderOf).exists,
    ).toBe(false);
    const path = join(dir, 'p.db');
    const db = new DatabaseSync(path);
    runBracketedMigrations(db, drizzle({ client: db }), [
      { folder: folderOf('drizzle-cleo-project') },
    ]);
    const rows = (
      db.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number }
    ).n;
    db.close();
    const r = inspectJournal('project', path, ['drizzle-cleo-project', 'drizzle-tasks'], folderOf);
    expect(r.journalRows).toBe(rows);
    expect(r.head?.name).toBe('20260930170000_t12819-trigger-suspend-clause');
    expect(r.lineages).toEqual([
      expect.objectContaining({ lineage: 'drizzle-cleo-project', applied: rows, pending: [] }),
    ]);
    expect(r.drift).toEqual([]);
    expect(r.unknown).toEqual([]);
    // drizzle-cleo-global has files with the same NAMES as some project
    // migrations and different content: no false drift, no phantom pending.
    const both = inspectJournal('project', path, ['drizzle-cleo-project'], folderOf);
    expect(both.drift).toEqual([]);
    expect(both.unknown).toEqual([]);
  });

  it('reports pending files, drifted rows and unknown rows', () => {
    const path = join(dir, 'p.db');
    const db = new DatabaseSync(path);
    runBracketedMigrations(db, drizzle({ client: db }), [
      { folder: folderOf('drizzle-cleo-project') },
    ]);
    db.exec(`
      DELETE FROM __drizzle_migrations WHERE name = '20260930170000_t12819-trigger-suspend-clause';
      UPDATE __drizzle_migrations SET hash = 'deadbeef' WHERE name = '20260929130000_t12736-claim-lease-iso-repair';
      INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('cafe', 1, 'from-a-newer-build');
    `);
    db.close();
    const r = inspectJournal('project', path, ['drizzle-cleo-project'], folderOf);
    expect(r.lineages[0]?.pending).toEqual(['20260930170000_t12819-trigger-suspend-clause']);
    expect(r.drift.map((d) => d.name)).toEqual(['20260929130000_t12736-claim-lease-iso-repair']);
    expect(r.unknown.map((u) => u.name)).toEqual(['from-a-newer-build']);
    expect(r.rebuilt).toBeNull();
  });

  it('names a journal the migrator rebuilt on a store that already held its schema (T13104)', async () => {
    const path = join(dir, 'p.db');
    // A store built by its migrations: the baseline ran, with its applied_at.
    await openDualScopeDbAtPath('project', path);
    _resetDualScopeDbCache();
    const lineages = ['drizzle-cleo-project'];
    expect(inspectJournal('project', path, lineages, folderOf).rebuilt).toBeNull();

    // What a vault restore before T13104 left: the schema, an empty journal.
    let db = new DatabaseSync(path);
    db.exec('DELETE FROM __drizzle_migrations');
    db.close();
    // The next open rebuilds it, stamping what it finds already applied.
    await openDualScopeDbAtPath('project', path);
    _resetDualScopeDbCache();
    db = new DatabaseSync(path, { readOnly: true });
    const nulls = (
      db
        .prepare('SELECT count(*) AS n FROM __drizzle_migrations WHERE applied_at IS NULL')
        .get() as {
        n: number;
      }
    ).n;
    db.close();
    const r = inspectJournal('project', path, lineages, folderOf);
    expect(nulls).toBeGreaterThan(0);
    expect(r.rebuilt?.stamped).toBe(nulls);
    expect(r.rebuilt?.detail).toContain('T13104');
    // Its rows are all accounted for: this is not drift.
    expect(r.drift).toEqual([]);
  });

  it('does not call a long-lived journal rebuilt for stamped rows after a legacy first row', () => {
    const path = join(dir, 'p.db');
    const db = new DatabaseSync(path);
    runBracketedMigrations(db, drizzle({ client: db }), [
      { folder: folderOf('drizzle-cleo-project') },
    ]);
    // A store older than the consolidation: legacy rows first, the baseline stamped later.
    db.exec(`
      CREATE TABLE j AS SELECT * FROM __drizzle_migrations;
      DELETE FROM __drizzle_migrations;
      INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
        VALUES ('legacy', 1, '20260318205539_initial', '2026-03-18T00:00:00.000Z');
      INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
        SELECT hash, created_at, name, NULL FROM j ORDER BY id;
      DROP TABLE j;
    `);
    db.close();
    expect(inspectJournal('project', path, ['drizzle-cleo-project'], folderOf).rebuilt).toBeNull();
  });
});
