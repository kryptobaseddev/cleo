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

import { createHash, randomUUID } from 'node:crypto';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
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
import type { ConduitDocMigrationLedgerRow } from './schema/cleo-project/docs.js';
import { conduitDocMigrationLedger } from './schema/cleo-project/docs.js';
import { getDb, getNativeDb } from './sqlite.js';

/**
 * Run one docs-projection write batch atomically (T13583).
 *
 * The section write path composes several accessors — section-state writes,
 * the version append, the head upsert, the rebase and the derived
 * contributors rebuild — and a failure halfway must not leave a non-head
 * version behind for the next update to fork onto. The drizzle handle from
 * {@link getDb} and the raw handle from {@link getNativeDb} are the same
 * underlying `DatabaseSync`, so a `BEGIN IMMEDIATE` on the raw handle
 * brackets every statement the accessors issue (the same pattern
 * `docs-update.ts` uses for its slug transfer).
 *
 * Constraint (T13583): every statement inside `fn` must resolve without a
 * real I/O yield — the docs projection satisfies this (sync-driver
 * accessors, sync `node:fs` blob reads/writes), so no other async writer can
 * interleave on this connection mid-transaction. A caller that awaits real
 * I/O inside `fn` breaks that guarantee; per-handle writer serialization is
 * the follow-up if such a caller appears.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param fn - The write batch; awaited between statements on this one
 *   connection, so no other writer can interleave inside the transaction.
 * @returns What `fn` returned.
 */
// @sync-invariant docs.head.max-hlc the version append, the head upsert and the rebase commit or roll back as one causal step; a half-landed projection cannot fork the next update
export async function withConduitDocWriteTransaction<T>(
  projectRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  await getDb(projectRoot);
  const native = getNativeDb(projectRoot);
  if (!native) {
    // @sync-invariant none:input-shape the projection requires an open project store; getDb above just opened it, so this is a broken environment, not row data — nothing was written
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'conduit doc write transaction requires an initialised project store',
    );
  }
  native.prepare('BEGIN IMMEDIATE').run();
  try {
    const out = await fn();
    native.prepare('COMMIT').run();
    return out;
  } catch (err) {
    try {
      native.prepare('ROLLBACK').run();
    } catch {
      /* Auto-rolled back by SQLite on most errors. */
    }
    throw err;
  }
}

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
  /**
   * The winning head's version uid at recording time — both sides of the
   * conflict are named on the row (head `head_version_uid` + this).
   * (T13595)
   */
  readonly winnerVersionUid?: string;
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
 * Adopt a document into the conduit family on first sight (T13355).
 *
 * The docs write path (`docs/section-write-path.ts`) projects every doc
 * update through the section CRDT layer, whose history tables are keyed on
 * `conduit_attachments.uid`; a doc that only exists in the legacy
 * `attachments` registry has no conduit row yet, so this inserts one. The
 * row is a thin identity shell: the bytes live in the blob store, so
 * `content` carries an empty buffer and the sizes/hash describe nothing —
 * the version rows carry the real content addressing.
 *
 * `conversation_id` is the NOT NULL transport owner; docs adopted here use
 * the `cleodocs` sentinel (no FK — soft reference by design). Idempotent:
 * an existing live row (or alias-resolved uid) is returned with
 * `adopted: false`.
 *
 * The adopted row's uid is the schema's random UUIDv7 default — a
 * single-device mint. Two devices adopting the same legacy slug concurrently
 * mint two uids for one doc; deduping that is the filed follow-up (T13586).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - Slug, author and current full text of the doc.
 * @returns The doc's immutable uid and whether this call created the row.
 */
// @sync-invariant docs.doc.adopt-once the existence probe and the identity-shell insert are one causal step; the uid default makes a re-adopt conflict-free
export async function ensureConduitDoc(
  projectRoot: string,
  input: { slug: string; authorAgentId: string; content: Buffer },
): Promise<{ uid: string; adopted: boolean }> {
  requireNonEmpty('slug', input.slug);
  requireNonEmpty('authorAgentId', input.authorAgentId);
  const existing = await resolveConduitDocUid(projectRoot, input.slug);
  if (existing !== null) return { uid: existing, adopted: false };

  const db = await getDb(projectRoot);
  await db
    .insert(conduitAttachments)
    .values({
      slug: input.slug,
      conversationId: 'cleodocs',
      fromAgentId: input.authorAgentId,
      content: Buffer.alloc(0),
      originalSize: input.content.length,
      compressedSize: input.content.length,
      contentHash: createHash('sha256').update(input.content).digest('hex'),
      format: 'text',
      title: input.slug,
      tokens: input.content
        .toString('utf-8')
        .split(/\s+/)
        .filter((w) => w.length > 0).length,
    })
    .onConflictDoNothing()
    .run();

  const row = await db
    .select({ uid: conduitAttachments.uid })
    .from(conduitAttachments)
    .where(eq(conduitAttachments.slug, input.slug))
    .get();
  if (!row?.uid) {
    // @sync-invariant docs.doc.adopt-once an adopt that cannot be read back means the store lost the write; fail loudly instead of returning a phantom
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      `conduit doc adopt for slug '${input.slug}' could not be read back`,
    );
  }
  return { uid: row.uid, adopted: true };
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
 * The set of content hashes the conduit doc-history family references.
 *
 * The blob sweep (`attachment-repair.ts`) only consulted the legacy
 * attachments tables, the publications ledger and the blobs manifest, so a
 * version/merged-text blob this family references could be garbage-collected
 * as "unreferenced" (T13596). The sweep callers consult this set; it covers
 * the version rows' `content_hash` (the merged-text blobs) and the adopted
 * docs' `content_hash`.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Every `content_hash` named by `conduit_attachment_versions` or
 *   `conduit_attachments`.
 */
export async function listConduitHistorySha256Set(projectRoot: string): Promise<Set<string>> {
  const db = await getDb(projectRoot);
  const versionRows = await db
    .select({ contentHash: conduitAttachmentVersions.contentHash })
    .from(conduitAttachmentVersions)
    .all();
  const docRows = await db
    .select({ contentHash: conduitAttachments.contentHash })
    .from(conduitAttachments)
    .all();
  const set = new Set<string>();
  for (const row of versionRows) set.add(row.contentHash);
  for (const row of docRows) set.add(row.contentHash);
  return set;
}

/**
 * Read one version row by its wire identity (`uid`).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param versionUid - The version's `uid`.
 * @returns The version row, or `null` when unknown.
 */
export async function getConduitAttachmentVersion(
  projectRoot: string,
  versionUid: string,
): Promise<ConduitAttachmentVersionRow | null> {
  requireNonEmpty('versionUid', versionUid);
  const db = await getDb(projectRoot);
  const row = await db
    .select()
    .from(conduitAttachmentVersions)
    .where(eq(conduitAttachmentVersions.uid, versionUid))
    .get();
  return row ?? null;
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
      winnerVersionUid: existing.headVersionUid,
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

// ============================================================================
// T13360 — legacy docs migration accessors (spec §5, D11165)
//
// The three importers below are IDEMPOTENT by construction: every row's uid
// is the NATURAL identity over its business key (doc slug; (doc uid,
// migration key); ledger slug), so a re-run derives the same uid and
// `onConflictDoNothing` turns the insert into a verified no-op — which is
// what makes the T13360 harness step re-runnable (AC4).
// ============================================================================

/** Input for {@link importMigratedConduitDoc}. */
export interface ImportMigratedConduitDocInput {
  /** Doc slug (the pre-rekey primary key; still the table PK). */
  readonly slug: string;
  /** Real provenance author when known; 'system:migration' when none. */
  readonly fromAgentId: string;
  /** Captured content bytes (stored uncompressed; sizes equal). */
  readonly content: Buffer;
  /** SHA-256 hex of `content`. */
  readonly contentHash: string;
  /** Content format tag ('markdown', 'text', …). */
  readonly format: string;
  /** Optional title. */
  readonly title?: string;
  /** Token count (measured, never invented). */
  readonly tokens: number;
  /** ISO-8601 doc creation instant from real provenance. */
  readonly createdAt: string;
  /** Imported history length (also written to the version_count columns). */
  readonly versionCount: number;
}

/**
 * Import one legacy doc as a `conduit_attachments` row (content-captured).
 *
 * The row uid is the natural identity over the slug: re-runs coalesce.
 * `conversation_id` is the honest system value 'docs:migration' — migrated
 * docs belong to no conduit conversation.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The captured doc facts.
 * @returns The doc uid and whether this call inserted the row.
 * @task T13360
 */
// @sync-invariant docs.docs-migration.idempotent-import the natural uid over the slug makes a re-run a verified no-op via ON CONFLICT DO NOTHING; nothing is updated or deleted
export async function importMigratedConduitDoc(
  projectRoot: string,
  input: ImportMigratedConduitDocInput,
): Promise<{ uid: string; inserted: boolean }> {
  requireNonEmpty('slug', input.slug);
  requireNonEmpty('fromAgentId', input.fromAgentId);
  requireNonEmpty('contentHash', input.contentHash);
  const uid = naturalRowUid('project', 'conduit_attachments', [input.slug]);
  const db = await getDb(projectRoot);
  const result = await db
    .insert(conduitAttachments)
    .values({
      slug: input.slug,
      conversationId: 'docs:migration',
      fromAgentId: input.fromAgentId,
      content: input.content,
      originalSize: input.content.length,
      compressedSize: input.content.length,
      contentHash: input.contentHash,
      format: input.format,
      ...(input.title !== undefined ? { title: input.title } : {}),
      tokens: input.tokens,
      versionCount: input.versionCount,
      currentVersion: input.versionCount,
      createdAt: input.createdAt,
      uid,
    })
    .onConflictDoNothing()
    .run();
  return { uid, inserted: (result.changes ?? 0) > 0 };
}

/** Input for {@link importMigratedConduitVersion}. */
export interface ImportMigratedConduitVersionInput {
  /** Immutable doc id (`conduit_attachments.uid`). */
  readonly attachmentUid: string;
  /**
   * Stable per-doc import key — the natural identity discriminator. The
   * migration uses the legacy audit event's ordinal position ('evt-1',
   * 'evt-2', …) or 'base' for the content-capture fallback, so a re-run
   * derives the same uid for the same legacy fact.
   */
  readonly migrationKey: string;
  /** Parent version uid in the DAG (NULL for the root import). */
  readonly parentVersionUid: string | null;
  /** Real provenance author (audit-log actor); 'system:migration' when none. */
  readonly authorAgentId: string;
  /** Content-addressed ref to the captured bytes. */
  readonly storageKey: string;
  /** SHA-256 hex of the version body. */
  readonly contentHash: string;
  /** Body size in bytes. */
  readonly sizeBytes: number;
  /** Measured token count. */
  readonly tokens: number;
  /** Display ordinal within the doc (derived from the real event order). */
  readonly versionNumber: number;
  /** ISO-8601 instant from real provenance (the audit event's ts). */
  readonly createdAt: string;
  /** Honest summary of what this row is. */
  readonly changeSummary: string;
  /** Pre-rekey display slug (legacy carry column). */
  readonly slug: string;
}

/**
 * Import one history row for a migrated doc.
 *
 * Every imported row carries `origin: 'migrated'` (spec §5 — no imported row
 * poses as native) and a natural uid over (doc uid, migration key), so the
 * insert is conflict-free on re-run and history can never be duplicated
 * (AC4).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The version facts.
 * @returns The version uid and whether this call inserted the row.
 * @task T13360
 */
// @sync-invariant docs.versions.append-only the natural uid over (doc uid, migration key) makes a re-run a verified no-op via ON CONFLICT DO NOTHING; imported history is never updated or deleted
export async function importMigratedConduitVersion(
  projectRoot: string,
  input: ImportMigratedConduitVersionInput,
): Promise<{ uid: string; inserted: boolean }> {
  requireNonEmpty('attachmentUid', input.attachmentUid);
  requireNonEmpty('migrationKey', input.migrationKey);
  requireNonEmpty('authorAgentId', input.authorAgentId);
  const uid = naturalRowUid('project', 'conduit_attachment_versions', [
    input.attachmentUid,
    input.migrationKey,
  ]);
  const db = await getDb(projectRoot);
  const result = await db
    .insert(conduitAttachmentVersions)
    .values({
      id: randomUUID(),
      uid,
      attachmentUid: input.attachmentUid,
      parentVersionUid: input.parentVersionUid,
      slug: input.slug,
      versionNumber: input.versionNumber,
      authorAgentId: input.authorAgentId,
      changeType: 'migrated',
      storageKey: input.storageKey,
      contentHash: input.contentHash,
      originalSize: input.sizeBytes,
      compressedSize: input.sizeBytes,
      tokens: input.tokens,
      changeSummary: input.changeSummary,
      sectionsModified: '[]',
      tokensAdded: 0,
      tokensRemoved: 0,
      createdAt: input.createdAt,
      origin: 'migrated',
    })
    .onConflictDoNothing()
    .run();
  return { uid, inserted: (result.changes ?? 0) > 0 };
}

/** Input for {@link recordConduitDocMigration}. */
export interface RecordConduitDocMigrationInput {
  /** The migrated doc's slug (one receipt per slug). */
  readonly slug: string;
  /** Captured doc uid (NULL when the doc is dangling). */
  readonly docUid: string | null;
  /** 'captured' or 'dangling'. */
  readonly status: 'captured' | 'dangling';
  /** Why (e.g. 'path-missing', 'path-ephemeral:worktree'). */
  readonly reason: string;
  /** Legacy pointer path when one existed. */
  readonly legacyPath?: string;
  /** Legacy content sha256 when known. */
  readonly legacySha256?: string;
  /** How many history rows the import created. */
  readonly versionsImported: number;
}

/**
 * Record the migration receipt for one doc (append-only, idempotent).
 *
 * This IS the auditable record for the dangling verdict (AC3): a dangling
 * doc leaves a row with status 'dangling', the legacy pointer and the
 * reason — never a silent import. The natural uid over the slug makes a
 * re-run coalesce onto the same row.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param input - The receipt facts.
 * @task T13360
 */
// @sync-invariant docs.docs-migration.idempotent-import the natural uid over the slug makes a re-run a verified no-op via ON CONFLICT DO NOTHING; receipts are never updated or deleted
export async function recordConduitDocMigration(
  projectRoot: string,
  input: RecordConduitDocMigrationInput,
): Promise<{ uid: string; inserted: boolean }> {
  requireNonEmpty('slug', input.slug);
  const uid = naturalRowUid('project', 'conduit_doc_migration_ledger', [input.slug]);
  const db = await getDb(projectRoot);
  const result = await db
    .insert(conduitDocMigrationLedger)
    .values({
      slug: input.slug,
      docUid: input.docUid,
      status: input.status,
      reason: input.reason,
      ...(input.legacyPath !== undefined ? { legacyPath: input.legacyPath } : {}),
      ...(input.legacySha256 !== undefined ? { legacySha256: input.legacySha256 } : {}),
      versionsImported: input.versionsImported,
      migratedAt: new Date().toISOString(),
      uid,
    })
    .onConflictDoNothing()
    .run();
  return { uid, inserted: (result.changes ?? 0) > 0 };
}

/** The migration receipt for one doc, or null when not migrated. */
export async function findConduitDocMigration(
  projectRoot: string,
  slug: string,
): Promise<ConduitDocMigrationLedgerRow | null> {
  requireNonEmpty('slug', slug);
  const db = await getDb(projectRoot);
  return (
    (await db
      .select()
      .from(conduitDocMigrationLedger)
      .where(eq(conduitDocMigrationLedger.slug, slug))
      .get()) ?? null
  );
}

/** All migration receipts, slug ascending (the audit view). */
export async function listConduitDocMigrations(
  projectRoot: string,
): Promise<ConduitDocMigrationLedgerRow[]> {
  const db = await getDb(projectRoot);
  return db
    .select()
    .from(conduitDocMigrationLedger)
    .orderBy(asc(conduitDocMigrationLedger.slug))
    .all();
}
