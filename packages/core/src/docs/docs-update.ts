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
import type {
  DocsLifecycleStatus,
  DocsSectionConflict,
  DocsSectionLeaseNotice,
  DocsUpdateParams,
} from '@cleocode/contracts';
import { blobAttachmentSchema } from '@cleocode/contracts/attachment-schema.js';
import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts/operations/docs.js';
import { and, eq } from 'drizzle-orm';
import { pushWarning } from '../output.js';
import { getCleoDirAbsolute, resolveCleoDir } from '../paths.js';
import { fileBytesMatchSha256 } from '../store/blob-keep.js';
import { resolveBoundSession } from '../store/session-store.js';
import { getDb, getNativeTasksDb } from '../store/sqlite.js';
import { attachmentRefs, docsAttachments } from '../store/tasks-schema.js';
import { assertTwinCollapseWritable } from '../store/twin-collapse.js';
import { writeFileAtomic } from '../tools/fs.js';
import {
  deriveDocLinks,
  extractWikilinkTargets,
  isScannableTextMime,
  linksJsonOrNull,
} from './derive-links.js';
import type { DocUpdatePreview, ProjectDocUpdateInput } from './section-write-path.js';
import { validateDocBody } from './validate-body.js';
import { getCanonicalCleoVersion } from './version-ssot.js';

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

/** Pipe-delimited lifecycle status list for dispatch/CLI validation messages. */
export const DOCS_UPDATE_LIFECYCLE_STATUS_LIST = ALLOWED_STATUSES.join('|');

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
  | { code: 'E_DOC_SCHEMA_MISMATCH'; message: string; details?: Record<string, unknown> }
  | { code: 'E_INVALID_STATUS'; message: string }
  | { code: 'E_FILE_ERROR'; message: string }
  | {
      /**
       * A declared `baseVersionUid` does not resolve to this doc's conduit
       * version history (unknown uid, another doc's version, or unresolvable
       * bytes). Refused BEFORE any write (T13674) — the base anchors the
       * stale-base merge, so guessing it could silently drop a concurrent
       * writer's edit, the exact hazard the parameter exists to prevent.
       */
      code: 'E_DOC_BASE_UNKNOWN';
      message: string;
    }
  | {
      /**
       * A declared `baseVersionUid` with a `file` that is not UTF-8 text:
       * the stale-base merge runs on text sections, so the base cannot be
       * honoured and is refused before any write rather than ignored (T13688).
       */
      code: 'E_DOC_BASE_UNSUPPORTED';
      message: string;
    };

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
  /** @deprecated Legacy version field (audit-log-based). Use ownerVersion + docVersion instead (T11181). */
  version: number;
  /** CLEO release version that wrote this row (canonical SSoT, T11181). */
  ownerVersion: string;
  /** Sequential doc version counter for this slug (T11181). */
  docVersion: number;
  squashed: boolean;
  /**
   * Human-readable summary of what happened to the slug.
   * Examples: "slug 'foo' was changed", "slug 'foo' was left untouched (content unchanged)".
   * @task T11055
   */
  summary: string;
  /**
   * Non-append concurrent section edits recorded by the CRDT projection
   * (T13604): the incoming edit landed as its own version row while the
   * head kept the stored projection. Absent when nothing conflicted; a
   * `W_DOC_SECTION_CONFLICT` warning names the same sections.
   */
  sectionConflicts?: DocsSectionConflict[];
  /**
   * Advisory section-lease notices (T13356): sections the update edited are
   * leased by other live sessions — the edit PROCEEDED anyway (leases are
   * advisory). Absent when nothing was leased elsewhere; a
   * `W_DOC_SECTION_LEASED` warning names the same sections and holders.
   */
  leaseNotices?: DocsSectionLeaseNotice[];
  /**
   * True when the update was authored against a superseded head and the CRDT
   * projection merged a concurrent writer's edit into the head (T13674):
   * the stored text is the merge, not the submitted bytes. A
   * `W_DOC_STALE_BASE` warning names the same situation and its remedy.
   * Absent when the declared base was the current head (or undeclared).
   *
   * @task T13674
   */
  staleBaseMerged?: boolean;
  /**
   * The conduit head version uid after the update — pass it as the next
   * update's `baseVersionUid` to chain edits without a re-fetch. Absent for
   * docs outside the conduit family.
   *
   * @task T13674
   */
  headVersionUid?: string;
  dryRun?: true;
  wouldWrite?: boolean;
  wouldChange?: boolean;
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
 * Detect a document's MIME type from its file path: the one rule `docs add`
 * and `docs update --file` share (T13918), so an update keeps the type the
 * add recorded and the readback stays `content` for a text document.
 * Falls back to `application/octet-stream`.
 *
 * @param filePath - Absolute or relative path to the file.
 * @returns The MIME type.
 * @task T13918
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
  if (lower.endsWith('.ts') || lower.endsWith('.tsx')) return 'text/plain';
  if (lower.endsWith('.js')) return 'text/javascript';
  if (lower.endsWith('.css')) return 'text/css';
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

  // At most one of file or content. With neither, `status` alone is a
  // lifecycle-only transition that keeps the current bytes (T12654) — the
  // only way to accept a doc without re-supplying its content.
  const hasFile = typeof params.file === 'string' && params.file.length > 0;
  const hasContent = typeof params.content === 'string';
  if (hasFile && hasContent) {
    return {
      ok: false,
      error: { code: 'E_INVALID_INPUT', message: 'file and content are mutually exclusive' },
    };
  }
  const statusOnly = !hasFile && !hasContent;
  if (statusOnly && params.status === undefined) {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Provide file or content, or status alone for a lifecycle-only change',
      },
    };
  }

  // Read the file bytes when `file` was supplied; otherwise use the inline
  // UTF-8 content as-is. The dispatch handler resolves relative paths to
  // absolute before invoking this function (worktree-routing discipline).
  // A status-only update reads nothing: the bytes stay as stored.
  let buf: Buffer | null = null;
  if (statusOnly) {
    // lifecycle-only: resolved against the stored row below
  } else if (hasFile) {
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
  // The text the base and the section projection work on: inline content, or
  // a file whose bytes are UTF-8 text (T13688 — `--file` must honour the base
  // exactly as `--content` does, never silently drop it).
  const text = hasContent ? (params.content as string) : buf !== null ? utf8TextOf(buf) : null;
  if (hasFile && text === null && params.baseVersionUid !== undefined) {
    return {
      ok: false,
      error: {
        // @sync-invariant none:input-shape a base cannot anchor a section merge of non-text bytes; refused before any write
        code: 'E_DOC_BASE_UNSUPPORTED',
        message: `--base-version-uid needs a UTF-8 text body; '${params.file}' is not text — omit the base to replace the bytes whole`,
      },
    };
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

  const now = new Date();
  const nowIso = now.toISOString();
  const attachedBy = params.attachedBy ?? 'human';

  const db = await getDb(projectRoot);
  // T12535: fail fast on a store degraded by a failed twin collapse (a dry
  // run only reads, so it is still served).
  if (params.dryRun !== true) assertTwinCollapseWritable(db, 'attachments');

  // Look up the existing row by slug.
  const oldRow = await db
    .select()
    .from(docsAttachments)
    .where(eq(docsAttachments.slug, slug))
    .get();
  if (!oldRow) {
    return {
      ok: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `no attachment found with slug '${slug}' — the slug does not exist in the store and cannot be updated`,
      },
    };
  }

  // T13674: resolve the declared base BEFORE any write. The base is the
  // conduit version the edit was authored against (the fetch envelope's
  // metadata.headVersionUid). An unresolvable base is refused up front —
  // guessing the head reference here could silently drop a concurrent
  // writer's edit, the exact hazard this parameter exists to prevent.
  let baseSections: string[] | undefined;
  if (text !== null && params.baseVersionUid !== undefined) {
    const { resolveConduitDocUid, getConduitAttachmentVersion } = await import(
      '../store/conduit-doc-history.js'
    );
    const { splitDocIntoSections } = await import('./section-merge.js');
    const docUid = await resolveConduitDocUid(projectRoot, slug);
    const version =
      docUid !== null
        ? await getConduitAttachmentVersion(projectRoot, params.baseVersionUid)
        : null;
    if (docUid === null || version === null || version.attachmentUid !== docUid) {
      return {
        ok: false,
        error: {
          // @sync-invariant none:input-shape a declared base that does not resolve to this doc's version history is refused before any write
          code: 'E_DOC_BASE_UNKNOWN',
          message:
            `base version '${params.baseVersionUid}' does not resolve to slug '${slug}'s version history — ` +
            're-fetch the doc (`cleo docs fetch ' +
            slug +
            '`) and retry with its metadata.headVersionUid',
        },
      };
    }
    if (!version.storageKey) {
      return {
        ok: false,
        error: {
          // @sync-invariant none:input-shape a base without resolvable bytes cannot anchor a merge; nothing was written
          code: 'E_DOC_BASE_UNKNOWN',
          message:
            `base version '${params.baseVersionUid}' has no stored bytes for slug '${slug}' — ` +
            're-fetch the doc and retry with its current metadata.headVersionUid',
        },
      };
    }
    const { readFile } = await import('node:fs/promises');
    try {
      const text = await readFile(
        join(getCleoDirAbsolute(projectRoot), 'attachments', 'sha256', version.storageKey),
        'utf-8',
      );
      baseSections = splitDocIntoSections(text);
    } catch (cause) {
      return {
        ok: false,
        error: {
          // @sync-invariant none:input-shape the declared base's bytes are unreadable; nothing was written
          code: 'E_DOC_BASE_UNKNOWN',
          message:
            `base version '${params.baseVersionUid}' bytes for slug '${slug}' cannot be read ` +
            `(${cause instanceof Error ? cause.message : String(cause)}) — re-fetch the doc and retry`,
        },
      };
    }
  }

  // T12945: superseded is absorbing (docs.lifecycle.transitions). Leaving it —
  // an explicit --status, or a content edit's draft default — would hold here
  // while every synced peer keeps the doc superseded, so it is refused. Any
  // content edit is refused too, even with --status superseded: it would write
  // a new superseded row without its successor link.
  if (oldRow.lifecycleStatus === 'superseded' && (status !== 'superseded' || !statusOnly)) {
    return {
      ok: false,
      error: {
        code: 'E_INVALID_STATUS', // @sync-invariant docs.lifecycle.transitions
        message: `doc '${slug}' is superseded${oldRow.supersededBy ? ` (by ${oldRow.supersededBy})` : ''}; a superseded doc cannot change its status or content — add the new content as a new doc and supersede again with \`cleo docs supersede ${slug} <new-slug>\``,
      },
    };
  }

  const previousAttachmentId = oldRow.id;
  const previousSha256 = oldRow.sha256;
  const incomingSha256 = buf === null ? previousSha256 : sha256Of(buf);

  // T13842: the row written below is what `docs fetch` reads, so it must hold
  // the HEAD text, not the incoming bytes — after a stale-base merge the head
  // carries a concurrent writer's edit the incoming bytes lack. The merge is
  // PREVIEWED here (the real projection, rolled back), the row is written from
  // its result, and the projection is committed only after the row write
  // succeeded, so a failed blob or row write never leaves the head advanced
  // over an old row. Text bodies only (T13688); binary files stay whole-doc.
  // A failed preview writes the incoming bytes and leaves the head unchanged.
  let projectionInput: ProjectDocUpdateInput | null = null;
  if (
    text !== null &&
    buf !== null &&
    params.dryRun !== true &&
    incomingSha256 !== previousSha256
  ) {
    try {
      const { previewDocUpdateThroughSections } = await import('./section-write-path.js');
      // T13734: link the pre-update bytes to the doc before the first projection.
      const priorVersionUid = await recordPriorVersionOnAdopt(
        projectRoot,
        slug,
        oldRow,
        attachedBy,
      );
      // T13356 AC4: the real session id drives lease acquire/renew, so a
      // lease dies honestly with its session (TTL bound, holder-only renew).
      // Gate 16: the bound session is resolved via resolveBoundSession —
      // never a bare getActiveSession().
      const boundSession = await resolveBoundSession(projectRoot);
      const input: ProjectDocUpdateInput = {
        slug,
        authorAgentId: attachedBy,
        content: text,
        ...(boundSession !== null ? { sessionId: boundSession.session.id } : {}),
        ...(params.message !== undefined ? { changeSummary: params.message } : {}),
        ...(priorVersionUid !== null ? { parentVersionUid: priorVersionUid } : {}),
        // T13674: the declared base replaces the previous head as the
        // single-writer/concurrent discriminator, so a stale base merges
        // (append) or conflicts (non-append) instead of re-seeding over a
        // concurrent writer's landed edit.
        ...(baseSections !== undefined ? { baseSections } : {}),
      };
      // T13881: the preview ROLLS BACK on the process-wide shared native handle,
      // so a write another in-process writer lands on that handle during its
      // awaits would be rolled back with it. Two guards: (1) every tracked
      // background op (graph nodes, hook dispatches, mirrors) settles first,
      // and the preview is skipped if one is still running; (2) the preview
      // runs on the handle's writer queue (scheduleTaskBackground), so accessor
      // transactions and committed background effects queued meanwhile start
      // only after its rollback.
      const { settleBackgroundOps } = await import('../store/background-ops.js');
      const pending = await settleBackgroundOps(PREVIEW_SETTLE_BUDGET_MS);
      if (pending > 0) {
        // @sync-invariant none:input-shape caught just below: the preview is skipped and the incoming bytes are written; nothing is rejected
        throw new Error(`${pending} background write(s) still running; the preview is skipped`);
      }
      const native = getNativeTasksDb(projectRoot);
      if (!native) {
        // @sync-invariant none:input-shape caught just below: without the store handle the preview is skipped and the incoming bytes are written; nothing is rejected
        throw new Error('tasks database is not initialised');
      }
      const { scheduleTaskBackground } = await import('../store/sqlite-data-accessor.js');
      const queued: { preview?: DocUpdatePreview } = {};
      await scheduleTaskBackground(native, async () => {
        queued.preview = await previewDocUpdateThroughSections(projectRoot, input);
      });
      const preview = queued.preview;
      if (preview === undefined) {
        // @sync-invariant none:input-shape caught just below: an empty preview skips the projection and the incoming bytes are written; nothing is rejected
        throw new Error('the merge preview returned nothing');
      }
      // The head is the merged text when this write would advance it; when it
      // loses the head race (an explicit lower HLC) the head stays where it is.
      const headText = preview.wouldAdvance
        ? preview.mergedText
        : await readCurrentHeadText(projectRoot, slug);
      if (headText === null) {
        // @sync-invariant none:input-shape caught just below: an unreadable head skips the projection and the incoming bytes are written; nothing is rejected
        throw new Error('the current conduit head text is unreadable');
      }
      if (headText !== text) buf = Buffer.from(headText, 'utf-8');
      projectionInput = input;
    } catch (previewErr) {
      pushWarning({
        // @sync-invariant none:input-shape the warning only reports that the section projection was skipped; the incoming bytes are written as before and nothing is rejected
        code: 'W_DOC_PROJECTION_FAILED',
        message:
          `section merge preview failed for slug '${slug}' — the incoming bytes are written and the conduit head is unchanged: ` +
          (previewErr instanceof Error ? previewErr.message : String(previewErr)),
      });
    }
  }
  const newSha256 = buf === null ? previousSha256 : sha256Of(buf);
  const wouldChange = newSha256 !== previousSha256 || oldRow.lifecycleStatus !== status;

  // The body schema is checked on new bytes; a lifecycle-only change keeps
  // the stored body, which was checked when it was written.
  if (buf !== null && oldRow.type !== null && oldRow.type !== undefined) {
    const check = validateDocBody(oldRow.type, buf.toString('utf-8'));
    if (!check.ok) {
      const missingList = check.missing.join(', ');
      if (params.strict === true) {
        return {
          ok: false,
          error: {
            code: 'E_DOC_SCHEMA_MISMATCH',
            message: `body for kind '${oldRow.type}' is missing required section(s): ${missingList}`,
            details: { kind: oldRow.type, missing: check.missing, strict: true },
          },
        };
      }
      pushWarning({
        code: 'W_DOC_SCHEMA_MISMATCH',
        message: `body for kind '${oldRow.type}' is missing required section(s): ${missingList}. Add '--strict' to fail on schema violations.`,
      });
    }
  }

  if (params.dryRun === true) {
    const summary = wouldChange
      ? `dry-run: slug '${slug}' would be changed`
      : `dry-run: slug '${slug}' would be left untouched`;
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
        squashed: false,
        summary,
        ownerVersion: getCanonicalCleoVersion(projectRoot),
        docVersion: oldRow.docVersion,
        dryRun: true,
        wouldWrite: false,
        wouldChange,
      },
    };
  }

  // NOOP fast-path: identical content. Still surface the lifecycle status
  // update if the caller asked for one, and still write an audit entry so
  // operators can see the noop attempt. A lifecycle-only update (no new
  // bytes, T12654) always takes this path.
  if (buf === null || incomingSha256 === previousSha256) {
    // Only touch lifecycle_status if it actually changes.
    if (oldRow.lifecycleStatus !== status) {
      await db
        .update(docsAttachments)
        .set({ lifecycleStatus: status })
        .where(eq(docsAttachments.id, oldRow.id))
        .run();
    }
    const { readDocHeadVersionUid } = await import('./fetch-result.js');
    const noopHead = await readDocHeadVersionUid(projectRoot, slug);
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
        summary:
          status === oldRow.lifecycleStatus
            ? `slug '${slug}' was left untouched (bytes and lifecycle status unchanged)`
            : `slug '${slug}' bytes unchanged but lifecycle status changed from '${oldRow.lifecycleStatus}' to '${status}'`,
        ownerVersion: getCanonicalCleoVersion(projectRoot),
        docVersion: oldRow.docVersion,
        ...(noopHead !== undefined ? { headVersionUid: noopHead } : {}),
      },
    };
  }

  // Write the new blob to disk BEFORE the transaction so failure here
  // never leaves committed DB state pointing at missing bytes (AC3).
  // Orphaned blob files are harmless — they're content-addressed, so a
  // future put of the same content will reuse the file rather than
  // creating a duplicate.
  // T13918: a file keeps the type `docs add` infers from its extension (a
  // `.md` stays text/markdown, read back as `content`), not octet-stream.
  const mime = hasFile ? mimeFromPath(params.file as string) : 'text/plain';
  // T13357: re-derive mention links from the new body; topics carry over
  // from the old row (labels do not flow through the update path).
  const derivedRelatedTasks =
    buf !== null && hasContent
      ? linksJsonOrNull(deriveDocLinks(buf.toString('utf-8')).relatedTasks)
      : (oldRow.relatedTasks ?? null);
  // Contract-compliant BlobAttachment shape (T11262). Historic rows used
  // {name, blobId} which violated the canonical {sha256, storageKey} shape
  // defined in `@cleocode/contracts/attachment.ts` and broke read paths that
  // call `.split('/')` on `storageKey`. Compute the storage key from the SHA
  // + MIME so reads can derive the on-disk path without re-resolving.
  const newStorageKey = `${newSha256.slice(0, 2)}/${newSha256.slice(2)}${extFromMime(mime)}`;
  const newAttachmentValue = {
    kind: 'blob' as const,
    sha256: newSha256,
    storageKey: newStorageKey,
    mime,
    size: buf.length,
  };
  // Validate against the canonical contract before persisting — any future
  // shape drift fails fast at the writer chokepoint (T11262 Part 3).
  blobAttachmentSchema.parse(newAttachmentValue);
  const newAttachmentJson = JSON.stringify(newAttachmentValue);
  const newBlobPath = blobPath(newSha256, mime, projectRoot);

  try {
    await mkdir(join(newBlobPath, '..'), { recursive: true });
    await writeFile(newBlobPath, buf);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'E_FILE_ERROR',
        message: `failed to write new blob for slug '${slug}': ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    };
  }

  // Verify the blob was written correctly by reading it back and comparing
  // the SHA-256 digest. Runs BEFORE the DB transaction so a disk failure
  // never leaves committed state pointing at missing bytes (AC3 / T11055).
  {
    const { readFile } = await import('node:fs/promises');
    let writtenBuf: Buffer;
    try {
      writtenBuf = await readFile(newBlobPath);
    } catch (cause) {
      return {
        ok: false,
        error: {
          code: 'E_FILE_ERROR',
          message: `blob was reported as written for slug '${slug}' but cannot be read back: ${cause instanceof Error ? cause.message : String(cause)}`,
        },
      };
    }
    const writtenSha256 = sha256Of(writtenBuf);
    if (writtenSha256 !== newSha256) {
      return {
        ok: false,
        error: {
          code: 'E_FILE_ERROR',
          message: `blob integrity check failed for slug '${slug}': expected sha256 ${newSha256.slice(0, 12)}... but read-back sha256 is ${writtenSha256.slice(0, 12)}... — storage is internally inconsistent`,
        },
      };
    }
  }

  // T13362/T13653/T13657: mirror the verified bytes into the content-addressed
  // blob store — the canonical read location since the legacy tree's read
  // paths retired. An existing target is RE-HASHED, never trusted on
  // existence alone: a truncated leftover from an interrupted pre-atomic
  // write is replaced from these verified bytes, a matching one is skipped
  // (content-addressed dedup). The write goes through the shared atomic
  // writer (unique tmp + rename), so a crash never leaves a partial file
  // that later runs would count as present.
  {
    const blobStoreFile = join(resolveCleoDir(projectRoot), 'blobs', 'blobs', newSha256);
    if (!fileBytesMatchSha256(blobStoreFile, newSha256)) {
      try {
        await writeFileAtomic({ path: blobStoreFile, content: buf });
      } catch (cause) {
        return {
          ok: false,
          error: {
            // @sync-invariant none:local-only a failed local blob-mirror write rolls the whole update back; no synced row was written
            code: 'E_FILE_ERROR',
            message: `failed to mirror new blob into the blob store for slug '${slug}': ${cause instanceof Error ? cause.message : String(cause)}`,
          },
        };
      }
    }
  }

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
    await db
      .update(docsAttachments)
      .set({ slug: null })
      .where(eq(docsAttachments.id, oldRow.id))
      .run();

    // 2. Insert OR update the new-sha256 row. If a row already exists
    //    for this sha256 (rare — same bytes already stored under a
    //    different slug), reuse it and just transfer the slug onto it.
    const existingNewRow = await db
      .select()
      .from(docsAttachments)
      .where(eq(docsAttachments.sha256, newSha256))
      .get();

    if (existingNewRow) {
      newAttachmentId = existingNewRow.id;
      await db
        .update(docsAttachments)
        .set({
          slug,
          type: oldRow.type ?? null,
          lifecycleStatus: status,
          docVersion: oldRow.docVersion + 1,
          topics: oldRow.topics ?? null,
          relatedTasks: derivedRelatedTasks,
        })
        .where(eq(docsAttachments.id, existingNewRow.id))
        .run();
    } else {
      newAttachmentId = randomUUID();
      await db
        .insert(docsAttachments)
        .values({
          id: newAttachmentId,
          sha256: newSha256,
          attachmentJson: newAttachmentJson,
          createdAt: nowIso,
          refCount: 0,
          slug,
          ...(oldRow.type ? { type: oldRow.type } : {}),
          lifecycleStatus: status,
          ownerVersion: getCanonicalCleoVersion(projectRoot),
          docVersion: oldRow.docVersion + 1,
          topics: oldRow.topics ?? null,
          relatedTasks: derivedRelatedTasks,
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
        .update(docsAttachments)
        .set({
          refCount: (existingNewRow?.refCount ?? 0) + refsAdded,
        })
        .where(eq(docsAttachments.id, newAttachmentId))
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

  // T13357: refresh the wikilinks edge table after the write. Best-effort —
  // a graph rebuild failure must not fail the completed update.
  try {
    const { rebuildDocsWikilinks, syncDocBodyWikilinks } = await import('./wikilinks.js');
    // T14113: the new body's `[[slug]]` links become `links-to` edges.
    if (buf !== null && (hasContent || isScannableTextMime(mime))) {
      await syncDocBodyWikilinks(slug, extractWikilinkTargets(buf.toString('utf-8')), {
        projectRoot,
      });
    }
    await rebuildDocsWikilinks({ projectRoot });
  } catch (rebuildErr) {
    // T13711: drizzle interpolates the full SQL + params into err.message
    // (~900 KB on axiom-app) — warn with the bounded driver cause, never the
    // parameter dump.
    const { boundedErrorMessage } = await import('../lib/error-message.js');
    process.emitWarning(
      `docs wikilinks rebuild failed after update of slug '${slug}': ${boundedErrorMessage(rebuildErr)}`,
    );
  }

  // T13842: commit the previewed projection now that the row holds its text.
  // T13604: a recorded conflict is threaded into the result envelope and a
  // stderr warning names the sections — the update reports changed:true, so
  // without this the caller would never learn their edit is not in the head.
  let sectionConflicts: DocsSectionConflict[] | undefined;
  let leaseNotices: DocsSectionLeaseNotice[] | undefined;
  let staleBaseMerged = false;
  if (projectionInput !== null) {
    try {
      const { projectDocUpdateThroughSections } = await import('./section-write-path.js');
      const projection = await projectDocUpdateThroughSections(projectRoot, projectionInput);
      const committedText = projection.head.advanced
        ? projection.mergedText
        : await readVersionText(projectRoot, projection.head.head.headVersionUid);
      if (committedText !== buf.toString('utf-8')) {
        pushWarning({
          // @sync-invariant none:input-shape the warning only reports that another writer landed between the preview and the commit; both versions are kept and nothing is rejected
          code: 'W_DOC_HEAD_DIVERGED',
          message:
            `slug '${slug}': another writer landed between the merge preview and its commit — the doc row holds the previewed text, ` +
            `the conduit head is ${projection.head.head.headVersionUid}. Re-fetch (\`cleo docs fetch ${slug}\`) and re-apply if needed.`,
        });
      }
      // T13674: the declared base was superseded AND at least one edited
      // section composed into the head — its text is the merge of the
      // caller's edit and a concurrent writer's. A section that only
      // conflicted merged nothing, so it is reported as a conflict alone.
      const conflicted = new Set(projection.conflicts.map((c) => c.sectionId));
      staleBaseMerged =
        params.baseVersionUid !== undefined &&
        projection.previousHeadVersionUid !== null &&
        params.baseVersionUid !== projection.previousHeadVersionUid &&
        projection.sectionsModified.some((id) => !conflicted.has(id));
      if (staleBaseMerged) {
        pushWarning({
          // @sync-invariant none:input-shape the warning only names a merge the CRDT projection already performed (docs.head.max-hlc); it rejects nothing and writes nothing
          code: 'W_DOC_STALE_BASE',
          message:
            `slug '${slug}' was updated against a superseded base — a concurrent writer's edit was merged ` +
            'into the head. Re-fetch (`cleo docs fetch ' +
            slug +
            '`) before your next edit so it is authored against the current head.',
        });
      }
      if (projection.conflicts.length > 0) {
        sectionConflicts = projection.conflicts.map((c) => ({
          sectionId: c.sectionId,
          incomingVersionUid: c.incomingVersionUid,
          projectionVersionUid: c.projectionVersionUid,
        }));
        pushWarning({
          // @sync-invariant none:input-shape the warning only NAMES a conflict the CRDT projection already recorded (docs.head.max-hlc); it rejects nothing and writes nothing
          code: 'W_DOC_SECTION_CONFLICT',
          message:
            `concurrent section edit(s) on slug '${slug}' did not merge into the conduit head: ` +
            projection.conflicts
              .map(
                (c) =>
                  `section '${c.sectionId}' (incoming version ${c.incomingVersionUid} kept in history; head keeps projection version ${c.projectionVersionUid})`,
              )
              .join('; '),
        });
      }
      if (projection.leaseNotices.length > 0) {
        leaseNotices = projection.leaseNotices.map((n) => ({
          sectionId: n.sectionId,
          holder: n.holder,
          sessionId: n.sessionId,
          expiresAt: n.expiresAt,
        }));
        pushWarning({
          // @sync-invariant none:input-shape the warning only NAMES an advisory lease held by another session (T13356); it rejects nothing and writes nothing
          code: 'W_DOC_SECTION_LEASED',
          message:
            `section lease(s) held by another session on slug '${slug}' (advisory — your edit still landed): ` +
            projection.leaseNotices
              .map((n) => `section '${n.sectionId}' held by ${n.holder} until ${n.expiresAt}`)
              .join('; '),
        });
      }
    } catch (projectionErr) {
      const { readDocHeadVersionUid: readHead } = await import('./fetch-result.js');
      const head = await readHead(projectRoot, slug);
      pushWarning({
        // @sync-invariant none:input-shape the warning only reports a failed projection commit after the row write; the row and the version history are intact and nothing is rejected
        code: 'W_DOC_PROJECTION_FAILED',
        message:
          `slug '${slug}': the doc row was written from the previewed merge, but committing the section projection failed ` +
          `(${projectionErr instanceof Error ? projectionErr.message : String(projectionErr)}); the conduit head stays at ${head ?? 'none'} — re-run the update to land it`,
      });
    }
  }

  const { readDocHeadVersionUid } = await import('./fetch-result.js');
  const headVersionUid = await readDocHeadVersionUid(projectRoot, slug);
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
      summary: `slug '${slug}' was changed — content replaced${params.message ? ` ("${params.message}")` : ''}`,
      ownerVersion: getCanonicalCleoVersion(projectRoot),
      docVersion: oldRow.docVersion + 1,
      ...(sectionConflicts !== undefined ? { sectionConflicts } : {}),
      ...(leaseNotices !== undefined ? { leaseNotices } : {}),
      ...(staleBaseMerged ? { staleBaseMerged: true as const } : {}),
      ...(headVersionUid !== undefined ? { headVersionUid } : {}),
    },
  };
}

/**
 * How long a docs update waits for tracked background writes to settle before
 * it previews a merge (T13881). A write still running after this is not
 * rolled back by the preview: the preview is skipped instead.
 */
const PREVIEW_SETTLE_BUDGET_MS = 5_000;

/**
 * A conduit version's text, read from its content-addressed blob (T13842).
 * `null` when the version or its bytes cannot be read; the caller then keeps
 * the incoming bytes.
 */
async function readVersionText(projectRoot: string, versionUid: string): Promise<string | null> {
  const { getConduitAttachmentVersion } = await import('../store/conduit-doc-history.js');
  const version = await getConduitAttachmentVersion(projectRoot, versionUid);
  if (!version?.storageKey) return null;
  const { readFile } = await import('node:fs/promises');
  return readFile(
    join(getCleoDirAbsolute(projectRoot), 'attachments', 'sha256', version.storageKey),
    'utf-8',
  ).catch(() => null);
}

/** The current conduit head's text for a slug (T13842), or `null` when it has none or it is unreadable. */
async function readCurrentHeadText(projectRoot: string, slug: string): Promise<string | null> {
  const { getConduitDocHead, resolveConduitDocUid } = await import(
    '../store/conduit-doc-history.js'
  );
  const docUid = await resolveConduitDocUid(projectRoot, slug);
  const head = docUid !== null ? await getConduitDocHead(projectRoot, docUid) : null;
  return head !== null ? readVersionText(projectRoot, head.headVersionUid) : null;
}

/** The bytes as text when they are valid UTF-8 without NUL bytes; else null. */
function utf8TextOf(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const text = buf.toString('utf-8');
  return Buffer.from(text, 'utf-8').equals(buf) ? text : null;
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
 * Record a doc's pre-update bytes as its root conduit version (T13734).
 *
 * The first text update adopts a doc into the conduit history family, and the
 * projection only records the NEW content — the update also moves the slug to
 * a new `attachments` row, so nothing linked the prior version to the doc and
 * `docs versions` could not list it. When the slug has no conduit doc yet and
 * the prior row's blob bytes are on disk, this adopts the doc and appends a
 * root version carrying the prior hash; the caller passes the returned uid as
 * the projection's parent, giving the history v1 → v2.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param slug - The doc slug being updated.
 * @param oldRow - The pre-update `attachments` row.
 * @param authorAgentId - Agent recorded as the root version's author.
 * The doc is adopted with the prior row's `created_at` as its birth even when
 * the bytes are missing, so its uid matches on every device (T13586).
 *
 * @returns The root version uid, or `null` when the doc already has conduit
 *   history or the prior row has no resolvable blob bytes.
 * @internal
 */
async function recordPriorVersionOnAdopt(
  projectRoot: string,
  slug: string,
  oldRow: typeof docsAttachments.$inferSelect,
  authorAgentId: string,
): Promise<string | null> {
  const { appendConduitAttachmentVersion, ensureConduitDoc, resolveConduitDocUid } = await import(
    '../store/conduit-doc-history.js'
  );
  if ((await resolveConduitDocUid(projectRoot, slug)) !== null) return null;
  let storageKey: string | undefined;
  let bytes: Buffer | undefined;
  try {
    const prior = blobAttachmentSchema.safeParse(JSON.parse(oldRow.attachmentJson));
    if (prior.success && prior.data.storageKey) {
      storageKey = prior.data.storageKey;
      bytes = readFileSync(
        join(getCleoDirAbsolute(projectRoot), 'attachments', 'sha256', storageKey),
      );
    }
  } catch {
    bytes = undefined; // shortcut: no parseable row or local bytes, no root row; the T13727 backfill covers these docs
  }
  // T13586: adopt with the PRE-update row's birth even without local bytes —
  // the slug already points at this device's new row, so letting the
  // projection adopt would stamp a per-device birth and mint a per-device uid.
  const { uid } = await ensureConduitDoc(projectRoot, {
    slug,
    authorAgentId,
    content: bytes ?? Buffer.alloc(0),
    legacyBirth: oldRow.createdAt,
  });
  if (bytes === undefined || storageKey === undefined) return null;
  const tokens = bytes
    .toString('utf-8')
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  const root = await appendConduitAttachmentVersion(projectRoot, {
    attachmentUid: uid,
    parentVersionUid: null,
    authorAgentId,
    storageKey,
    contentHash: oldRow.sha256,
    originalSize: bytes.length,
    compressedSize: bytes.length,
    tokens,
    changeType: 'create',
    changeSummary: `prior version of '${slug}' recorded on first update (T13734)`,
    tokensAdded: tokens,
  });
  return root.uid ?? null;
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
