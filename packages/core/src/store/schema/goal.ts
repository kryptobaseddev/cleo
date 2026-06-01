/**
 * Drizzle schema for the `tasks_goal` table — CLEO's DB-persisted, per-agent
 * goal store (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * Pattern A (ADR-068 / the SQLite-consolidation decision): one file per scope
 * (this table lives INSIDE the project `cleo.db`, opened via
 * `openCleoDb('project', cwd)` / `getTasksDb`), domain-prefixed table name
 * (`tasks_goal`), and an idempotency
 * key as the natural primary key so a re-issued `create` coalesces via
 * `onConflictDoNothing` rather than duplicating a row.
 *
 * Per-agent isolation: every row carries `session_id` + `agent_id` resolved
 * from E0 (`resolveSessionIdFromEnv` / `resolveAgentIdFromEnv`). The
 * `idx_tasks_goal_owner_active` index serves the dominant lookup —
 * "the active goal for THIS agent" — so two concurrent agents never collide on
 * one global row (the session-bleed class this saga exists to kill).
 *
 * `criteria` is a JSONB column (binary, queryable in-SQL) via the reusable
 * {@link jsonb} customType. The load-bearing read rule applies: whole-value
 * reads MUST project `json(col)` (see {@link jsonbText}) — never `JSON.parse`
 * the raw BLOB bytes. `last_verdict` is whole-value-read-only structured state,
 * so it uses JSONB too and is always read back through `json(col)`.
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11377
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 * @adr ADR-068
 */

import type { GoalJudgeVerdict, GoalKind } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { jsonb } from './jsonb.js';

/**
 * Per-agent goal record, persisted in `tasks.db`.
 *
 * Survives process restart (the whole point — Claude-Code forgets the goal on a
 * fresh process; CLEO does not). Keyed by `idempotency_key` so the create path
 * is safe to retry. `goal_kind` is the serialized {@link GoalKind} discriminated
 * union (whole-value JSONB read) that routes the judge: evidence path for
 * `task-completion`, LLM fallback for `fuzzy`.
 *
 * @task T11377
 */
export const tasksGoal = sqliteTable(
  'tasks_goal',
  {
    /**
     * Idempotency key + primary identity. A re-issued create with the same key
     * coalesces via `onConflictDoNothing` instead of inserting a duplicate.
     */
    idempotencyKey: text('idempotency_key').primaryKey(),
    /**
     * Resolved owning session id (`resolveSessionIdFromEnv`). `null` for the
     * global-scope / no-session case. Half of the per-agent ownership key.
     */
    sessionId: text('session_id'),
    /**
     * Resolved owning agent handle (`resolveAgentIdFromEnv`). `null` when spawn
     * injected no agent identity. The other half of the per-agent ownership key.
     */
    agentId: text('agent_id'),
    /** Parent goal id when this is a sub-goal, else `null`. */
    parentGoalId: text('parent_goal_id'),
    /**
     * Serialized {@link GoalKind} discriminated union (JSONB). Drives the judge
     * route. Read whole via `json(col)` — never parse the raw BLOB.
     */
    goalKind: jsonb<GoalKind>('goal_kind').notNull(),
    /** Human-readable statement of the agent's intent. */
    intent: text('intent').notNull(),
    /**
     * Append-only acceptance criteria (JSONB array of strings). Appended via
     * the store's `appendCriteria`; read whole via `json(col)`.
     */
    criteria: jsonb<string[]>('criteria').notNull().default(sql`jsonb('[]')`),
    /** Current lifecycle status (GoalStatus). */
    status: text('status').notNull().default('active'),
    /** Hard turn cap before the loop abandons the goal. */
    turnBudget: integer('turn_budget').notNull(),
    /** Turns consumed so far (never exceeds `turn_budget`). */
    turnsUsed: integer('turns_used').notNull().default(0),
    /** Auto-pause reason when `status = 'paused'`, else `null`. */
    pausedReason: text('paused_reason'),
    /**
     * Most recent {@link GoalJudgeVerdict} (JSONB), persisted so `cleo goal
     * status` shows the last reason without re-judging. `null` before the first
     * judge. Read whole via `json(col)`.
     */
    lastVerdict: jsonb<GoalJudgeVerdict>('last_verdict'),
    /** ISO-8601 creation timestamp. */
    createdAt: text('created_at').notNull(),
    /** ISO-8601 last-update timestamp. */
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    // Dominant lookup: "the active goal for THIS (session, agent)". Keying the
    // index on (session_id, agent_id, status) lets getActiveGoal hit an index
    // instead of scanning, and structurally scopes the read per agent.
    index('idx_tasks_goal_owner_active').on(table.sessionId, table.agentId, table.status),
    // Sub-goal traversal: find children of a parent goal.
    index('idx_tasks_goal_parent').on(table.parentGoalId),
  ],
);

/** Row type for `tasks_goal` SELECT queries (T11377). */
export type TasksGoalRow = typeof tasksGoal.$inferSelect;
/** Row type for `tasks_goal` INSERT operations (T11377). */
export type NewTasksGoalRow = typeof tasksGoal.$inferInsert;
