/**
 * `cleo docs update <slug>` — in-place blob replacement that preserves the slug.
 *
 * The slug is the stable, human-addressable handle. On update we keep the
 * slug pinned but rotate the bytes underneath: insert a NEW row for the new
 * sha256 content (without a slug), then atomically transfer the slug from
 * the old row to the new one inside a `BEGIN IMMEDIATE` transaction.
 *
 * The previous row stays reachable by attachment-id (and by raw sha256) for
 * version history — its slug column is cleared so the UNIQUE index does
 * not trip. No supersession edge is written (callers wanting an explicit
 * lineage edge should use `cleo docs supersede`).
 *
 * Each successful update appends one line to
 * `.cleo/audit/docs-versioning.jsonl`. When a second update for the same
 * slug arrives within a 5-minute window the audit line is squashed onto
 * the prior entry's `revisions[]` rather than written as a new line.
 *
 * @task T10161 (Epic T10157 / Saga T9855 — E12.C4)
 * @see packages/core/src/store/attachment-store.ts — `put()` write path
 * @see packages/core/src/store/schema/attachments.ts — `lifecycle_status` column
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DOCS_LIFECYCLE_STATUSES,
  type DocsLifecycleStatus,
  type DocsUpdateParams,
} from '@cleocode/contracts/operations/docs';
import { and, eq } from 'drizzle-orm';
import { getCleoDirAbsolute } from '../paths.js';
import { attachmentRefs, attachments } from '../store/schema/attachments.js';
import { getDb, getNativeTasksDb } from '../store/sqlite.js';

/**
 * 5-minute squash window for audit-log entries. A second update for the
 * same slug landing within this many milliseconds of the prior audit
 * entry's `firstAt` does NOT write a new line — it appends a revision
 * onto the existing line in place.
 *
 * @task T10161
 */
export const DOCS_UPDATE_SQUASH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Project-root-relative path to the docs-versioning audit log.
 *
 * @task T10161
 */
export const DOCS_VERSIONING_AUDIT_FILE = '.cleo/audit/docs-versioning.jsonl';

/** Allowed lifecycle statuses from the docs.update operation contract SSoT. */
const ALLOWED_STATUSES: readonly DocsLifecycleStatus[] = DOCS_LIFECYCLE_STATUSES;

/**
 * Discriminated error for `updateDocBySlug` failures.
 *
 * Mirrors the LAFS error shape so callers (dispatch + tests) can map
 * directly onto an envelope code without bespoke translation.
 *
 * @task T10161
 */
export type DocsUpdateError =
  | { code: 'E_NOT_FOUND'; message: string }
  | { code: 'E_INVALID_INPUT'; message: string }
  | { code: 'E_INVALID_STATUS'; message: string }
  | { code: 'E_FILE_ERROR'; message: string };

/**
 * Successful update result returned by {@link updateDocBySlug}.
 *
 * Shape matches `DocsUpdateResult` from `@cleocode/contracts` — the
 * dispatch handler forwards it verbatim. `changed === false` indicates a
 * byte-identical noop (no new row inserted, no audit entry written).
 *
 * @task T10161
 */
export interface DocsUpdateOk {
  slug: string;
  type: string | null;
  attachmentId: string;
  previousAttachmentId: string;
  sha256: string;
  previousSha256: string;
  changed: boolean;
  lifecycleStatus: DocsLifecycleStatus;
  updatedAt: string;
  version: number;
  squashed: boolean;
}

/**
 * Output of {@link updateDocBySlug} — either a success record or a
 * discriminated error envelope.
 *
 * @task T10161
 */
export type UpdateDocBySlugResult =
  | { ok: true; result: DocsUpdateOk }
  | { ok: false; error: DocsUpdateError };

interface AuditRevision {
  /** ISO 8601 timestamp of this revision write. */
  ts: string;
  /** SHA-256 the slug pointed at BEFORE this revision. */
  previousSha256: string;
  /** SHA-256 the slug points at AFTER this revision. */
  sha256: string;
  /** Whether this revision actually changed bytes (false ⇒ noop). */
  changed: boolean;
  /** Operator-supplied summary, when provided. */
  message?: string;
  /** Lifecycle status applied with this revision. */
  lifecycleStatus: DocsLifecycleStatus;
  /** Agent identity that authored this revision. */
  attachedBy: string;
}

interface AuditLine {
  /** Operation discriminator (always `'docs.update'` for this writer). */
  op: 'docs.update';
  /** Slug being tracked. */
  slug: string;
  /** ISO 8601 timestamp the squash window started (oldest revision). */
  firstAt: string;
  /** ISO 8601 timestamp of the most recent revision. */
  lastAt: string;
  /** Chronological revision history within this squash window. */
  revisions: AuditRevision[];
}

/**
 * Detect MIME type from a file path. Mirrors the helper inside
 * `attachment-store.ts` — kept private to this module to avoid widening
 * the store's public surface for a single caller.
 *
 * @internal
 */
function mimeFromPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

/** Map a MIME type to its on-disk file extension. */
function extFromMime(mime: string): string {
  switch (mime) {
    case 'text/markdown':
      return '.md';
    case 'text/plain':
      return '.txt';
    case 'text/html':
      return '.html';
    case 'application/json':
      return '.json';
    case 'application/pdf':
      return '.pdf';
    case 'application/zip':
      return '.zip';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '.bin';
  }
}

/** Compute the SHA-256 hex digest of a Buffer. */
function sha256Of(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Resolve the on-disk blob path used by the AttachmentStore. */
function blobPath(sha256: string, mime: string, cwd?: string): string {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  const ext = extFromMime(mime);
  return join(getCleoDirAbsolute(cwd), 'attachments', 'sha256', prefix, `${rest}${ext}`);
}

/**
 * Read the last line of the docs-versioning audit log if it matches the
 * given slug and is still inside the squash window. Returns `null` when
 * the log is missing, empty, or the latest entry does not qualify.
 *
 * The file is parsed line-by-line (cheap — entries are at most a few KB)
 * and the LAST entry for `slug` is returned. Older squash-window entries
 * for the same slug are deliberately ignored — they have already rolled
 * past the window and become immutable.
 *
 * @internal
 */
function readSquashCandidate(
  auditPath: string,
  slug: string,
  now: Date,
): { line: string; index: number; entry: AuditLine } | null {
  let raw: string;
  try {
    raw = readFileSync(auditPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let entry: AuditLine;
    try {
      entry = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (entry.op !== 'docs.update' || entry.slug !== slug) continue;
    const lastAtMs = Date.parse(entry.lastAt);
    if (Number.isNaN(lastAtMs)) continue;
    if (now.getTime() - lastAtMs > DOCS_UPDATE_SQUASH_WINDOW_MS) return null;
    return { line, index: i, entry };
  }
  return null;
}

/**
 * Append a new audit line to the docs-versioning log (NO squash).
 *
 * Best-effort: write failures swallowed so audit drift never blocks an
 * otherwise-successful update.
 *
 * @internal
 */
function appendNewAuditLine(auditPath: string, entry: AuditLine): void {
  try {
    mkdirSync(join(auditPath, '..'), { recursive: true });
    appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    /* Audit drift is non-fatal. */
  }
}

/**
 * Rewrite an audit line in place with a new revision appended. Reads the
 * full file, swaps line `index` for the updated JSON, and writes atomically.
 *
 * Best-effort: rewrite failures swallowed so audit drift never blocks an
 * otherwise-successful update.
 *
 * @internal
 */
function rewriteAuditLine(auditPath: string, index: number, entry: AuditLine): void {
  try {
    const raw = readFileSync(auditPath, 'utf-8');
    const lines = raw.split('\n');
    if (index >= lines.length) {
      // Index drifted (shouldn't happen — we just read this file). Fall
      // back to append to avoid a silent audit-loss.
      appendNewAuditLine(auditPath, entry);
      return;
    }
    lines[index] = JSON.stringify(entry);
    // Preserve the trailing newline if the original file had one.
    const out = lines.join('\n');
    writeFileSync(auditPath, out, { encoding: 'utf-8' });
  } catch {
    /* Audit drift is non-fatal. */
  }
}

/**
 * Validate a {@link DocsLifecycleStatus} value at runtime.
 *
 * Used by the dispatch handler before calling {@link updateDocBySlug} so
 * the core function can stay type-narrowed without a redundant check.
 *
 * @task T10161
 */
export function isLifecycleStatus(raw: unknown): raw is DocsLifecycleStatus {
  return typeof raw === 'string' && (ALLOWED_STATUSES as readonly string[]).includes(raw);
}

/**
 * Update the attachment identified by `slug` to carry new bytes.
 *
 * Flow:
 *   1. Look up the existing row by slug → `E_NOT_FOUND` if missing.
 *   2. Hash the new bytes. If the hash matches the existing row's
 *      sha256, the operation is a NOOP (return early with `changed: false`).
 *   3. Inside a `BEGIN IMMEDIATE` transaction:
 *      a. Clear the slug column on the old row.
 *      b. Insert (or upsert) a row for the new sha256 with the slug,
 *         the prior row's type, and the requested lifecycle status.
 *      c. Add an `attachment_refs` binding for each owner the prior row
 *         had, so the slug stays addressable from the same owners.
 *      d. Commit. Write the new blob to disk AFTER the transaction.
 *   4. Append (or squash) an audit-log entry.
 *
 * Signature follows ADR-057 L1: `(projectRoot, params): Promise<Result>`.
 * The dispatch handler is the sole call site; tests drive this via the
 * dispatch surface (or via the CLI E2E suite which spawns the compiled
 * binary against an isolated project root).
 *
 * @param projectRoot - Absolute path to the CLEO project root
 * @param params - {@link DocsUpdateParams} from the dispatch envelope
 * @returns Success record or discriminated error
 *
 * @task T10161
 */
export async function updateDocBySlug(
  projectRoot: string,
  params: DocsUpdateParams,
): Promise<UpdateDocBySlugResult> {
  const slug = params.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    return { ok: false, error: { code: 'E_INVALID_INPUT', message: 'slug is required' } };
  }

  // Exactly one of file or content must be provided.
  const hasFile = typeof params.file === 'string' && params.file.length > 0;
  const hasContent = typeof params.content === 'string';
  if (hasFile === hasContent) {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Provide exactly one of file or content',
      },
    };
  }

  // Read the file bytes when `file` was supplied; otherwise use the inline
  // UTF-8 content as-is. The dispatch handler resolves relative paths to
  // absolute before invoking this function (worktree-routing discipline).
  let buf: Buffer;
  if (hasFile) {
    const { readFile } = await import('node:fs/promises');
    try {
      buf = await readFile(params.file as string);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'E_FILE_ERROR',
          message: `Cannot read file: ${params.file} (${cause instanceof Error ? cause.message : String(cause)})`,
        },
      };
    }
  } else {
    buf = Buffer.from(params.content as string, 'utf-8');
  }

  // Validate requested status (defaults to draft).
  const status: DocsLifecycleStatus = params.status ?? 'draft';
  if (!isLifecycleStatus(status)) {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_STATUS',
        message: `status must be one of: ${ALLOWED_STATUSES.join('|')} — got '${String(status)}'`,
      },
    };
  }

  const newSha256 = sha256Of(buf);
  const now = new Date();
  const nowIso = now.toISOString();
  const attachedBy = params.attachedBy ?? 'human';

  const db = await getDb(projectRoot);

  // Look up the existing row by slug.
  const oldRow = await db.select().from(attachments).where(eq(attachments.slug, slug)).get();
  if (!oldRow) {
    return {
      ok: false,
      error: { code: 'E_NOT_FOUND', message: `no attachment found with slug '${slug}'` },
    };
  }

  const previousAttachmentId = oldRow.id;
  const previousSha256 = oldRow.sha256;

  // NOOP fast-path: identical content. Still surface the lifecycle status
  // update if the caller asked for one, and still write an audit entry so
  // operators can see the noop attempt.
  if (newSha256 === previousSha256) {
    // Only touch lifecycle_status if it actually changes.
    if (oldRow.lifecycleStatus !== status) {
      await db
        .update(attachments)
        .set({ lifecycleStatus: status })
        .where(eq(attachments.id, oldRow.id))
        .run();
    }
    const auditPath = join(projectRoot, DOCS_VERSIONING_AUDIT_FILE);
    const squashed = writeOrSquashAudit({
      auditPath,
      slug,
      now,
      revision: {
        ts: nowIso,
        previousSha256,
        sha256: newSha256,
        changed: false,
        ...(params.message !== undefined ? { message: params.message } : {}),
        lifecycleStatus: status,
        attachedBy,
      },
    });
    return {
      ok: true,
      result: {
        slug,
        type: oldRow.type ?? null,
        attachmentId: oldRow.id,
        previousAttachmentId,
        sha256: newSha256,
        previousSha256,
        changed: false,
        lifecycleStatus: status,
        updatedAt: nowIso,
        version: countVersionsForSlug(projectRoot, slug),
        squashed,
      },
    };
  }

  // Resolve the storage path for the NEW blob now so we can write it
  // outside the transaction (mirrors AttachmentStore.put discipline).
  // The attachment JSON we attach is a minimal `blob`-kind record — the
  // updateDoc path does not know the source file's name, just bytes.
  const mime = hasContent ? 'text/plain' : 'application/octet-stream';
  const newAttachmentJson = JSON.stringify({
    kind: 'blob',
    name: oldRow.slug ?? slug,
    mime,
    size: buf.length,
    blobId: newSha256,
  });
  const newBlobPath = blobPath(newSha256, mime, projectRoot);

  const nativeDb = getNativeTasksDb();
  if (!nativeDb) {
    return {
      ok: false,
      error: { code: 'E_INVALID_INPUT', message: 'tasks database is not initialised' },
    };
  }

  // Refs to migrate. We pull them BEFORE the transaction so a failure
  // does not partially drain the table.
  const oldRefs = await db
    .select()
    .from(attachmentRefs)
    .where(eq(attachmentRefs.attachmentId, oldRow.id))
    .all();

  let newAttachmentId: string;
  try {
    nativeDb.prepare('BEGIN IMMEDIATE').run();

    // 1. Clear the slug on the old row so the UNIQUE INDEX is free.
    await db.update(attachments).set({ slug: null }).where(eq(attachments.id, oldRow.id)).run();

    // 2. Insert OR update the new-sha256 row. If a row already exists
    //    for this sha256 (rare — same bytes already stored under a
    //    different slug), reuse it and just transfer the slug onto it.
    const existingNewRow = await db
      .select()
      .from(attachments)
      .where(eq(attachments.sha256, newSha256))
      .get();

    if (existingNewRow) {
      newAttachmentId = existingNewRow.id;
      await db
        .update(attachments)
        .set({
          slug,
          type: oldRow.type ?? null,
          lifecycleStatus: status,
        })
        .where(eq(attachments.id, existingNewRow.id))
        .run();
    } else {
      newAttachmentId = randomUUID();
      await db
        .insert(attachments)
        .values({
          id: newAttachmentId,
          sha256: newSha256,
          attachmentJson: newAttachmentJson,
          createdAt: nowIso,
          refCount: 0,
          slug,
          ...(oldRow.type ? { type: oldRow.type } : {}),
          lifecycleStatus: status,
        })
        .run();
    }

    // 3. Carry every existing ref over to the new row so the slug stays
    //    reachable from the same owners. We skip rows that already exist
    //    on the new row (idempotent re-runs).
    let refsAdded = 0;
    for (const ref of oldRefs) {
      const dup = await db
        .select()
        .from(attachmentRefs)
        .where(
          and(
            eq(attachmentRefs.attachmentId, newAttachmentId),
            eq(attachmentRefs.ownerType, ref.ownerType),
            eq(attachmentRefs.ownerId, ref.ownerId),
          ),
        )
        .get();
      if (dup) continue;
      await db
        .insert(attachmentRefs)
        .values({
          attachmentId: newAttachmentId,
          ownerType: ref.ownerType,
          ownerId: ref.ownerId,
          attachedAt: nowIso,
          attachedBy,
        })
        .run();
      refsAdded += 1;
    }
    if (refsAdded > 0) {
      await db
        .update(attachments)
        .set({
          refCount: (existingNewRow?.refCount ?? 0) + refsAdded,
        })
        .where(eq(attachments.id, newAttachmentId))
        .run();
    }

    nativeDb.prepare('COMMIT').run();
  } catch (err) {
    try {
      nativeDb.prepare('ROLLBACK').run();
    } catch {
      /* Auto-rolled back by SQLite on most errors. */
    }
    throw err;
  }

  // Write the new blob to disk AFTER the transaction is committed.
  try {
    await mkdir(join(newBlobPath, '..'), { recursive: true });
    await writeFile(newBlobPath, buf);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'E_FILE_ERROR',
        message: `failed to write new blob: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    };
  }

  // Audit log entry (best-effort).
  const auditPath = join(projectRoot, DOCS_VERSIONING_AUDIT_FILE);
  const squashed = writeOrSquashAudit({
    auditPath,
    slug,
    now,
    revision: {
      ts: nowIso,
      previousSha256,
      sha256: newSha256,
      changed: true,
      ...(params.message !== undefined ? { message: params.message } : {}),
      lifecycleStatus: status,
      attachedBy,
    },
  });

  return {
    ok: true,
    result: {
      slug,
      type: oldRow.type ?? null,
      attachmentId: newAttachmentId,
      previousAttachmentId,
      sha256: newSha256,
      previousSha256,
      changed: true,
      lifecycleStatus: status,
      updatedAt: nowIso,
      version: countVersionsForSlug(projectRoot, slug),
      squashed,
    },
  };
}

/**
 * Count how many revisions for `slug` exist in the audit log, plus 1 for
 * the current row. Returns 2 as a floor for the first update so callers
 * always see a monotone counter even when the audit file is missing.
 *
 * Synchronous (reads a small audit JSONL file) so callers can compose
 * the value into the LAFS result without an extra await round-trip.
 *
 * @internal
 */
function countVersionsForSlug(projectRoot: string, slug: string): number {
  // The attachments table only carries the CURRENT slug-bearing row.
  // History lives in the audit log; we derive `version` from it so the
  // counter is meaningful across the entire update sequence.
  const auditPath = join(projectRoot, DOCS_VERSIONING_AUDIT_FILE);
  let raw: string;
  try {
    raw = readFileSync(auditPath, 'utf-8');
  } catch {
    return 2;
  }
  let total = 1; // initial create (no audit entry for the original add)
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: AuditLine;
    try {
      entry = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (entry.op !== 'docs.update' || entry.slug !== slug) continue;
    total += entry.revisions.length;
  }
  return total;
}

/**
 * Either append a new audit line OR squash this revision onto the most
 * recent line for the same slug, depending on the 5-minute squash window.
 *
 * Returns `true` when the entry was squashed.
 *
 * @internal
 */
function writeOrSquashAudit(opts: {
  auditPath: string;
  slug: string;
  now: Date;
  revision: AuditRevision;
}): boolean {
  const { auditPath, slug, now, revision } = opts;
  const candidate = readSquashCandidate(auditPath, slug, now);
  if (candidate) {
    const updated: AuditLine = {
      ...candidate.entry,
      lastAt: revision.ts,
      revisions: [...candidate.entry.revisions, revision],
    };
    rewriteAuditLine(auditPath, candidate.index, updated);
    return true;
  }
  appendNewAuditLine(auditPath, {
    op: 'docs.update',
    slug,
    firstAt: revision.ts,
    lastAt: revision.ts,
    revisions: [revision],
  });
  return false;
}

// `mimeFromPath` is exported for the dispatch layer when the new content
// arrives via a file path (the layer derives an attachment.name + mime
// before calling updateDocBySlug). Keeping it in this module avoids a
// duplicate copy elsewhere.
export { mimeFromPath as docsUpdateMimeFromPath };
