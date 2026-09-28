/**
 * Unit tests for the project-wide snapshot gate and time-spread retention.
 *
 * Covers, in-process:
 * - `routine`: a burst of N requests within the debounce window produces one
 *   snapshot; the debounce is read from the persisted `schema_meta` row;
 *   no state store means no snapshot; a held lock means skip.
 * - `required` (session end, pre-destructive): not debounced by a routine
 *   snapshot; unaffected by a failed earlier attempt; works without the state
 *   row; waits for the lock and reports `lock-timeout` instead of skipping;
 *   N queued requests are covered by one snapshot.
 * - failed or empty attempts never consume the window.
 * - retention keeps latest / quarter-hour / hourly / daily slots, pins the
 *   file just written, ignores future and impossible stamps, and handles the
 *   DST fall-back hour.
 *
 * The cross-process lock is proven in `snapshot-gate-multiprocess.test.ts`.
 *
 * @task T12508
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeSnapshotMiss,
  readSnapshotGeneration,
  runGatedSnapshot,
  SNAPSHOT_DEBOUNCE_MS,
  SNAPSHOT_GATE_META_KEY,
  type SnapshotOutcome,
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

/** A snapshot function that records each call and writes successfully. */
function recorder(): { runs: string[]; snap: (p: string) => Promise<SnapshotOutcome> } {
  const runs: string[] = [];
  return {
    runs,
    snap: async (p) => {
      runs.push(p);
      return 'written';
    },
  };
}

const T0 = 1_800_000_000_000;

describe('runGatedSnapshot — routine mode (T12508)', () => {
  it('a burst of N sequential requests within the window produces one snapshot', async () => {
    const { runs, snap } = recorder();
    for (let i = 0; i < 8; i++) {
      await runGatedSnapshot(
        { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => T0 + i * 1_000 },
        snap,
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
          return 'written' as const;
        }),
      ),
    );
    expect(runs).toBe(1);
    expect(maxActive).toBe(1);
    for (const r of results.filter((x) => x.snapshotted.length === 0)) {
      expect(['in-flight', 'debounced']).toContain(r.skipped);
    }
  });

  it('admits the next snapshot once the window has elapsed', async () => {
    const runs: number[] = [];
    for (const t of [T0, T0 + SNAPSHOT_DEBOUNCE_MS - 1, T0 + SNAPSHOT_DEBOUNCE_MS]) {
      await runGatedSnapshot(
        { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => t },
        async () => {
          runs.push(t);
          return 'written' as const;
        },
      );
    }
    expect(runs).toEqual([T0, T0 + SNAPSHOT_DEBOUNCE_MS]);
  });

  it('reads the debounce from the persisted row, so a fresh handle is still debounced', async () => {
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, recorder().snap);

    const row = stateDb
      .prepare('SELECT value FROM schema_meta WHERE key = ?')
      .get(SNAPSHOT_GATE_META_KEY) as { value: string } | undefined;
    const persisted: {
      generation: number;
      prefixes: Record<string, { generation: number; startedAt: number; completedAt: number }>;
    } = JSON.parse(row?.value ?? '{}');
    expect(persisted.generation).toBe(1);
    expect(persisted.prefixes['tasks']?.generation).toBe(1);
    expect(typeof persisted.prefixes['tasks']?.completedAt).toBe('number');

    // A second connection has no in-memory history — only the DB row.
    const other = new DatabaseSync(join(workDir, 'state.db'));
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb: other, prefixes: ['tasks'] },
      snap,
    );
    other.close();
    expect(runs).toEqual([]);
    expect(r.skipped).toBe('debounced');
  });

  it('debounces each prefix independently', async () => {
    const { runs, snap } = recorder();
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, snap);
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks', 'brain'] }, snap);
    expect(runs).toEqual(['tasks', 'brain']);
  });

  it('a start time in the future (clock moved back) does not block', async () => {
    const future = Date.now() + 3_600_000;
    stateDb.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      SNAPSHOT_GATE_META_KEY,
      JSON.stringify({
        generation: 1,
        prefixes: { tasks: { generation: 1, startedAt: future, completedAt: future } },
      }),
    );
    const { runs, snap } = recorder();
    await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, snap);
    expect(runs).toEqual(['tasks']);
  });

  it('fails closed when there is no state store', async () => {
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb: null, prefixes: ['tasks'] },
      snap,
    );
    expect(runs).toEqual([]);
    expect(r.skipped).toBe('state-unavailable');
  });

  it('skips as in-flight when the lock is held', async () => {
    mkdirSync(join(workDir, '.snapshot-gate.lock'));
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot({ backupDir: workDir, stateDb, prefixes: ['tasks'] }, snap);
    expect(runs).toEqual([]);
    expect(r.skipped).toBe('in-flight');
  });
});

describe('runGatedSnapshot — failed attempts never consume the window (T12508)', () => {
  it('a thrown snapshot is reported as failed and the next routine request runs', async () => {
    let attempts = 0;
    const first = await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => T0 },
      async () => {
        attempts += 1;
        throw new Error('disk full');
      },
    );
    expect(first).toMatchObject({ snapshotted: [], failed: ['tasks'], skipped: null });

    const { runs, snap } = recorder();
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => T0 + 1_000 },
      snap,
    );
    expect(attempts).toBe(1);
    expect(runs).toEqual(['tasks']);
  });

  it('an absent database is reported absent — not snapshotted, not failed (LOW-6, NEW-2)', async () => {
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks', 'llmtxt'], now: () => T0 },
      async (p) => (p === 'llmtxt' ? 'absent' : 'written'),
    );
    expect(r).toEqual({ snapshotted: ['tasks'], absent: ['llmtxt'], failed: [], skipped: null });
  });

  it('an absent prefix satisfies admission: later routine calls never take the lock for it (NEW-2)', async () => {
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks', 'llmtxt'], now: () => T0 },
      async (p) => (p === 'llmtxt' ? 'absent' : 'written'),
    );
    // Hold the lock: a caller that still wanted `llmtxt` would report
    // in-flight; a satisfied one returns from the lock-free fast path.
    mkdirSync(join(workDir, '.snapshot-gate.lock'));
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks', 'llmtxt'], now: () => T0 + 1_000 },
      snap,
    );
    expect(r.skipped).toBe('debounced');
    expect(runs).toEqual([]);
  });
});

describe('runGatedSnapshot — required mode (T12508)', () => {
  it('is not debounced by a routine snapshot taken 60 s earlier (HIGH-1)', async () => {
    const { runs, snap } = recorder();
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => T0 },
      snap,
    );
    const r = await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        now: () => T0 + 60_000,
      },
      snap,
    );
    expect(r.snapshotted).toEqual(['tasks']);
    expect(runs).toEqual(['tasks', 'tasks']);
  });

  it('runs after a failed routine attempt (HIGH-1)', async () => {
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], now: () => T0 },
      async () => {
        throw new Error('boom');
      },
    );
    const { runs, snap } = recorder();
    await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        now: () => T0 + 60_000,
      },
      snap,
    );
    expect(runs).toEqual(['tasks']);
  });

  it('works without schema_meta (HIGH-1)', async () => {
    const bare = new DatabaseSync(':memory:');
    const { runs, snap } = recorder();
    const r1 = await runGatedSnapshot(
      { backupDir: workDir, stateDb: bare, prefixes: ['tasks'], mode: 'required' },
      snap,
    );
    const r2 = await runGatedSnapshot(
      { backupDir: workDir, stateDb: null, prefixes: ['tasks'], mode: 'required' },
      snap,
    );
    bare.close();
    expect(r1.snapshotted).toEqual(['tasks']);
    expect(r2.snapshotted).toEqual(['tasks']);
    expect(runs).toEqual(['tasks', 'tasks']);
  });

  it('waits for a held lock and reports lock-timeout, not a silent skip (HIGH-1)', async () => {
    mkdirSync(join(workDir, '.snapshot-gate.lock'));
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        lockWaitRetries: 2,
      },
      snap,
    );
    expect(runs).toEqual([]);
    expect(r.skipped).toBe('lock-timeout');
    expect(r.error).toContain('.snapshot-gate.lock');
  });

  it('proceeds once a held lock is released within the wait', async () => {
    const lockDir = join(workDir, '.snapshot-gate.lock');
    mkdirSync(lockDir);
    setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 150);
    const { runs, snap } = recorder();
    const r = await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], mode: 'required' },
      snap,
    );
    expect(r.snapshotted).toEqual(['tasks']);
    expect(runs).toEqual(['tasks']);
  });

  it('coverage is by generation, not wall clock: a frozen clock cannot fake it (NEW-5)', async () => {
    const frozen = (): number => T0; // every call in the same millisecond
    const { runs, snap } = recorder();
    // Request A is made before any snapshot: it saw generation 0.
    const seenByA = readSnapshotGeneration(stateDb) ?? 0;
    expect(seenByA).toBe(0);
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], mode: 'required', now: frozen },
      snap,
    );
    // Request B is made after that snapshot (same millisecond): it sees 1.
    const seenByB = readSnapshotGeneration(stateDb) ?? 0;
    expect(seenByB).toBe(1);

    const a = await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        seenGeneration: seenByA,
        now: frozen,
      },
      snap,
    );
    const b = await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        seenGeneration: seenByB,
        now: frozen,
      },
      snap,
    );
    expect(a.skipped).toBe('covered');
    expect(b.snapshotted).toEqual(['tasks']);
    expect(runs).toEqual(['tasks', 'tasks']);
  });

  it('a request made while a snapshot is in flight is not covered by it', async () => {
    let seenMidFlight = -1;
    const { runs, snap } = recorder();
    await runGatedSnapshot(
      { backupDir: workDir, stateDb, prefixes: ['tasks'], mode: 'required' },
      async (p) => {
        // The run claimed its generation before snapshotting.
        seenMidFlight = readSnapshotGeneration(stateDb) ?? -1;
        return snap(p);
      },
    );
    expect(seenMidFlight).toBe(1);
    const r = await runGatedSnapshot(
      {
        backupDir: workDir,
        stateDb,
        prefixes: ['tasks'],
        mode: 'required',
        seenGeneration: seenMidFlight,
      },
      snap,
    );
    expect(r.snapshotted).toEqual(['tasks']);
    expect(runs).toEqual(['tasks', 'tasks']);
  });

  it('N concurrent requests made before the first snapshot starts produce one snapshot', async () => {
    let runs = 0;
    let active = 0;
    let maxActive = 0;
    const seenGeneration = readSnapshotGeneration(stateDb) ?? 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        runGatedSnapshot(
          { backupDir: workDir, stateDb, prefixes: ['tasks'], mode: 'required', seenGeneration },
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            runs += 1;
            await new Promise((r) => setTimeout(r, 50));
            active -= 1;
            return 'written' as const;
          },
        ),
      ),
    );
    expect(runs).toBe(1);
    expect(maxActive).toBe(1);
    expect(results.filter((r) => r.skipped === 'covered')).toHaveLength(5);
  });
});

describe('describeSnapshotMiss (T12508)', () => {
  it('is null for written, covered and all-absent outcomes', () => {
    expect(
      describeSnapshotMiss({ snapshotted: ['tasks'], absent: [], failed: [], skipped: null }),
    ).toBeNull();
    expect(
      describeSnapshotMiss({ snapshotted: [], absent: [], failed: [], skipped: 'covered' }),
    ).toBeNull();
    expect(
      describeSnapshotMiss({ snapshotted: [], absent: ['llmtxt'], failed: [], skipped: null }),
    ).toBeNull();
  });

  it('explains a lock timeout, a failure, and an unresolved backup dir', () => {
    expect(
      describeSnapshotMiss({
        snapshotted: [],
        absent: [],
        failed: [],
        skipped: 'lock-timeout',
        error: 'lock held',
      }),
    ).toBe('lock held');
    expect(
      describeSnapshotMiss({ snapshotted: [], absent: [], failed: ['tasks'], skipped: null }),
    ).toContain('tasks');
    expect(describeSnapshotMiss(null)).toContain('backup directory');
  });
});

describe('selectSnapshotsToKeep — time-spread retention (T12508)', () => {
  /** Build `tasks-YYYYMMDD-HHmmss.db` names. */
  const name = (day: string, hms: string): string => `tasks-${day}-${hms}.db`;

  it('keeps at most latest + quarterHourly + hourly + daily files', () => {
    const names: string[] = [];
    for (let d = 1; d <= 20; d++) {
      for (let h = 0; h < 24; h++) {
        for (const m of ['00', '20', '40']) {
          names.push(
            name(`202609${String(d).padStart(2, '0')}`, `${String(h).padStart(2, '0')}${m}00`),
          );
        }
      }
    }
    const keep = selectSnapshotsToKeep(names);
    expect(keep.size).toBeLessThanOrEqual(10);
    expect(new Set([...keep].map((n) => n.slice(6, 14))).size).toBe(3);
  });

  it('quarter-hour slots keep an active hour from collapsing to one file (LOW-5)', () => {
    const names = ['00', '15', '30', '45'].map((m) => name('20260927', `14${m}00`));
    const keep = selectSnapshotsToKeep(names);
    // latest (14:45) + two more quarter-hour buckets (14:30, 14:15).
    expect(keep).toEqual(new Set([names[3], names[2], names[1]]));
  });

  it('a burst cannot evict history: the kept history is the same as for one snapshot', () => {
    const history = [
      name('20260920', '090000'),
      name('20260924', '090000'),
      name('20260926', '090000'),
      name('20260927', '100000'),
      name('20260927', '120000'),
      name('20260927', '140000'),
    ];
    // Twelve snapshots in one minute (the observed storm shape, times three).
    const burst = Array.from({ length: 12 }, (_, i) =>
      name('20260927', `1506${String(i * 5).padStart(2, '0')}`),
    );
    const last = burst[11] ?? '';
    const withBurst = selectSnapshotsToKeep([...history, ...burst], { pinned: last });
    const withOne = selectSnapshotsToKeep([...history, last], { pinned: last });

    expect(history.filter((n) => withBurst.has(n))).toEqual(history.filter((n) => withOne.has(n)));
    expect(burst.filter((n) => withBurst.has(n))).toEqual([last]);

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

  it('always keeps the pinned file, even when it wins no slot', () => {
    const older = name('20260101', '000000');
    const names = [
      older,
      name('20260102', '000000'),
      name('20260103', '000000'),
      name('20260104', '000000'),
    ];
    const keep = selectSnapshotsToKeep(names, {
      policy: { latest: 0, quarterHourly: 0, hourly: 0, daily: 1 },
      pinned: older,
    });
    expect(keep.has(older)).toBe(true);
  });

  it('future-dated stamps win no slot and cannot push out the real snapshot (MEDIUM-4)', () => {
    const future = ['01', '02', '03', '04', '05'].map((d) => name(`202701${d}`, '120000'));
    const real = name('20260927', '150000');
    const history = [name('20260926', '090000'), name('20260925', '090000')];
    const names = [...future, real, ...history];
    const nowStamp = '20260927-150001';

    // Pinned or not, the real snapshot and the history survive.
    const unpinned = selectSnapshotsToKeep(names, { nowStamp });
    expect(unpinned.has(real)).toBe(true);
    expect(history.every((n) => unpinned.has(n))).toBe(true);
    // Future files are kept (never deleted), but only because they are unslotted.
    expect(future.every((n) => unpinned.has(n))).toBe(true);

    const pinned = selectSnapshotsToKeep(names, { nowStamp, pinned: real });
    expect(pinned.has(real)).toBe(true);
  });

  it('an impossible stamp is unslotted and kept (MEDIUM-4)', () => {
    const bogus = 'tasks-99999999-999999.db';
    const real = name('20260927', '150000');
    const keep = selectSnapshotsToKeep([bogus, real], {
      policy: { latest: 1, quarterHourly: 0, hourly: 0, daily: 0 },
      nowStamp: '20260927-150001',
    });
    expect(keep).toEqual(new Set([bogus, real]));
  });

  it('DST fall-back: 01:30 PDT then 01:10 PST — both kept, the repeated hour costs one hourly slot (MEDIUM-4)', () => {
    const pdt = name('20261101', '013000'); // written first
    const pst = name('20261101', '011000'); // written 40 minutes later
    const names = [
      pdt,
      pst,
      name('20261031', '220000'),
      name('20261031', '200000'),
      name('20261031', '180000'),
    ];
    const keep = selectSnapshotsToKeep(names, { pinned: pst, nowStamp: '20261101-011001' });
    expect(keep.has(pst)).toBe(true);
    // During the repeated hour the PDT file's stamp is later than the clock,
    // so it is unslotted and kept — the fall-back never deletes it.
    expect(keep.has(pdt)).toBe(true);
    // The repeated hour consumes ONE hourly slot, so 20:00 still has one.
    expect(keep.has(name('20261031', '220000'))).toBe(true);
    expect(keep.has(name('20261031', '200000'))).toBe(true);
    expect(keep.has(name('20261031', '180000'))).toBe(false);
  });
});
