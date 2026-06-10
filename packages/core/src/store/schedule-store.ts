/**
 * Store-layer accessor for the cron / todo schedule table (`schedules`) — T11962
 * (under T11679 · M7 · epic T11456).
 *
 * This module is the ONLY place that touches the native `cleo.db` handle for
 * schedule persistence. It lives INSIDE the store chokepoint
 * (`packages/core/src/store/**`), the Gate-3 allowlist, so it may extract the
 * native `DatabaseSync` that {@link openDualScopeDb} already holds (via drizzle's
 * `$client`) and run prepared statements over it — exactly the established
 * `selfimprove-dhq-store.ts` / `pi-session-store.ts` pattern. It NEVER calls
 * `new DatabaseSync(` itself.
 *
 * The `cron_schedule` agent tool ({@link import('../tools/schedule-agent-tools.js')})
 * sits OUTSIDE the chokepoint, so it must NOT open a raw handle; it calls
 * {@link addSchedule} / {@link listSchedules} / {@link removeSchedule}. A single
 * INSERT/DELETE is one atomic SQLite statement, so the accessor does not wrap them
 * in a writer lease itself — daemon-OFF the chokepoint already serializes the
 * single in-process writer; a future daemon scheduler (a separate reader, AC4)
 * never writes through this path.
 *
 * Physical model (see the `t11962-schedules` migration):
 *  - `schedules(id, schedule_id, cron_expr, title, description, enabled,
 *    created_at, updated_at)` — one row per recurring schedule.
 *  - `schedule_id` is a unique opaque handle (`sched-<token>`) returned to the
 *    caller and used to remove a schedule.
 *
 * ## Never `.all()` an unbounded query
 *
 * {@link listSchedules} reads through `iterate()` with an explicit SQL `LIMIT`
 * (capped, default {@link SCHEDULE_LIST_DEFAULT_LIMIT}), never `.all()` over the
 * whole table — the established OOM-safe read pattern (cf.
 * `exodus/verify-migration.ts`).
 *
 * @module
 * @task T11962
 * @epic T11679
 * @see ./schedule-schema.ts — the drizzle table declaration (physical-name SSoT)
 * @see ./selfimprove-dhq-store.ts — the Gate-3 native-handle accessor precedent this mirrors
 * @see ../tools/schedule-agent-tools.ts — the `cron_schedule` tool that delegates here
 */

import { randomBytes } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { openDualScopeDb } from './dual-scope-db.js';
import { SCHEDULES_TABLE } from './schedule-schema.js';

export { SCHEDULES_TABLE } from './schedule-schema.js';

/** Default cap for {@link listSchedules} — bounds the read so it never OOMs. */
export const SCHEDULE_LIST_DEFAULT_LIMIT = 500 as const;

/** Hard ceiling on a {@link listSchedules} request — a caller cannot exceed it. */
export const SCHEDULE_LIST_MAX_LIMIT = 5000 as const;

/** A persisted schedule row, decoded from `schedules`. */
export interface ScheduleRecord {
  /** Stable opaque schedule handle (`sched-<token>`). */
  readonly scheduleId: string;
  /** The recurrence — a standard 5-field cron expression. */
  readonly cronExpr: string;
  /** The title of the task created on each fire (the template). */
  readonly title: string;
  /** Optional description for the task created on each fire. */
  readonly description: string | null;
  /** Whether the daemon scheduler should fire this schedule. */
  readonly enabled: boolean;
  /** ISO-8601 UTC creation instant. */
  readonly createdAt: string;
  /** ISO-8601 UTC last-update instant. */
  readonly updatedAt: string;
}

/** Fields required to register one schedule via {@link addSchedule}. */
export interface AddScheduleParams {
  /** The recurrence — a standard 5-field cron expression (e.g. `'0 9 * * 1'`). */
  readonly cronExpr: string;
  /** The title of the task to create on each fire. */
  readonly title: string;
  /** Optional description for the task created on each fire. */
  readonly description?: string;
}

/** Narrow shape of the native handle methods this accessor uses. */
type NativeRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };
interface NativeStatement {
  run(...params: ReadonlyArray<string | number | null>): NativeRunResult;
  get(...params: ReadonlyArray<string | number | null>): Record<string, unknown> | undefined;
  iterate(
    ...params: ReadonlyArray<string | number | null>
  ): IterableIterator<Record<string, unknown>>;
}
interface NativeHandle {
  prepare(sql: string): NativeStatement;
}

/**
 * Extract the native `DatabaseSync` handle for the PROJECT-scope `cleo.db`.
 *
 * Routes through {@link openDualScopeDb} (the dual-scope chokepoint) — which
 * applies the pragma SSoT, runs the consolidated migrations (creating
 * `schedules`), and manages the singleton cache — then extracts the native handle
 * drizzle holds on `$client`. NEVER opens a raw connection (Gate 3): it reuses the
 * handle the chokepoint already owns.
 *
 * @param cwd - Working directory for project resolution (defaults to `cwd`).
 * @returns The live native handle.
 * @throws When the chokepoint returns a handle without `$client`.
 */
export async function getScheduleNativeDb(cwd?: string): Promise<NativeHandle> {
  const handle = await openDualScopeDb('project', cwd);
  const native = (handle.db as unknown as { $client?: DatabaseSyncType }).$client;
  if (!native) {
    throw new Error(
      'T11962: openDualScopeDb returned a project handle without $client — ' +
        'cannot extract DatabaseSync for schedule persistence.',
    );
  }
  // The node:sqlite surface is wider than NativeHandle; narrow to what we use.
  return native as unknown as NativeHandle;
}

/** Decode a raw SQLite row into a typed {@link ScheduleRecord}. */
function decodeRow(row: Record<string, unknown>): ScheduleRecord {
  return {
    scheduleId: String(row.schedule_id),
    cronExpr: String(row.cron_expr),
    title: String(row.title),
    description:
      row.description === null || row.description === undefined ? null : String(row.description),
    // SQLite stores the typed boolean as 0/1.
    enabled: Number(row.enabled) !== 0,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** Mint a stable opaque schedule handle (`sched-<24 hex>`). */
function mintScheduleId(): string {
  return `sched-${randomBytes(12).toString('hex')}`;
}

/**
 * REGISTER a recurring schedule: insert one `schedules` row and return its handle.
 *
 * A fresh `schedule_id` is minted (`sched-<token>`) and returned so the caller can
 * later {@link removeSchedule} by it. The row is created `enabled = true`. Writes
 * one atomic INSERT — the chokepoint serializes the single in-process writer
 * daemon-OFF.
 *
 * @param native - The native project `cleo.db` handle (from {@link getScheduleNativeDb}).
 * @param params - The cron expression + task template.
 * @returns The minted schedule handle.
 */
export function addSchedule(native: NativeHandle, params: AddScheduleParams): string {
  const scheduleId = mintScheduleId();
  native
    .prepare(
      `INSERT INTO ${SCHEDULES_TABLE} ` +
        `(schedule_id, cron_expr, title, description, enabled) ` +
        `VALUES (?, ?, ?, ?, 1)`,
    )
    .run(scheduleId, params.cronExpr, params.title, params.description ?? null);
  return scheduleId;
}

/**
 * LIST registered schedules in stable creation order (`created_at ASC`, then `id`).
 *
 * Bounded by an explicit SQL `LIMIT` and read through `iterate()` — NEVER an
 * unbounded `.all()`. The request limit is clamped to
 * `[1, {@link SCHEDULE_LIST_MAX_LIMIT}]`, defaulting to
 * {@link SCHEDULE_LIST_DEFAULT_LIMIT}.
 *
 * @param native - The native project `cleo.db` handle.
 * @param limit - Maximum rows to return (clamped). Defaults to the default cap.
 * @returns The ordered schedule records (at most `limit`).
 */
export function listSchedules(
  native: NativeHandle,
  limit: number = SCHEDULE_LIST_DEFAULT_LIMIT,
): ScheduleRecord[] {
  const clamped = Math.max(1, Math.min(Math.floor(limit), SCHEDULE_LIST_MAX_LIMIT));
  const stmt = native.prepare(
    `SELECT schedule_id, cron_expr, title, description, enabled, created_at, updated_at ` +
      `FROM ${SCHEDULES_TABLE} ORDER BY created_at ASC, id ASC LIMIT ?`,
  );
  const out: ScheduleRecord[] = [];
  for (const row of stmt.iterate(clamped)) {
    out.push(decodeRow(row));
  }
  return out;
}

/**
 * GET one schedule by its opaque handle, or `null` when no such schedule exists.
 *
 * @param native - The native project `cleo.db` handle.
 * @param scheduleId - The `sched-<token>` handle.
 * @returns The schedule record, or `null`.
 */
export function getSchedule(native: NativeHandle, scheduleId: string): ScheduleRecord | null {
  const row = native
    .prepare(
      `SELECT schedule_id, cron_expr, title, description, enabled, created_at, updated_at ` +
        `FROM ${SCHEDULES_TABLE} WHERE schedule_id = ?`,
    )
    .get(scheduleId);
  return row === undefined ? null : decodeRow(row);
}

/**
 * REMOVE a schedule by its opaque handle.
 *
 * Writes one atomic DELETE. Returns whether a row was actually removed (`false`
 * when the handle is unknown).
 *
 * @param native - The native project `cleo.db` handle.
 * @param scheduleId - The `sched-<token>` handle to remove.
 * @returns `true` if a row was deleted, `false` when no such schedule existed.
 */
export function removeSchedule(native: NativeHandle, scheduleId: string): boolean {
  const result = native
    .prepare(`DELETE FROM ${SCHEDULES_TABLE} WHERE schedule_id = ?`)
    .run(scheduleId);
  return Number(result.changes) > 0;
}
