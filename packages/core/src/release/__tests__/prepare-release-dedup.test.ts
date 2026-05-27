/**
 * Regression test for changelog duplication bug (T9094).
 *
 * prepareRelease() previously grabbed ALL done tasks when auto-preparing
 * (no explicit task list), causing each consecutive release to include tasks
 * completed before the prior pushed version. This test asserts that only
 * tasks completed AFTER the previous pushed version's pushedAt timestamp are
 * included.
 *
 * @task T9094
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedTasks } from '../../store/__tests__/test-db-helper.js';
import { getDb, resetDbState } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { releases } from '../../store/tasks-schema.js';
import { prepareRelease } from '../release-manifest.js';

let TEST_ROOT: string;

function writeConfig(): void {
  const cleoDir = join(TEST_ROOT, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  writeFileSync(
    join(cleoDir, 'config.json'),
    JSON.stringify({
      enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
      },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    }),
  );
}

beforeEach(async () => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-prepare-release-dedup-'));
  resetDbState();
  writeConfig();

  const accessor = await createSqliteDataAccessor(TEST_ROOT);
  await seedTasks(accessor, [
    {
      id: 'T100',
      title: 'Old task — before previous release',
      status: 'done',
      completedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'T200',
      title: 'New task — after previous release',
      status: 'done',
      completedAt: '2026-03-01T00:00:00.000Z',
    },
  ]);
  await accessor.close();
  resetDbState();

  // Seed a "pushed" release manifest whose pushedAt falls between T100 and T200.
  // pushedAt = 2026-02-01 means T100 (Jan) is OLD and T200 (Mar) is NEW.
  const db = await getDb(TEST_ROOT);
  await db
    .insert(releases)
    .values({
      id: 'rel-v2026-1-0',
      version: 'v2026.1.0',
      status: 'pushed',
      tasksJson: JSON.stringify(['T100']),
      createdAt: '2026-01-15T00:00:00.000Z',
      preparedAt: '2026-01-15T00:00:00.000Z',
      pushedAt: '2026-02-01T00:00:00.000Z',
    })
    .run();
  resetDbState();
});

afterEach(() => {
  resetDbState();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('prepareRelease() task deduplication (T9094)', () => {
  it('excludes tasks completed before the previous pushed version pushedAt', async () => {
    const loadTasksFn = async () => {
      const db = await getDb(TEST_ROOT);
      const rows = await db
        .select()
        .from((await import('../../store/tasks-schema.js')).tasks)
        .all();
      return rows.map((r) => ({
        id: r.id,
        title: r.title ?? '',
        status: r.status ?? 'pending',
        completedAt: r.completedAt ?? undefined,
        parentId: r.parentId ?? undefined,
      }));
    };

    const result = await prepareRelease('2026.3.1', undefined, undefined, loadTasksFn, TEST_ROOT);

    expect(result.tasks).toContain('T200');
    expect(result.tasks).not.toContain('T100');
    expect(result.taskCount).toBe(1);
  });

  it('includes all done tasks when no previous pushed version exists', async () => {
    // Insert a fresh DB without any pushed release
    const freshRoot = mkdtempSync(join(tmpdir(), 'cleo-prepare-release-fresh-'));
    try {
      resetDbState();
      const cleoDir = join(freshRoot, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(
        join(cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
        }),
      );
      const accessor = await createSqliteDataAccessor(freshRoot);
      await seedTasks(accessor, [
        {
          id: 'T300',
          title: 'First task',
          status: 'done',
          completedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'T400',
          title: 'Second task',
          status: 'done',
          completedAt: '2026-02-01T00:00:00.000Z',
        },
      ]);
      await accessor.close();
      resetDbState();

      const loadFn = async () => {
        const db = await getDb(freshRoot);
        const rows = await db
          .select()
          .from((await import('../../store/tasks-schema.js')).tasks)
          .all();
        return rows.map((r) => ({
          id: r.id,
          title: r.title ?? '',
          status: r.status ?? 'pending',
          completedAt: r.completedAt ?? undefined,
          parentId: r.parentId ?? undefined,
        }));
      };

      const result = await prepareRelease('2026.3.2', undefined, undefined, loadFn, freshRoot);

      expect(result.tasks).toContain('T300');
      expect(result.tasks).toContain('T400');
      expect(result.taskCount).toBe(2);
    } finally {
      resetDbState();
      rmSync(freshRoot, { recursive: true, force: true });
    }
  });
});
