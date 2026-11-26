/**
 * `cleo doctor gate-text` — text acceptance criteria that hold a typed gate's JSON.
 *
 * Before T12292 a typed gate passed as text acceptance (`cleo add --acceptance
 * '{"kind":"test",…}'`) was stored as prose: it carried no gate meaning, and
 * nothing ran it. Writes now refuse that input, so a task still holding such a
 * row cannot be decomposed or have its acceptance rewritten. This check lists
 * those tasks and, with `apply`, converts each row to the typed gate through
 * {@link reqConvertGateText} (the same checks as `cleo req add`). It is a dry
 * run unless `apply` is set. A task in an AC-locked stage converts only with a
 * `reason` (audited like `cleo update --acceptance --reason`); without one it
 * is listed with the exact command. Terminal tasks are listed for information,
 * never rewritten, and do not count as remaining.
 *
 * @module
 * @task T14635
 */

import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts/status-registry.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { isAcceptanceLocked } from '../tasks/ac-immutability.js';
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
  /** Why the task was not converted as a whole (terminal, locked, or its rows disagree); null otherwise. */
  readonly skipped: string | null;
  /** The command that converts a task skipped for a locked stage; null otherwise. */
  readonly fix: string | null;
  /** True for a terminal task: listed for information only. */
  readonly terminal: boolean;
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
  /** Criteria on open tasks still stored as gate-JSON text after this run (decides the exit code). */
  readonly remaining: number;
  /** Criteria on terminal tasks: informational, never converted, not counted as remaining. */
  readonly terminal: number;
  /** Every task holding at least one gate-JSON text criterion. */
  readonly tasks: readonly GateTextTaskEntry[];
}

/**
 * Find — and with `apply: true`, convert — text criteria that hold a typed gate's JSON.
 *
 * @param cwd - Project root.
 * @param opts - `apply: true` converts every convertible criterion on open tasks;
 *   `reason` authorizes the rewrite on tasks in an AC-locked stage.
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
  opts: { apply?: boolean; reason?: string } = {},
): Promise<GateTextReport> {
  const apply = opts.apply === true;
  const reason = opts.reason?.trim() || undefined;
  const accessor = await getTaskAccessor(cwd);
  const { tasks } = await accessor.queryTasks({});
  const entries: GateTextTaskEntry[] = [];
  for (const task of tasks) {
    const holdsGateText = (task.acceptance ?? []).some(
      (item) => typeof item === 'string' && isTypedGateJson(item.trim()),
    );
    if (!holdsGateText) continue;
    const terminal = TERMINAL_TASK_STATUSES.has(task.status);
    const locked = !terminal && !reason && isAcceptanceLocked(task.pipelineStage);
    const preview = await reqConvertGateText(cwd, task.id, false, { accessor });
    let result = preview;
    let skipped: string | null = terminal
      ? `task is ${task.status}`
      : locked
        ? `acceptance is locked at stage ${task.pipelineStage}; converting needs a reason`
        : null;
    if (apply && skipped === null && preview.conversions.some((c) => c.gate)) {
      try {
        result = await reqConvertGateText(cwd, task.id, true, { accessor, reason });
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
      fix: locked
        ? 'cleo doctor gate-text --apply --reason "<why the conversion is acceptable>"'
        : null,
      terminal,
    });
  }
  const count = (list: readonly GateTextTaskEntry[]): number =>
    list.reduce((n, e) => n + e.conversions.length, 0);
  const found = count(entries);
  const terminalCount = count(entries.filter((e) => e.terminal));
  const converted = entries.reduce((n, e) => n + e.applied, 0);
  return {
    applied: apply,
    tasksScanned: tasks.length,
    found,
    converted,
    remaining: found - terminalCount - converted,
    terminal: terminalCount,
    tasks: entries,
  };
}
