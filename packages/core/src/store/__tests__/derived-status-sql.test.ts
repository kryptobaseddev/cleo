/**
 * The bound, the inlined and the drizzle derived-status SQL come from one
 * builder and agree row for row (T14330, T14343, T14268).
 *
 * @task T14330
 * @task T14343
 * @task T14346
 */

import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { describe, expect, it } from 'vitest';
import { derivedStatusIn, derivedStatusSql } from '../sqlite-data-accessor.js';
import { DERIVED_STATUS_SQL, derivedStatusSqlAt } from '../task-claim.js';

const NOW = '2026-11-06T12:00:00.000Z';

describe('derived-status SQL forms (T14330)', () => {
  it('DERIVED_STATUS_SQL bound to now and derivedStatusSqlAt(now) give the same status for every row', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE tasks_tasks (id TEXT PRIMARY KEY, status TEXT, claimed_by_session TEXT, lease_expires_at TEXT)',
    );
    const rows: Array<[string, string, string | null, string | null]> = [
      ['T1', 'pending', null, null],
      ['T2', 'pending', 'ses_a', '2999-01-01T00:00:00.000Z'],
      ['T3', 'pending', 'ses_a', '2000-01-01T00:00:00.000Z'],
      ['T4', 'active', null, null],
      ['T5', 'active', 'ses_a', '2999-01-01T00:00:00.000Z'],
      ['T6', 'active', 'ses_a', NOW],
      ['T7', 'done', 'ses_a', '2999-01-01T00:00:00.000Z'],
      ['T8', 'blocked', null, null],
    ];
    const insert = db.prepare('INSERT INTO tasks_tasks VALUES (?, ?, ?, ?)');
    for (const row of rows) insert.run(...row);

    const bound = db
      .prepare(`SELECT id, ${DERIVED_STATUS_SQL} AS s FROM tasks_tasks ORDER BY id`)
      .all(NOW);
    const inlined = db
      .prepare(`SELECT id, ${derivedStatusSqlAt(undefined, NOW)} AS s FROM tasks_tasks ORDER BY id`)
      .all();
    const aliased = db
      .prepare(`SELECT t.id, ${derivedStatusSqlAt('t', NOW)} AS s FROM tasks_tasks t ORDER BY t.id`)
      .all();
    // T14343: the drizzle form, built from the same builder with now bound.
    const drizzled = drizzle({ client: db }).all(
      sql`SELECT id, ${derivedStatusSql(NOW)} AS s FROM tasks_tasks ORDER BY id`,
    );
    expect(inlined).toEqual(bound);
    expect(aliased).toEqual(bound);
    expect(drizzled).toEqual(bound);

    // T14346: the drizzle IN filter selects exactly the ids each status reads with.
    const orm = drizzle({ client: db });
    for (const status of ['active', 'pending', 'done', 'blocked'] as const) {
      const filtered = orm
        .all<{ id: string }>(
          sql`SELECT id FROM tasks_tasks WHERE ${derivedStatusIn([status], NOW)} ORDER BY id`,
        )
        .map((r) => r.id);
      const expected = bound.filter((r) => r.s === status).map((r) => r.id);
      expect(filtered, status).toEqual(expected);
    }
    expect(bound.map((r) => r.s)).toEqual([
      'pending',
      'active',
      'pending',
      'pending',
      'active',
      'pending',
      'done',
      'blocked',
    ]);
    db.close();
  });

  it('the inlined form is the bound form with now substituted', () => {
    expect(derivedStatusSqlAt(undefined, NOW)).toBe(DERIVED_STATUS_SQL.replace('?', `'${NOW}'`));
    expect(() => derivedStatusSqlAt(undefined, "2026' OR 1=1 --")).toThrow(/ISO-8601/);
  });
});
