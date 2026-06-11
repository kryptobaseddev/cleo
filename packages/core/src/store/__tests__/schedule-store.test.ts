/**
 * Tests for the cron/todo `schedules` table + Gate-3 accessor (T11962).
 *
 * Required proofs:
 *  1. **migration round-trip** — open a TEMP-DIR project `cleo.db` (real migrations
 *     applied), assert the `schedules` table and BOTH indexes
 *     (`ux_schedules_schedule_id`, `ix_schedules_enabled`) are present, and
 *     round-trip a row through {@link addSchedule} / {@link getSchedule}.
 *  2. **add / list / remove** — register two schedules, list them in creation
 *     order (bounded read — never `.all()`), then remove one and confirm it is gone.
 *  3. **unique handle** — the `schedule_id` minted per row is unique
 *     (`ux_schedules_schedule_id`), and removing an unknown handle reports `false`.
 *
 * The accessor opens via `openDualScopeDbAtPath` (the dual-scope chokepoint) and
 * extracts `$client` — it NEVER calls `new DatabaseSync` (Gate 3).
 *
 * @epic T11679
 * @task T11962
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { SCHEDULES_TABLE } from '../schedule-schema.js';
import { addSchedule, getSchedule, listSchedules, removeSchedule } from '../schedule-store.js';

/** The narrow native-handle shape the accessor consumes (re-derived for the test). */
type ScheduleNativeHandle = Parameters<typeof addSchedule>[0];

let testRoot: string;
let native: ScheduleNativeHandle;
let rawNative: DatabaseSync;

beforeEach(async () => {
  testRoot = join(tmpdir(), `schedule-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cleoDir = join(testRoot, 'project', '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const dbPath = join(cleoDir, 'cleo.db');
  // Real migrations applied (the t11962 migration creates `schedules` + indexes).
  const handle = await openDualScopeDbAtPath('project', dbPath);
  rawNative = (handle.db as unknown as { $client: DatabaseSync }).$client;
  native = rawNative as unknown as ScheduleNativeHandle;
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('schedules migration + Gate-3 accessor (T11962)', () => {
  it('migrates the table and both indexes', () => {
    const tbl = rawNative
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(SCHEDULES_TABLE) as { name: string } | undefined;
    expect(tbl?.name).toBe(SCHEDULES_TABLE);

    const indexes = rawNative
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`)
      .all(SCHEDULES_TABLE)
      .map((r) => String((r as { name: unknown }).name));
    expect(indexes).toContain('ux_schedules_schedule_id');
    expect(indexes).toContain('ix_schedules_enabled');
  });

  it('round-trips one schedule via add + get', () => {
    const id = addSchedule(native, {
      cronExpr: '0 9 * * 1',
      title: 'weekly report',
      description: 'compile the weekly report',
    });
    expect(id).toMatch(/^sched-[0-9a-f]{24}$/);

    const row = getSchedule(native, id);
    expect(row).not.toBeNull();
    expect(row?.cronExpr).toBe('0 9 * * 1');
    expect(row?.title).toBe('weekly report');
    expect(row?.description).toBe('compile the weekly report');
    expect(row?.enabled).toBe(true);
    expect(typeof row?.createdAt).toBe('string');
  });

  it('lists schedules in creation order (bounded read)', () => {
    const first = addSchedule(native, { cronExpr: '0 9 * * 1', title: 'a' });
    const second = addSchedule(native, { cronExpr: '0 10 * * 2', title: 'b' });

    const all = listSchedules(native);
    expect(all.map((s) => s.scheduleId)).toEqual([first, second]);
    expect(all[1]?.description).toBeNull();
  });

  it('removes a schedule and reports false for an unknown handle', () => {
    const id = addSchedule(native, { cronExpr: '0 9 * * 1', title: 'gone soon' });
    expect(removeSchedule(native, id)).toBe(true);
    expect(getSchedule(native, id)).toBeNull();
    expect(listSchedules(native)).toHaveLength(0);
    // Removing an unknown handle is a no-op that reports false.
    expect(removeSchedule(native, 'sched-000000000000000000000000')).toBe(false);
  });

  it('mints a unique handle per schedule', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      ids.add(addSchedule(native, { cronExpr: '0 9 * * 1', title: `t${i}` }));
    }
    expect(ids.size).toBe(25);
    expect(listSchedules(native)).toHaveLength(25);
  });
});
