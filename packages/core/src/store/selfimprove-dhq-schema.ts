/**
 * Drizzle ORM schema for the **self-improvement DHQ** table (`selfimprove_dhq`),
 * the durable sink for the P5 self-improvement loop (T11889 · T11889-A · T11911).
 *
 * One row per Dogfood-Harness-Question (DHQ) emitted by `cleo selfimprove run`:
 * the loop replays a canned dogfood scenario, diffs the resulting LAFS envelopes
 * against a golden, and — on regression — UPSERTs exactly ONE row here through the
 * leased Gate-3 accessor ({@link ./selfimprove-dhq-store.ts}). On green it writes
 * nothing. The table is dual-scope: co-located inside EACH scope's consolidated
 * `cleo.db` (project + global) via the `drizzle-cleo-project` / `drizzle-cleo-global`
 * migration sets, exactly like the `_writer_leases` (T11627) and `pi_session_*`
 * (T11899) runtime-infrastructure tables. It is NOT part of the exodus target shape
 * under `schema/cleo-project/`.
 *
 * ## Idempotency invariant — at most ONE open DHQ per `question_hash`
 *
 * A repeated regression must UPSERT the SAME open row rather than spam N duplicates.
 * This is enforced by the **partial UNIQUE index**
 * `ux_selfimprove_dhq_open ON selfimprove_dhq (question_hash) WHERE status = 'open'`.
 * drizzle-orm does **not** surface partial-`WHERE` indexes in its typed schema API
 * (cf. `writer-lease-schema.ts` `_writer_leases.active`, `conduit-schema.ts`
 * `project_agent_refs.enabled`), so the partial index is emitted as **raw SQL in the
 * baseline migration** — this module declares only the full-column table plus the two
 * non-partial indexes drizzle CAN model. The runtime bootstrap asserts the partial
 * index exists via {@link assertSelfimproveDhqOpenIndexPresent} so a missing index
 * (a migration that never ran, or a dropped index) fails loudly instead of silently
 * permitting two open rows for the same `question_hash`.
 *
 * @module
 * @task T11911
 * @task T11889
 * @epic T11889
 * @see ./selfimprove-dhq-store.ts — the Gate-3 accessor over these tables
 * @see ./writer-lease-schema.ts — the partial-UNIQUE-index-via-raw-SQL precedent
 * @see ../../migrations/drizzle-cleo-project — project migration (raw partial index)
 * @see ../../migrations/drizzle-cleo-global — global migration (raw partial index)
 */

import type { DatabaseSync } from 'node:sqlite';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The physical name of the self-improvement DHQ table. Exported so the engine, the
 * store accessor, the bootstrap assertion, and tests all reference one source of
 * truth.
 */
export const SELFIMPROVE_DHQ_TABLE = 'selfimprove_dhq' as const;

/**
 * The physical name of the partial-UNIQUE active-row index (`WHERE status = 'open'`).
 * Asserted present at bootstrap because drizzle cannot emit it — it lives as raw SQL
 * in the baseline migration.
 */
export const SELFIMPROVE_DHQ_OPEN_INDEX = 'ux_selfimprove_dhq_open' as const;

/**
 * `selfimprove_dhq` — one row per self-improvement-loop DHQ.
 *
 * The at-most-one-open-per-`question_hash` invariant is enforced by the raw-SQL
 * partial-UNIQUE index `ux_selfimprove_dhq_open ON selfimprove_dhq (question_hash)
 * WHERE status = 'open'` (emitted in the baseline migration — drizzle cannot model
 * partial `WHERE`). This declaration intentionally carries only the full-column
 * table plus the two non-partial indexes; do NOT add a `.unique()` on
 * `question_hash` here (it would emit a NON-partial unique that wrongly forbids a
 * second non-open row for the same hash).
 */
export const selfimproveDhq = sqliteTable(
  SELFIMPROVE_DHQ_TABLE,
  {
    /** Surrogate primary key (autoincrement via INTEGER PRIMARY KEY rowid alias). */
    id: integer('id').primaryKey(),
    /** Stable `'DHQ-###'` handle for the question. */
    dhqId: text('dhq_id').notNull(),
    /** The scenario name replayed when this DHQ was raised. */
    scenario: text('scenario').notNull(),
    /** sha256 of the normalized regression signature — the idempotency key. */
    questionHash: text('question_hash').notNull(),
    /** Human-readable DHQ title. */
    title: text('title').notNull(),
    /** The envelope-diff payload (the evidence) as serialized JSON. */
    regressionJson: text('regression_json').notNull(),
    /**
     * Lifecycle status — `open` while the regression is live; advanced to a terminal
     * value as the DHQ is worked. The partial-UNIQUE index keys on `status = 'open'`.
     */
    status: text('status').notNull().default('open'),
    /** Severity classification (nullable until triaged), e.g. `P0`..`P3`. */
    severity: text('severity'),
    /** The draft PR URL once egress fires (nullable until a PR is opened). */
    prUrl: text('pr_url'),
    /** Ties the row to ONE loop run. */
    runId: text('run_id').notNull(),
    /** Creation timestamp (epoch ms). */
    createdAt: integer('created_at').notNull(),
    /** Last-update timestamp (epoch ms). */
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    index('ix_selfimprove_dhq_status').on(table.status),
    index('ix_selfimprove_dhq_scenario').on(table.scenario),
  ],
);

/**
 * Assert that the raw-SQL partial-UNIQUE open-row index is physically present on the
 * given native `cleo.db` handle.
 *
 * Because drizzle cannot emit a partial-`WHERE` index, the at-most-one-open-DHQ
 * invariant depends entirely on the hand-written baseline migration having run. This
 * check makes a missing index a loud, immediate failure at bootstrap rather than a
 * silent loss of the idempotency guarantee (which would let the loop spam duplicate
 * open rows).
 *
 * @param nativeDb - The native `DatabaseSync` handle for a scope's `cleo.db`.
 * @throws {Error} `E_SELFIMPROVE_DHQ_INDEX_MISSING` if `ux_selfimprove_dhq_open` is
 *   absent (the migration did not run, or the partial index was dropped).
 *
 * @example
 * ```ts
 * const nativeDb = (handle.db as { $client: DatabaseSync }).$client;
 * assertSelfimproveDhqOpenIndexPresent(nativeDb); // throws if the index is missing
 * ```
 *
 * @task T11911
 */
export function assertSelfimproveDhqOpenIndexPresent(nativeDb: DatabaseSync): void {
  const row = nativeDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(SELFIMPROVE_DHQ_OPEN_INDEX) as { name: string } | undefined;
  if (!row) {
    throw new Error(
      `E_SELFIMPROVE_DHQ_INDEX_MISSING: partial-unique open-row index ` +
        `"${SELFIMPROVE_DHQ_OPEN_INDEX}" is absent from this cleo.db. The DHQ ` +
        `baseline migration (drizzle-cleo-{project,global}/…_t11889-selfimprove-dhq) ` +
        `did not run, so the at-most-one-open-DHQ-per-question_hash invariant is ` +
        `unenforced.`,
    );
  }
}
