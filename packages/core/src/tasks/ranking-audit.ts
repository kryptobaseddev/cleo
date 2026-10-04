/**
 * Ranking-input audit trail (T12693, owner decision D11161).
 *
 * Agents may write a task's ranking inputs — priority, severity, kind and
 * depends — directly, but every such change records WHO (actor), in WHICH
 * session, WHY (optional reason) and the values before and after, as one
 * `ranking_changed` row in the task audit log, written in the same
 * transaction as the change. `cleo history ranking <id>` lists them and
 * `cleo history revert <entryId>` undoes one.
 *
 * @task T12693
 */

import type { Task, TaskAuditLogRow } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { resolveAgentIdFromEnv, resolveSessionIdFromEnv } from '../sessions/session-id.js';
import { getTaskAccessor } from '../store/data-accessor.js';

/** The audit action a ranking change is recorded under. */
export const RANKING_CHANGED_ACTION = 'ranking_changed';

/** Fields the ranking sort reads (D11161). */
export const RANKING_FIELDS = ['priority', 'severity', 'kind', 'depends'] as const;

/** One ranking input. */
export type RankingField = (typeof RANKING_FIELDS)[number];

/** A task's ranking inputs at one moment. */
export interface RankingSnapshot {
  priority: Task['priority'] | null;
  severity: NonNullable<Task['severity']> | null;
  kind: NonNullable<Task['kind']> | null;
  depends: string[];
}

/** Who made a change: agent (or `human`) and session. */
export interface RankingActor {
  actor: string;
  sessionId: string | null;
}

/** One recorded ranking change, as `cleo history ranking` shows it. */
export interface RankingChange {
  /** Audit row id — what `cleo history revert` takes. */
  id: string;
  taskId: string;
  timestamp: string;
  actor: string;
  sessionId: string | null;
  reason: string | null;
  /** What made the change (`update`, `delete-cascade`, `revert`). */
  source: string | null;
  fields: RankingField[];
  before: Partial<RankingSnapshot>;
  after: Partial<RankingSnapshot>;
}

/**
 * A task's ranking inputs.
 *
 * @param task - The task.
 * @returns The snapshot (depends sorted, so order changes are not changes).
 * @task T12693
 */
export function rankingSnapshot(
  task: Pick<Task, 'priority' | 'severity' | 'kind' | 'depends'>,
): RankingSnapshot {
  return {
    priority: task.priority ?? null,
    severity: task.severity ?? null,
    kind: task.kind ?? null,
    depends: [...(task.depends ?? [])].sort(),
  };
}

/**
 * The ranking fields that differ between two snapshots.
 *
 * @param before - Snapshot before the change.
 * @param after - Snapshot after it.
 * @returns Changed fields, in {@link RANKING_FIELDS} order.
 * @task T12693
 */
export function rankingDiff(before: RankingSnapshot, after: RankingSnapshot): RankingField[] {
  return RANKING_FIELDS.filter((field) =>
    field === 'depends'
      ? before.depends.join('\0') !== after.depends.join('\0')
      : before[field] !== after[field],
  );
}

/**
 * The actor and session a change is attributed to: the agent id
 * (`CLEO_AGENT_ID`, else `human`) and the caller's session (env first, then
 * the bound session).
 *
 * @param cwd - Project root.
 * @returns The actor and session.
 * @task T12693
 */
export async function resolveRankingActor(cwd?: string): Promise<RankingActor> {
  let sessionId = resolveSessionIdFromEnv();
  if (!sessionId) {
    try {
      const { resolveBoundSessionId } = await import('../store/session-store.js');
      sessionId = (await resolveBoundSessionId(cwd)) ?? null;
    } catch {
      sessionId = null;
    }
  }
  return { actor: resolveAgentIdFromEnv() ?? 'human', sessionId };
}

/**
 * The audit-log entry for one ranking change, or null when nothing ranking
 * related changed. Only the changed fields are stored before and after.
 *
 * @param input - Task, snapshots, attribution and why.
 * @returns The `appendLog` entry, or null.
 * @task T12693
 */
export function rankingAuditEntry(input: {
  taskId: string;
  before: RankingSnapshot;
  after: RankingSnapshot;
  actor: RankingActor;
  reason?: string | undefined;
  source: string;
}): Record<string, unknown> | null {
  const fields = rankingDiff(input.before, input.after);
  if (fields.length === 0) return null;
  const pick = (snap: RankingSnapshot): Partial<RankingSnapshot> =>
    Object.fromEntries(fields.map((f) => [f, snap[f]])) as Partial<RankingSnapshot>;
  return {
    id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    action: RANKING_CHANGED_ACTION,
    taskId: input.taskId,
    actor: input.actor.actor,
    sessionId: input.actor.sessionId,
    details: {
      fields,
      reason: input.reason?.trim() ? input.reason.trim() : null,
      source: input.source,
    },
    before: pick(input.before),
    after: pick(input.after),
  };
}

function parseRow(row: TaskAuditLogRow): RankingChange {
  const json = <T>(text: string | null, fallback: T): T => {
    try {
      return text ? (JSON.parse(text) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const details = json<{ fields?: RankingField[]; reason?: string | null; source?: string }>(
    row.detailsJson,
    {},
  );
  return {
    id: row.id,
    taskId: row.taskId,
    timestamp: row.timestamp,
    actor: row.actor,
    sessionId: row.sessionId ?? null,
    reason: details.reason ?? null,
    source: details.source ?? null,
    fields: details.fields ?? [],
    before: json<Partial<RankingSnapshot>>(row.beforeJson, {}),
    after: json<Partial<RankingSnapshot>>(row.afterJson, {}),
  };
}

/**
 * Who changed a task's ranking inputs, when, and why — newest first.
 *
 * @param taskId - Task.
 * @param cwd - Project root.
 * @param limit - Maximum rows (default 50).
 * @returns The recorded changes.
 * @task T12693
 */
export async function listRankingHistory(
  taskId: string,
  cwd?: string,
  limit = 50,
): Promise<RankingChange[]> {
  const accessor = await getTaskAccessor(cwd);
  const rows = await accessor.queryAuditLog({
    taskIds: [taskId],
    actions: [RANKING_CHANGED_ACTION],
    limit,
  });
  return rows.map(parseRow);
}

/**
 * Undo one recorded ranking change: set each field it changed back to its
 * value before, as a new audited change (source `revert`). Refused when a
 * field has changed again since, so a later decision is never silently lost —
 * unless `force`.
 *
 * @param entryId - The `ranking_changed` audit row id.
 * @param opts - Why (recorded), and `force` to revert over later changes.
 * @param cwd - Project root.
 * @returns The task id, the reverted fields and the new audit row id.
 * @throws {CleoError} When the entry is not a ranking change, or a field
 *   changed since and `force` is not set.
 * @task T12693
 */
export async function revertRankingChange(
  entryId: string,
  opts: { reason?: string; force?: boolean } = {},
  cwd?: string,
): Promise<{ taskId: string; fields: RankingField[]; revertedTo: Partial<RankingSnapshot> }> {
  const accessor = await getTaskAccessor(cwd);
  const [row] = await accessor.queryAuditLog({ ids: [entryId], actions: [RANKING_CHANGED_ACTION] });
  if (!row) {
    throw new CleoError(ExitCode.NOT_FOUND, `No ranking change ${entryId}`, {
      fix: 'cleo history ranking <taskId>  # lists ranking changes with their ids',
    });
  }
  const change = parseRow(row);
  const task = await accessor.loadSingleTask(change.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${change.taskId} no longer exists`);
  }
  const current = rankingSnapshot(task);
  const moved = change.fields.filter((field) => {
    const now = current[field];
    const then = change.after[field];
    return field === 'depends'
      ? [...(now as string[])].sort().join('\0') !==
          [...((then as string[] | undefined) ?? [])].sort().join('\0')
      : now !== (then ?? null);
  });
  if (moved.length > 0 && !opts.force) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `${change.taskId}'s ${moved.join(', ')} changed again after ${entryId}; reverting would discard that later change`,
      { fix: `cleo history ranking ${change.taskId}  # or re-run with --force` },
    );
  }
  const { updateTask } = await import('./update.js');
  const back = change.before;
  await updateTask(
    {
      taskId: change.taskId,
      ...(change.fields.includes('priority') && back.priority ? { priority: back.priority } : {}),
      ...(change.fields.includes('severity') ? { severity: back.severity ?? null } : {}),
      ...(change.fields.includes('kind') && back.kind ? { kind: back.kind } : {}),
      ...(change.fields.includes('depends') ? { depends: back.depends ?? [] } : {}),
      reason: `revert ${entryId}${opts.reason?.trim() ? `: ${opts.reason.trim()}` : ''}`,
      rankingSource: 'revert',
    },
    cwd,
    accessor,
  );
  return { taskId: change.taskId, fields: change.fields, revertedTo: back };
}
