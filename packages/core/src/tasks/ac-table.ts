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

import { createHash } from 'node:crypto';
import type {
  AcceptanceGate,
  AcceptanceItem,
  AcProjectionAuditFinding,
  AcProjectionAuditResult,
  AcRow,
  TransactionAccessor,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

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
  // Structured gate — preserve full shape as canonical JSON. Readers may
  // JSON-parse when they detect a leading `{`.
  return stableStringify(item as unknown as CanonicalJson);
}

/**
 * Compute the row payload for a fresh task with no pre-existing AC rows.
 *
 * Generates deterministic UUID-shaped AC ids from task id + source key and
 * assigns 1-based ordinals matching insertion order. Returns the empty array
 * if the input is empty/undefined.
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
  contentHash?: string | null;
};

type AcCriterionKind = NonNullable<AcInsertRow['kind']>;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

/** Deterministically stringify structured AC objects by sorting object keys recursively. */
function stableStringify(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

/**
 * Canonical text used for AC hashing/idempotency. It deliberately ignores
 * display-only ordering and task lifecycle fields: ordinals, titles, and
 * statuses never enter this value.
 */
export function canonicalizeAcText(text: string): string {
  return text.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

/** Build a deterministic sha256 over the canonical AC representation. */
export function acTextHash(text: string): string {
  return createHash('sha256').update(canonicalizeAcText(text)).digest('hex');
}

/** Default direct-text source key. Deterministic from monotonic ordinal + canonical content only. */
export function directTextSourceKey(ordinal: number, text: string): string {
  return `text:${ordinal}:${acTextHash(text).slice(0, 32)}`;
}

/** Stable source key for a T760 structured gate projected into an evidence-bound AC row. */
export function evidenceBoundSourceKey(gate: AcceptanceGate, canonicalText: string): string {
  const req = typeof gate.req === 'string' ? gate.req.trim() : '';
  if (req.length > 0) return `evidence:${req}`;
  return `evidence:${acTextHash(canonicalText).slice(0, 32)}`;
}

/** Source key for parent-owned child projections. Excludes child title/status. */
export function childProjectionSourceKey(childId: string): string {
  return `child:${childId}`;
}

/**
 * Deterministic UUID-shaped AC id derived only from owning task + canonical AC identity.
 * This is UUIDv5-shaped for ecosystem compatibility, but it is intentionally
 * implemented with SHA-256 so we do not introduce a new runtime dependency.
 */
export function buildAcRowId(taskId: string, canonicalIdentity: string): string {
  const hex = createHash('sha256')
    .update(`cleo-ac-row\0${taskId}\0${canonicalIdentity}`)
    .digest('hex');
  const chars = hex.split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars
    .slice(12, 16)
    .join('')}-${chars.slice(16, 20).join('')}-${chars.slice(20, 32).join('')}`;
}

function assertUniqueGeneratedRows(taskId: string, rows: readonly AcInsertRow[]): void {
  const seenSourceKeys = new Map<string, number>();
  const seenIds = new Map<string, number>();
  for (const row of rows) {
    const previousIdOrdinal = seenIds.get(row.id);
    if (previousIdOrdinal !== undefined) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, 'Duplicate acceptance criterion id', {
        fix: 'Make each acceptance criterion semantically distinct; duplicate canonical AC bodies now fail before DB write.',
        details: {
          field: 'acceptance',
          taskId,
          acId: row.id,
          firstOrdinal: previousIdOrdinal,
          duplicateOrdinal: row.ordinal,
        },
      });
    }
    seenIds.set(row.id, row.ordinal);

    if (!row.sourceKey) continue;
    const previousOrdinal = seenSourceKeys.get(row.sourceKey);
    if (previousOrdinal !== undefined) {
      throw new CleoError(ExitCode.VALIDATION_ERROR, 'Duplicate acceptance criterion source_key', {
        fix: 'Make each acceptance criterion semantically distinct; duplicate canonical AC source keys now fail before DB write.',
        details: {
          field: 'acceptance',
          taskId,
          sourceKey: row.sourceKey,
          firstOrdinal: previousOrdinal,
          duplicateOrdinal: row.ordinal,
        },
      });
    }
    seenSourceKeys.set(row.sourceKey, row.ordinal);
  }
}

function criterionKindForItem(item: AcceptanceItem): AcCriterionKind {
  return typeof item === 'string' ? 'text' : 'evidence_bound';
}

function sourceKeyForItem(ordinal: number, item: AcceptanceItem, text: string): string {
  return typeof item === 'string'
    ? directTextSourceKey(ordinal, text)
    : evidenceBoundSourceKey(item, text);
}

function buildInsertRow(
  taskId: string,
  item: AcceptanceItem,
  ordinal: number,
  idOverride?: string,
): AcInsertRow {
  const text = acItemToText(item);
  const kind = criterionKindForItem(item);
  const sourceKey = sourceKeyForItem(ordinal, item, text);
  const canonicalIdentity = kind === 'text' ? text : sourceKey;

  return {
    id: idOverride ?? buildAcRowId(taskId, canonicalIdentity),
    taskId,
    ordinal,
    text,
    kind,
    sourceKey,
    targetTaskId: null,
    projection: 'legacy',
    contentHash: acTextHash(text),
  };
}

export function buildFreshAcRows(
  taskId: string,
  acceptance: readonly AcceptanceItem[] | undefined,
): AcInsertRow[] {
  if (!acceptance || acceptance.length === 0) return [];
  const rows = acceptance.map((item, idx) => {
    const ordinal = idx + 1;
    return buildInsertRow(taskId, item, ordinal);
  });
  assertUniqueGeneratedRows(taskId, rows);
  return rows;
}

/** Parent-owned AC projection text for a direct child task. */
export function buildChildProjectionAcText(childId: string, childTitle: string): string {
  return `Complete child ${childId}: ${childTitle.trim()}`;
}

/** Minimal direct child state needed to audit parent-owned child_task AC projections. */
export interface ChildProjectionAuditInput {
  readonly id: string;
  readonly title: string;
}

type ExpectedChildProjection = {
  childId: string;
  text: string;
  sourceKey: string;
  contentHash: string;
};

/** Result emitted after an idempotent child-projection rebuild attempt. */
export interface ChildProjectionRebuildResult {
  parentId: string;
  rebuilt: boolean;
  auditBefore: AcProjectionAuditResult;
  auditAfter: AcProjectionAuditResult;
}

/** Freshness fingerprint for one parent-owned child projection row. */
export function childProjectionFreshnessFingerprint(childId: string, childTitle: string): string {
  const text = buildChildProjectionAcText(childId, childTitle);
  return acTextHash(`${childProjectionSourceKey(childId)}\0${text}`);
}

function expectedChildProjection(child: ChildProjectionAuditInput): ExpectedChildProjection {
  const text = buildChildProjectionAcText(child.id, child.title);
  return {
    childId: child.id,
    text,
    sourceKey: childProjectionSourceKey(child.id),
    contentHash: childProjectionFreshnessFingerprint(child.id, child.title),
  };
}

function isChildProjectionCandidate(row: AcRow): boolean {
  return (
    row.kind === 'child_task' ||
    row.projection === 'parent-child' ||
    row.sourceKey.startsWith('child:') ||
    row.targetTaskId !== null
  );
}

function acRowToInsertRow(row: AcRow): AcInsertRow {
  return {
    id: row.id,
    taskId: row.taskId,
    ordinal: row.ordinal,
    text: row.text,
    kind: row.kind,
    sourceKey: row.sourceKey,
    targetTaskId: row.targetTaskId,
    projection: row.projection,
    contentHash: row.contentHash,
  };
}

function buildChildProjectionInsertRow(
  parentId: string,
  child: ChildProjectionAuditInput,
  ordinal: number,
): AcInsertRow {
  const sourceKey = childProjectionSourceKey(child.id);
  return {
    id: buildAcRowId(parentId, sourceKey),
    taskId: parentId,
    ordinal,
    kind: 'child_task',
    sourceKey,
    targetTaskId: child.id,
    projection: 'parent-child',
    text: buildChildProjectionAcText(child.id, child.title),
    contentHash: childProjectionFreshnessFingerprint(child.id, child.title),
  };
}

function legacyAcceptanceFromRows(rows: readonly AcInsertRow[]): string[] {
  return rows
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.text);
}

function childIdForProjectionRow(row: AcRow): string | null {
  if (row.targetTaskId !== null && row.targetTaskId.length > 0) return row.targetTaskId;
  if (row.sourceKey.startsWith('child:')) return row.sourceKey.slice('child:'.length);
  const match = /^Complete child ([^:]+): /.exec(row.text);
  return match?.[1] ?? null;
}

function acFinding(finding: Omit<AcProjectionAuditFinding, 'dirty'>): AcProjectionAuditFinding {
  return { ...finding, dirty: true };
}

/**
 * Audit parent-owned `child_task` AC projections against current WorkGraph direct children.
 *
 * The result is intentionally typed for doctor/audit JSON output: missing rows,
 * extra rows, field mismatches, and stale text/fingerprint projections are all
 * surfaced as stable finding codes with a `dirty` flag.
 */
export function auditChildProjectionAcRows(
  parentId: string,
  children: readonly ChildProjectionAuditInput[],
  rows: readonly AcRow[],
): AcProjectionAuditResult {
  const expected = children
    .map(expectedChildProjection)
    .sort((a, b) => a.childId.localeCompare(b.childId));
  const expectedByChild = new Map(expected.map((projection) => [projection.childId, projection]));
  const actualRows = rows.filter(isChildProjectionCandidate);
  const actualByChild = new Map<string, AcRow[]>();

  for (const row of actualRows) {
    const childId = childIdForProjectionRow(row);
    if (childId === null) continue;
    const bucket = actualByChild.get(childId) ?? [];
    bucket.push(row);
    actualByChild.set(childId, bucket);
  }

  const findings: AcProjectionAuditFinding[] = [];

  for (const projection of expected) {
    const matchingRows = actualByChild.get(projection.childId) ?? [];
    const row = matchingRows[0];
    if (row === undefined) {
      findings.push(
        acFinding({
          code: 'missing_child_task_row',
          parentId,
          childId: projection.childId,
          field: 'row',
          expected: projection.sourceKey,
          actual: null,
        }),
      );
      continue;
    }

    for (const extraRow of matchingRows.slice(1)) {
      findings.push(
        acFinding({
          code: 'extra_child_task_row',
          parentId,
          childId: projection.childId,
          acId: extraRow.id,
          field: 'row',
          expected: projection.sourceKey,
          actual: extraRow.sourceKey,
        }),
      );
    }

    const comparisons: Array<{
      field: AcProjectionAuditFinding['field'];
      expected: string | null;
      actual: string | null;
    }> = [
      { field: 'kind', expected: 'child_task', actual: row.kind },
      { field: 'sourceKey', expected: projection.sourceKey, actual: row.sourceKey },
      { field: 'targetTaskId', expected: projection.childId, actual: row.targetTaskId },
      { field: 'projection', expected: 'parent-child', actual: row.projection },
      { field: 'text', expected: projection.text, actual: row.text },
    ];

    if (row.contentHash !== null) {
      comparisons.push({
        field: 'contentHash',
        expected: projection.contentHash,
        actual: row.contentHash,
      });
    }

    for (const comparison of comparisons) {
      if (comparison.expected === comparison.actual) continue;
      findings.push(
        acFinding({
          code:
            comparison.field === 'text' || comparison.field === 'contentHash'
              ? 'stale_child_task_projection'
              : 'mismatched_child_task_row',
          parentId,
          childId: projection.childId,
          acId: row.id,
          field: comparison.field,
          expected: comparison.expected,
          actual: comparison.actual,
        }),
      );
    }
  }

  for (const row of actualRows) {
    const childId = childIdForProjectionRow(row);
    if (childId !== null && expectedByChild.has(childId)) continue;
    findings.push(
      acFinding({
        code: 'extra_child_task_row',
        parentId,
        childId: childId ?? undefined,
        acId: row.id,
        field: 'row',
        expected: null,
        actual: row.sourceKey,
      }),
    );
  }

  const freshnessFingerprint = createHash('sha256')
    .update(expected.map((projection) => projection.contentHash).join('\n'))
    .digest('hex');
  const dirty = findings.length > 0;

  return {
    parentId,
    status: dirty ? 'dirty' : 'clean',
    dirty,
    expectedRows: expected.length,
    actualRows: actualRows.length,
    freshnessFingerprint,
    staleProjection: dirty,
    findings,
  };
}

/**
 * Plan a full parent-owned child_task projection rebuild.
 *
 * The function is idempotent: a clean audit emits a no-op plan. Dirty parents
 * get a delete/reinsert plan that preserves non-child AC rows, rewrites the
 * complete child_task set from current direct children, and records previous
 * child projection rows to history before deletion.
 */
export function planChildProjectionRebuild(
  parentId: string,
  children: readonly ChildProjectionAuditInput[],
  existing: readonly AcRow[],
): { plan: AcUpdatePlan; legacyAcceptance: string[]; auditBefore: AcProjectionAuditResult } {
  const auditBefore = auditChildProjectionAcRows(parentId, children, existing);
  if (!auditBefore.dirty) {
    return {
      plan: { inserts: [], history: [], fullDelete: false },
      legacyAcceptance: [],
      auditBefore,
    };
  }

  const nonChildRows = existing.filter((row) => !isChildProjectionCandidate(row));
  const childRows = existing.filter(isChildProjectionCandidate);
  const nonChildInserts = nonChildRows.map(acRowToInsertRow);
  const maxNonChildOrdinal = nonChildInserts.reduce(
    (max, row) => (row.ordinal > max ? row.ordinal : max),
    0,
  );
  const childInserts = children.map((child, index) =>
    buildChildProjectionInsertRow(parentId, child, maxNonChildOrdinal + index + 1),
  );
  const inserts = [...nonChildInserts, ...childInserts];
  assertUniqueGeneratedRows(parentId, inserts);

  return {
    plan: {
      inserts,
      history: childRows.map((row) => ({
        acId: row.id,
        previousText: row.text,
        reason: 'projection_rebuild',
      })),
      fullDelete: true,
    },
    legacyAcceptance: legacyAcceptanceFromRows(inserts),
    auditBefore,
  };
}

/** Rebuild one parent's child_task projection rows inside a caller-owned transaction. */
export async function rebuildChildProjectionAc(
  tx: TransactionAccessor,
  parentId: string,
  children: readonly ChildProjectionAuditInput[],
  updatedAt: string,
): Promise<ChildProjectionRebuildResult> {
  const existing = await tx.getAcRows(parentId);
  const { plan, legacyAcceptance, auditBefore } = planChildProjectionRebuild(
    parentId,
    children,
    existing,
  );
  if (!auditBefore.dirty) {
    return { parentId, rebuilt: false, auditBefore, auditAfter: auditBefore };
  }

  await applyAcPlan(tx, parentId, plan);
  await tx.updateTaskFields(parentId, {
    acceptanceJson: JSON.stringify(legacyAcceptance),
    updatedAt,
  });

  const rebuiltRows = await tx.getAcRows(parentId);
  const auditAfter = auditChildProjectionAcRows(parentId, children, rebuiltRows);
  return { parentId, rebuilt: true, auditBefore, auditAfter };
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
      const tail = incoming.slice(existing.length).map((item, i) => {
        const ordinal = maxOrdinal + 1 + i;
        return buildInsertRow(taskId, item, ordinal);
      });
      assertUniqueGeneratedRows(taskId, tail);
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
        contentHash: row.contentHash,
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
  const inserts = incoming.map((item, idx) => {
    const ordinal = idx + 1;
    return buildInsertRow(taskId, item, ordinal);
  });
  assertUniqueGeneratedRows(taskId, inserts);
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
      contentHash: row.contentHash,
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
