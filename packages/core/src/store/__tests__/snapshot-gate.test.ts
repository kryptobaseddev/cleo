/**
 * Unit tests for the project-wide snapshot gate and time-spread retention.
 *
 * Covers, in-process:
 * - a burst of N requests within the debounce window produces one snapshot;
 * - concurrent requests in one process never overlap and produce one snapshot;
 * - the debounce is read from the persisted `schema_meta` row, not memory;
 * - no state store means no snapshot (fail closed);
 * - retention keeps latest / hourly / daily slots, so a burst cannot evict
 *   older recovery history.
 *
 * The cross-process lock is proven in `snapshot-gate-multiprocess.test.ts`.
 *
 * @task T12508
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runGatedSnapshot,
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_GATE_META_KEY,
  selectSnapshotsToKeep,
} from '../snapshot-gate.js';

let workDir: string;
let stateDb: DatabaseSync;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cleo-t12508-gate-'));
  stateDb = new DatabaseSync(join(workDir, 'state.db'));
  stateDb.exec('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
});

afterEach(() => {
  stateDb.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('runGatedSnapshot — debounce (T12508)', () => {
  it('a burst of N sequential requests within the window produces one snapshot', async () => {
    const runs: string[] = [];
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 8; i++) {
      await runGatedSnapshot(
        { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => t0 + i * 1_000 },
        async (p) => {
          runs.push(p);
        },
      );
    }
    expect(runs).toEqual(['tasks']);
  });

  it('a concurrent burst in one process runs exactly one snapshot, never overlapping', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          runs += 1;
          await new Promise((r) => setTimeout(r, 50));
          active -= 1;
        }),
      ),
    );
    expect(runs).toBe(1);
    expect(maxActive).toBe(1);
    expect(results.filter((r) => r.snapshotted.length > 0)).toHaveLength(1);
    for (const r of results.filter((x) => x.snapshotted.length === 0)) {
      expect(['in-flight', 'debounced']).toContain(r.skipped);
    }
  });

  it('admits the next snapshot once the window has elapsed', async () => {
    const runs: number[] = [];
    const t0 = 1_800_000_000_000;
    for (const t of [t0, t0 + SNAPSHOT_DEBOUNCE_MS - 1, t0 + SNAPSHOT_DEBOUNCE_MS]) {
      await runGatedSnapshot(
        { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => t },
        async () => {
          runs.push(t);
        },
      );
    }
    expect(runs).toEqual([t0, t0 + SNAPSHOT_DEBOUNCE_MS]);
  });

  it('reads the debounce from the persisted row, so a fresh handle is still debounced', async () => {
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, async () => {});

    const row = stateDb
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(SNAPSHOT_GATE_META_KEY) as { value: string } | undefined;
    expect(row).toBeDefined();
    const persisted: Record<string, { startedAt: number; completedAt: number | null }> = JSON.parse(
      row?.value ?? '{}',
    );
    expect(typeof persisted['tasks']?.startedAt).toBe('number');
    expect(typeof persisted['tasks']?.completedAt).toBe('number');

    // A second connection has no in-memory history — only the DB row.
    const other = new DatabaseSync(join(workDir, 'state.db'));
    let ran = false;
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb: other, prefixes: ['tasks'] },
      async () => {
        ran = true;
      },
    );
    other.close();
    expect(ran).toBe(false);
    expect(r.skipped).toBe('debounced');
  });

  it('debounces each prefix independently', async () => {
    const runs: string[] = [];
    const snap = async (p: string): Promise<void> => {
      runs.push(p);
    };
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, snap);
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks', 'brain'] }, snap);
    expect(runs).toEqual(['tasks', 'brain']);
  });

  it('a start time in the future (clock moved back) does not block', async () => {
    stateDb
      .prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
      .run(
        SNAPSHOT_GATE_META_KEY,
        JSON.stringify({ tasks: { startedAt: Date.now() + 3_600_000, completedAt: null } }),
      );
    let ran = false;
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it('fails closed when there is no state store', async () => {
    let ran = false;
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb: null, prefixes: ['tasks'] },
      async () => {
        ran = true;
      },
    );
    expect(ran).toBe(false);
    expect(r.skipped).toBe('state-unavailable');
  });

  it('a failed snapshot still debounces, so a failing snapshot cannot storm', async () => {
    let attempts = 0;
    const fail = async (): Promise<void> => {
      attempts += 1;
      throw new Error('disk full');
    };
    const first = await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'] },
      fail,
    );
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, fail);
    expect(attempts).toBe(1);
    expect(first.snapshotted).toEqual([]);
    expect(first.skipped).toBeNull();
  });
});

describe('selectSnapshotsToKeep — time-spread retention (T12508)', () => {
  /** Build `tasks-YYYYMMDD-HHmmss.db` names. */
  const name = (day: string, hms: string): string => `tasks-${day}-${hms}.db`;

  it('keeps at most latest + hourly + daily files', () => {
    const names: string[] = [];
    for (let d = 1; d <= 20; d++) {
      for (let h = 0; h < 24; h += 3) {
        names.push(
          name(`202609${String(d).padStart(2, '0')}`, `${String(h).padStart(2, '0')}0000`),
        );
      }
    }
    const keep = selectSnapshotsToKeep(names, { latest: 2, hourly: 4, daily: 4 });
    expect(keep.size).toBeLessThanOrEqual(10);
    // Four distinct days are represented.
    expect(new Set([...keep].map((n) => n.slice(6, 14))).size).toBe(4);
  });

  it('a burst within one hour cannot evict older hourly and daily history', () => {
    const history = [
      name('20260920', '090000'),
      name('20260924', '090000'),
      name('20260926', '090000'),
      name('20260927', '100000'),
      name('20260927', '120000'),
      name('20260927', '140000'),
    ];
    // Twelve snapshots in ten seconds (the observed storm shape, times three).
    const burst = Array.from({ length: 12 }, (_, i) =>
      name('20260927', `1506${String(i * 5).padStart(2, '0')}`),
    );
    const keep = selectSnapshotsToKeep([...history, ...burst]);

    // The burst occupies the two "latest" slots and ONE hourly bucket.
    const keptBurst = burst.filter((n) => keep.has(n));
    expect(keptBurst).toEqual([burst[10], burst[11]]);
    // Older recovery points survive: three prior hours today, and prior days.
    expect(keep.has(name('20260927', '140000'))).toBe(true);
    expect(keep.has(name('20260927', '120000'))).toBe(true);
    expect(keep.has(name('20260927', '100000'))).toBe(true);
    expect(keep.has(name('20260926', '090000'))).toBe(true);
    expect(keep.has(name('20260924', '090000'))).toBe(true);
    expect(keep.has(name('20260920', '090000'))).toBe(true);

    // Under the former newest-10 rule the burst alone would fill every slot.
    const newestTen = [...history, ...burst].sort().slice(-10);
    expect(newestTen.every((n) => burst.includes(n))).toBe(true);
  });

  it('keeps old history when nothing new is taken (buckets are non-empty ones, not clock hours)', () => {
    const names = [name('20250101', '010000'), name('20250102', '010000')];
    expect(selectSnapshotsToKeep(names)).toEqual(new Set(names));
  });

  it('never deletes a file it cannot place', () => {
    const keep = selectSnapshotsToKeep(['tasks-unstamped.db', name('20260927', '010000')]);
    expect(keep.has('tasks-unstamped.db')).toBe(true);
  });
});
