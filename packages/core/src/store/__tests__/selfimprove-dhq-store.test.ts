/**
 * Tests for the self-improvement DHQ table + Gate-3 accessor (T11889-A · T11911).
 *
 * Required proofs (AC4):
 *  1. **migration round-trip** — open a TEMP-DIR project `cleo.db` (real migrations
 *     applied), assert the `selfimprove_dhq` table and all THREE indexes
 *     (`ix_selfimprove_dhq_status`, `ix_selfimprove_dhq_scenario`,
 *     `ux_selfimprove_dhq_open`) are present, and round-trip one row.
 *  2. **partial-unique-open enforcement** — two `status='open'` rows for the SAME
 *     `question_hash` are rejected (the second raw INSERT throws); a SECOND row for
 *     the same hash with a NON-open status IS allowed (the partial index only keys
 *     on `WHERE status='open'`); and the adapter UPSERT path refreshes the single
 *     open row instead of inserting a duplicate.
 *  3. **bootstrap assertion** — `assertSelfimproveDhqOpenIndexPresent` returns when
 *     the index exists and THROWS `E_SELFIMPROVE_DHQ_INDEX_MISSING` once it is
 *     dropped (proving the migration is the sole enforcer of the invariant).
 *
 * The accessor opens via `openDualScopeDbAtPath` (the dual-scope chokepoint) and
 * extracts `$client` — it NEVER calls `new DatabaseSync` (Gate 3).
 *
 * @epic T11889
 * @task T11889
 * @task T11911
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import {
  assertSelfimproveDhqOpenIndexPresent,
  SELFIMPROVE_DHQ_OPEN_INDEX,
  SELFIMPROVE_DHQ_TABLE,
} from '../selfimprove-dhq-schema.js';
import {
  readOpenSelfimproveDhq,
  readSelfimproveDhqByScenario,
  setSelfimproveDhqPrUrl,
  updateSelfimproveDhqStatus,
  upsertOpenSelfimproveDhq,
} from '../selfimprove-dhq-store.js';

let testRoot: string;
let native: DatabaseSync;

beforeEach(async () => {
  testRoot = join(tmpdir(), `selfimprove-dhq-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const cleoDir = join(testRoot, 'project', '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const dbPath = join(cleoDir, 'cleo.db');
  // Real migrations applied (the t11889 migration creates selfimprove_dhq + indexes).
  const handle = await openDualScopeDbAtPath('project', dbPath);
  native = (handle.db as unknown as { $client: DatabaseSync }).$client;
});

afterEach(() => {
  _resetDualScopeDbCache();
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Count rows in `selfimprove_dhq`. */
function rowCount(): number {
  const row = native.prepare(`SELECT COUNT(*) AS n FROM ${SELFIMPROVE_DHQ_TABLE}`).get() as {
    n: number;
  };
  return Number(row.n);
}

describe('selfimprove_dhq migration + Gate-3 accessor (T11911)', () => {
  it('migrates the table and all three indexes (round-trip)', () => {
    const tbl = native
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(SELFIMPROVE_DHQ_TABLE) as { name: string } | undefined;
    expect(tbl?.name).toBe(SELFIMPROVE_DHQ_TABLE);

    const indexes = native
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name`)
      .all(SELFIMPROVE_DHQ_TABLE)
      .map((r) => String((r as { name: unknown }).name));
    expect(indexes).toContain('ix_selfimprove_dhq_status');
    expect(indexes).toContain('ix_selfimprove_dhq_scenario');
    expect(indexes).toContain(SELFIMPROVE_DHQ_OPEN_INDEX);

    // Insert/select round-trip via the accessor.
    upsertOpenSelfimproveDhq(native, {
      dhqId: 'DHQ-101',
      scenario: 'dhq-replay-find',
      questionHash: 'hash-a',
      title: 'find drift',
      regressionJson: '{"regressions":[{"path":"/data/total"}]}',
      severity: 'P1',
      runId: 'run-1',
      now: 1000,
    });

    const open = readOpenSelfimproveDhq(native, 'hash-a');
    expect(open).not.toBeNull();
    expect(open?.dhqId).toBe('DHQ-101');
    expect(open?.scenario).toBe('dhq-replay-find');
    expect(open?.status).toBe('open');
    expect(open?.severity).toBe('P1');
    expect(open?.prUrl).toBeNull();
    expect(open?.runId).toBe('run-1');
    expect(open?.createdAt).toBe(1000);

    const byScenario = readSelfimproveDhqByScenario(native, 'dhq-replay-find');
    expect(byScenario).toHaveLength(1);
    expect(byScenario[0]?.questionHash).toBe('hash-a');
  });

  it('rejects a second open row for the same question_hash (raw INSERT)', () => {
    const rawInsert = (hash: string, status: string): void => {
      native
        .prepare(
          `INSERT INTO ${SELFIMPROVE_DHQ_TABLE} ` +
            `(dhq_id, scenario, question_hash, title, regression_json, status, severity, ` +
            `pr_url, run_id, created_at, updated_at) ` +
            `VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run('DHQ-1', 'scen', hash, 't', '{}', status, 'run', 1, 1);
    };

    rawInsert('dup-hash', 'open');
    // Second OPEN row for the same hash violates the partial-UNIQUE index.
    expect(() => rawInsert('dup-hash', 'open')).toThrow(/UNIQUE|constraint/i);
    expect(rowCount()).toBe(1);

    // A second row for the SAME hash with a NON-open status IS allowed — the partial
    // index only keys on `WHERE status = 'open'`.
    expect(() => rawInsert('dup-hash', 'fixed')).not.toThrow();
    expect(rowCount()).toBe(2);
  });

  it('UPSERT refreshes the single open row instead of inserting a duplicate', () => {
    upsertOpenSelfimproveDhq(native, {
      dhqId: 'DHQ-201',
      scenario: 'scen',
      questionHash: 'idem',
      title: 'first',
      regressionJson: '{"v":1}',
      severity: null,
      runId: 'run-a',
      now: 100,
    });
    upsertOpenSelfimproveDhq(native, {
      dhqId: 'DHQ-999-IGNORED',
      scenario: 'scen',
      questionHash: 'idem',
      title: 'second-ignored',
      regressionJson: '{"v":2}',
      severity: 'P2',
      runId: 'run-b',
      now: 200,
    });

    expect(rowCount()).toBe(1);
    const open = readOpenSelfimproveDhq(native, 'idem');
    expect(open?.dhqId).toBe('DHQ-201'); // first insert wins identity
    expect(open?.regressionJson).toBe('{"v":2}'); // refreshed
    expect(open?.severity).toBe('P2'); // refreshed
    expect(open?.runId).toBe('run-b'); // refreshed
    expect(open?.updatedAt).toBe(200); // refreshed

    // Terminal transition frees the slot; a new regression of the same hash opens a
    // fresh row.
    const changed = updateSelfimproveDhqStatus(native, 'idem', 'fixed', 300);
    expect(changed).toBe(1);
    expect(readOpenSelfimproveDhq(native, 'idem')).toBeNull();

    upsertOpenSelfimproveDhq(native, {
      dhqId: 'DHQ-202',
      scenario: 'scen',
      questionHash: 'idem',
      title: 'reopened',
      regressionJson: '{"v":3}',
      severity: null,
      runId: 'run-c',
      now: 400,
    });
    expect(rowCount()).toBe(2);
    expect(readOpenSelfimproveDhq(native, 'idem')?.dhqId).toBe('DHQ-202');
  });

  it('records the draft PR URL on the open row', () => {
    upsertOpenSelfimproveDhq(native, {
      dhqId: 'DHQ-301',
      scenario: 'scen',
      questionHash: 'pr-hash',
      title: 'pr',
      regressionJson: '{}',
      severity: null,
      runId: 'run-1',
      now: 100,
    });
    const changed = setSelfimproveDhqPrUrl(native, 'pr-hash', 'https://github.com/o/r/pull/1', 150);
    expect(changed).toBe(1);
    expect(readOpenSelfimproveDhq(native, 'pr-hash')?.prUrl).toBe('https://github.com/o/r/pull/1');
  });

  it('assertSelfimproveDhqOpenIndexPresent passes when present, throws when dropped', () => {
    expect(() => assertSelfimproveDhqOpenIndexPresent(native)).not.toThrow();

    native.prepare(`DROP INDEX ${SELFIMPROVE_DHQ_OPEN_INDEX}`).run();
    expect(() => assertSelfimproveDhqOpenIndexPresent(native)).toThrow(
      /E_SELFIMPROVE_DHQ_INDEX_MISSING/,
    );
  });
});
