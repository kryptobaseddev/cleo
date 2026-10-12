/**
 * Canonical accessors for the re-keyed CleoDocs conduit history family
 * (T13354 · spec `cleodocs-rearch-design` §3/§10 · D11165).
 *
 * Every write to `conduit_attachment_versions` / `conduit_attachment_approvals`
 * / `conduit_doc_slug_aliases` / `conduit_doc_heads` /
 * `conduit_attachment_contributors` / `section_crdt_states` goes through the
 * functions here, on the `openDualScopeDb` chokepoint's drizzle handle
 * ({@link getDb}) — gate 3 (no raw opens) and gate 28 (no raw writes to
 * syncing tables; the derived contributors rebuild is raw SQL by design and
 * exempt per (file, table) in `scripts/lint-no-raw-table-writes.mjs`).
 *
 * Semantics implemented here:
 *
 *   - Version identity is the row uid + `parent_version_uid` DAG;
 *     `version_number` is minted as a LOCAL display ordinal (max + 1 within
 *     the doc on this device) and is never a key.
 *   - Approvals are append-only; {@link revokeConduitAttachmentApproval}
 *     writes a tombstone row (`status: 'revoked'`).
 *   - The doc head projection keeps the max-HLC head; a losing concurrent
 *     head increments `conflict_count` and is recorded in
 *     `last_conflict_json` (typed merge rule `docs.head.max-hlc`).
 *   - `section_crdt_states` is local-only; nothing here syncs it, and an
 *     apply that lands a version rebases it via
 *     {@link rebaseSectionCrdtStates}.
 *
 * @module
 * @task T13354
 * @epic T13340
 * @saga T13339
 */

import { randomUUID } from 'node:crypto';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { and, desc, eq, sql } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import { naturalRowUid } from './row-identity.js';
import {
  conduitAttachmentApprovals,
  conduitAttachments,
  conduitAttachmentVersions,
  conduitDocHeads,
  conduitDocSlugAliases,
  sectionCrdtStates,
} from './schema/cleo-project/conduit.js';
import { getDb } from './sqlite.js';

/** Row shape of `conduit_attachment_versions` as read back. */
export type ConduitAttachmentVersionRow = typeof conduitAttachmentVersions.$inferSelect;
/** Row shape of `conduit_attachment_approvals` as read back. */
export type ConduitAttachmentApprovalRow = typeof conduitAttachmentApprovals.$inferSelect;
/** Row shape of `conduit_doc_heads` as read back. */
export type ConduitDocHeadRow = typeof conduitDocHeads.$inferSelect;
/** Row shape of `section_crdt_states` as read back. */
export type SectionCrdtStateRow = typeof sectionCrdtStates.$inferSelect;

/** One recorded head conflict (the losing concurrent head). */
export interface ConduitDocHeadConflict {
  /** The losing head's version uid. */
  readonly versionUid: string;
  /** The losing head's HLC. */
  readonly hlc: string;
  /** ISO-8601 instant the conflict was recorded. */
  readonly recordedAt: string;
}

/**
 * Refuse an empty identifier at the write boundary.
 *
 * @param name - Field name for the message.
 * @param value - The value to check.
 */
function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    // @sync-invariant none:input-shape a blank identifier is refused before any write; nothing was written
    throw new CleoError(ExitCode.VALIDATION_ERROR, `${name} must be a non-empty string`);
  }
}

/**
 * Resolve a document slug to its immutable row uid.
 *
 * Lookup order: the live slug on `conduit_attachments` first (a live id
 * always wins), then the newest alias in `conduit_doc_slug_aliases` (the
 * old-slug lookup, T13354 AC2).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param slug - The slug to resolve.
 * @returns The doc's `conduit_attachments.uid`, or `null` when unknown.
 */
export async function resolveConduitDocUid(
  projectRoot: string,
  slug: string,
): Promise<string | null> {
  requireNonEmpty('slug', slug);
  const db = await getDb(projectRoot);
  const live = await db
    .select({ uid: conduitAttachments.uid })
    .from(conduitAttachments)
    .where(eq(conduitAttachments.slug, slug))
    .get();
  if (live?.uid) return live.uid;
  const alias = await db
    .select({ docUid: conduitDocSlugAliases.docUid })
    .from(conduitDocSlugAliases)
    .where(eq(conduitDocSlugAliases.slug, slug))
    .orderBy(desc(conduitDocSlugAliases.createdAt))
    .get();
  return alias?.docUid ?? null;
}

/**
 * Record an old-slug → doc-uid alias (append-only).
 *
 * The row's uid is the NATURAL identity over (slug, docUid), so two devices
 * recording the same alias merge to one row; a repeat insert is a no-op.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param alias - Slug, target doc uid and an optional reason.
 * @returns The alias row's uid.
 */
export async function recordConduitDocAlias(
  projectRoot: string,
  alias: { slug: string; docUid: string; reason?: string },
): Promise<string> {
  requireNonEmpty('slug', alias.slug);
  requireNonEmpty('docUid', alias.docUid);
  const uid = naturalRowUid('project', 'conduit_doc_slug_aliases', [alias.slug, alias.docUid]);
  const db = await getDb(projectRoot);
  await db
    .insert(conduitDocSlugAliases)
    .values({
      uid,
      slug: alias.slug,
      docUid: alias.docUid,
      reason: alias.reason ?? 'rename',
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  return uid;
}

/** Input for {@link appendConduitAttachmentVersion}. */
export interface AppendConduitAttachmentVersionInput {
  /** Immutable doc id (`conduit_attachments.uid`). */
  readonly attachmentUid: string;
  /** Parent version uid in the DAG; null for the root version. */
  readonly parentVersionUid: string | null;
  /** Revision author agent id. */
  readonly authorAgentId: string;
  /** Content-addressed blob ref (never inline bytes for large bodies). */
  readonly storageKey: string;
  /** SHA content hash of the body the blob ref points at. */
  readonly contentHash: string;
  /** Uncompressed size in bytes. */
  readonly originalSize: number;
  /** Compressed size in bytes. */
  readonly compressedSize: number;
  /** Token count of this version. */
  readonly tokens: number;
  /** Change type (default 'patch'). */
  readonly changeType?: string;
  /** Optional patch text for small edits. */
  readonly patchText?: string;
  /** Optional change summary. */
  readonly changeSummary?: string;
  /** Section ids this version modified. */
  readonly sectionsModified?: readonly string[];
  /** Tokens added / removed by this version. */
  readonly tokensAdded?: number;
  readonly tokensRemoved?: number;
}

/**
 * Append a version row to a document's history DAG.
 *
 * `version_number` is minted as (current local max within the doc) + 1 — a
 * display ordinal only; another device minting the same number is NOT a
 * conflict, because version identity is the row uid + parent linkage. The
 * `uid` itself comes from the schema's `defaultRowUid` (a random UUIDv7 at
 * insert), matching the T12341 minted-table pattern.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The version facts.
 * @returns The inserted row.
 */
// @sync-invariant docs.versions.append-only the read (local max display ordinal) and the append are one causal step; the uid makes the insert conflict-free
export async function appendConduitAttachmentVersion(
  projectRoot: string,
  input: AppendConduitAttachmentVersionInput,
): Promise<ConduitAttachmentVersionRow> {
  requireNonEmpty('attachmentUid', input.attachmentUid);
  requireNonEmpty('authorAgentId', input.authorAgentId);
  requireNonEmpty('storageKey', input.storageKey);
  requireNonEmpty('contentHash', input.contentHash);
  const db = await getDb(projectRoot);
  const latest = await db
    .select({ versionNumber: conduitAttachmentVersions.versionNumber })
    .from(conduitAttachmentVersions)
    .where(eq(conduitAttachmentVersions.attachmentUid, input.attachmentUid))
    .orderBy(desc(conduitAttachmentVersions.versionNumber))
    .get();
  const id = randomUUID();
  await db
    .insert(conduitAttachmentVersions)
    .values({
      id,
      attachmentUid: input.attachmentUid,
      parentVersionUid: input.parentVersionUid,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
      authorAgentId: input.authorAgentId,
      changeType: input.changeType ?? 'patch',
      ...(input.patchText !== undefined ? { patchText: input.patchText } : {}),
      storageKey: input.storageKey,
      contentHash: input.contentHash,
      originalSize: input.originalSize,
      compressedSize: input.compressedSize,
      tokens: input.tokens,
      ...(input.changeSummary !== undefined ? { changeSummary: input.changeSummary } : {}),
      sectionsModified: JSON.stringify(input.sectionsModified ?? []),
      tokensAdded: input.tokensAdded ?? 0,
      tokensRemoved: input.tokensRemoved ?? 0,
      createdAt: new Date().toISOString(),
    })
    .run();
  const row = await db
    .select()
    .from(conduitAttachmentVersions)
    .where(eq(conduitAttachmentVersions.id, id))
    .get();
  if (!row) {
    // @sync-invariant docs.versions.append-only a version insert that cannot be read back means the store lost the write; fail loudly instead of returning a phantom
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `version insert for doc ${input.attachmentUid} could not be read back`,
    );
  }
  return row;
}

/**
 * List a document's versions, newest display ordinal first.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param attachmentUid - The doc's immutable uid.
 * @returns The version rows.
 */
export async function listConduitAttachmentVersions(
  projectRoot: string,
  attachmentUid: string,
): Promise<ConduitAttachmentVersionRow[]> {
  requireNonEmpty('attachmentUid', attachmentUid);
  const db = await getDb(projectRoot);
  return db
    .select()
    .from(conduitAttachmentVersions)
    .where(eq(conduitAttachmentVersions.attachmentUid, attachmentUid))
    .orderBy(desc(conduitAttachmentVersions.versionNumber))
    .all();
}

/** Input for {@link recordConduitAttachmentApproval}. */
export interface RecordConduitAttachmentApprovalInput {
  /** Immutable doc id. */
  readonly attachmentUid: string;
  /** The reviewed version's uid. */
  readonly versionUid: string;
  /** Section the verdict covers; omit for a whole-document verdict. */
  readonly sectionId?: string;
  /** Reviewer agent id. */
  readonly reviewerAgentId: string;
  /** Verdict (default 'approved'; a revoke is written as 'revoked'). */
  readonly status?: string;
  /** Optional reviewer comment. */
  readonly comment?: string;
  /** The version's display ordinal (display only). */
  readonly versionReviewed: number;
}

/**
 * Record an approval verdict as an append-only row.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The verdict facts.
 * @returns The inserted row.
 */
export async function recordConduitAttachmentApproval(
  projectRoot: string,
  input: RecordConduitAttachmentApprovalInput,
): Promise<ConduitAttachmentApprovalRow> {
  requireNonEmpty('attachmentUid', input.attachmentUid);
  requireNonEmpty('versionUid', input.versionUid);
  requireNonEmpty('reviewerAgentId', input.reviewerAgentId);
  const db = await getDb(projectRoot);
  const id = randomUUID();
  const now = new Date().toISOString();
  await db
    .insert(conduitAttachmentApprovals)
    .values({
      id,
      attachmentUid: input.attachmentUid,
      versionUid: input.versionUid,
      ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
      reviewerAgentId: input.reviewerAgentId,
      status: input.status ?? 'approved',
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      versionReviewed: input.versionReviewed,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const row = await db
    .select()
    .from(conduitAttachmentApprovals)
    .where(eq(conduitAttachmentApprovals.id, id))
    .get();
  if (!row) {
    // @sync-invariant docs.approvals.append-only an approval insert that cannot be read back means the store lost the write; fail loudly instead of returning a phantom
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `approval insert for version ${input.versionUid} could not be read back`,
    );
  }
  return row;
}

/**
 * Revoke an approval as a TOMBSTONE row (never an UPDATE or DELETE).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The revoke facts (same shape as the original verdict).
 * @returns The tombstone row.
 */
export async function revokeConduitAttachmentApproval(
  projectRoot: string,
  input: Omit<RecordConduitAttachmentApprovalInput, 'status'>,
): Promise<ConduitAttachmentApprovalRow> {
  return recordConduitAttachmentApproval(projectRoot, { ...input, status: 'revoked' });
}

/**
 * The effective verdicts for one version: the latest row per (reviewer,
 * section) wins, and 'revoked' tombstones cancel the earlier verdict.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param versionUid - The version uid.
 * @param sectionId - Restrict to one section when given (plus whole-doc rows).
 * @returns The approval rows in creation order.
 */
export async function listConduitAttachmentApprovals(
  projectRoot: string,
  versionUid: string,
  sectionId?: string,
): Promise<ConduitAttachmentApprovalRow[]> {
  requireNonEmpty('versionUid', versionUid);
  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(conduitAttachmentApprovals)
    .where(
      sectionId === undefined
        ? eq(conduitAttachmentApprovals.versionUid, versionUid)
        : and(
            eq(conduitAttachmentApprovals.versionUid, versionUid),
            eq(conduitAttachmentApprovals.sectionId, sectionId),
          ),
    )
    .all();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Rebuild the DERIVED contributors rollup from the versions table.
 *
 * `conduit_attachment_contributors` is not synced (spec §10): every device
 * recomputes it after apply. Raw set-SQL (DELETE + INSERT … SELECT … GROUP
 * BY) because the rebuild is a pure aggregate — the two statements are the
 * gate-28 exempt sites for this (file, table).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param attachmentUid - Rebuild one doc only when given, else every doc.
 * @returns The number of rollup rows written.
 */
export async function rebuildConduitAttachmentContributors(
  projectRoot: string,
  attachmentUid?: string,
): Promise<number> {
  const db = await getDb(projectRoot);
  if (attachmentUid !== undefined) {
    requireNonEmpty('attachmentUid', attachmentUid);
    await db.run(
      sql`DELETE FROM conduit_attachment_contributors WHERE attachment_uid = ${attachmentUid}`,
    );
  } else {
    await db.run(sql`DELETE FROM conduit_attachment_contributors`);
  }
  const scope = attachmentUid ?? null;
  const result = await db.run(sql`
    INSERT INTO conduit_attachment_contributors (
      attachment_uid, slug, agent_id, version_count,
      total_tokens_added, total_tokens_removed,
      first_contribution_at, last_contribution_at
    )
    SELECT
      v.attachment_uid,
      NULL,
      v.author_agent_id,
      COUNT(*),
      SUM(v.tokens_added),
      SUM(v.tokens_removed),
      MIN(v.created_at),
      MAX(v.created_at)
    FROM conduit_attachment_versions AS v
    WHERE v.attachment_uid IS NOT NULL
      AND (${scope} IS NULL OR v.attachment_uid = ${scope})
    GROUP BY v.attachment_uid, v.author_agent_id
  `);
  return Number(result.changes);
}

/** Input for {@link upsertConduitDocHead}. */
export interface UpsertConduitDocHeadInput {
  /** Immutable doc id. */
  readonly attachmentUid: string;
  /** The candidate head version's uid. */
  readonly headVersionUid: string;
  /**
   * The candidate head's HLC (journal wire form). Its lexical order IS the
   * (phys, ctr, replica) tuple order (`store/sync/hlc.ts`), so plain string
   * comparison is the max-HLC rule.
   */
  readonly headHlc: string;
}

/** Outcome of a {@link upsertConduitDocHead} call. */
export interface UpsertConduitDocHeadResult {
  /** Whether the candidate became the head. */
  readonly advanced: boolean;
  /** Whether a losing concurrent head was recorded as a conflict. */
  readonly conflictRecorded: boolean;
  /** The head row after the call. */
  readonly head: ConduitDocHeadRow;
}

/**
 * Move a document's current-version projection (typed rule
 * `docs.head.max-hlc`).
 *
 * The row keeps the MAX-HLC head. A candidate that loses to a concurrent
 * head is never silently shadowed: `conflict_count` increments and
 * `last_conflict_json` records the loser (the losing version itself survives
 * in `conduit_attachment_versions`). A repeat of the same head is a no-op.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The candidate head.
 * @returns Whether the head advanced or a conflict was recorded.
 */
// @sync-invariant docs.head.max-hlc the read-modify-write IS the max-HLC rule: keep the max head, record the losing concurrent head as a conflict
export async function upsertConduitDocHead(
  projectRoot: string,
  input: UpsertConduitDocHeadInput,
): Promise<UpsertConduitDocHeadResult> {
  requireNonEmpty('attachmentUid', input.attachmentUid);
  requireNonEmpty('headVersionUid', input.headVersionUid);
  requireNonEmpty('headHlc', input.headHlc);
  const db = await getDb(projectRoot);
  const existing = await db
    .select()
    .from(conduitDocHeads)
    .where(eq(conduitDocHeads.attachmentUid, input.attachmentUid))
    .get();
  const now = new Date().toISOString();

  if (!existing) {
    await db
      .insert(conduitDocHeads)
      .values({
        attachmentUid: input.attachmentUid,
        uid: naturalRowUid('project', 'conduit_doc_heads', [input.attachmentUid]),
        headVersionUid: input.headVersionUid,
        headHlc: input.headHlc,
        conflictCount: 0,
        updatedAt: now,
      })
      .run();
  } else if (existing.headVersionUid === input.headVersionUid) {
    // Same head — idempotent re-apply, no conflict.
  } else if (input.headHlc > existing.headHlc) {
    await db
      .update(conduitDocHeads)
      .set({ headVersionUid: input.headVersionUid, headHlc: input.headHlc, updatedAt: now })
      .where(eq(conduitDocHeads.attachmentUid, input.attachmentUid))
      .run();
  } else {
    const conflict: ConduitDocHeadConflict = {
      versionUid: input.headVersionUid,
      hlc: input.headHlc,
      recordedAt: now,
    };
    await db
      .update(conduitDocHeads)
      .set({
        conflictCount: existing.conflictCount + 1,
        lastConflictJson: JSON.stringify(conflict),
        updatedAt: now,
      })
      .where(eq(conduitDocHeads.attachmentUid, input.attachmentUid))
      .run();
  }

  const head = await db
    .select()
    .from(conduitDocHeads)
    .where(eq(conduitDocHeads.attachmentUid, input.attachmentUid))
    .get();
  if (!head) {
    // @sync-invariant docs.head.max-hlc the projection row must exist after its upsert; fail loudly instead of returning a phantom
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `doc head upsert for ${input.attachmentUid} could not be read back`,
    );
  }
  return {
    advanced: head.headVersionUid === input.headVersionUid && head.headHlc === input.headHlc,
    conflictRecorded:
      head.headVersionUid !== input.headVersionUid && head.lastConflictJson !== null,
    head,
  };
}

/**
 * Read a document's current-version projection row.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param attachmentUid - The doc's immutable uid.
 * @returns The head row, or `null` when the doc has no projection yet.
 */
export async function getConduitDocHead(
  projectRoot: string,
  attachmentUid: string,
): Promise<ConduitDocHeadRow | null> {
  requireNonEmpty('attachmentUid', attachmentUid);
  const db = await getDb(projectRoot);
  const row = await db
    .select()
    .from(conduitDocHeads)
    .where(eq(conduitDocHeads.attachmentUid, attachmentUid))
    .get();
  return row ?? null;
}

/**
 * Read the local Loro state of one document section.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param attachmentUid - The doc's immutable uid.
 * @param sectionId - The section id.
 * @returns The state row, or `null` when this device has none.
 */
export async function readSectionCrdtState(
  projectRoot: string,
  attachmentUid: string,
  sectionId: string,
): Promise<SectionCrdtStateRow | null> {
  requireNonEmpty('attachmentUid', attachmentUid);
  requireNonEmpty('sectionId', sectionId);
  const db = await getDb(projectRoot);
  const row = await db
    .select()
    .from(sectionCrdtStates)
    .where(
      and(
        eq(sectionCrdtStates.attachmentUid, attachmentUid),
        eq(sectionCrdtStates.sectionId, sectionId),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Write the local Loro state of one document section (upsert).
 *
 * LOCAL-ONLY: this state never syncs; content moves cross-device only
 * through landed versions (spec §2 option b).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The section's snapshot bytes and optional base version.
 */
export async function writeSectionCrdtState(
  projectRoot: string,
  input: {
    attachmentUid: string;
    sectionId: string;
    snapshot: Buffer;
    baseVersionUid?: string | null;
  },
): Promise<void> {
  requireNonEmpty('attachmentUid', input.attachmentUid);
  requireNonEmpty('sectionId', input.sectionId);
  const db = await getDb(projectRoot);
  await db
    .insert(sectionCrdtStates)
    .values({
      attachmentUid: input.attachmentUid,
      sectionId: input.sectionId,
      snapshot: input.snapshot,
      baseVersionUid: input.baseVersionUid ?? null,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [sectionCrdtStates.attachmentUid, sectionCrdtStates.sectionId],
      set: {
        snapshot: input.snapshot,
        baseVersionUid: input.baseVersionUid ?? null,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

/**
 * Rebase every local CRDT state of a document onto a landed version.
 *
 * Called when an apply lands a new version: the local Loro state is reset
 * onto the landed base (`base_version_uid`) so stale local edits do not
 * silently diverge from the synced history (spec §10).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param attachmentUid - The doc's immutable uid.
 * @param baseVersionUid - The landed version's uid.
 */
export async function rebaseSectionCrdtStates(
  projectRoot: string,
  attachmentUid: string,
  baseVersionUid: string,
): Promise<void> {
  requireNonEmpty('attachmentUid', attachmentUid);
  requireNonEmpty('baseVersionUid', baseVersionUid);
  const db = await getDb(projectRoot);
  await db
    .update(sectionCrdtStates)
    .set({ baseVersionUid, updatedAt: new Date().toISOString() })
    .where(eq(sectionCrdtStates.attachmentUid, attachmentUid))
    .run();
}
