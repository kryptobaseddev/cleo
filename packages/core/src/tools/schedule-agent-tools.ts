/**
 * Cron / todo agent-tool family — `todo_add` / `todo_list` / `cron_schedule`
 * (T11950 · M7 · epic T11456 · SG-TOOLS).
 *
 * Surfaces the EXISTING task store to the agent loop as `agent`-toolset tools that
 * work daemon-OFF:
 *
 *   - **`todo_add`** — create a task, DELEGATING to the existing
 *     {@link import('../tasks/ops.js')}'s `tasksAddOp` (the same path `cleo add`
 *     uses). No new table, no new schema.
 *   - **`todo_list`** — list tasks, DELEGATING to `tasksListOp` (the same path
 *     `cleo list` uses).
 *   - **`cron_schedule`** — register a recurring schedule. The schedule store now
 *     exists (the `schedules` table + leased Gate-3 accessor `store/schedule-store.ts`,
 *     T11962 under T11679), so this tool DELEGATES to {@link ScheduleStore.add} and
 *     persists a row daemon-OFF (a future daemon scheduler consumes the SAME table
 *     as a separate reader). It stays REGISTERED-but-capability-gated: its
 *     {@link AvailabilityCheck} hides it until a host advertises a schedule store
 *     (`capabilities.scheduleStore === true`) so a host that has opted out of the
 *     schedule domain does not surface it; invoking it without the store still
 *     returns a typed `E_SCHEDULE_STORE_UNAVAILABLE` failure. `todo_*` are always
 *     available daemon-OFF.
 *
 * ## Why a seam, not a hardcoded import (testing + Gate-11)
 *
 * The task ops are injected through the {@link TaskOps} seam, defaulting to the
 * real `ops` functions. The unit test injects a FAKE store and asserts delegation
 * + schema validation WITHOUT opening a real `tasks.db`. The tools are DEFINED
 * here under `packages/core/src/tools` and CONSUME the task subsystem — they
 * construct no new atomic primitive (Gate-11).
 *
 * ## Gate-13
 *
 * No model/transport/provider client is constructed here — task CRUD is a local
 * SQLite operation. There is no chokepoint concern.
 *
 * @epic T11456
 * @task T11950
 * @see ../tasks/ops.js — `tasksAddOp` / `tasksListOp` (the ops this family delegates to)
 * @see ./exec-code-agent-tool.js — the injectable-seam + capability-gated availability pattern mirrored here
 */

import type { TaskPriority, TaskStatus, TaskType } from '@cleocode/contracts';
import { z } from 'zod';
import { resolveOrCwd } from '../paths.js';
import type { AddTaskResult } from '../tasks/add.js';
import type { ListTasksResult } from '../tasks/list.js';
import {
  type AgentToolRegistry,
  ALWAYS_AVAILABLE,
  type AvailabilityCheck,
} from './agent-registry.js';

/**
 * The task store operations the `todo_*` tools delegate to. Each member has the
 * SAME signature as the corresponding `ops` function. Injectable so the unit test
 * can supply a fake store; defaults to the real ops in production.
 */
export interface TaskOps {
  /** Create a task (→ `tasksAddOp`). */
  readonly add: (
    projectRoot: string,
    params: {
      title: string;
      description?: string;
      parent?: string;
      priority?: TaskPriority;
      type?: TaskType;
      acceptance?: string[];
    },
  ) => Promise<AddTaskResult>;
  /** List tasks (→ `tasksListOp`). */
  readonly list: (
    projectRoot: string,
    params: {
      parent?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      type?: TaskType;
      limit?: number;
    },
  ) => Promise<ListTasksResult>;
}

/**
 * The result `cron_schedule` returns: on success the minted `scheduleId` of the
 * persisted row; on failure a typed, non-throwing error (e.g. when no schedule
 * store backs the host). The tool is registered (catalog-stable) and gated on the
 * `scheduleStore` host capability.
 */
export interface CronScheduleResult {
  /** Whether a schedule row was registered. */
  readonly ok: boolean;
  /** The registered schedule's ID (present on success). */
  readonly scheduleId?: string;
  /** A stable code + message for why scheduling failed (present on failure). */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * The schedule-store operation the `cron_schedule` tool delegates to. Injectable
 * so the unit test can supply a fake store; defaults to the real Gate-3 accessor
 * (`store/schedule-store.ts`) opened through the {@link openDualScopeDb} chokepoint.
 */
export interface ScheduleStore {
  /**
   * Register a recurring schedule and return its minted opaque handle.
   *
   * @param projectRoot - The project root whose `cleo.db` the schedule persists in.
   * @param params - The cron expression + task template (title / description).
   * @returns The minted `sched-<token>` handle.
   */
  readonly add: (
    projectRoot: string,
    params: { cron: string; title: string; description?: string },
  ) => Promise<string>;
}

/**
 * Available only when the host advertises a schedule store
 * (`capabilities.scheduleStore === true`). The schedule store now EXISTS (the
 * `schedules` table + leased Gate-3 accessor, T11962 under T11679), so the gate is
 * a host POLICY/capability switch — a host that has opted out of the schedule
 * domain does not surface `cron_schedule`. Registration of a schedule row persists
 * WITHOUT a live daemon (the chokepoint serializes the single in-process writer);
 * a future daemon scheduler consumes the same table as a separate reader.
 */
export const scheduleStoreAvailable: AvailabilityCheck = (ctx) =>
  ctx.capabilities?.scheduleStore === true;

/** Options for {@link registerScheduleAgentTools} — all injectable for testing. */
export interface ScheduleAgentToolOptions {
  /** The task ops seam. Defaults to the real `tasksAddOp` / `tasksListOp`. */
  readonly tasks?: TaskOps;
  /**
   * The schedule-store seam `cron_schedule` delegates to. Defaults to the real
   * Gate-3 accessor (`store/schedule-store.ts`). Injected in tests with a fake
   * store so registration is asserted WITHOUT opening a real `cleo.db`.
   */
  readonly schedule?: ScheduleStore;
  /**
   * The project root threaded into every op (defaults to the resolved project
   * root via {@link resolveOrCwd} — never a bare `process.cwd()` in core, T9584).
   */
  readonly projectRoot?: string;
}

/**
 * Build the real task-ops seam by lazily importing the existing `ops` module.
 * Lazy so this tool module stays import-time side-effect-free; the import happens
 * only when the real ops are first needed.
 *
 * @returns The production {@link TaskOps}.
 */
async function realTaskOps(): Promise<TaskOps> {
  const { tasksAddOp, tasksListOp } = await import('../tasks/ops.js');
  return {
    add: (root, params) => tasksAddOp(root, params),
    list: (root, params) => tasksListOp(root, params),
  };
}

/**
 * Build the real schedule-store seam by lazily importing the Gate-3 accessor.
 * Lazy so this tool module stays import-time side-effect-free; the import (and the
 * `cleo.db` open) happens only when `cron_schedule` first fires. The accessor
 * routes through {@link openDualScopeDb} (the dual-scope chokepoint) — it NEVER
 * opens a raw handle.
 *
 * @returns The production {@link ScheduleStore}.
 */
async function realScheduleStore(): Promise<ScheduleStore> {
  const { getScheduleNativeDb, addSchedule } = await import('../store/schedule-store.js');
  return {
    add: async (root, params) => {
      const native = await getScheduleNativeDb(root);
      return addSchedule(native, {
        cronExpr: params.cron,
        title: params.title,
        description: params.description,
      });
    },
  };
}

/**
 * Register the cron / todo agent-tool family into `registry`. Pure registration —
 * no `tasks.db` is opened, no row is written here; all of that happens later
 * inside each tool's `execute` through the injected (or lazily-resolved real)
 * ops. Import-time side-effect-free.
 *
 * @param registry - The registry to populate.
 * @param options - Injectable task ops / project root (for testing).
 */
export function registerScheduleAgentTools(
  registry: AgentToolRegistry,
  options: ScheduleAgentToolOptions = {},
): void {
  const projectRoot = resolveOrCwd(options.projectRoot);

  // --- todo_add (→ tasksAddOp) ---------------------------------------------
  registry.register({
    name: 'todo_add',
    // 'fs' — persists a row to the local tasks store (its strongest side-effect surface).
    class: 'fs',
    description:
      'Add a task (todo) to the project task store. Delegates to the same path as `cleo add`. ' +
      'Returns the created task. Always available daemon-OFF.',
    toolset: 'agent',
    stateless: false,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      title: z.string().describe('The task title.'),
      description: z.string().optional().describe('A longer task description.'),
      parent: z.string().optional().describe('Parent task/epic ID to nest this task under.'),
      priority: z
        .enum(['critical', 'high', 'medium', 'low'])
        .optional()
        .describe('Task priority (default medium).'),
      acceptance: z
        .array(z.string())
        .optional()
        .describe('Acceptance criteria — one entry per criterion.'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const tasks = options.tasks ?? (await realTaskOps());
      const title = String(rawArgs.title);
      const description =
        rawArgs.description === undefined ? undefined : String(rawArgs.description);
      const parent = rawArgs.parent === undefined ? undefined : String(rawArgs.parent);
      const priority =
        rawArgs.priority === 'critical' ||
        rawArgs.priority === 'high' ||
        rawArgs.priority === 'medium' ||
        rawArgs.priority === 'low'
          ? rawArgs.priority
          : undefined;
      const acceptance = Array.isArray(rawArgs.acceptance)
        ? rawArgs.acceptance.map(String)
        : undefined;
      return tasks.add(projectRoot, {
        title,
        description,
        parent,
        priority,
        type: 'task',
        acceptance,
      });
    },
  });

  // --- todo_list (→ tasksListOp) -------------------------------------------
  registry.register({
    name: 'todo_list',
    // 'search' — a local read-query of the tasks store.
    class: 'search',
    description:
      'List tasks (todos) from the project task store, optionally filtered by parent / status / ' +
      'priority. Delegates to the same path as `cleo list`. Always available daemon-OFF.',
    toolset: 'agent',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      parent: z.string().optional().describe('Only list direct children of this task/epic ID.'),
      status: z.string().optional().describe('Filter by status (e.g. pending, in_progress, done).'),
      priority: z
        .enum(['critical', 'high', 'medium', 'low'])
        .optional()
        .describe('Filter by priority.'),
      limit: z.number().int().positive().optional().describe('Maximum number of tasks to return.'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const tasks = options.tasks ?? (await realTaskOps());
      const parent = rawArgs.parent === undefined ? undefined : String(rawArgs.parent);
      const status =
        rawArgs.status === undefined ? undefined : (String(rawArgs.status) as TaskStatus);
      const priority =
        rawArgs.priority === 'critical' ||
        rawArgs.priority === 'high' ||
        rawArgs.priority === 'medium' ||
        rawArgs.priority === 'low'
          ? rawArgs.priority
          : undefined;
      const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : undefined;
      return tasks.list(projectRoot, { parent, status, priority, limit });
    },
  });

  // --- cron_schedule (persists a row through the leased Gate-3 store) -------
  registry.register({
    name: 'cron_schedule',
    // 'fs' — registering a schedule persists a store row.
    class: 'fs',
    description:
      'Register a recurring schedule (cron expression → task template). Persists a row to the ' +
      'project schedule store and returns its schedule ID. Gated on the host advertising a ' +
      'schedule store; persists daemon-OFF (a daemon scheduler consumes the table separately).',
    toolset: 'agent',
    stateless: false,
    available: scheduleStoreAvailable,
    parameters: z.object({
      cron: z.string().describe('A cron expression for the recurrence (e.g. "0 9 * * 1").'),
      title: z.string().describe('The title of the task to create on each fire.'),
      description: z
        .string()
        .optional()
        .describe('A description for the task created on each fire.'),
    }),
    execute: async (rawArgs): Promise<CronScheduleResult> => {
      // Delegate to the schedule-store seam (the real Gate-3 accessor, or an
      // injected fake in tests). The accessor routes through openDualScopeDb — no
      // raw db open here. A store/IO failure is returned as a typed, non-throwing
      // result so the agent loop sees a structured failure rather than an
      // exception.
      const cron = String(rawArgs.cron);
      const title = String(rawArgs.title);
      const description =
        rawArgs.description === undefined ? undefined : String(rawArgs.description);
      try {
        const schedule = options.schedule ?? (await realScheduleStore());
        const scheduleId = await schedule.add(projectRoot, { cron, title, description });
        return { ok: true, scheduleId };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'E_SCHEDULE_STORE_UNAVAILABLE',
            message: `failed to register schedule: ${err instanceof Error ? err.message : String(err)}`,
          },
        };
      }
    },
  });
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. Aliases
 * {@link registerScheduleAgentTools} so a future scan-dir discovery (or the
 * built-in aggregator) can call it uniformly with the other agent-tool modules.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerScheduleAgentTools(registry);
}
