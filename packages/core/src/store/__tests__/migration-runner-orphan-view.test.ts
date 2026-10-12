/**
 * A table rebuild must not fail on a view or trigger over a table that no longer
 * exists (T13631): the cleocode store carried `releases_view` over the dropped
 * `release_manifests`, and 2026.10.10's first `RENAME` failed every open.
 *
 * @task T13631
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dropOrphanSchemaObjects, runBracketedMigrations } from '../migration-runner.js';

let dir: string;
let db: DatabaseSync;
let folder: string;

const objects = () =>
  (
    db
      .prepare(
        `SELECT type || ' ' || name AS o FROM sqlite_master WHERE type IN ('view','trigger') ORDER BY 1`,
      )
      .all() as { o: string }[]
  ).map((r) => r.o);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-runner-orphan-'));
  folder = join(dir, 'lineage');
  mkdirSync(join(folder, '20260101000001_base'), { recursive: true });
  writeFileSync(
    join(folder, '20260101000001_base', 'migration.sql'),
    `CREATE TABLE releases (id TEXT PRIMARY KEY, version TEXT);
--> statement-breakpoint
CREATE TABLE release_manifests (version TEXT);
--> statement-breakpoint
CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT);
--> statement-breakpoint
CREATE TABLE log (id TEXT);`,
  );
  db = new DatabaseSync(join(dir, 'store.db'));
  runBracketedMigrations(db, drizzle({ client: db }), [{ folder }]);
  // The stranded legacy shape: the view and a trigger outlive release_manifests.
  db.exec(`CREATE VIEW releases_view AS SELECT version FROM releases
             UNION ALL SELECT version FROM release_manifests`);
  db.exec(`CREATE TRIGGER stale_tr AFTER INSERT ON releases
             BEGIN INSERT INTO release_manifests(version) VALUES (new.version); END`);
  db.exec('CREATE VIEW live_view AS SELECT id, version FROM releases');
  db.exec(
    `CREATE TRIGGER live_tr AFTER INSERT ON releases BEGIN INSERT INTO log(id) VALUES (new.id); END`,
  );
  db.exec('DROP TABLE release_manifests');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('orphan views and triggers before a table rebuild (T13631)', () => {
  it('applies a rebuild migration, dropping only the objects over the missing table', () => {
    mkdirSync(join(folder, '20260101000002_rebuild'));
    writeFileSync(
      join(folder, '20260101000002_rebuild', 'migration.sql'),
      `CREATE TABLE \`__new_t\` (id TEXT PRIMARY KEY, v TEXT, extra TEXT);
--> statement-breakpoint
INSERT INTO \`__new_t\`(id, v) SELECT id, v FROM \`t\`;
--> statement-breakpoint
DROP TABLE \`t\`;
--> statement-breakpoint
ALTER TABLE \`__new_t\` RENAME TO \`t\`;`,
    );
    const report = runBracketedMigrations(db, drizzle({ client: db }), [{ folder }]);
    expect(report.applied).toEqual(['20260101000002_rebuild']);
    expect(objects()).toEqual(['trigger live_tr', 'view live_view']);
  });

  it('drops nothing on a schema whose objects all compile', () => {
    db.exec('DROP VIEW releases_view');
    db.exec('DROP TRIGGER stale_tr');
    db.exec('BEGIN');
    expect(dropOrphanSchemaObjects(db)).toEqual([]);
    db.exec('COMMIT');
    expect(objects()).toEqual(['trigger live_tr', 'view live_view']);
  });
});
