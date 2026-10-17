/**
 * T13727 — backfill `conduit_attachment_versions` for docs whose history
 * predates the conduit adoption.
 *
 * The section write path (`section-write-path.ts`) has projected every docs
 * update through the conduit history family since the adoption release, but
 * updates from BEFORE the adoption wrote no conduit rows — the T13360
 * migration projected only then-current content. A doc at `docVersion` 3 can
 * therefore hold a single conduit version row (the first post-adoption
 * update, minted as local display ordinal 1), with versions 1..N−1 known
 * only to the legacy surfaces. This module is the historical complement to
 * that projection: it reconstructs the missing rows from the honest
 * pre-adoption sources and inserts them through the canonical accessor.
 *
 * Honest-metadata contract (Council condition for migrated history):
 *
 *   - The version CHAIN comes from the docs-versioning audit log
 *     (`.cleo/audit/docs-versioning.jsonl`): each changed revision records
 *     the real timestamp (`ts`), the real author (`attachedBy`) and the real
 *     content address (`sha256`). Version 1 anchors at the first revision's
 *     `previousSha256`; its creation instant is read from the matching
 *     `docs_attachments` row (historical rows keep their `created_at` after
 *     an update re-homes the slug), and its author is unknown — recorded as
 *     {@link CONDUIT_BACKFILL_AUTHOR}, never invented.
 *   - `changeType` is the schema's honest `'migrated'` (via
 *     {@link importMigratedConduitVersion}); `origin` is `'backfill-t13727'`
 *     so repair-synthesized rows never pose as T13360 imports.
 *   - `contentHash` addresses the REAL historical bytes. When the bytes are
 *     unrecoverable (neither the blob store nor the legacy attachment tree
 *     holds them), the position is recorded as a GAP and skipped — content
 *     is never fabricated. The parent chain links across a gap to the
 *     nearest present ancestor and the report counts the gap.
 *   - Existing conduit rows are NEVER updated or renumbered (append-only).
 *     Matching is by CONTENT HASH, never by ordinal or tail position
 *     (review-2253): a chain position whose hash already has a row is done;
 *     an existing row whose hash is not in the chain refuses the doc
 *     (reported for manual review); complete means every recoverable
 *     position is present, and unrecoverable positions stay reported as
 *     gaps rather than being silently dropped.
 *
 * Idempotency: a doc whose chain positions all have rows (by content hash)
 * is skipped; per-row natural uids (doc uid, content hash, createdAt) make a
 * partial re-run a verified no-op via `ON CONFLICT DO NOTHING`.
 *
 * The parent link from the last backfilled row to the first EXISTING row is
 * implicit (content alignment + display ordinals); existing rows'
 * `parent_version_uid` is history and stays untouched.
 *
 * @module
 * @task T13727
 * @epic T13340
 * @saga T13339
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { resolveCleoDir } from '../paths.js';
import { resolveLegacyByteSource } from '../store/blob-keep.js';
import {
  importMigratedConduitVersion,
  listConduitAttachmentVersions,
  withConduitDocWriteTransaction,
} from '../store/conduit-doc-history.js';
import { naturalRowUid } from '../store/row-identity.js';
import { conduitAttachments } from '../store/schema/cleo-project/conduit.js';
import { getDb } from '../store/sqlite.js';
import { docsAttachments } from '../store/tasks-schema.js';
import { DOCS_VERSIONING_AUDIT_FILE } from './docs-update.js';

/**
 * Honest author label for backfilled rows whose real author is unrecoverable
 * (the original creation predates the docs-versioning audit trail's author
 * tracking on revisions, and `docs_attachments` records no author).
 *
 * @task T13727
 */
export const CONDUIT_BACKFILL_AUTHOR = 'cleo:backfill-t13727';

/**
 * Import provenance written to `conduit_attachment_versions.origin` — keeps
 * repair-synthesized rows distinguishable from T13360 `'migrated'` imports
 * and from native (`NULL`) rows.
 *
 * @task T13727
 */
export const CONDUIT_BACKFILL_ORIGIN = 'backfill-t13727';

/** MIME used to probe the legacy attachment tree for historical doc bytes. */
const DOC_PROBE_MIME = 'text/markdown';

/** One revision of the docs-versioning audit log (narrow, defensive parse). */
interface AuditRevision {
  readonly ts?: unknown;
  readonly previousSha256?: unknown;
  readonly sha256?: unknown;
  readonly changed?: unknown;
  readonly message?: unknown;
  readonly attachedBy?: unknown;
}

/** One content state in a doc's reconstructed pre-adoption version chain. */
export interface ConduitBackfillChainState {
  /** 1-based position in the doc's version chain (aligns with docVersion). */
  readonly position: number;
  /** Real content address of this version's bytes. */
  readonly sha256: string;
  /**
   * Real creation instant. For chain position 1 this is the
   * `docs_attachments` row's `created_at` when the row survives; when it
   * does not, the first revision's `ts` is used and the change summary
   * discloses that the original creation instant is unrecoverable.
   */
  readonly createdAt: string;
  /** Real revision author, or {@link CONDUIT_BACKFILL_AUTHOR} when unknown. */
  readonly authorAgentId: string;
  /** Honest change summary (never claims to be a native edit). */
  readonly changeSummary: string;
}

/** One version row the apply pass would insert. */
export interface ConduitBackfillVersion extends ConduitBackfillChainState {
  /** Measured byte length of the verified historical bytes. */
  readonly sizeBytes: number;
  /** Measured token count of the verified historical bytes. */
  readonly tokens: number;
  /**
   * The parent version's row uid for the DAG link — the uid of the nearest
   * lower chain position that has (or will have, via this plan) a row, or
   * null for the chain root. Precomputed at plan time: a present parent's
   * uid is read from its existing row; a backfilled parent's uid is the
   * natural row uid {@link importMigratedConduitVersion} derives, so the
   * link is stable across a re-run.
   */
  readonly parentVersionUid: string | null;
}

/** One chain position whose historical bytes are unrecoverable. */
export interface ConduitBackfillGap {
  /** Chain position skipped. */
  readonly position: number;
  /** The real content address that has no recoverable bytes. */
  readonly sha256: string;
}

/**
 * Per-doc backfill plan (the dry-run artifact — pure with respect to the
 * database and the blob store; the only I/O is reading).
 */
export interface ConduitDocBackfillPlan {
  /** The doc's live slug. */
  readonly slug: string;
  /** The doc's immutable uid (`conduit_attachments.uid`). */
  readonly docUid: string;
  /** Content states reconstructable from the honest sources. */
  readonly expectedVersions: number;
  /** `conduit_attachment_versions` rows already present. */
  readonly existingVersions: number;
  /** Chain positions whose content_hash already has a row. */
  readonly presentVersions: number;
  /** Rows the apply pass would insert (bytes verified present). */
  readonly toBackfill: readonly ConduitBackfillVersion[];
  /** Chain positions with unrecoverable bytes — counted, never fabricated. */
  readonly gaps: readonly ConduitBackfillGap[];
  /**
   * True when every recoverable chain position is present — nothing left to
   * insert. A doc with unrecoverable gaps can be complete AND still carry
   * {@link gaps}; the gaps stay reported (they are real, unhealed drift),
   * only the false "conflict" is gone.
   */
  readonly complete: boolean;
  /**
   * True when the existing conduit rows contradict the reconstructed chain
   * (content-hash mismatch at a tail position). The doc is refused and
   * reported for manual review; nothing is written.
   */
  readonly conflict: boolean;
  /**
   * `docs_attachments.doc_version` minus the provable chain length when
   * positive — versions the audit trail cannot account for (e.g. a doc whose
   * updates predate the versioning audit file). Informational; those rows
   * stay unrecoverable rather than being invented.
   */
  readonly auditGapVersions: number;
}

/** Outcome of applying one {@link ConduitDocBackfillPlan}. */
export interface ConduitDocBackfillResult {
  /** The doc's live slug. */
  readonly slug: string;
  /** The doc's immutable uid. */
  readonly docUid: string;
  /** Rows actually inserted (0 on a skipped/refused re-run). */
  readonly inserted: number;
  /** Chain positions left as unrecoverable gaps. */
  readonly gaps: number;
}

/**
 * Measure a token count the way the docs write path does
 * (`section-write-path.ts`) — whitespace-split, empty tokens dropped.
 *
 * @internal
 */
function countTokens(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * True when `value` is a non-empty string (the audit parser's field guard).
 * @internal
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Read the docs-versioning audit log once, flattening every squash window's
 * revisions into a per-slug chronological list. Malformed lines and entries
 * are skipped — the file is an audit aid, and a corrupt line must not fail
 * the repair planning pass.
 *
 * @internal
 */
function readAuditRevisionsBySlug(projectRoot: string): Map<string, AuditRevision[]> {
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, DOCS_VERSIONING_AUDIT_FILE), 'utf-8');
  } catch {
    return new Map();
  }
  const bySlug = new Map<string, AuditRevision[]>();
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let entry: { op?: unknown; slug?: unknown; revisions?: unknown };
    try {
      entry = JSON.parse(line) as { op?: unknown; slug?: unknown; revisions?: unknown };
    } catch {
      continue;
    }
    if (entry.op !== 'docs.update' || !isNonEmptyString(entry.slug)) continue;
    if (!Array.isArray(entry.revisions)) continue;
    const list = bySlug.get(entry.slug) ?? [];
    for (const revision of entry.revisions) {
      if (revision !== null && typeof revision === 'object') {
        list.push(revision as AuditRevision);
      }
    }
    bySlug.set(entry.slug, list);
  }
  return bySlug;
}

/**
 * Read the bytes for `sha256` from the blob store or the legacy attachment
 * tree, verifying the SHA-256 before returning. Read-only: unlike
 * `blobReadBySha` this never heals/mirrors — planning and dry runs must stay
 * side-effect free. A candidate whose hash does not verify is skipped (a
 * corrupt file at the address is a gap, not content).
 *
 * @internal
 */
async function readVerifiedVersionBytes(cleoDir: string, sha256: string): Promise<Buffer | null> {
  const candidates: Array<string | null> = [
    join(cleoDir, 'blobs', 'blobs', sha256),
    resolveLegacyByteSource(cleoDir, sha256, DOC_PROBE_MIME),
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    let bytes: Buffer;
    try {
      bytes = await readFile(candidate);
    } catch {
      continue;
    }
    if (createHash('sha256').update(bytes).digest('hex') === sha256) return bytes;
  }
  return null;
}

/**
 * Reconstruct one doc's pre-adoption version chain from the honest sources.
 *
 * Chain shape: position 1 anchors at the first audit revision's
 * `previousSha256` (the content the slug pointed at before any recorded
 * update); every CHANGED revision appends its `sha256` as the next state.
 * Noop revisions (a lifecycle-only update writes `changed: false`) create no
 * new content state and are skipped. A doc the audit log never saw yields a
 * single-state chain from its current `docs_attachments` row.
 *
 * Returns null when the chain cannot be anchored honestly (the first
 * revision carries no usable `previousSha256` but changed revisions exist) —
 * the caller reports the doc as unrecoverable rather than mislabeling a
 * later state as the root.
 *
 * @internal
 */
async function deriveChainStates(
  db: Awaited<ReturnType<typeof getDb>>,
  slug: string,
  revisions: readonly AuditRevision[],
): Promise<ConduitBackfillChainState[] | null> {
  const changed = revisions.filter(
    (r): r is AuditRevision & { ts: string; sha256: string } =>
      r.changed === true && isNonEmptyString(r.ts) && isNonEmptyString(r.sha256),
  );

  if (revisions.length === 0) {
    const row = await db
      .select({ sha256: docsAttachments.sha256, createdAt: docsAttachments.createdAt })
      .from(docsAttachments)
      .where(eq(docsAttachments.slug, slug))
      .get();
    if (!row) return [];
    // Honest labeling (review-2253 LOW-2): the audit log records NOTHING for
    // this doc, so the single state is the version that SURVIVED, not a
    // recorded "original version" — chain length 1 by survival, and any
    // earlier history is unrecoverable rather than absent-by-proof.
    return [
      {
        position: 1,
        sha256: row.sha256,
        createdAt: row.createdAt,
        authorAgentId: CONDUIT_BACKFILL_AUTHOR,
        changeSummary:
          'only surviving version — doc predates the docs-versioning audit log; ' +
          'earlier history is unrecoverable (backfilled by T13727)',
      },
    ];
  }

  const anchor = revisions[0]?.previousSha256;
  if (!isNonEmptyString(anchor)) return null;
  const firstTs = revisions[0]?.ts;
  // The anchor row must be the ORIGINAL creation row (doc_version = 1), not
  // just any row carrying the sha: content-address dedupe reuses one
  // docs_attachments row across slugs, and a reused row's created_at belongs
  // to another doc's timeline (review-2253 LOW-1).
  const anchorRow = await db
    .select({ createdAt: docsAttachments.createdAt })
    .from(docsAttachments)
    .where(and(eq(docsAttachments.sha256, anchor), eq(docsAttachments.docVersion, 1)))
    .get();
  if (!anchorRow && !isNonEmptyString(firstTs)) return null;

  const states: ConduitBackfillChainState[] = [
    {
      position: 1,
      sha256: anchor,
      createdAt: anchorRow?.createdAt ?? (firstTs as string),
      authorAgentId: CONDUIT_BACKFILL_AUTHOR,
      changeSummary: anchorRow
        ? 'original version (pre-adoption history backfilled by T13727)'
        : 'original version — timestamp is the first recorded update; the creation instant ' +
          'is unrecoverable (pre-adoption history backfilled by T13727)',
    },
  ];
  for (const revision of changed) {
    const message = isNonEmptyString(revision.message) ? `: ${revision.message}` : '';
    states.push({
      position: states.length + 1,
      sha256: revision.sha256,
      createdAt: revision.ts,
      authorAgentId: isNonEmptyString(revision.attachedBy)
        ? revision.attachedBy
        : CONDUIT_BACKFILL_AUTHOR,
      changeSummary: `pre-adoption history backfilled by T13727${message}`,
    });
  }
  return states;
}

/**
 * Plan the conduit-history backfill for every adopted doc.
 *
 * A doc is in scope when the docs registry (`docs_attachments`) knows its
 * slug AND a `conduit_attachments` row exists for it — the doc was adopted
 * (or migrated) but its pre-adoption updates wrote no conduit rows. Pure
 * with respect to the database and the blob store: safe in dry-run planning.
 *
 * Matching model (review-2253): matching is by CONTENT HASH, never by
 * ordinal or tail position — after a gapped apply the existing set mixes
 * backfilled low positions with minted rows, so a positional tail check
 * would false-conflict forever. The rules:
 *
 *   - a chain position whose content_hash already has a row is done;
 *   - a position with no row and no verified bytes is a gap (counted);
 *   - an existing row whose content_hash is not in the chain is a conflict
 *     (the doc is refused and reported, never overwritten);
 *   - complete means every recoverable position is present — a doc with
 *     permanent gaps can be complete AND still report them.
 *
 * Existing rows keep their minted local display ordinals (rows are
 * append-only); backfilled rows carry their chain position as
 * `version_number`, so ordinals may repeat across the seam — the schema
 * defines `version_number` as a local display ordinal that is never a key,
 * and `docs versions` assigns read-time display ordinals instead.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns One plan per in-scope doc (complete, backfill, gap or conflict).
 * @task T13727
 */
export async function planConduitHistoryBackfill(
  projectRoot: string,
): Promise<ConduitDocBackfillPlan[]> {
  const db = await getDb(projectRoot);
  const registrySlugs = new Set(
    (
      await db
        .select({ slug: docsAttachments.slug })
        .from(docsAttachments)
        .where(isNotNull(docsAttachments.slug))
        .all()
    ).map((r) => r.slug),
  );
  const conduitDocs = await db
    .select({ uid: conduitAttachments.uid, slug: conduitAttachments.slug })
    .from(conduitAttachments)
    .where(isNotNull(conduitAttachments.slug))
    .orderBy(asc(conduitAttachments.slug))
    .all();
  const revisionsBySlug = readAuditRevisionsBySlug(projectRoot);
  const cleoDir = resolveCleoDir(projectRoot);

  const plans: ConduitDocBackfillPlan[] = [];
  for (const doc of conduitDocs) {
    if (doc.slug === null || doc.uid === null) continue;
    if (!registrySlugs.has(doc.slug)) continue;
    const slug = doc.slug;

    const registryRow = await db
      .select({ docVersion: docsAttachments.docVersion })
      .from(docsAttachments)
      .where(eq(docsAttachments.slug, slug))
      .get();

    const existing = (await listConduitAttachmentVersions(projectRoot, doc.uid)).sort(
      (a, b) => a.versionNumber - b.versionNumber,
    );

    const base = {
      slug,
      docUid: doc.uid,
      existingVersions: existing.length,
      auditGapVersions: 0,
    };

    const states = await deriveChainStates(db, slug, revisionsBySlug.get(slug) ?? []);
    if (states === null) {
      plans.push({
        ...base,
        expectedVersions: 0,
        presentVersions: 0,
        toBackfill: [],
        gaps: [],
        complete: false,
        conflict: true,
      });
      continue;
    }
    const auditGapVersions = Math.max(
      0,
      (registryRow?.docVersion ?? states.length) - states.length,
    );

    // An existing row whose content_hash is not in the chain contradicts
    // the honest sources — refuse the doc and report it, never overwrite.
    const chainHashes = new Set(states.map((s) => s.sha256));
    if (existing.some((row) => !chainHashes.has(row.contentHash))) {
      plans.push({
        ...base,
        expectedVersions: states.length,
        auditGapVersions,
        presentVersions: 0,
        toBackfill: [],
        gaps: [],
        complete: false,
        conflict: true,
      });
      continue;
    }

    // Content-hash matching (review-2253): no ordinal or tail-position
    // assumptions — a position is done when its hash already has a row.
    const hashPresent = new Set(existing.map((r) => r.contentHash));
    // Earliest-created row per hash is the DAG parent candidate when several
    // rows share a content hash (a revert, a recorded conflict).
    const uidByHash = new Map<string, string>();
    for (const row of [...existing].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || (a.uid ?? '').localeCompare(b.uid ?? ''),
    )) {
      if (typeof row.uid === 'string' && row.uid.length > 0 && !uidByHash.has(row.contentHash)) {
        uidByHash.set(row.contentHash, row.uid);
      }
    }

    const toBackfill: ConduitBackfillVersion[] = [];
    const gaps: ConduitBackfillGap[] = [];
    let presentVersions = 0;
    // The DAG parent of the next backfilled row: the uid of the nearest
    // lower chain position that has (or will have, via this plan) a row.
    let lastRowUid: string | null = null;
    for (const state of states) {
      if (hashPresent.has(state.sha256)) {
        presentVersions += 1;
        const uid = uidByHash.get(state.sha256);
        if (uid !== undefined) lastRowUid = uid;
        continue;
      }
      const bytes = await readVerifiedVersionBytes(cleoDir, state.sha256);
      if (bytes === null) {
        gaps.push({ position: state.position, sha256: state.sha256 });
        continue;
      }
      toBackfill.push({
        ...state,
        sizeBytes: bytes.length,
        tokens: countTokens(bytes.toString('utf-8')),
        parentVersionUid: lastRowUid,
      });
      // The uid this row WILL have — importMigratedConduitVersion derives the
      // same natural uid, so the link is stable across a re-run.
      lastRowUid = naturalRowUid('project', 'conduit_attachment_versions', [
        doc.uid,
        state.sha256,
        state.createdAt,
      ]);
    }

    plans.push({
      ...base,
      expectedVersions: states.length,
      auditGapVersions,
      presentVersions,
      toBackfill,
      gaps,
      // Complete = every recoverable position is present; permanent gaps
      // stay reported in `gaps` rather than being silently dropped.
      complete: toBackfill.length === 0,
      conflict: false,
    });
  }
  return plans;
}

/**
 * Execute one {@link ConduitDocBackfillPlan}: insert the synthesized history
 * rows through the canonical accessor, one transaction per doc.
 *
 * Every statement inside the transaction resolves without a real I/O yield
 * (bytes were read and measured during planning; {@link withConduitDocWriteTransaction}
 * brackets the inserts), so a partial backfill cannot leave a forked chain.
 * Per-row natural uids make a re-run a verified no-op; a doc whose count
 * already equals the chain length was filtered by the planner
 * (`complete: true`) and inserts nothing here.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param plan - One doc's plan from {@link planConduitHistoryBackfill}.
 * @returns Inserted row count and unrecoverable gap count for the doc.
 * @task T13727
 */
// @sync-invariant docs.versions.append-only history rows are synthesized from the real audit chain and inserted with natural uids; nothing is updated or deleted, and a conflicting doc is refused by the planner before any write
export async function applyConduitHistoryBackfill(
  projectRoot: string,
  plan: ConduitDocBackfillPlan,
): Promise<ConduitDocBackfillResult> {
  if (plan.complete || plan.conflict) {
    return { slug: plan.slug, docUid: plan.docUid, inserted: 0, gaps: plan.gaps.length };
  }
  let inserted = 0;
  await withConduitDocWriteTransaction(projectRoot, async () => {
    for (const version of plan.toBackfill) {
      const { inserted: didInsert } = await importMigratedConduitVersion(projectRoot, {
        attachmentUid: plan.docUid,
        parentVersionUid: version.parentVersionUid,
        authorAgentId: version.authorAgentId,
        storageKey: `sha256:${version.sha256}`,
        contentHash: version.sha256,
        sizeBytes: version.sizeBytes,
        tokens: version.tokens,
        versionNumber: version.position,
        createdAt: version.createdAt,
        changeSummary: version.changeSummary,
        slug: plan.slug,
        origin: CONDUIT_BACKFILL_ORIGIN,
      });
      if (didInsert) inserted += 1;
    }
  });
  return { slug: plan.slug, docUid: plan.docUid, inserted, gaps: plan.gaps.length };
}
