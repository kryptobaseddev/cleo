/**
 * Helpers that compute the diff between an existing AC row set and an
 * incoming AC text list, then apply the dual-write (rows + history) inside
 * a caller-owned transaction. The legacy `tasks.acceptance` string column
 * MUST stay in lock-step — the legacy writer lives in addTask/updateTask;
 * this module only manages the row-table SSoT side.
 *
 * @adr ADR-079-r1 §2.2 — ordinal monotonicity, never reused
 * @epic T10381 E-AC-MIGRATION
 * @saga T10377 SG-IVTR-AC-BINDING
 * @task T10508
 * @decision D013
 */

import { createHash, randomUUID } from 'node:crypto';
import type { AcceptanceItem, AcRow, TransactionAccessor } from '@cleocode/contracts';

/**
 * Coerce an {@link AcceptanceItem} into the canonical row `text` form.
 *
 * Plain strings pass through; structured {@link import('@cleocode/contracts').AcceptanceGate}
 * objects are JSON-serialised so the row preserves the structured payload
 * for future round-tripping (decision D013 § "structured-gate retention").
 *
 * @param item — AC item from the in-memory Task.acceptance array
 * @returns canonical text string for the `task_acceptance_criteria.text` column
 */
export function acItemToText(item: AcceptanceItem): string {
  if (typeof item === 'string') return item.trim();
  // Structured gate — preserve full shape as JSON. Readers may JSON-parse
  // when they detect a leading `{`.
  return JSON.stringify(item);
}

/**
 * Compute the row payload for a fresh task with no pre-existing AC rows.
 *
 * Generates a UUIDv4 per AC and assigns 1-based ordinals matching the
 * insertion order. Returns the empty array if the input is empty/undefined.
 *
 * @param taskId — owning task ID
 * @param acceptance — pipe-split AC items in display order
 * @returns rows ready for {@link TransactionAccessor.insertAcRows}
 */
export type AcInsertRow = {
  id: string;
  taskId: string;
  ordinal: number;
  text: string;
  kind?: 'text' | 'child_task' | 'evidence_bound';
  sourceKey?: string;
  targetTaskId?: string | null;
  projection?: string;
};

/** Build a short deterministic sha256 prefix for human-debuggable source keys. */
export function acTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Default direct-text source key. Keeps duplicates legal by including the
 * monotonic ordinal; content_hash still records text drift separately.
 */
export function directTextSourceKey(ordinal: number, text: string): string {
  return `text:${ordinal}:${acTextHash(text).slice(0, 12)}`;
}

export function buildFreshAcRows(
  taskId: string,
  acceptance: readonly AcceptanceItem[] | undefined,
): AcInsertRow[] {
  if (!acceptance || acceptance.length === 0) return [];
  return acceptance.map((item, idx) => {
    const ordinal = idx + 1;
    const text = acItemToText(item);
    return {
      id: randomUUID(),
      taskId,
      ordinal,
      text,
      kind: 'text',
      sourceKey: directTextSourceKey(ordinal, text),
      targetTaskId: null,
      projection: 'legacy',
    };
  });
}

/** Parent-owned AC projection text for a direct child task. */
export function buildChildProjectionAcText(childId: string, childTitle: string): string {
  return `Complete child ${childId}: ${childTitle.trim()}`;
}

/** Returns true when an AC row is the compatibility/typed projection for `childId`. */
export function isChildProjectionAcRow(row: AcRow, childId: string): boolean {
  return (
    row.targetTaskId === childId ||
    row.sourceKey === `child:${childId}` ||
    row.text.startsWith(`Complete child ${childId}: `)
  );
}

/**
 * Result of `planAcUpdate` — the row + history mutations the caller must
 * apply inside a transaction.
 */
export interface AcUpdatePlan {
  /** AC rows to INSERT (new, never-before-seen AC text). */
  inserts: AcInsertRow[];
  /** History rows to append BEFORE deleting any rows. */
  history: Array<{ acId: string; previousText: string; reason: string }>;
  /**
   * When true the caller MUST issue {@link TransactionAccessor.deleteAcRowsForTask}
   * BEFORE applying inserts. Used by replace-all + shrink paths to
   * guarantee no stale (taskId, ordinal) conflicts survive.
   */
  fullDelete: boolean;
}

/**
 * Plan the AC table mutations for a `cleo update --acceptance` call.
 *
 * Update semantics (per ADR-079-r1 §2.2 + task spec):
 *   - **extend** (was 2, now 3): new AC gets ordinal=3; existing 1,2 unchanged.
 *   - **shrink** (was 3, now 1): ACs 2 and 3 → history (reason='edit'); AC 1 stays.
 *   - **replace-all**: ALL existing rows → history; new rows inserted from ordinal=1.
 *
 * "Replace-all" is detected when ANY of the in-place ordinals would change
 * text — we can't tell from the input which existing AC each new AC maps
 * to, so any text drift implies the operator wants a wholesale rewrite.
 *
 * "Extend" is the safe path: only when the new AC list is a strict prefix
 * extension of the existing rows (all existing texts retained in order),
 * we preserve the existing rows and append the new tail with continuing
 * ordinals.
 *
 * "Shrink" is detected when the new list is a strict prefix of the
 * existing texts (length N < existing length M, and texts 1..N match).
 * The tail rows (N+1..M) are appended to history and then deleted.
 *
 * Any other shape (mid-edit, reorder, mixed) falls back to full
 * replace-all — the safest semantic for the schema's "no ordinal reuse"
 * invariant within a single transaction (ordinals only have to be unique
 * after COMMIT, so a delete-then-insert in one tx is sound).
 *
 * @param taskId — task being updated
 * @param existing — current AC rows from the table (ordered by ordinal ASC)
 * @param incoming — new AC items from `--acceptance "a|b|c"`
 * @returns plan to be applied in order: appendAcHistory → deleteAcRowsForTask (if fullDelete) → insertAcRows
 */
export function planAcUpdate(
  taskId: string,
  existing: readonly AcRow[],
  incoming: readonly AcceptanceItem[],
): AcUpdatePlan {
  const incomingTexts = incoming.map(acItemToText);

  // Case 1: extend — new list strictly extends the existing prefix.
  if (incomingTexts.length >= existing.length) {
    const isPrefixMatch = existing.every((row, idx) => row.text === incomingTexts[idx]);
    if (isPrefixMatch) {
      // Compute the starting ordinal for the new tail: highest existing
      // ordinal + 1, OR 1 if there were none. Ordinals are NEVER reused,
      // and the schema's UNIQUE (task_id, ordinal) enforces this.
      const maxOrdinal = existing.reduce((m, row) => (row.ordinal > m ? row.ordinal : m), 0);
      const tail = incomingTexts.slice(existing.length).map((text, i) => {
        const ordinal = maxOrdinal + 1 + i;
        return {
          id: randomUUID(),
          taskId,
          ordinal,
          text,
          kind: 'text' as const,
          sourceKey: directTextSourceKey(ordinal, text),
          targetTaskId: null,
          projection: 'legacy',
        };
      });
      return { inserts: tail, history: [], fullDelete: false };
    }
  }

  // Case 2: shrink — new list is a strict prefix of existing (no text drift).
  if (incomingTexts.length < existing.length) {
    const isStrictPrefix = incomingTexts.every((text, idx) => existing[idx]?.text === text);
    if (isStrictPrefix) {
      const tailRows = existing.slice(incomingTexts.length);
      const history = tailRows.map((row) => ({
        acId: row.id,
        previousText: row.text,
        reason: 'edit',
      }));
      // For shrink we DO need to delete the tail. We use the
      // fullDelete-then-reinsert approach to keep the codepath uniform
      // (insertAcRows below uses the kept prefix rows with their EXISTING
      // ids + ordinals so binding stability survives).
      const keepInserts = existing.slice(0, incomingTexts.length).map((row) => ({
        id: row.id,
        taskId,
        ordinal: row.ordinal,
        text: row.text,
        kind: row.kind,
        sourceKey: row.sourceKey,
        targetTaskId: row.targetTaskId,
        projection: row.projection,
      }));
      return { inserts: keepInserts, history, fullDelete: true };
    }
  }

  // Case 3: replace-all (mid-edit, reorder, mixed, or text drift).
  const history = existing.map((row) => ({
    acId: row.id,
    previousText: row.text,
    reason: 'edit',
  }));
  const inserts = incomingTexts.map((text, idx) => {
    const ordinal = idx + 1;
    return {
      id: randomUUID(),
      taskId,
      ordinal,
      text,
      kind: 'text' as const,
      sourceKey: directTextSourceKey(ordinal, text),
      targetTaskId: null,
      projection: 'legacy',
    };
  });
  return { inserts, history, fullDelete: true };
}

/**
 * Plan removal of a parent-owned child projection row while preserving the
 * remaining AC UUIDs, ordinals, kind/source metadata, and bindings.
 */
export function planChildProjectionRemoval(
  parentId: string,
  existing: readonly AcRow[],
  childId: string,
  reason: 'delete' | 'archive',
): AcUpdatePlan {
  const removed = existing.filter((row) => isChildProjectionAcRow(row, childId));
  if (removed.length === 0) return { inserts: [], history: [], fullDelete: false };

  const inserts = existing
    .filter((row) => !isChildProjectionAcRow(row, childId))
    .map((row) => ({
      id: row.id,
      taskId: parentId,
      ordinal: row.ordinal,
      text: row.text,
      kind: row.kind,
      sourceKey: row.sourceKey,
      targetTaskId: row.targetTaskId,
      projection: row.projection,
    }));
  const history = removed.map((row) => ({
    acId: row.id,
    previousText: row.text,
    reason,
  }));

  return { inserts, history, fullDelete: true };
}

/** Remove a direct child's parent-owned AC projection from row + legacy views. */
export async function removeChildProjectionAc(
  tx: TransactionAccessor,
  parentId: string,
  childId: string,
  reason: 'delete' | 'archive',
  updatedAt: string,
): Promise<boolean> {
  const existing = await tx.getAcRows(parentId);
  const plan = planChildProjectionRemoval(parentId, existing, childId, reason);
  if (plan.history.length === 0) return false;

  await applyAcPlan(tx, parentId, plan);
  const legacyAcceptance = plan.inserts
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.text);
  await tx.updateTaskFields(parentId, {
    acceptanceJson: JSON.stringify(legacyAcceptance),
    updatedAt,
  });
  return true;
}

/**
 * Convenience executor — apply an {@link AcUpdatePlan} against a transaction
 * accessor in the required order: history append → delete (if requested) →
 * insert. Caller MUST have already opened a transaction.
 *
 * @param tx — open transaction accessor
 * @param taskId — task whose AC rows are being mutated
 * @param plan — pre-computed plan from {@link planAcUpdate} or {@link buildFreshAcRows}
 */
export async function applyAcPlan(
  tx: TransactionAccessor,
  taskId: string,
  plan: AcUpdatePlan,
): Promise<void> {
  if (plan.history.length > 0) {
    await tx.appendAcHistory(plan.history);
  }
  if (plan.fullDelete) {
    await tx.deleteAcRowsForTask(taskId);
  }
  if (plan.inserts.length > 0) {
    await tx.insertAcRows(plan.inserts);
  }
}
