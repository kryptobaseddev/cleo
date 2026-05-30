/**
 * DB-persisted, per-agent goal CRUD store (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * Persists {@link GoalRecord}s in the `tasks_goal` table inside `tasks.db`
 * (Pattern A — opened through the canonical `getDb` chokepoint, never a raw
 * `new DatabaseSync`). Every read/write is keyed by the resolved per-agent
 * identity from E0 (`resolveSessionIdFromEnv` / `resolveAgentIdFromEnv`) so two
 * concurrent agents never collide on one global row — the session-bleed class
 * this saga exists to kill.
 *
 * JSONB discipline: `goal_kind`, `criteria`, and `last_verdict` are JSONB BLOB
 * columns. Writes go through the {@link jsonb} customType's `toDriver` (wraps in
 * the SQL `jsonb()` constructor); whole-value reads MUST project `json(col)`
 * (see {@link jsonbText}) because the raw-BLOB read path is intentionally
 * rejected — the on-disk JSONB encoding is version-unstable.
 *
 * @module @cleocode/core/goal/store
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11377
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { randomUUID } from 'node:crypto';
import type { GoalJudgeVerdict, GoalKind, GoalRecord, GoalStatus } from '@cleocode/contracts';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { resolveAgentIdFromEnv, resolveSessionIdFromEnv } from '../sessions/session-id.js';
import { tasksGoal } from '../store/schema/goal.js';
import { jsonbText } from '../store/schema/jsonb.js';
import { getDb } from '../store/sqlite.js';
import type * as schema from '../store/tasks-schema.js';

/** Drizzle handle for `tasks.db` (typed against the tasks schema). */
type DrizzleTasksDb = NodeSQLiteDatabase<typeof schema>;

/**
 * The resolved per-agent ownership key for a goal row.
 *
 * Both fields come from E0's env-first resolvers. When spawn injected no
 * session/agent identity they are `null` (the global-scope case), which still
 * isolates correctly because every concurrent agent in a shell DOES carry its
 * own injected identity.
 *
 * @task T11377
 */
export interface GoalOwner {
  /** Resolved session id (`resolveSessionIdFromEnv`), or `null`. */
  readonly sessionId: string | null;
  /** Resolved agent handle (`resolveAgentIdFromEnv`), or `null`. */
  readonly agentId: string | null;
}

/**
 * Parameters for {@link createGoal}.
 *
 * @task T11377
 */
export interface CreateGoalParams {
  /** The goal-kind discriminator + payload (task-completion vs fuzzy). */
  readonly goalKind: GoalKind;
  /** Human-readable intent statement. */
  readonly intent: string;
  /** Hard turn cap before the loop abandons the goal. */
  readonly turnBudget: number;
  /** Initial acceptance criteria (defaults to empty). */
  readonly criteria?: readonly string[];
  /** Parent goal id when this is a sub-goal. */
  readonly parentGoalId?: string | null;
  /**
   * Explicit owner override. When omitted, the owner is resolved from the
   * environment via {@link resolveGoalOwner}. Tests pass an explicit owner to
   * simulate two distinct agents without mutating `process.env`.
   */
  readonly owner?: GoalOwner;
  /**
   * Idempotency key. When omitted a UUID is generated. Supplying a stable key
   * makes a re-issued create a no-op (the row already exists).
   */
  readonly idempotencyKey?: string;
}

/**
 * Mutable fields accepted by {@link updateGoal}.
 *
 * `criteria` is replaced wholesale here; use {@link appendCriteria} for the
 * append-only path. All fields are optional — only the provided ones are
 * written, and `updated_at` is always refreshed.
 *
 * @task T11377
 */
export interface UpdateGoalFields {
  readonly status?: GoalStatus;
  readonly turnsUsed?: number;
  readonly pausedReason?: string | null;
  readonly lastVerdict?: GoalJudgeVerdict | null;
  readonly criteria?: readonly string[];
}

/**
 * Resolve the current per-agent goal owner from the environment (E0).
 *
 * Reads `CLEO_SESSION_ID` (+ precedence) and `CLEO_AGENT_ID` via the canonical
 * env-first resolvers so the goal store keys identity the SAME way every other
 * hot path does. Never reads the DB.
 *
 * @returns The resolved {@link GoalOwner}.
 * @task T11377
 */
export function resolveGoalOwner(): GoalOwner {
  return { sessionId: resolveSessionIdFromEnv(), agentId: resolveAgentIdFromEnv() };
}

/**
 * Project a `tasks_goal` row (with JSONB columns read through `json(col)`) into
 * the typed {@link GoalRecord} contract.
 *
 * @internal
 */
interface GoalSelectRow {
  idempotencyKey: string;
  sessionId: string | null;
  agentId: string | null;
  parentGoalId: string | null;
  goalKind: GoalKind;
  intent: string;
  criteria: string[];
  status: string;
  turnBudget: number;
  turnsUsed: number;
  pausedReason: string | null;
  lastVerdict: GoalJudgeVerdict | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The select projection that reads every JSONB column through `json(col)` so
 * `fromDriver`'s raw-BLOB guard never fires. Shared by every read path.
 *
 * @internal
 */
const GOAL_SELECTION = {
  idempotencyKey: tasksGoal.idempotencyKey,
  sessionId: tasksGoal.sessionId,
  agentId: tasksGoal.agentId,
  parentGoalId: tasksGoal.parentGoalId,
  // jsonbText projects `json(col)` so the version-unstable raw BLOB is never
  // parsed. The column is interpolated through `sql` to satisfy jsonbText's
  // `SQL | SQL.Aliased` parameter (a bare column ref is not an `SQL`).
  goalKind: jsonbText<GoalKind>(sql`${tasksGoal.goalKind}`),
  intent: tasksGoal.intent,
  criteria: jsonbText<string[]>(sql`${tasksGoal.criteria}`),
  status: tasksGoal.status,
  turnBudget: tasksGoal.turnBudget,
  turnsUsed: tasksGoal.turnsUsed,
  pausedReason: tasksGoal.pausedReason,
  lastVerdict: jsonbText<GoalJudgeVerdict | null>(sql`${tasksGoal.lastVerdict}`),
  createdAt: tasksGoal.createdAt,
  updatedAt: tasksGoal.updatedAt,
};

/**
 * Map a JSONB-decoded select row to the immutable {@link GoalRecord} contract.
 *
 * @internal
 */
function toGoalRecord(row: GoalSelectRow): GoalRecord {
  return {
    id: row.idempotencyKey,
    sessionId: row.sessionId,
    agentId: row.agentId,
    parentGoalId: row.parentGoalId,
    goalKind: row.goalKind,
    intent: row.intent,
    criteria: row.criteria ?? [],
    status: row.status as GoalStatus,
    turnBudget: row.turnBudget,
    turnsUsed: row.turnsUsed,
    pausedReason: row.pausedReason,
    // json(NULL) decodes to null — guard the array/object decode defensively.
    lastVerdict: row.lastVerdict ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Create a new goal, persisted in `tasks.db` and keyed to the resolved
 * per-agent owner.
 *
 * Idempotent on the primary key: a re-issued create with the same
 * `idempotencyKey` coalesces via `onConflictDoNothing` and returns the existing
 * row rather than inserting a duplicate.
 *
 * @param params - Goal creation parameters.
 * @param cwd - Project root override (defaults to the resolved CLEO project).
 * @returns The created (or pre-existing) {@link GoalRecord}.
 * @task T11377
 */
export async function createGoal(params: CreateGoalParams, cwd?: string): Promise<GoalRecord> {
  const db = (await getDb(cwd)) as DrizzleTasksDb;
  const owner = params.owner ?? resolveGoalOwner();
  const id = params.idempotencyKey ?? randomUUID();
  const now = new Date().toISOString();
  const criteria: string[] = [...(params.criteria ?? [])];

  await db
    .insert(tasksGoal)
    .values({
      idempotencyKey: id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      parentGoalId: params.parentGoalId ?? null,
      goalKind: params.goalKind,
      intent: params.intent,
      criteria,
      status: 'active',
      turnBudget: params.turnBudget,
      turnsUsed: 0,
      pausedReason: null,
      lastVerdict: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();

  const created = await getGoalById(id, cwd);
  if (!created) {
    // Unreachable in practice — the row was just inserted (or already existed).
    throw new Error(`createGoal: row ${id} not found immediately after insert`);
  }
  return created;
}

/**
 * Load a single goal by its id (idempotency key / primary key).
 *
 * @param id - The goal id.
 * @param cwd - Project root override.
 * @returns The {@link GoalRecord}, or `null` when absent.
 * @task T11377
 */
export async function getGoalById(id: string, cwd?: string): Promise<GoalRecord | null> {
  const db = (await getDb(cwd)) as DrizzleTasksDb;
  const rows = (await db
    .select(GOAL_SELECTION)
    .from(tasksGoal)
    .where(eq(tasksGoal.idempotencyKey, id))
    .limit(1)
    .all()) as GoalSelectRow[];
  const row = rows[0];
  return row ? toGoalRecord(row) : null;
}

/**
 * Get the most-recently-updated ACTIVE or PAUSED goal owned by an agent.
 *
 * This is the dominant lookup ("what is THIS agent working on?") and is served
 * by the `idx_tasks_goal_owner_active` index. Owner defaults to the
 * environment-resolved identity so concurrent agents see their OWN goal — never
 * each other's. Terminal goals (satisfied/abandoned/impossible) are excluded;
 * an agent's active goal is the live one it can still advance.
 *
 * @param cwd - Project root override.
 * @param owner - Explicit owner override (defaults to {@link resolveGoalOwner}).
 * @returns The active/paused {@link GoalRecord}, or `null` when none.
 * @task T11377
 */
export async function getActiveGoal(cwd?: string, owner?: GoalOwner): Promise<GoalRecord | null> {
  const db = (await getDb(cwd)) as DrizzleTasksDb;
  const resolved = owner ?? resolveGoalOwner();
  const rows = (await db
    .select(GOAL_SELECTION)
    .from(tasksGoal)
    .where(ownerScope(resolved))
    .orderBy(desc(tasksGoal.updatedAt))
    .all()) as GoalSelectRow[];
  // Filter to live statuses in JS — keeps the WHERE clause a single index-hit
  // on the owner columns and avoids an OR-of-statuses scan. The owner set is
  // small (a handful of goals per agent), so this is O(few).
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'paused') {
      return toGoalRecord(row);
    }
  }
  return null;
}

/**
 * List all goals owned by an agent, newest first.
 *
 * @param cwd - Project root override.
 * @param owner - Explicit owner override (defaults to {@link resolveGoalOwner}).
 * @returns Every {@link GoalRecord} for the owner, ordered by `updatedAt` desc.
 * @task T11377
 */
export async function listGoals(cwd?: string, owner?: GoalOwner): Promise<GoalRecord[]> {
  const db = (await getDb(cwd)) as DrizzleTasksDb;
  const resolved = owner ?? resolveGoalOwner();
  const rows = (await db
    .select(GOAL_SELECTION)
    .from(tasksGoal)
    .where(ownerScope(resolved))
    .orderBy(desc(tasksGoal.updatedAt))
    .all()) as GoalSelectRow[];
  return rows.map(toGoalRecord);
}

/**
 * Update mutable fields of a goal and refresh `updated_at`.
 *
 * Only the provided fields are written. Returns the updated record (re-read so
 * JSONB columns round-trip through `json(col)`), or `null` if the goal is gone.
 *
 * @param id - The goal id.
 * @param fields - The fields to update.
 * @param cwd - Project root override.
 * @returns The updated {@link GoalRecord}, or `null` when the goal is absent.
 * @task T11377
 */
export async function updateGoal(
  id: string,
  fields: UpdateGoalFields,
  cwd?: string,
): Promise<GoalRecord | null> {
  const db = (await getDb(cwd)) as DrizzleTasksDb;
  const patch: Partial<typeof tasksGoal.$inferInsert> = { updatedAt: new Date().toISOString() };
  if (fields.status !== undefined) patch.status = fields.status;
  if (fields.turnsUsed !== undefined) patch.turnsUsed = fields.turnsUsed;
  if (fields.pausedReason !== undefined) patch.pausedReason = fields.pausedReason;
  if (fields.lastVerdict !== undefined) patch.lastVerdict = fields.lastVerdict;
  if (fields.criteria !== undefined) patch.criteria = [...fields.criteria];

  await db.update(tasksGoal).set(patch).where(eq(tasksGoal.idempotencyKey, id)).run();
  return getGoalById(id, cwd);
}

/**
 * Append a single criterion to a goal's criteria array (append-only).
 *
 * Reads the current criteria, appends, and writes the whole array back. The
 * read round-trips through `json(col)` so no raw BLOB is ever parsed.
 *
 * @param id - The goal id.
 * @param criterion - The criterion text to append.
 * @param cwd - Project root override.
 * @returns The updated {@link GoalRecord}, or `null` when the goal is absent.
 * @task T11377
 */
export async function appendCriteria(
  id: string,
  criterion: string,
  cwd?: string,
): Promise<GoalRecord | null> {
  const current = await getGoalById(id, cwd);
  if (!current) return null;
  const next = [...current.criteria, criterion];
  return updateGoal(id, { criteria: next }, cwd);
}

/**
 * Build the owner-scope WHERE predicate, handling the `null` (no-identity)
 * case correctly: a `null` session/agent must match `IS NULL`, not `= NULL`
 * (which SQLite evaluates to UNKNOWN and never matches). Without `isNull`, the
 * global-scope/no-session owner would match ZERO rows and silently lose its own
 * goal — the inverse of the bleed we are preventing.
 *
 * @internal
 */
function ownerScope(owner: GoalOwner) {
  return and(
    owner.sessionId === null
      ? isNull(tasksGoal.sessionId)
      : eq(tasksGoal.sessionId, owner.sessionId),
    owner.agentId === null ? isNull(tasksGoal.agentId) : eq(tasksGoal.agentId, owner.agentId),
  );
}
