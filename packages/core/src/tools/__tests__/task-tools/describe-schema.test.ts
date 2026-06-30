import { describe, expect, it } from 'vitest';
import { describeSchema, describeSchemaRegistered } from '../../../task-tools/describe-schema.js';

describe('describeSchema', () => {
  it('returns at least 10 tables', () => {
    const { tables } = describeSchema();
    expect(tables.length).toBeGreaterThanOrEqual(10);
  });

  it('tables are sorted alphabetically by name', () => {
    const { tables } = describeSchema();
    const names = tables.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  // T11883 (E3): describe-schema imports the tasks-schema barrel, whose
  // task-domain symbols are SHADOWED onto the PREFIXED consolidated tables the
  // runtime reads/writes — so the described physical name is `tasks_tasks` and
  // its indexes are `idx_tasks_tasks_*`, not the legacy bare `tasks`.
  it('snapshot — tasks_tasks table shape', () => {
    const { tables } = describeSchema();
    const tasks = tables.find((t) => t.name === 'tasks_tasks');
    expect(tasks).toBeDefined();

    const idCol = tasks!.columns.find((c) => c.name === 'id');
    expect(idCol).toMatchObject({ name: 'id', primaryKey: true, notNull: true });

    const titleCol = tasks!.columns.find((c) => c.name === 'title');
    expect(titleCol).toMatchObject({ name: 'title', notNull: true });

    const statusCol = tasks!.columns.find((c) => c.name === 'status');
    expect(statusCol).toMatchObject({ name: 'status', notNull: true });

    expect(tasks!.indexes.length).toBeGreaterThan(0);
    const indexNames = tasks!.indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_tasks_tasks_status');
    expect(indexNames).toContain('idx_tasks_tasks_priority');
  });

  it('snapshot — tasks_sessions table shape', () => {
    const { tables } = describeSchema();
    const sessions = tables.find((t) => t.name === 'tasks_sessions');
    expect(sessions).toBeDefined();

    const idCol = sessions!.columns.find((c) => c.name === 'id');
    expect(idCol).toMatchObject({ name: 'id', primaryKey: true, notNull: true });

    expect(sessions!.columns.map((c) => c.name)).toContain('status');
    expect(sessions!.columns.map((c) => c.name)).toContain('started_at');
  });

  it('snapshot — tasks_lifecycle_pipelines table shape', () => {
    const { tables } = describeSchema();
    // gh#1107 / T12017: the runtime lifecycle drizzle symbols were rebound from
    // the dead bare `lifecycle_pipelines` table to the prefixed
    // `tasks_lifecycle_pipelines` table, so describeSchema now reports the
    // prefixed name.
    const lp = tables.find((t) => t.name === 'tasks_lifecycle_pipelines');
    expect(lp).toBeDefined();

    const idCol = lp!.columns.find((c) => c.name === 'id');
    expect(idCol).toMatchObject({ name: 'id', primaryKey: true, notNull: true });

    expect(lp!.columns.map((c) => c.name)).toContain('task_id');
    expect(lp!.columns.map((c) => c.name)).toContain('status');
  });

  it('all columns have non-empty name and type', () => {
    const { tables } = describeSchema();
    for (const table of tables) {
      for (const col of table.columns) {
        expect(col.name.length).toBeGreaterThan(0);
        expect(col.type.length).toBeGreaterThan(0);
      }
    }
  });

  it('registered tool identity matches', () => {
    expect(describeSchemaRegistered.identity.name).toBe('describe-schema');
    expect(describeSchemaRegistered.identity.version).toBe('1.0.0');
  });

  it('registered tool invoke returns same result as describeSchema()', () => {
    const direct = describeSchema();
    const viaRegistered = describeSchemaRegistered.invoke({});
    expect(viaRegistered).toEqual(direct);
  });
});
