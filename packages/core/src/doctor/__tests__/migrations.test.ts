/**
 * `cleo doctor migrations` report (T12796): journal count, head, per-lineage
 * applied / pending, drift. Temp stores only.
 *
 * @task T12796
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  });
});
