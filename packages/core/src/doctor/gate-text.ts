/**
 * `cleo doctor gate-text` — text acceptance criteria that hold a typed gate's JSON.
 *
 * Before T12292 a typed gate passed as text acceptance (`cleo add --acceptance
 * '{"kind":"test",…}'`) was stored as prose: it carried no gate meaning, and
 * nothing ran it. Writes now refuse that input, so a task still holding such a
 * row cannot be decomposed or have its acceptance rewritten. This check lists
 * those tasks and, with `apply`, converts each row to the typed gate through
 * {@link reqConvertGateText} (the same checks as `cleo req add`). It is a dry
 * run unless `apply` is set. Terminal tasks are listed, never rewritten.
 *
 * @module
 * @task T14635
 */

import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts/status-registry.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { isTypedGateJson } from '../tasks/acceptance-input.js';
import { type GateTextConversion, reqConvertGateText } from '../tasks/req.js';

/** One task holding gate-JSON text criteria. */
export interface GateTextTaskEntry {
  /** Task id. */
  readonly taskId: string;
  /** Task status; a terminal task is never rewritten. */
  readonly status: string;
  /** Each gate-JSON text criterion, with its gate or the reason it cannot convert. */
  readonly conversions: readonly GateTextConversion[];
  /** Criteria converted by this run (0 in a dry run). */
  readonly applied: number;
  /** Why the task was not converted as a whole (terminal, or its rows disagree); null otherwise. */
  readonly skipped: string | null;
}

/** Outcome of {@link scanGateTextAcceptance}. */
export interface GateTextReport {
  /** `false` for a dry run (the default). */
  readonly applied: boolean;
  /** Non-archived tasks examined. */
  readonly tasksScanned: number;
  /** Gate-JSON text criteria found, before any conversion. */
  readonly found: number;
  /** Criteria converted to typed gates by this run. */
  readonly converted: number;
  /** Criteria still stored as gate-JSON text after this run. */
  readonly remaining: number;
  /** Every task holding at least one gate-JSON text criterion. */
  readonly tasks: readonly GateTextTaskEntry[];
}

/**
 * Find — and with `apply: true`, convert — text criteria that hold a typed gate's JSON.
 *
 * @param cwd - Project root.
 * @param opts - `apply: true` converts every convertible criterion on open tasks.
 * @returns What was found, converted and left.
 * @example
 * ```ts
 * const preview = await scanGateTextAcceptance(projectRoot);
 * if (preview.found > 0) await scanGateTextAcceptance(projectRoot, { apply: true });
 * ```
 * @task T14635
 */
export async function scanGateTextAcceptance(
  cwd: string,
  opts: { apply?: boolean } = {},
): Promise<GateTextReport> {
  const apply = opts.apply === true;
  const accessor = await getTaskAccessor(cwd);
  const { tasks } = await accessor.queryTasks({});
  const entries: GateTextTaskEntry[] = [];
  for (const task of tasks) {
    const holdsGateText = (task.acceptance ?? []).some(
      (item) => typeof item === 'string' && isTypedGateJson(item.trim()),
    );
    if (!holdsGateText) continue;
    const terminal = TERMINAL_TASK_STATUSES.has(task.status);
    const preview = await reqConvertGateText(cwd, task.id, false, accessor);
    let result = preview;
    let skipped: string | null = terminal ? `task is ${task.status}` : null;
    if (apply && !terminal && preview.conversions.some((c) => c.gate)) {
      try {
        result = await reqConvertGateText(cwd, task.id, true, accessor);
      } catch (err) {
        if (!(err instanceof CleoError)) throw err;
        skipped = err.message;
      }
    }
    entries.push({
      taskId: task.id,
      status: task.status,
      conversions: result.conversions,
      applied: result.applied,
      skipped,
    });
  }
  const found = entries.reduce((n, e) => n + e.conversions.length, 0);
  const converted = entries.reduce((n, e) => n + e.applied, 0);
  return {
    applied: apply,
    tasksScanned: tasks.length,
    found,
    converted,
    remaining: found - converted,
    tasks: entries,
  };
}
