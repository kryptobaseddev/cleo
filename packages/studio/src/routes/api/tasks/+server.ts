/**
 * GET /api/tasks — list tasks with optional filters, enriched with rollup state.
 *
 * Query params:
 *   status  — pending | active | done | archived (single value)
 *   priority — critical | high | medium | low (single value)
 *   type    — epic | task | subtask (single value)
 *   limit   — max rows (default 200, max 1000)
 *
 * Response shape:
 *   {
 *     tasks:   TaskRow[]               // task row + rollup fields merged
 *     rollups: TaskRollupPayload[]     // canonical projection from core
 *     total:   number
 *   }
 *
 * Architecture (T948, T943):
 *   - Uses `@cleocode/core` lifecycle + tasks modules directly via narrow
 *     subpath imports. NO raw SQL is issued in this route.
 *   - `listTasks({ sortByPriority: true, excludeArchived: true, ... })`
 *     preserves the legacy priority-first ordering without hand-rolled SQL.
 *   - `computeTaskRollups(ids, accessor)` gives every row the same canonical
 *     shape consumed by Studio + CLI + tests, so `/tasks` and
 *     `/tasks/pipeline` can no longer disagree about a task's state.
 *   - `computeTaskViews(ids, accessor)` (T943) adds the canonical `TaskView`
 *     for each row — `readyToComplete`, `nextAction`, `lifecycleProgress`, and
 *     `gatesStatus` are included in the `views` field of the response so
 *     consumers do not have to issue per-task `/api/tasks/[id]` calls just to
 *     check action state.
 *   - Narrow imports (`@cleocode/core/tasks/list`,
 *     `@cleocode/core/lifecycle/rollup`, `@cleocode/core/store/data-accessor`)
 *     avoid pulling the full Cleo facade — which transitively drags in
 *     llmtxt + loro-crdt WASM and breaks Vite's Rollup bundler.
 *   - Response `tasks` rows retain the historic snake_case columns the UI
 *     shape expected so external consumers of `/api/tasks` do not break.
 *
 * ## Write path (T11788 · E2-STUDIO-DATA-LAYER)
 *
 *   - POST   /api/tasks        — create a task
 *   - PATCH  /api/tasks/[id]   — patch fields (status/priority/assignee/title)
 *     (the collection PATCH/DELETE live on the `[id]` route; see below)
 *
 * Per AC1 the board write path routes through the `/v1` gateway SDK client
 * (`@cleocode/core/gateway-client` via `_dispatch.ts`), NOT a direct in-process
 * core DB write — gateway-first with an in-process `@cleocode/core` fallback so
 * the board stays usable in Studio dev without a running `cleo daemon serve`.
 * The fallback uses the SAME engine the gateway dispatches into; it is never a
 * raw DB write and never bypasses the mutation envelope. Secrets never cross
 * the wire — the request body carries only the task fields.
 *
 * @task T948
 * @task T943
 * @task T11788
 * @epic T11557
 */

import type {
  Task,
  TaskPriority,
  TaskRollupPayload,
  TaskStatus,
  TaskType,
} from '@cleocode/contracts';
import { computeTaskRollups } from '@cleocode/core/lifecycle/rollup';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { computeTaskViews, type TaskView } from '@cleocode/core/tasks';
import { addTask } from '@cleocode/core/tasks/add';
import { listTasks } from '@cleocode/core/tasks/list';
import { json } from '@sveltejs/kit';
import {
  err,
  gatewayClient,
  isGatewayUnreachable,
  isParseError,
  ok,
  optionalString,
  parseJsonBody,
  requireString,
} from './_dispatch.js';
import type { RequestHandler } from './$types';

/**
 * Back-compat row shape the pre-T948 raw-SQL endpoint produced.
 *
 * Exported so downstream TypeScript consumers can type their fetch
 * responses without re-declaring the snake_case contract.
 */
export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  pipeline_stage: string | null;
  size: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  verification_json: string | null;
  acceptance_json: string | null;
}

/** Envelope returned by GET /api/tasks. */
export interface TasksResponse {
  /** Legacy row shape (snake_case) for back-compat with pre-T948 clients. */
  tasks: TaskRow[];
  /** Canonical rollup projection (T948 fix for the /tasks vs /pipeline drift). */
  rollups: TaskRollupPayload[];
  /**
   * Canonical task views produced by `computeTaskViews` (T943).
   *
   * Includes `status`, `pipelineStage`, `readyToComplete`, `nextAction`,
   * `lifecycleProgress`, `gatesStatus`, and `childRollup` for each task.
   * Aligned with `tasks` by index — `views[i]` corresponds to `tasks[i]`.
   */
  views: TaskView[];
  /** Number of rows returned. */
  total: number;
}

const VALID_STATUS: ReadonlySet<TaskStatus> = new Set([
  'pending',
  'active',
  'blocked',
  'done',
  'cancelled',
  'archived',
  'proposed',
]);
const VALID_PRIORITY: ReadonlySet<TaskPriority> = new Set(['critical', 'high', 'medium', 'low']);
const VALID_TYPE: ReadonlySet<TaskType> = new Set(['epic', 'task', 'subtask']);

/**
 * Parse a query-string enum value, returning `undefined` when the raw value
 * is missing or not in the allow-list. Single-value form only — the old
 * comma-separated syntax was dropped in T948 because the facade does not
 * support `IN (…)` filters. Clients needing multi-value filtering should
 * issue multiple requests or upgrade to `/tasks/pipeline`.
 */
function parseEnum<T extends string>(raw: string | null, allowed: ReadonlySet<T>): T | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  return (allowed as ReadonlySet<string>).has(trimmed) ? (trimmed as T) : undefined;
}

/**
 * Project a core `Task` row into the legacy snake_case shape so pre-T948
 * consumers of `/api/tasks` keep working. Only the fields the prior raw
 * SELECT returned are surfaced.
 *
 * @remarks
 * `verification_json` and `acceptance_json` are re-serialised from the parsed
 * `Task.verification` / `Task.acceptance` fields so the pipeline UI's
 * `JSON.parse(row.verification_json)` path keeps working post-T948.
 */
export function _toLegacyRow(task: Task): TaskRow {
  return {
    id: task.id,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    type: task.type ?? 'task',
    parent_id: task.parentId ?? null,
    pipeline_stage: task.pipelineStage ?? null,
    size: task.size ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt ?? task.createdAt,
    completed_at: task.completedAt ?? null,
    verification_json:
      task.verification !== undefined && task.verification !== null
        ? JSON.stringify(task.verification)
        : null,
    acceptance_json:
      task.acceptance !== undefined && task.acceptance.length > 0
        ? JSON.stringify(task.acceptance)
        : null,
  };
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const status = parseEnum<TaskStatus>(url.searchParams.get('status'), VALID_STATUS);
  const priority = parseEnum<TaskPriority>(url.searchParams.get('priority'), VALID_PRIORITY);
  const type = parseEnum<TaskType>(url.searchParams.get('type'), VALID_TYPE);
  const rawLimit = Number(url.searchParams.get('limit') ?? '200');
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 1000) : 200;

  try {
    // Open a DataAccessor bound to THIS project's tasks.db. Core's
    // getNativeTasksDb() is a process-level singleton keyed on `cwd`,
    // so calling getTaskAccessor(projectPath) sets it up for the batch rollup.
    const accessor = await getTaskAccessor(ctx.projectPath);
    // Facade call — ZERO raw SQL in this route post-T948.
    const result = await listTasks(
      {
        status,
        priority,
        type,
        limit,
        excludeArchived: status !== 'archived',
        sortByPriority: true,
      },
      ctx.projectPath,
      accessor,
    );

    const tasks = result.tasks;
    const ids = tasks.map((t) => t.id);
    // computeTaskRollups (T948) and computeTaskViews (T943) both use the
    // same accessor — they share the underlying native DB handle so there
    // is no redundant connection overhead.
    const [rollups, views] = await Promise.all([
      computeTaskRollups(ids, accessor),
      computeTaskViews(ids, accessor),
    ]);

    const body: TasksResponse = {
      tasks: tasks.map(_toLegacyRow),
      rollups,
      views,
      total: tasks.length,
    };
    return json(body);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};

/** Data returned on a successful create. */
export interface CreateTaskData {
  /** The created task id. */
  taskId: string;
  /** Which write path serviced the create. */
  via: 'gateway' | 'core';
}

/** The `tasks.add` request body shape forwarded to the gateway SDK. */
interface AddBody {
  title: string;
  parent?: string;
  priority?: TaskPriority;
  acceptance?: string[];
}

/** The bound `tasks.add` method, re-typed to the success envelope we read. */
type AddInvoker = (opts: { body: AddBody }) => Promise<{
  data?: {
    success?: boolean;
    data?: { created?: string[]; ids?: string[] };
    error?: { message?: string };
  };
}>;

const VALID_PRIORITY_W: ReadonlySet<TaskPriority> = new Set(['critical', 'high', 'medium', 'low']);

/**
 * POST /api/tasks — create a task through the `/v1` gateway SDK client
 * (gateway-first, in-process core fallback). T11788 · AC1.
 *
 * Body: `{ title, parent?, priority?, acceptance?: string[] }`. `acceptance`
 * is required by the create contract (ADR-066) when reaching the core engine,
 * so an empty/absent list is rejected with a typed `E_VALIDATION`.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json(err('E_DB_UNAVAILABLE', 'tasks.db unavailable'), { status: 503 });
  }

  const body = await parseJsonBody(request);
  if (isParseError(body)) {
    return json(err('E_VALIDATION', body._parseError), { status: 400 });
  }

  const titleR = requireString(body, 'title', 500);
  if (!titleR.ok) return json(err('E_VALIDATION', titleR.message), { status: 400 });

  const parent = optionalString(body, 'parent');
  const rawPriority = optionalString(body, 'priority');
  const priority =
    rawPriority !== undefined && VALID_PRIORITY_W.has(rawPriority as TaskPriority)
      ? (rawPriority as TaskPriority)
      : undefined;

  // Acceptance — required by the create contract (ADR-066). Accept a string[]
  // or a single newline/pipe-delimited string for ergonomics.
  const rawAcceptance = body.acceptance;
  let acceptance: string[] = [];
  if (Array.isArray(rawAcceptance)) {
    acceptance = rawAcceptance.filter((a): a is string => typeof a === 'string' && a.trim() !== '');
  } else if (typeof rawAcceptance === 'string' && rawAcceptance.trim() !== '') {
    acceptance = rawAcceptance
      .split(/[\n|]/)
      .map((a) => a.trim())
      .filter((a) => a !== '');
  }
  if (acceptance.length === 0) {
    return json(err('E_VALIDATION', 'At least one acceptance criterion is required'), {
      status: 400,
    });
  }

  const addBody: AddBody = {
    title: titleR.value,
    acceptance,
    ...(parent !== undefined ? { parent } : {}),
    ...(priority !== undefined ? { priority } : {}),
  };

  // 1) Gateway-first.
  try {
    const cleo = gatewayClient();
    const add = cleo.tasks.add as unknown as AddInvoker;
    const res = await add({ body: addBody });
    const envelope = res.data;
    if (envelope && envelope.success === false) {
      return json(err('E_GATEWAY_REJECTED', envelope.error?.message ?? 'Create rejected'), {
        status: 409,
      });
    }
    const createdId = envelope?.data?.created?.[0] ?? envelope?.data?.ids?.[0] ?? '';
    return json(ok<CreateTaskData>({ taskId: createdId, via: 'gateway' }));
  } catch (gatewayErr) {
    if (!isGatewayUnreachable(gatewayErr)) {
      const msg = gatewayErr instanceof Error ? gatewayErr.message : 'Gateway create failed';
      return json(err('E_GATEWAY_ERROR', msg), { status: 502 });
    }
    // Gateway down → in-process core fallback.
  }

  // 2) Core fallback — same engine the gateway dispatches into.
  try {
    const result = await addTask(
      {
        title: titleR.value,
        acceptance,
        ...(parent !== undefined ? { parentId: parent } : {}),
        ...(priority !== undefined ? { priority } : {}),
      },
      ctx.projectPath,
    );
    return json(ok<CreateTaskData>({ taskId: result.task.id, via: 'core' }));
  } catch (coreErr) {
    const e = coreErr as { code?: number; message?: string };
    return json(err('E_CREATE_FAILED', e?.message ?? 'Failed to create task'), { status: 500 });
  }
};
