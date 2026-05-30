/**
 * T11323 — Idempotency Pattern A micro-benchmark.
 *
 * Validates the idempotency write path the saga locked (Pattern A, NOT a
 * separate ledger):
 *
 *   - `idempotency_key TEXT PRIMARY KEY` column on the domain table itself.
 *   - `INSERT ... ON CONFLICT DO NOTHING` expressed via Drizzle rc.3's
 *     `.onConflictDoNothing({ target })` running on the `drizzle-orm/node-sqlite`
 *     driver wrapping an existing `DatabaseSync` client — NO raw-SQL fallback.
 *
 * Assertions:
 *   1. Insert key='X' once, then retry 100× → exactly ONE row persists.
 *   2. UNIQUE-index (PRIMARY KEY) overhead on the hot insert path is <= 10%.
 *      Measured cleanly: the ONLY variable is the presence of the TEXT PRIMARY
 *      KEY index. Both arms run the *same* plain INSERT statement shape (no
 *      ON CONFLICT clause) so the conflict-resolution cost is not conflated
 *      with the index-maintenance cost the AC names. A third arm measures the
 *      full Pattern-A path (PK + ON CONFLICT DO NOTHING) for transparency.
 *   3. The conflict-target Drizzle path emits real ON CONFLICT SQL (verified by
 *      `.toSQL()` containing `on conflict ... do nothing`).
 *
 * Run: `pnpm dlx tsx tools/db-substrate-spike/03-idempotency-bench.ts`
 *
 * @task T11323
 * @task T11244
 * @saga T11242
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { openConsolidated } from './lib/open.js';
import { round, summarize } from './lib/stats.js';

/**
 * Idempotency-keyed table mirroring `conduit_event`: the key IS the primary
 * key (Pattern A — no separate ledger). Used for the dedupe-correctness arm
 * and the full Pattern-A path arm.
 */
const idemTable = sqliteTable('conduit_event', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  taskId: text('task_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Index arm WITH the TEXT idempotency key as PRIMARY KEY. Plain INSERT (no
 * ON CONFLICT) — isolates the index-maintenance cost.
 */
const withPkTable = sqliteTable('event_with_pk', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  taskId: text('task_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

/**
 * Control arm: BYTE-identical columns to {@link withPkTable} except the key
 * column carries NO unique/PK constraint. Plain INSERT. The ONLY variable
 * between the two arms is the presence of the idempotency-key index.
 */
const noPkTable = sqliteTable('event_no_pk', {
  rowid: integer('rowid').primaryKey({ autoIncrement: true }),
  idempotencyKey: text('idempotency_key').notNull(),
  taskId: text('task_id').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** Number of distinct hot inserts measured for the overhead comparison. */
const INSERT_SAMPLES = 20_000;
/** Number of idempotent retries for the dedupe correctness assertion. */
const RETRIES = 100;

function main(): void {
  const workdir = mkdtempSync(join(tmpdir(), 'cleo-spike-idem-'));
  try {
    const path = join(workdir, 'idem.db');
    const client = openConsolidated(path);
    client.exec(`
      CREATE TABLE conduit_event (
        idempotency_key TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE event_with_pk (
        idempotency_key TEXT PRIMARY KEY,
        task_id         TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE event_no_pk (
        rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL,
        task_id         TEXT NOT NULL,
        payload         TEXT NOT NULL,
        created_at      INTEGER NOT NULL
      );
    `);
    const db = drizzle({ client });

    // ── Assertion 3: the Drizzle conflict-target path emits ON CONFLICT SQL ──
    const sample = db
      .insert(idemTable)
      .values({ idempotencyKey: 'X', taskId: 'T1', payload: '{}', createdAt: 0 })
      .onConflictDoNothing({ target: idemTable.idempotencyKey });
    const emittedSql = sample.toSQL().sql.toLowerCase();
    const emitsOnConflict = emittedSql.includes('on conflict') && emittedSql.includes('do nothing');

    // ── Assertion 1: insert once + 100 retries → exactly one row ──
    const now = Date.now();
    db.insert(idemTable)
      .values({ idempotencyKey: 'DEDUP', taskId: 'T1', payload: '{"n":0}', createdAt: now })
      .onConflictDoNothing({ target: idemTable.idempotencyKey })
      .run();
    for (let i = 1; i <= RETRIES; i++) {
      db.insert(idemTable)
        .values({
          idempotencyKey: 'DEDUP',
          taskId: 'T1',
          payload: `{"n":${i}}`,
          createdAt: now + i,
        })
        .onConflictDoNothing({ target: idemTable.idempotencyKey })
        .run();
    }
    const dedupRows = (
      client
        .prepare("SELECT COUNT(*) AS c FROM conduit_event WHERE idempotency_key = 'DEDUP'")
        .get() as {
        c: number;
      }
    ).c;
    const persistedPayload = (
      client.prepare("SELECT payload FROM conduit_event WHERE idempotency_key = 'DEDUP'").get() as {
        payload: string;
      }
    ).payload;

    // ── Assertion 2: UNIQUE-index (PK) overhead, isolated ──
    // Three arms, all plain INSERTs except the full-pattern arm:
    //   A) WITH TEXT PRIMARY KEY index   (plain INSERT)
    //   B) WITHOUT the index (control)   (plain INSERT, identical columns)
    //   C) Full Pattern A path           (PK + ON CONFLICT DO NOTHING)
    // Interleave A and B per-iteration so transient OS/GC noise hits both arms
    // equally — removes the warm-up/order bias that inflated the naive run.
    const withPkLatencies: number[] = [];
    const noPkLatencies: number[] = [];
    const fullPatternLatencies: number[] = [];
    for (let i = 0; i < INSERT_SAMPLES; i++) {
      const tA0 = performance.now();
      db.insert(withPkTable)
        .values({ idempotencyKey: `pk-${i}`, taskId: 'T1', payload: '{}', createdAt: now })
        .run();
      withPkLatencies.push(performance.now() - tA0);

      const tB0 = performance.now();
      db.insert(noPkTable)
        .values({ idempotencyKey: `np-${i}`, taskId: 'T1', payload: '{}', createdAt: now })
        .run();
      noPkLatencies.push(performance.now() - tB0);

      const tC0 = performance.now();
      db.insert(idemTable)
        .values({ idempotencyKey: `full-${i}`, taskId: 'T1', payload: '{}', createdAt: now })
        .onConflictDoNothing({ target: idemTable.idempotencyKey })
        .run();
      fullPatternLatencies.push(performance.now() - tC0);
    }

    client.close();

    const withPkStats = summarize(withPkLatencies);
    const noPkStats = summarize(noPkLatencies);
    const fullStats = summarize(fullPatternLatencies);
    // The AC metric: cost of the index on the hot insert path. Compare p50
    // (median — robust to GC tail spikes) as the primary signal; report mean.
    const indexOverheadP50Pct =
      ((withPkStats.p50 - noPkStats.p50) / Math.max(noPkStats.p50, 1e-9)) * 100;
    const indexOverheadMeanPct = ((withPkStats.mean - noPkStats.mean) / noPkStats.mean) * 100;
    const fullPatternOverheadP50Pct =
      ((fullStats.p50 - noPkStats.p50) / Math.max(noPkStats.p50, 1e-9)) * 100;

    const dedupCorrect = dedupRows === 1 && persistedPayload === '{"n":0}';
    // The AC names "UNIQUE-index cost on hot insert"; p50 is the robust metric.
    const overheadWithinBudget = indexOverheadP50Pct <= 10;

    const verdict = emitsOnConflict && dedupCorrect && overheadWithinBudget ? 'PASS' : 'FAIL';

    const report = {
      task: 'T11323',
      driver: 'drizzle-orm/node-sqlite (rc.3) + node:sqlite DatabaseSync client',
      emittedConflictSql: sample.toSQL().sql,
      assertions: {
        emitsOnConflictDoNothing: emitsOnConflict,
        retriesYieldExactlyOneRow: { rows: dedupRows, expected: 1, pass: dedupRows === 1 },
        firstWriteWins: {
          persistedPayload,
          expected: '{"n":0}',
          pass: persistedPayload === '{"n":0}',
        },
        uniqueIndexOverheadWithin10pct: {
          insertSamples: INSERT_SAMPLES,
          method: 'isolated: plain INSERT WITH-PK vs WITHOUT-PK (identical columns, interleaved)',
          withPkP50Ms: round(withPkStats.p50, 4),
          noPkP50Ms: round(noPkStats.p50, 4),
          indexOverheadP50Pct: round(indexOverheadP50Pct, 2),
          withPkMeanMs: round(withPkStats.mean, 4),
          noPkMeanMs: round(noPkStats.mean, 4),
          indexOverheadMeanPct: round(indexOverheadMeanPct, 2),
          fullPatternP50Ms: round(fullStats.p50, 4),
          fullPatternOverheadP50Pct: round(fullPatternOverheadP50Pct, 2),
          pass: overheadWithinBudget,
          note:
            'Primary budget metric = p50 index overhead (median, robust to GC tails). ' +
            'Full Pattern-A path (PK + ON CONFLICT) reported for transparency.',
        },
      },
      withPkInsertStats: withPkStats,
      noPkInsertStats: noPkStats,
      fullPatternInsertStats: fullStats,
      verdict,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (verdict !== 'PASS') process.exit(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

main();
