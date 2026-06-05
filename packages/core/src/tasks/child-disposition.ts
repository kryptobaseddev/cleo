/**
 * Shared child-disposition guard for terminal-status writers (T11811 AC2).
 *
 * Three writers can drive a task into a terminal state: `coreTaskCancel`
 * (`cleo cancel`), `updateTask` with `status='cancelled'`
 * (`cleo update --status cancelled`), and `archiveTasks` (`cleo archive`).
 * Historically only `coreTaskCancel` consulted the child set before
 * terminalising a parent — the other two flipped the parent and SILENTLY
 * STRANDED its still-active children under a terminal (or removed) parent
 * (the T9031/T9044 strand class).
 *
 * The orphan-prevention guard collapses that to ONE decision: before any
 * terminal-status writer terminalises a parent, it MUST consult this module.
 * The lowest-blast-radius default — matching {@link coreTaskCancel}'s own
 * `children: 'block'` default — is to REFUSE the write when the parent still
 * has active (non-terminal) children, surfacing {@link ExitCode.HAS_CHILDREN}
 * and pointing the operator at `cleo cancel <id> --children …`, where the full
 * `block | cascade | reparent` disposition matrix lives.
 *
 * This is a read-only guard: it queries the child set and throws on violation;
 * it performs no writes. The actual child disposition (cascade/reparent) is
 * owned by `cleo cancel` via {@link coreTaskCancel} so there is exactly one
 * place that mutates children on cancellation.
 *
 * @task T11811 — orphan-prevention guard (AC2: one disposition path)
 * @saga T10400
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { DataAccessor } from '../store/data-accessor.js';

/**
 * Verb describing why a parent is being terminalised — woven into the
 * {@link ExitCode.HAS_CHILDREN} message so the operator sees which write was
 * refused.
 */
export type TerminalDispositionVerb = 'cancel' | 'archive';

/**
 * Refuse to terminalise a parent that still has active children.
 *
 * Counts the parent's non-terminal children via
 * {@link DataAccessor.countActiveChildren} (the canonical "active" =
 * not-in-`TERMINAL_TASK_STATUSES` count). When that count is non-zero the
 * function throws {@link CleoError} with {@link ExitCode.HAS_CHILDREN}, a
 * `fix:` that routes the operator to `cleo cancel <id> --children …`, and a
 * structured `details` payload carrying the live child count. When the parent
 * has zero active children it returns normally and the caller proceeds with
 * the terminal write — no strand is possible.
 *
 * Routing every terminal-status writer through this single guard means the
 * child-disposition decision lives in exactly one place (AC2): the only way to
 * dispose of active children on cancellation is the explicit
 * `cleo cancel <id> --children cascade|reparent` surface.
 *
 * @param accessor - Open data accessor for the active task store.
 * @param taskId - The parent task ID being terminalised.
 * @param verb - Which terminal write is being attempted (`cancel`/`archive`).
 * @throws {CleoError} {@link ExitCode.HAS_CHILDREN} when the parent has ≥ 1
 *   active (non-terminal) child.
 *
 * @example
 * ```typescript
 * // Inside the update --status cancelled path:
 * await assertNoActiveChildrenForTerminal(accessor, taskId, 'cancel');
 * // …only reached when the parent has no active children to strand.
 * ```
 */
export async function assertNoActiveChildrenForTerminal(
  accessor: DataAccessor,
  taskId: string,
  verb: TerminalDispositionVerb,
): Promise<void> {
  const activeChildCount = await accessor.countActiveChildren(taskId);
  if (activeChildCount === 0) {
    return;
  }

  const verbNoun = verb === 'archive' ? 'Archiving' : 'Cancelling';
  throw new CleoError(
    ExitCode.HAS_CHILDREN,
    `${verbNoun} ${taskId} would strand ${activeChildCount} active child task(s). ` +
      `Dispose of the children first via \`cleo cancel ${taskId} --children cascade\` ` +
      `(cancel the whole subtree) or \`cleo cancel ${taskId} --children reparent --to <epicId>\` ` +
      `(move them under another parent).`,
    {
      fix:
        `cleo cancel ${taskId} --children cascade   # cancel the subtree, or\n` +
        `cleo cancel ${taskId} --children reparent --to <epicId>   # move children elsewhere`,
      details: {
        field: 'status',
        taskId,
        activeChildCount,
        verb,
      },
    },
  );
}
