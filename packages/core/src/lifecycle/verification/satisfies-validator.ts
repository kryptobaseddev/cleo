/**
 * Runtime validator for the ADR-079-r2 `satisfies:<task-id>#<ac-id>` evidence
 * atom — the 5-check pipeline shipped by T10507.
 *
 * # Why a dedicated module
 *
 * The parser for the atom (T10506) lives in
 * `packages/contracts/src/evidence-atom-schema.ts`. The dispatch entry
 * point that consumes the parsed atom lives in
 * `packages/core/src/tasks/evidence.ts::validateAtom`. The 5-check semantics
 * are non-trivial — they touch the tasks table, the AC table, the AC-history
 * table, and the saga membership graph — so they get their own module to
 * keep `evidence.ts` focused on dispatch.
 *
 * # First-failure-wins
 *
 * Per ADR-079-r2 §2.4, the 5 checks run **in order** and the validator
 * returns the FIRST failure with its corresponding error code. NO further
 * checks run once one has failed. This is critical for stability: an atom
 * with a malformed task-id MUST surface `E_AC_BINDING_MALFORMED`, not
 * `E_AC_BINDING_TARGET_NOT_FOUND`, even though both would technically
 * apply.
 *
 * The checks are ordered cheapest-first so a malformed atom does not
 * touch the DB at all and an out-of-scope atom is detected only AFTER
 * the cheap target+ac existence checks have passed.
 *
 * # Same-saga scope (ADR-079-r2 §2.3)
 *
 * The forward-looking `tasks.saga_id` column has not yet shipped (T10494
 * owns the migration). Until it lands, same-saga membership is resolved
 * via the `task_relations` table where `relation_type='groups'` (the
 * canonical Saga-membership representation per ADR-073 §1.2 I3). The
 * resolution is bi-directional: a task A and a task B share a saga IFF
 * there exists a saga task S such that S→A and S→B both have
 * `relation_type='groups'` edges. As a fallback (no saga membership on
 * either task), A and B are considered "same scope" IFF they share the
 * same root epic — resolved by walking `parent_id` ancestors until a
 * top-level epic is reached.
 *
 * # Alias drift detection
 *
 * Per ADR-079-r2 §3, the `E_AC_ALIAS_DRIFTED` error fires when an atom
 * captured under an alias (`AC<n>`) at mint time now resolves to a
 * different canonical UUID than what was previously persisted in the
 * binding side-effect table. The soft warning `W_AC_ALIAS_DRIFTED` is
 * surfaced (NOT yet treated as an error) when an atom-rewrite would
 * be required to keep the binding stable — implementation is reserved
 * for the AC-coverage gate (T10508 / ADR-079-r4). T10507 ships the
 * hard error path; the soft warning is a forward-looking placeholder.
 *
 * # Side effects
 *
 * On accept, the validator returns the canonicalised
 * `EvidenceAtom` with `resolvedAcUuid` populated. Writing the binding
 * row into `evidence_ac_bindings` is the dispatch layer's
 * responsibility — keeping this module side-effect-free preserves the
 * "validator is a pure function of (atom, state)" invariant the rest
 * of the evidence pipeline relies on.
 *
 * @task T10507
 * @epic T10381
 * @saga T10377 (SG-IVTR-AC-BINDING)
 * @adr ADR-079-r2
 */

import type { EvidenceAtom } from '@cleocode/contracts';
import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/tasks-schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed-atom shape consumed by {@link validateSatisfiesAtom}.
 *
 * Mirrors the `satisfies` arm of the `ParsedAtom` union exported from
 * `evidence.ts` — duplicated here to keep this module standalone and
 * avoid an import cycle through `tasks/evidence.ts`. The contract is
 * pinned by ADR-079-r2 §2.1 ABNF.
 */
export interface ParsedSatisfiesAtom {
  /** Atom discriminator. */
  kind: 'satisfies';
  /** `T<1-7 digits>` per ADR-079-r2 §2.1. */
  targetTaskId: string;
  /** Lowercase UUIDv4/v5 — populated for canonical form. */
  targetAcId?: string;
  /** `AC<1-4 digits>` alias — populated for alias form. */
  targetAcAlias?: string;
  /** Optional `@YYYYMMDDhhmmss` pin captured at mint time. */
  versionPin?: string;
}

/**
 * Validator outcome — mirrors `AtomValidation` from `evidence.ts` but
 * specialised for the satisfies atom so callers can pattern-match on
 * the canonical `resolvedAcUuid` populated on success.
 */
export type SatisfiesValidation =
  | { ok: true; atom: Extract<EvidenceAtom, { kind: 'satisfies' }> }
  | { ok: false; reason: string; codeName: SatisfiesErrorCode };

/**
 * Hard-error codes surfaced by the 5-check validator pipeline.
 *
 * Codes follow the existing `E_<DOMAIN>_<REASON>` convention. The first
 * five mirror ADR-079-r2 §3 exactly; `E_AC_ALIAS_DRIFTED` is the
 * sixth code that fires at validate-time when the alias resolves to
 * a UUID that differs from the one previously persisted under the
 * same `(source, target_task, alias)` triple.
 */
export type SatisfiesErrorCode =
  | 'E_AC_BINDING_MALFORMED'
  | 'E_AC_BINDING_TARGET_NOT_FOUND'
  | 'E_AC_BINDING_TARGET_TERMINAL'
  | 'E_AC_BINDING_TARGET_AC_NOT_FOUND'
  | 'E_AC_BINDING_OUT_OF_SCOPE'
  | 'E_AC_ALIAS_DRIFTED';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate the surface shape of the parsed atom one more time. Per
 * ADR-079-r2 §2.4 check 1, the validator MUST re-confirm the malformed
 * grammar even though the parser already did — defence-in-depth against
 * callers that construct a `ParsedSatisfiesAtom` programmatically and
 * bypass `parseEvidenceString`.
 */
function isMalformed(atom: ParsedSatisfiesAtom): string | null {
  if (typeof atom.targetTaskId !== 'string' || !/^T[0-9]{1,7}$/.test(atom.targetTaskId)) {
    return `targetTaskId "${atom.targetTaskId}" must match /^T[0-9]{1,7}$/`;
  }
  const hasUuid = typeof atom.targetAcId === 'string';
  const hasAlias = typeof atom.targetAcAlias === 'string';
  // Exactly one of UUID / alias MUST be set — never both, never neither.
  if (hasUuid === hasAlias) {
    return `exactly one of targetAcId (UUID) or targetAcAlias (AC<n>) must be set`;
  }
  if (hasUuid && atom.targetAcId !== undefined) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        atom.targetAcId,
      )
    ) {
      return `targetAcId "${atom.targetAcId}" must be a lowercase UUIDv4/v5`;
    }
  }
  if (hasAlias && atom.targetAcAlias !== undefined) {
    if (!/^AC[0-9]{1,4}$/.test(atom.targetAcAlias)) {
      return `targetAcAlias "${atom.targetAcAlias}" must match /^AC[0-9]{1,4}$/`;
    }
  }
  if (atom.versionPin !== undefined && !/^[0-9]{14}$/.test(atom.versionPin)) {
    return `versionPin "${atom.versionPin}" must be 14 digits (YYYYMMDDhhmmss)`;
  }
  return null;
}

/** Drizzle DB type alias — opaque to consumers. */
type Db = Awaited<ReturnType<typeof getDb>>;

/**
 * Walk `parent_id` ancestors of `taskId` until a top-level row
 * (`parent_id IS NULL`) is reached, returning that row's id. Used as
 * the same-saga scope fallback when neither the source nor the target
 * is a member of any saga.
 *
 * Bounded to 32 hops as a defensive guard against cycles — the maxDepth
 * invariant from ADR-073 §1.2 I7 is 3 but a corrupted DB could in
 * principle introduce a longer chain. 32 is more than 10x the legitimate
 * upper bound.
 */
async function resolveRootEpic(db: Db, taskId: string): Promise<string | null> {
  let currentId: string = taskId;
  for (let depth = 0; depth < 32; depth++) {
    const rows: Array<{ id: string; parentId: string | null }> = await db
      .select({ id: schema.tasks.id, parentId: schema.tasks.parentId })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, currentId))
      .all();
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row === undefined) return null;
    if (row.parentId === null) {
      return row.id;
    }
    currentId = row.parentId;
  }
  return null;
}

/**
 * Find every saga task that groups `taskId` as a member via
 * `task_relations.relation_type='groups'` edges. Returns the saga IDs
 * in stable insertion order. Empty when `taskId` is not a saga
 * member.
 */
async function findSagasGroupingTaskId(db: Db, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ taskId: schema.taskRelations.taskId })
    .from(schema.taskRelations)
    .where(
      and(
        eq(schema.taskRelations.relatedTo, taskId),
        eq(schema.taskRelations.relationType, 'groups'),
      ),
    )
    .all();
  return rows.map((r) => r.taskId);
}

/**
 * Resolve the same-saga scope of `taskId`. Returns either:
 *   - The set of saga IDs grouping `taskId` (non-empty when the task is
 *     a saga member), OR
 *   - A singleton set containing the task's root epic ID when no saga
 *     groups it (per ADR-079-r2 §2.3 fallback).
 *
 * Returns `null` when the task cannot be resolved (deleted? corrupted
 * parent chain?) — caller surfaces that as `E_AC_BINDING_TARGET_NOT_FOUND`
 * or `E_AC_BINDING_OUT_OF_SCOPE` depending on which side of the binding
 * is missing.
 */
async function resolveScopeAnchors(
  db: Db,
  taskId: string,
): Promise<{ kind: 'saga'; anchors: string[] } | { kind: 'epic'; anchor: string } | null> {
  const sagas = await findSagasGroupingTaskId(db, taskId);
  if (sagas.length > 0) {
    return { kind: 'saga', anchors: sagas };
  }
  const rootEpic = await resolveRootEpic(db, taskId);
  if (rootEpic === null) return null;
  return { kind: 'epic', anchor: rootEpic };
}

/**
 * Check whether `sourceId` and `targetId` share a same-saga (or
 * same-root-epic) anchor. The check is symmetric: A→B and B→A both
 * resolve the same way.
 */
async function shareScope(db: Db, sourceId: string, targetId: string): Promise<boolean> {
  const srcScope = await resolveScopeAnchors(db, sourceId);
  const tgtScope = await resolveScopeAnchors(db, targetId);
  if (srcScope === null || tgtScope === null) return false;
  // Both anchored in saga(s) — at least one common saga.
  if (srcScope.kind === 'saga' && tgtScope.kind === 'saga') {
    const tgtSet = new Set(tgtScope.anchors);
    return srcScope.anchors.some((s) => tgtSet.has(s));
  }
  // One side is saga-anchored, the other root-epic-anchored — only
  // share scope if the root-epic anchor is one of the saga's member-
  // walks. Defensive: such a configuration is rare in practice (one
  // task in a saga, sibling not yet linked), so we treat it as
  // out-of-scope and require the orchestrator to link explicitly.
  if (srcScope.kind === 'saga' || tgtScope.kind === 'saga') {
    return false;
  }
  // Both root-epic-anchored — share scope IFF root epics match.
  return srcScope.anchor === tgtScope.anchor;
}

/**
 * Resolve an `AC<n>` alias to the canonical `task_acceptance_criteria.id`
 * UUID for the given target task. Returns `null` when the alias does not
 * resolve (no AC with that ordinal on the task).
 */
async function resolveAliasToUuid(
  db: Db,
  targetTaskId: string,
  alias: string,
): Promise<string | null> {
  const ordinalMatch = /^AC([0-9]{1,4})$/.exec(alias);
  if (!ordinalMatch) return null;
  const ordinal = Number.parseInt(ordinalMatch[1] ?? '', 10);
  if (!Number.isFinite(ordinal) || ordinal < 1) return null;
  const rows = await db
    .select({ id: schema.taskAcceptanceCriteria.id })
    .from(schema.taskAcceptanceCriteria)
    .where(
      and(
        eq(schema.taskAcceptanceCriteria.taskId, targetTaskId),
        eq(schema.taskAcceptanceCriteria.ordinal, ordinal),
      ),
    )
    .all();
  return rows[0]?.id ?? null;
}

/**
 * Check whether `acUuid` exists on `targetTaskId`. Used for the
 * UUID-form path of check 4.
 */
async function uuidExistsOnTask(db: Db, targetTaskId: string, acUuid: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.taskAcceptanceCriteria.id })
    .from(schema.taskAcceptanceCriteria)
    .where(
      and(
        eq(schema.taskAcceptanceCriteria.id, acUuid),
        eq(schema.taskAcceptanceCriteria.taskId, targetTaskId),
      ),
    )
    .all();
  return rows.length > 0;
}

/**
 * Detect alias drift: the alias on the atom resolves to a UUID that
 * differs from a previously-persisted binding for the same
 * `(source_task, target_task, alias)` triple. Returns the previously-
 * persisted UUID when drift is detected, `null` otherwise.
 *
 * Returns `null` when `evidence_ac_bindings` is unavailable (e.g.
 * table not yet migrated — gracefully no-op).
 */
async function detectAliasDrift(
  db: Db,
  sourceTaskId: string | undefined,
  targetTaskId: string,
  alias: string,
  currentUuid: string,
): Promise<string | null> {
  if (sourceTaskId === undefined) return null;
  try {
    const rows = await db
      .select({
        acId: schema.evidenceAcBindings.acId,
        evidenceAtomId: schema.evidenceAcBindings.evidenceAtomId,
      })
      .from(schema.evidenceAcBindings)
      .where(eq(schema.evidenceAcBindings.bindingType, 'satisfies'))
      .all();
    // The stable atom id pattern follows the form used by writers
    // (T10505/T10506) but is not yet finalised — we match conservatively
    // by scanning for any binding whose atom id encodes the same
    // (source, target, alias) triple. The id format is opaque to this
    // module; we expect it to contain the alias literal so the
    // conservative substring match suffices.
    const aliasMarker = `${targetTaskId}#${alias}`;
    for (const row of rows) {
      if (
        typeof row.evidenceAtomId === 'string' &&
        row.evidenceAtomId.includes(aliasMarker) &&
        row.evidenceAtomId.includes(sourceTaskId) &&
        row.acId !== currentUuid
      ) {
        return row.acId;
      }
    }
    return null;
  } catch {
    // Table missing or schema mismatch — no historical record means no drift.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `satisfies:<task-id>#<ac-id>[@<version-pin>]` atom
 * against the live tasks DB. Runs the 5 checks from ADR-079-r2 §2.4
 * IN ORDER, returning the FIRST failure (early return — no further
 * checks once one has failed).
 *
 * @param parsed - Parsed atom (post-grammar, pre-runtime check).
 * @param sourceTaskId - The task that bears the atom — used for the
 *   same-saga scope check. May be omitted by callers that don't have
 *   the task context (e.g. CLI smoke tests); when undefined, check 5
 *   (out-of-scope) is SKIPPED — caller is responsible for stamping
 *   the task id before invoking `validateAtom`.
 * @param projectRoot - Absolute path to project root (drives tasks-db
 *   resolution).
 * @returns Success carries the canonicalised
 *   {@link EvidenceAtom['satisfies']} (with `resolvedAcUuid` populated);
 *   failure carries the first applicable {@link SatisfiesErrorCode}.
 *
 * @adr ADR-079-r2 §2.4 (validator semantics)
 * @adr ADR-079-r2 §3 (error codes)
 * @task T10507
 */
export async function validateSatisfiesAtom(
  parsed: ParsedSatisfiesAtom,
  sourceTaskId: string | undefined,
  projectRoot: string,
): Promise<SatisfiesValidation> {
  // -------------------------------------------------------------------
  // Check 1 — Malformed (re-check; cheap, no DB)
  // -------------------------------------------------------------------
  const malformedReason = isMalformed(parsed);
  if (malformedReason !== null) {
    return {
      ok: false,
      reason: `satisfies atom malformed: ${malformedReason}`,
      codeName: 'E_AC_BINDING_MALFORMED',
    };
  }

  const db = await getDb(projectRoot);

  // -------------------------------------------------------------------
  // Check 2 — Target task exists
  // -------------------------------------------------------------------
  const targetTaskRows = await db
    .select({ id: schema.tasks.id, status: schema.tasks.status })
    .from(schema.tasks)
    .where(eq(schema.tasks.id, parsed.targetTaskId))
    .all();
  if (targetTaskRows.length === 0) {
    return {
      ok: false,
      reason:
        `satisfies: target task "${parsed.targetTaskId}" does not exist in the local tasks table. ` +
        `Verify the task ID via 'cleo find ${parsed.targetTaskId}' or 'cleo show ${parsed.targetTaskId}'.`,
      codeName: 'E_AC_BINDING_TARGET_NOT_FOUND',
    };
  }
  const targetTask = targetTaskRows[0];

  // -------------------------------------------------------------------
  // Check 3 — Target task NOT in terminal state
  //
  // ADR-079-r2 §2.4 row 3 says status ∈ {pending, active, done}.
  // We use TERMINAL_TASK_STATUSES from contracts (cancelled, archived,
  // done) and invert — but the ADR explicitly allows `done` because
  // workers routinely satisfy ACs on already-shipped tasks. So the
  // forbidden set is `cancelled` + `archived` (+ legacy `deleted` if
  // such a status ever exists). `done` is OK.
  // -------------------------------------------------------------------
  const FORBIDDEN_STATUSES: ReadonlySet<string> = new Set(
    [...TERMINAL_TASK_STATUSES].filter((s) => s !== 'done'),
  );
  if (typeof targetTask.status === 'string' && FORBIDDEN_STATUSES.has(targetTask.status)) {
    return {
      ok: false,
      reason:
        `satisfies: target task "${parsed.targetTaskId}" is in terminal state "${targetTask.status}". ` +
        `Atoms may only target tasks in {pending, active, done}. ` +
        `Cancelled or archived tasks cannot satisfy live evidence chains.`,
      codeName: 'E_AC_BINDING_TARGET_TERMINAL',
    };
  }

  // -------------------------------------------------------------------
  // Check 4 — AC exists on the target task
  //
  // Resolve to the canonical UUID — even when the atom carried the
  // alias form. The canonical UUID is what gets persisted in
  // `evidence_ac_bindings` so the AC-coverage gate (T10508) is alias-
  // drift-safe (per ADR-079-r2 §2.5).
  // -------------------------------------------------------------------
  let resolvedAcUuid: string | null = null;
  if (parsed.targetAcId !== undefined) {
    // Canonical UUID path — verify it actually exists on the target task
    // (a free-floating UUID that does not belong to the target task is
    // still an AC-not-found from the binding's perspective).
    const exists = await uuidExistsOnTask(db, parsed.targetTaskId, parsed.targetAcId);
    if (!exists) {
      return {
        ok: false,
        reason:
          `satisfies: AC "${parsed.targetAcId}" does not exist on target task "${parsed.targetTaskId}". ` +
          `Run 'cleo show ${parsed.targetTaskId}' to list its acceptance criteria.`,
        codeName: 'E_AC_BINDING_TARGET_AC_NOT_FOUND',
      };
    }
    resolvedAcUuid = parsed.targetAcId;
  } else if (parsed.targetAcAlias !== undefined) {
    // Alias path — resolve via (task_id, ordinal) lookup.
    resolvedAcUuid = await resolveAliasToUuid(db, parsed.targetTaskId, parsed.targetAcAlias);
    if (resolvedAcUuid === null) {
      return {
        ok: false,
        reason:
          `satisfies: alias "${parsed.targetAcAlias}" does not resolve to any AC on target task "${parsed.targetTaskId}". ` +
          `Run 'cleo show ${parsed.targetTaskId}' to list its acceptance criteria (the alias is the 1-based AC<n> position).`,
        codeName: 'E_AC_BINDING_TARGET_AC_NOT_FOUND',
      };
    }
    // -------------------------------------------------------------------
    // Alias drift detection (ADR-079-r2 §3 — hard error path)
    //
    // Compare the alias's current canonical UUID against any
    // previously-persisted binding for the same (source, target, alias)
    // triple. When they disagree, the alias has shifted — the worker
    // MUST re-state the atom using the canonical UUID form.
    // -------------------------------------------------------------------
    const driftedFrom = await detectAliasDrift(
      db,
      sourceTaskId,
      parsed.targetTaskId,
      parsed.targetAcAlias,
      resolvedAcUuid,
    );
    if (driftedFrom !== null) {
      return {
        ok: false,
        reason:
          `satisfies: alias "${parsed.targetAcAlias}" on target "${parsed.targetTaskId}" has drifted — ` +
          `previously resolved to ${driftedFrom}, now resolves to ${resolvedAcUuid}. ` +
          `Re-emit the atom using the canonical UUID form to lock the binding: ` +
          `satisfies:${parsed.targetTaskId}#${resolvedAcUuid}`,
        codeName: 'E_AC_ALIAS_DRIFTED',
      };
    }
  } else {
    // Defence-in-depth — covered by check 1 but exhausting the union
    // here keeps TypeScript exhaustiveness happy.
    return {
      ok: false,
      reason: `satisfies: neither targetAcId nor targetAcAlias is set`,
      codeName: 'E_AC_BINDING_MALFORMED',
    };
  }

  // -------------------------------------------------------------------
  // Check 5 — Same-saga (or same-root-epic) scope
  //
  // Costliest check — runs ONLY after target+ac existence verified.
  // Skipped when `sourceTaskId` is undefined (caller is responsible
  // for stamping the task id; see param docs).
  // -------------------------------------------------------------------
  if (sourceTaskId !== undefined && sourceTaskId !== parsed.targetTaskId) {
    const shared = await shareScope(db, sourceTaskId, parsed.targetTaskId);
    if (!shared) {
      return {
        ok: false,
        reason:
          `satisfies: source task "${sourceTaskId}" and target task "${parsed.targetTaskId}" ` +
          `are not in the same saga (or root epic when no saga is present). ` +
          `Atoms may only bind ACs across tasks that ship as a coherent unit per ADR-079-r2 §2.3. ` +
          `If the cross-saga binding is genuinely required, escalate to the Lead — ` +
          `the saga boundary is the binding boundary by design.`,
        codeName: 'E_AC_BINDING_OUT_OF_SCOPE',
      };
    }
  }

  // -------------------------------------------------------------------
  // Success — return the canonicalised atom with resolvedAcUuid pinned
  // -------------------------------------------------------------------
  return {
    ok: true,
    atom: {
      kind: 'satisfies',
      targetTaskId: parsed.targetTaskId,
      targetAcId: parsed.targetAcId,
      targetAcAlias: parsed.targetAcAlias,
      versionPin: parsed.versionPin,
      resolvedAcUuid,
    },
  };
}
