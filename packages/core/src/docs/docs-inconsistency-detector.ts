/**
 * Docs Inconsistency Detector — checks that all docs stores and ledgers
 * agree on the canonical SHA for published documents.
 *
 * The doc storage landscape:
 *   1. tasks.db `attachments` table — slug, sha256, type, lifecycle_status,
 *      supersedes/supersededBy lineage edges.
 *   2. tasks.db `attachment_refs` table — links attachments to owner entities
 *      (tasks, sessions, observations, decisions, learnings, patterns).
 *   3. manifest.db `blob_attachments` table (CleoBlobStore / BlobFsAdapter) —
 *      content-addressed blob store with (doc_slug, blob_name, hash) per row.
 *   4. Filesystem blobs at `.cleo/attachments/sha256/<pref>/<rest>` (legacy)
 *      and `.cleo/blobs/blobs/<sha256>` (new via llmtxt).
 *
 * Inconsistencies detected:
 *   - SHA mismatch between tasks.db attachments.sha256 and manifest.db
 *     blob_attachments.hash for the same document.
 *   - Missing filesystem blob for a SHA that should be on disk.
 *   - Orphaned attachment_refs (refs pointing to non-existent attachment rows).
 *   - Zero-ref attachments (attachments with no corresponding refs).
 *   - Slug collision between different SHA rows (two rows with same slug
 *     but different SHA — slug column UNIQUE prevents this at DB level,
 *     but the detector double-checks).
 *
 * @task T11051 (Epic T10519 / Saga T10516 — docs storage/query consolidation)
 */

import { type Dirent, existsSync, readdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { getProjectRoot } from '../paths.js';
import {
  type AttachmentLifecycleStatus,
  attachmentRefs,
  attachments,
} from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';
import { CleoBlobStore } from '../store/llmtxt-blob-adapter.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Severity of an inconsistency finding.
 */
export type InconsistencySeverity = 'error' | 'warning';

/**
 * Category of inconsistency.
 */
export type InconsistencyKind =
  | 'sha-mismatch'
  | 'missing-blob-filesystem'
  | 'missing-blob-manifest'
  | 'orphaned-ref'
  | 'zero-ref-attachment'
  | 'slug-disagreement'
  | 'blob-corrupt';

/**
 * A single inconsistency finding.
 */
export interface InconsistencyFinding {
  /** What kind of inconsistency was detected. */
  readonly kind: InconsistencyKind;
  /** Severity — 'error' stops publishing, 'warning' is advisory. */
  readonly severity: InconsistencySeverity;
  /** Human-readable description of the problem. */
  readonly message: string;
  /** Slug of the affected document, when applicable. */
  readonly slug?: string;
  /** Attachment ID affected, when applicable. */
  readonly attachmentId?: string;
  /** SHA-256 hash expected by one store, when applicable. */
  readonly expectedSha?: string;
  /** SHA-256 hash found by another store, when applicable. */
  readonly actualSha?: string;
  /** Additional diagnostic details. */
  readonly detail?: Record<string, unknown>;
}

/**
 * Result of a full consistency check.
 */
export interface InconsistencyCheckResult {
  /** Whether the stores are fully consistent (no errors). */
  readonly consistent: boolean;
  /** Total number of published documents checked. */
  readonly docsChecked: number;
  /** Total number of attachments examined. */
  readonly attachmentsExamined: number;
  /** Findings grouped by kind. */
  readonly findings: InconsistencyFinding[];
  /** Summary of findings by severity. */
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
  };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Lifecycle states that indicate a document is "published" and should be
 * checked for consistency. Drafts may be incomplete; we only validate
 * docs that are expected to be canonical.
 */
const PUBLISHED_LIFECYCLE_STATES: ReadonlySet<AttachmentLifecycleStatus> =
  new Set<AttachmentLifecycleStatus>(['accepted', 'proposed', 'superseded']);

/**
 * Build the expected filesystem path for a legacy attachment blob.
 *
 * Pattern: `.cleo/attachments/sha256/<sha256[0..2]>/<sha256[2..]>`
 */
function legacyBlobPath(projectRoot: string, sha256: string): string {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  return join(projectRoot, '.cleo', 'attachments', 'sha256', prefix, rest);
}

/**
 * Build the expected filesystem path for a new (llmtxt) blob.
 *
 * Pattern: `.cleo/blobs/blobs/<sha256>`
 */
function newBlobPath(projectRoot: string, sha256: string): string {
  return join(projectRoot, '.cleo', 'blobs', 'blobs', sha256);
}

/**
 * Best-effort scan for the file extension of a legacy blob file.
 * The legacy store appends a dot-extension computed at write time —
 * scan the directory for any file whose name starts with the SHA suffix.
 *
 * @internal
 */
function findLegacyBlobWithExt(projectRoot: string, sha256: string): string | null {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  const dir = join(projectRoot, '.cleo', 'attachments', 'sha256', prefix);
  try {
    const entries: Dirent[] = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith(rest)) {
        return join(dir, entry.name);
      }
    }
  } catch {
    // Directory may not exist
  }
  return null;
}

// ─── Core detection logic ────────────────────────────────────────────────────

/**
 * Run a full consistency check across all docs stores.
 *
 * Checks:
 *  1. SHA agreement between attachments table and blob_attachments manifest.
 *  2. Filesystem blobs exist for every claimed SHA (legacy + new paths).
 *  3. No orphaned attachment_refs (refs to deleted attachments).
 *  4. No zero-ref attachments (attachments with no owner refs).
 *  5. No two published attachments with the same slug but different SHA.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns Full inconsistency check result.
 */
export async function checkDocsConsistency(
  projectRoot?: string,
): Promise<InconsistencyCheckResult> {
  const root = projectRoot ?? getProjectRoot();

  const findings: InconsistencyFinding[] = [];

  // ── 1. Fetch published attachments ──────────────────────────────────────
  let publishedAttachments: Array<{
    id: string;
    sha256: string;
    slug: string | null;
    type: string | null;
    lifecycleStatus: AttachmentLifecycleStatus;
    refCount: number;
  }>;

  try {
    const db = await getDb();
    const rows = db
      .select({
        id: attachments.id,
        sha256: attachments.sha256,
        slug: attachments.slug,
        type: attachments.type,
        lifecycleStatus: attachments.lifecycleStatus,
        refCount: attachments.refCount,
      })
      .from(attachments)
      .all();

    publishedAttachments = rows.filter(
      (r) => r.slug !== null && PUBLISHED_LIFECYCLE_STATES.has(r.lifecycleStatus),
    );
  } catch (err) {
    findings.push({
      kind: 'missing-blob-manifest',
      severity: 'error',
      message: `Cannot read attachments from tasks.db: ${String(err)}`,
    });
    return {
      consistent: false,
      docsChecked: 0,
      attachmentsExamined: 0,
      findings,
      summary: { errors: 1, warnings: 0 },
    };
  }

  let docsChecked = 0;
  let blobStore: CleoBlobStore | null = null;

  try {
    blobStore = new CleoBlobStore({ projectRoot: root });
    await blobStore.open();
  } catch {
    // manifest.db may not exist yet — that's fine, we'll flag missing blobs
  }

  try {
    // ── 2. Check SHA consistency per published doc ────────────────────────
    for (const attachment of publishedAttachments) {
      if (!attachment.slug) continue;
      docsChecked++;

      // 2a. Check manifest.db blob_attachments for this sha256
      if (blobStore) {
        try {
          // Try to find the blob in manifest.db by sha256 lookup.
          // BlobFsAdapter exposes listBlobs which returns by docSlug, not by hash.
          // We check if the blob exists by looking up via the attachment's own id.
          // The __docs__ sentinel is used by DocsAccessorImpl for doc-kind blobs.
          // For task attachments, the taskId is used as docSlug.
          // We list all blobs for the sentinel and check for hash matches.

          // Check via the sentinel __docs__ (used by DocsAccessorImpl)
          const sentinelBlobs = blobStore.list('__docs__');
          // Also check via attachment ID as docSlug (used by task attachments)
          const taskBlobs = blobStore.list(attachment.id);

          const [sentinelList, taskList] = await Promise.allSettled([
            sentinelBlobs,
            taskBlobs,
          ]);

          const allBlobs = [
            ...(sentinelList.status === 'fulfilled' ? sentinelList.value : []),
            ...(taskList.status === 'fulfilled' ? taskList.value : []),
          ];

          // Check if any blob in the manifest has the same sha256
          const manifestMatch = allBlobs.find((b) => b.hash === attachment.sha256);

          if (manifestMatch === undefined && allBlobs.length > 0) {
            // Blob exists in attachments table but not in manifest with matching hash
            findings.push({
              kind: 'sha-mismatch',
              severity: 'error',
              message:
                `Document slug="${attachment.slug}" has sha256=${attachment.sha256} in ` +
                `attachments table but that hash was not found in manifest.db blob_attachments.`,
              slug: attachment.slug,
              attachmentId: attachment.id,
              expectedSha: attachment.sha256,
            });
          }
        } catch {
          // manifest.db lookup can fail gracefully
        }
      }

      // 2b. Check filesystem blobs exist
      const legacyPath = findLegacyBlobWithExt(root, attachment.sha256);
      const newPath = newBlobPath(root, attachment.sha256);

      const legacyExists = legacyPath !== null;
      let newExists = false;
      try {
        await access(newPath);
        newExists = true;
      } catch {
        // file doesn't exist
      }

      if (!legacyExists && !newExists) {
        findings.push({
          kind: 'missing-blob-filesystem',
          severity: 'error',
          message:
            `No filesystem blob found for slug="${attachment.slug}" ` +
            `sha256=${attachment.sha256}. Checked legacy path and new path.`,
          slug: attachment.slug,
          attachmentId: attachment.id,
          expectedSha: attachment.sha256,
        });
      } else if (legacyExists && !newExists) {
        // Blob only exists in legacy store — this is a migration gap, not
        // an error per se, but worth flagging for awareness.
        findings.push({
          kind: 'missing-blob-filesystem',
          severity: 'warning',
          message:
            `Blob for slug="${attachment.slug}" exists only in legacy path ` +
            `(${legacyPath}), not in the new blob store. ` +
            `This is expected during migration but should be addressed.`,
          slug: attachment.slug,
          attachmentId: attachment.id,
          expectedSha: attachment.sha256,
          detail: { legacyPath },
        });
      }
    }

    // ── 3. Check for orphaned attachment_refs ─────────────────────────────
    try {
      const db = await getDb();
      const orphanedRefs = db
        .select({
          attachmentId: attachmentRefs.attachmentId,
          ownerType: attachmentRefs.ownerType,
          ownerId: attachmentRefs.ownerId,
        })
        .from(attachmentRefs)
        .where(
          sql`${attachmentRefs.attachmentId} NOT IN (SELECT id FROM ${attachments})`,
        )
        .all();

      for (const ref of orphanedRefs) {
        findings.push({
          kind: 'orphaned-ref',
          severity: 'warning',
          message:
            `Orphaned attachment_ref: attachmentId="${ref.attachmentId}" ` +
            `referenced by ${ref.ownerType}:${ref.ownerId} but no corresponding ` +
            `attachment row exists.`,
          attachmentId: ref.attachmentId,
          detail: { ownerType: ref.ownerType, ownerId: ref.ownerId },
        });
      }
    } catch {
      // Schema may differ
    }

    // ── 4. Check for zero-ref attachments ─────────────────────────────────
    try {
      const db = await getDb();
      const zeroRefAttachments = db
        .select({
          id: attachments.id,
          sha256: attachments.sha256,
          slug: attachments.slug,
          refCount: attachments.refCount,
        })
        .from(attachments)
        .where(eq(attachments.refCount, 0))
        .all();

      for (const att of zeroRefAttachments) {
        findings.push({
          kind: 'zero-ref-attachment',
          severity: 'warning',
          message:
            `Attachment id="${att.id}" sha256=${att.sha256} ` +
            `${att.slug ? `slug="${att.slug}" ` : ''}` +
            `has ref_count=0 — it exists in the registry but no owner references it.`,
          attachmentId: att.id,
          slug: att.slug ?? undefined,
          expectedSha: att.sha256,
        });
      }
    } catch {
      // Schema may differ
    }

    // ── 5. Check slug uniqueness among published attachments ──────────────
    const slugMap = new Map<string, Array<{ id: string; sha256: string }>>();
    for (const att of publishedAttachments) {
      if (!att.slug) continue;
      const entries = slugMap.get(att.slug) ?? [];
      entries.push({ id: att.id, sha256: att.sha256 });
      slugMap.set(att.slug, entries);
    }

    for (const [slug, entries] of slugMap) {
      if (entries.length > 1) {
        const uniqueShas = new Set(entries.map((e) => e.sha256));
        if (uniqueShas.size > 1) {
          findings.push({
            kind: 'slug-disagreement',
            severity: 'error',
            message:
              `Slug "${slug}" maps to ${entries.length} attachment rows ` +
              `with ${uniqueShas.size} different SHAs: ` +
              `${entries.map((e) => `${e.id}(${e.sha256.slice(0, 8)}…)`).join(', ')}. ` +
              `The DB UNIQUE constraint on slug should prevent this — ` +
              `investigate manual INSERT or schema drift.`,
            slug,
            detail: {
              entries: entries.map((e) => ({ id: e.id, sha256: e.sha256 })),
            },
          });
        }
      }
    }
  } finally {
    if (blobStore) {
      try {
        await blobStore.close();
      } catch {
        // Best-effort cleanup
      }
    }
  }

  // ── Calculate all attachments examined (not just published) ─────────────
  let allAttachmentCount = publishedAttachments.length;
  try {
    const db = await getDb();
    const count = db
      .select({ n: sql<number>`count(*)` })
      .from(attachments)
      .get();
    if (count) allAttachmentCount = count.n;
  } catch {
    // Keep published count as fallback
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;

  return {
    consistent: errors === 0,
    docsChecked,
    attachmentsExamined: allAttachmentCount,
    findings,
    summary: { errors, warnings },
  };
}

/**
 * Synchronous, best-effort version of the consistency check.
 * Only checks filesystem blob existence (no DB access).
 *
 * Intended for fast pre-flight checks where opening both DBs
 * would be too expensive.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param shas - Set of SHA-256 hashes to verify.
 * @returns List of SHAs missing from the filesystem.
 */
export function checkBlobFilesystem(
  projectRoot: string,
  shas: ReadonlySet<string>,
): { missing: string[]; legacy: string[]; new: string[] } {
  const missing: string[] = [];
  const legacy: string[] = [];
  const newOnly: string[] = [];

  for (const sha256 of shas) {
    const legacyPath = findLegacyBlobWithExt(projectRoot, sha256);
    const newPath = newBlobPath(projectRoot, sha256);

    const legacyExists = legacyPath !== null;
    const newExists = existsSync(newPath);

    if (!legacyExists && !newExists) {
      missing.push(sha256);
    } else if (legacyExists && !newExists) {
      legacy.push(sha256);
    } else {
      newOnly.push(sha256);
    }
  }

  return { missing, legacy, new: newOnly };
}
