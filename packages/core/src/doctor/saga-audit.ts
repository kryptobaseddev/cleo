/**
 * Saga hierarchy audit primitive for `cleo doctor`.
 *
 * Walks every Saga (`type='epic'` + `label='saga'`) and surfaces violations
 * of the ADR-073 §1.2 invariant ladder:
 *
 *   - **I5** — saga `parentId` MUST be NULL.
 *   - **I7** — saga members MUST NOT themselves carry `label='saga'`
 *     (no nested sagas).
 *   - **depth** — saga → member → member-children depth ladder MUST
 *     stay ≤ 3 hops (saga is hop 0, member-Epic is hop 1, the Epic's
 *     direct task children are hop 2, subtasks are hop 3 — anything
 *     deeper is structurally invalid for the saga hierarchy).
 *
 * Plus one soft-drift detector:
 *
 *   - **auto-close-drift** — every member is `status='done'` but the
 *     saga still says `pending` or `active`. ADR-073 §1.3 says a saga
 *     auto-completes when all members do; T10116 implements that closure
 *     hook at the rollup layer, so this branch becomes a regression
 *     detector once T10116 ships.
 *
 * Each violation is actionable — the result carries the offending IDs and
 * the canonical `cleo` command an operator should run to repair it. The
 * doctor CLI converts these into one-line summary rows; the LAFS envelope
 * carries the full structured `SagaAuditResult` payload.
 *
 * Reuses the runtime guards in `packages/core/src/sagas/enforcement.ts`
 * (T10115) so the audit + runtime gate share one definition of "violation".
 *
 * @task T10119
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type {
  SagaAuditEntry,
  SagaAuditResult,
  SagaAuditViolation,
  Task,
} from '@cleocode/contracts';
import { assertSagaInvariantI7, isSagaInvariantViolationError } from '../sagas/index.js';
import { resolveSagaMemberIds } from '../sagas/storage.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { taskList } from '../tasks/list.js';
import { taskShow } from '../tasks/show.js';

/**
 * Maximum saga-hierarchy depth permitted by ADR-073 §1.2 (I5/I7 depth
 * ladder).
 *
 * The hop count is counted FROM the saga row:
 *   - hop 0: the saga itself.
 *   - hop 1: a member Epic linked via `task_relations.type='groups'`.
 *   - hop 2: a direct child of the member Epic (task or subtask).
 *   - hop 3: a grandchild of the member Epic (subtask of subtask is
 *            already over-budget).
 *
 * Anything that lives strictly deeper than the member Epic's direct
 * children violates the depth ladder — sagas are not meant to host
 * deeply-nested trees beneath each member.
 */
const SAGA_HIERARCHY_MAX_DEPTH = 3;

/**
 * Cast a {@link TaskRecord}-shaped row from `taskList` / `taskShow` to the
 * narrower {@link Task} shape the saga enforcement guards expect.
 *
 * The two types share the relevant fields (`id`, `labels`, `parentId`,
 * `depends`) — only the union-typed columns (status/priority/...) widen
 * in `TaskRecord`. A direct structural narrow is safe here.
 */
interface TaskLike {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  parentId?: string | null;
  labels?: string[];
  depends?: string[];
  relates?: Array<{ taskId: string; type: string }>;
}

/**
 * Walk a saga member's sub-tree and return the maximum hop count
 * encountered relative to the saga root.
 *
 * Iterative BFS so we never blow the stack on a wide tree; bounded by
 * `maxDepth + 1` to short-circuit as soon as an over-budget node is
 * found.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param rootMemberId - The saga member Epic's task ID (hop 1 from the saga).
 * @param maxDepth - The hop-budget; iteration stops one level beyond.
 * @returns The deepest hop count reached. Returns `1` for a leaf member,
 *          `maxDepth + 1` if the tree exceeds the budget.
 */
async function measureMemberSubtreeDepth(
  projectRoot: string,
  rootMemberId: string,
  maxDepth: number,
): Promise<number> {
  let frontier: string[] = [rootMemberId];
  let depth = 1; // hop 1: the member Epic itself.
  while (frontier.length > 0 && depth <= maxDepth) {
    const nextFrontier: string[] = [];
    for (const id of frontier) {
      const childResult = await taskList(projectRoot, { parent: id });
      if (!childResult.success || !childResult.data?.tasks) continue;
      for (const child of childResult.data.tasks) {
        const cid = (child as { id?: string }).id;
        if (typeof cid === 'string') {
          nextFrontier.push(cid);
        }
      }
    }
    if (nextFrontier.length === 0) {
      return depth;
    }
    depth += 1;
    frontier = nextFrontier;
  }
  return depth;
}

/**
 * Audit every Saga in the project's task store for ADR-073 §1.2
 * invariant violations and auto-close drift.
 *
 * Read-only — performs zero writes. Safe to invoke from `cleo doctor`
 * without any `--fix`-style flag.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Aggregated result. `count` is the I-invariant + depth
 *          violation total (drives non-zero exit). `driftCount` is the
 *          soft auto-close-drift warning total (does NOT drive exit on
 *          its own).
 *
 * @example
 * ```typescript
 * const audit = await auditSagaHierarchy(projectRoot);
 * for (const v of audit.sagas.flatMap((s) => s.violations)) {
 *   console.log(v.message); // includes offending IDs + repair command
 * }
 * if (audit.count > 0) process.exitCode = 2;
 * ```
 */
export async function auditSagaHierarchy(projectRoot: string): Promise<SagaAuditResult> {
  // Step 1 — list every saga row via type='saga' (T10638: collapsed from
  // dual-shape sweep after T10636 migration).
  const result = await taskList(projectRoot, { type: 'saga' });
  const sagaRows: TaskLike[] = result.success ? (result.data.tasks as TaskLike[]) : [];
  if (sagaRows.length === 0) {
    return { sagas: [], count: 0, driftCount: 0 };
  }

  let totalInvariantViolations = 0;
  let totalDrift = 0;
  const sagas: SagaAuditEntry[] = [];

  for (const sagaRow of sagaRows) {
    if (!sagaRow.id) continue;

    const violations: SagaAuditViolation[] = [];

    // --- I5 check (sagaRow.parentId IS NULL) ---
    // T10638 (E10.W5): sagas are identified by type='saga'. The I5 invariant —
    // `parentId MUST be NULL` (ADR-073 §1.2) — reduces to a direct field check.
    const sagaParentId = sagaRow.parentId ?? null;
    if (sagaParentId !== null && sagaParentId !== '') {
      violations.push({
        kind: 'I5',
        sagaId: sagaRow.id,
        offendingId: sagaRow.id,
        message:
          `Saga ${sagaRow.id} violates I5: parentId=${sagaRow.parentId ?? '<null>'}` +
          ` — run \`cleo saga repair ${sagaRow.id}\``,
        repairCommand: `cleo saga repair ${sagaRow.id}`,
      });
    }

    // --- Resolve members via parent_id containment (T10638) ---
    const accessor = await getTaskAccessor(projectRoot);
    let memberIds: string[] = [];
    try {
      const resolved = await resolveSagaMemberIds(accessor, sagaRow.id);
      memberIds = resolved ?? [];
    } finally {
      await accessor.close();
    }

    let doneCount = 0;

    for (const memberId of memberIds) {
      const memberShow = await taskShow(projectRoot, memberId);
      if (!memberShow.success || !memberShow.data?.task) continue;
      const member = memberShow.data.task as TaskLike;

      if (member.status === 'done') {
        doneCount += 1;
      }

      // --- I7 check (member must NOT be type='saga') ---
      try {
        assertSagaInvariantI7(
          memberId,
          member.labels ?? [],
          sagaRow.id,
          member.type as Task['type'],
        );
      } catch (err) {
        if (isSagaInvariantViolationError(err) && err.diag.invariant === 'I7') {
          violations.push({
            kind: 'I7',
            sagaId: sagaRow.id,
            offendingId: memberId,
            message:
              `Saga ${sagaRow.id} violates I7: member ${memberId} has type=saga` +
              ` — run \`cleo saga detach ${sagaRow.id} ${memberId}\``,
            repairCommand: `cleo saga detach ${sagaRow.id} ${memberId}`,
          });
        }
      }

      // --- depth check (member sub-tree must stay ≤ MAX hops) ---
      const observedDepth = await measureMemberSubtreeDepth(
        projectRoot,
        memberId,
        SAGA_HIERARCHY_MAX_DEPTH,
      );
      if (observedDepth > SAGA_HIERARCHY_MAX_DEPTH) {
        violations.push({
          kind: 'depth',
          sagaId: sagaRow.id,
          offendingId: memberId,
          message:
            `Saga ${sagaRow.id} violates depth ladder: member ${memberId} sub-tree exceeds ` +
            `${SAGA_HIERARCHY_MAX_DEPTH} hops — flatten via \`cleo show ${memberId}\` then ` +
            `reorganize`,
          repairCommand: `cleo show ${memberId}`,
        });
      }
    }

    // --- auto-close-drift (soft warning, does NOT count as invariant break) ---
    const totalMembers = memberIds.length;
    const sagaStatus = sagaRow.status ?? 'pending';
    if (totalMembers > 0 && doneCount === totalMembers && sagaStatus !== 'done') {
      violations.push({
        kind: 'auto-close-drift',
        sagaId: sagaRow.id,
        offendingId: sagaRow.id,
        message:
          `Saga ${sagaRow.id} auto-close drift: ${doneCount}/${totalMembers} members done` +
          ` but status=${sagaStatus} — run \`cleo saga reconcile ${sagaRow.id}\``,
        repairCommand: `cleo saga reconcile ${sagaRow.id}`,
      });
      totalDrift += 1;
    }

    // Tally only hard invariant violations toward the exit-driving total.
    for (const v of violations) {
      if (v.kind !== 'auto-close-drift') {
        totalInvariantViolations += 1;
      }
    }

    sagas.push({
      sagaId: sagaRow.id,
      title: sagaRow.title ?? '',
      status: sagaStatus,
      memberCount: totalMembers,
      doneCount,
      violations,
    });
  }

  return { sagas, count: totalInvariantViolations, driftCount: totalDrift };
}
