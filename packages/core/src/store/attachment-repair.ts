/**
 * Attachment store repair routine — janitor-safe, dry-run capable.
 *
 * Detects and resolves two classes of orphan that can arise from crashes or
 * prior ordering bugs (pre-T11997):
 *
 *   (1) **row-without-file** — an `attachments` row exists but the blob file
 *       on disk is absent.  The row is MARKED (lifecycleStatus → 'archived',
 *       summary updated) rather than deleted — metadata is preserved for
 *       url-kind rows that are re-fetchable.  Amendment 2 (adversarial review).
 *
 *   (2) **file-without-row** — a blob file on disk has no corresponding row in
 *       the `attachments` table AND is not referenced by any of the three doc
 *       storage surfaces (tasks.db attachments, blobs manifest.db, and
 *       docs-publications.json).  Eligible for deletion only after the grace
 *       period elapses.  Amendment 3 (adversarial review).
 *
 * Amendment 1 (config restore): handled separately in config-repair.ts via
 * `repairConfigFile`.
 *
 * Output contract:
 *   - Silent by default — NO console output; callers read the returned result.
 *   - Writes one JSONL line per action to `.cleo/audit/attachment-repair.jsonl`.
 *   - Returns a structured {@link RepairResult} so the janitor (T11995) can
 *     report counts without parsing the audit log.
 *   - Converges on repeated runs: a fully-healthy store produces zero actions.
 *
 * @task T11997
 * @epic T11992
 */

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { eq } from 'drizzle-orm';
import { resolveCleoDir } from '../paths.js';
import { getDb } from './sqlite.js';
import { attachments } from './tasks-schema.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/** One action taken (or that would be taken in dry-run) by the repair routine. */
export interface RepairAction {
  /** What happened. */
  readonly kind:
    | 'mark-row-without-file'
    | 'delete-unreferenced-blob'
    | 'skip-grace-period'
    | 'skip-referenced-blob';
  /** SHA-256 of the affected blob (64 hex chars, or '' when n/a). */
  readonly sha256: string;
  /** Attachment row ID, when the row exists. */
  readonly attachmentId?: string;
  /** Absolute path to the on-disk blob file, when applicable. */
  readonly filePath?: string;
  /** Human-readable reason. */
  readonly reason: string;
}

/** Structured result of {@link repairAttachmentStore}. */
export interface RepairResult {
  /**
   * Whether any mutations were (or would be) made.
   * `false` when the store is fully healthy or `dryRun` had nothing to fix.
   */
  readonly mutated: boolean;
  /** `true` when this was a dry-run invocation (no writes performed). */
  readonly dryRun: boolean;
  /** Rows-without-files found (and marked, or would-mark). */
  readonly rowsWithoutFilesCount: number;
  /** Unreferenced blob files deleted (or would-delete). */
  readonly unreferencedBlobsDeletedCount: number;
  /** Blobs skipped because they are still within the grace period. */
  readonly gracePeriodSkipCount: number;
  /** Blobs skipped because they appear in a secondary reference surface. */
  readonly referencedSkipCount: number;
  /** All actions, in order. */
  readonly actions: readonly RepairAction[];
}

// ─── Options ──────────────────────────────────────────────────────────────────

/** Options for {@link repairAttachmentStore}. */
export interface RepairOptions {
  /**
   * When `true`, analyse the store and return what would happen but do NOT
   * write any changes.  Default: `false`.
   */
  readonly dryRun?: boolean;
  /**
   * Minimum age in milliseconds before an unreferenced on-disk blob is
   * eligible for deletion.  Default: 5 minutes (300 000 ms).
   *
   * The grace period exists to avoid racing against an in-flight `put` that
   * has written the file but not yet committed the row.
   */
  readonly gracePeriodMs?: number;
  /**
   * Working directory (project root) for resolving `.cleo/` paths.
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default grace period (5 minutes). */
const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1_000;

/** Audit log file, relative to project root. */
const REPAIR_AUDIT_FILE = '.cleo/audit/attachment-repair.jsonl';

/** Marker added to `summary` of rows with missing blobs. */
const MISSING_FILE_SUMMARY_PREFIX = '[repair:missing-blob]';

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compute the sha256 from a blob on-disk layout entry.
 *
 * On-disk layout: `.cleo/attachments/sha256/<2-char-prefix>/<62-char-rest>.<ext>`
 * The sha256 is the concatenation of the prefix directory name and the filename stem.
 */
function sha256FromBlobPath(prefixDir: string, filename: string): string {
  const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  return `${prefixDir}${stem}`;
}

/**
 * Read the docs-publications ledger and return all blob SHA-256 hashes
 * that appear in it, so we never declare a published blob unreferenced.
 */
async function readPublicationsSha256Set(cwd: string): Promise<Set<string>> {
  const ledgerPath = join(cwd, '.cleo', 'docs-publications.json');
  const out = new Set<string>();
  try {
    const raw = await readFile(ledgerPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      entries?: Array<{ lastBlobSha?: string; [key: string]: unknown }>;
    };
    if (Array.isArray(parsed?.entries)) {
      for (const e of parsed.entries) {
        if (typeof e?.lastBlobSha === 'string' && e.lastBlobSha.length === 64) {
          out.add(e.lastBlobSha);
        }
      }
    }
  } catch {
    // File absent or malformed — treat as empty
  }
  return out;
}

/**
 * Check whether the blobs manifest.db blob store references the given sha256.
 *
 * The llmtxt BlobFsAdapter stores bytes at `<projectRoot>/.cleo/blobs/blobs/<sha256-hex>`.
 * A file at that path means the manifest store has this blob — checking the path is
 * lighter than opening the SQLite manifest.db and avoids a hard CleoBlobStore dependency.
 */
function isInBlobManifest(sha256: string, projectRoot: string): boolean {
  // BlobFsAdapter convention: bytes at .cleo/blobs/blobs/<full-sha256-hex>
  const blobFile = join(projectRoot, '.cleo', 'blobs', 'blobs', sha256);
  return existsSync(blobFile);
}

/** Append one JSON line to the repair audit log. */
async function appendAuditLine(projectRoot: string, entry: Record<string, unknown>): Promise<void> {
  const auditPath = join(projectRoot, REPAIR_AUDIT_FILE);
  await mkdir(join(auditPath, '..'), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(entry)}\n`, 'utf-8');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the attachment store for orphans and optionally repair them.
 *
 * This function is designed for janitor consumption (T11995).  Call it with
 * `dryRun: true` first to preview what would change, then without `dryRun` to
 * apply.  The function is idempotent: running it repeatedly on a healthy store
 * returns `{ mutated: false, actions: [] }`.
 *
 * @param opts - Repair options (see {@link RepairOptions}).
 * @returns Structured {@link RepairResult} — no console output.
 *
 * @example
 * ```ts
 * import { repairAttachmentStore } from '@cleocode/core/store/attachment-repair';
 *
 * const result = await repairAttachmentStore({ dryRun: true });
 * if (result.rowsWithoutFilesCount > 0) {
 *   console.log(`${result.rowsWithoutFilesCount} rows would be marked`);
 *   await repairAttachmentStore({ dryRun: false }); // apply
 * }
 * ```
 *
 * @task T11997
 */
export async function repairAttachmentStore(opts?: RepairOptions): Promise<RepairResult> {
  const dryRun = opts?.dryRun ?? false;
  const gracePeriodMs = opts?.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const cwd = opts?.cwd ?? process.cwd(); // CWD-OK: explicit project-root parameter

  const cleoDir = resolveCleoDir(cwd);
  const db = await getDb(cwd);
  const now = Date.now();
  const actions: RepairAction[] = [];

  // ── Phase 1: rows-without-files ─────────────────────────────────────────────

  const allRows = await db.select().from(attachments).all();

  for (const row of allRows) {
    // Only blob/local-file kinds store bytes on disk; url + llms-txt + llmtxt-doc
    // are by-reference — their absence on disk is expected.
    let attachment: { kind: string; mime?: string } | null = null;
    try {
      attachment = JSON.parse(row.attachmentJson) as { kind: string; mime?: string };
    } catch {
      // Malformed row — skip
      continue;
    }

    if (attachment.kind !== 'blob' && attachment.kind !== 'local-file') {
      continue;
    }

    // Derive on-disk path using the same sharding logic as attachment-store.ts
    const prefix = row.sha256.slice(0, 2);
    const rest = row.sha256.slice(2);
    const mime = attachment.mime ?? 'application/octet-stream';
    const base = mime.split(';')[0]?.trim() ?? mime;
    const MIME_TO_EXT: Record<string, string> = {
      'text/markdown': '.md',
      'text/plain': '.txt',
      'text/html': '.html',
      'text/css': '.css',
      'text/javascript': '.js',
      'application/json': '.json',
      'application/pdf': '.pdf',
      'application/zip': '.zip',
      'application/octet-stream': '.bin',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'audio/mpeg': '.mp3',
      'video/mp4': '.mp4',
    };
    const ext = MIME_TO_EXT[base] ?? '.bin';
    const filePath = join(cleoDir, 'attachments', 'sha256', prefix, `${rest}${ext}`);

    if (!existsSync(filePath)) {
      const action: RepairAction = {
        kind: 'mark-row-without-file',
        sha256: row.sha256,
        attachmentId: row.id,
        filePath,
        reason: `Blob file absent at expected path; row marked archived to preserve metadata`,
      };
      actions.push(action);

      if (!dryRun) {
        // Mark the row: set lifecycleStatus = 'archived', prepend marker to summary
        const existingSummary = row.summary ?? '';
        const newSummary = existingSummary.startsWith(MISSING_FILE_SUMMARY_PREFIX)
          ? existingSummary
          : `${MISSING_FILE_SUMMARY_PREFIX} ${existingSummary}`.trim();

        await db
          .update(attachments)
          .set({
            lifecycleStatus: 'archived',
            summary: newSummary,
          })
          .where(eq(attachments.id, row.id))
          .run();

        await appendAuditLine(cwd, {
          ts: new Date().toISOString(),
          event: 'attachment-repair:mark-row-without-file',
          attachmentId: row.id,
          sha256: row.sha256,
          filePath: relative(cwd, filePath),
          summary: 'Row marked archived; blob file absent',
        });
      }
    }
  }

  // ── Phase 2: files-without-rows (unreferenced blobs on disk) ────────────────

  const sha256Dir = join(cleoDir, 'attachments', 'sha256');
  const rowSha256Set = new Set(allRows.map((r) => r.sha256));
  const publicationsSha256Set = await readPublicationsSha256Set(cwd);

  let gracePeriodSkipCount = 0;
  let referencedSkipCount = 0;
  let unreferencedBlobsDeletedCount = 0;

  if (existsSync(sha256Dir)) {
    let prefixDirs: string[] = [];
    try {
      prefixDirs = await readdir(sha256Dir);
    } catch {
      // Directory unreadable — skip phase 2
      prefixDirs = [];
    }

    for (const prefixDir of prefixDirs) {
      const prefixPath = join(sha256Dir, prefixDir);
      let files: string[] = [];
      try {
        files = await readdir(prefixPath);
      } catch {
        continue;
      }

      for (const filename of files) {
        const sha256 = sha256FromBlobPath(prefixDir, filename);

        // Validate it looks like a sha256 (sanity guard)
        if (!/^[0-9a-f]{64}$/.test(sha256)) continue;

        // Already referenced by attachments table row
        if (rowSha256Set.has(sha256)) continue;

        const filePath = join(prefixPath, filename);

        // Check grace period
        let fileMtimeMs = 0;
        try {
          const s = await stat(filePath);
          fileMtimeMs = s.mtimeMs;
        } catch {
          continue;
        }

        if (now - fileMtimeMs < gracePeriodMs) {
          gracePeriodSkipCount++;
          const action: RepairAction = {
            kind: 'skip-grace-period',
            sha256,
            filePath,
            reason: `File too new (age=${Math.round((now - fileMtimeMs) / 1000)}s, grace=${Math.round(gracePeriodMs / 1000)}s)`,
          };
          actions.push(action);
          continue;
        }

        // Check docs-publications.json
        if (publicationsSha256Set.has(sha256)) {
          referencedSkipCount++;
          const action: RepairAction = {
            kind: 'skip-referenced-blob',
            sha256,
            filePath,
            reason: 'Referenced in docs-publications.json ledger',
          };
          actions.push(action);
          continue;
        }

        // Check blobs manifest.db (llmtxt)
        const inManifest = isInBlobManifest(sha256, cwd);
        if (inManifest) {
          referencedSkipCount++;
          const action: RepairAction = {
            kind: 'skip-referenced-blob',
            sha256,
            filePath,
            reason: 'Referenced in blobs/manifest.db',
          };
          actions.push(action);
          continue;
        }

        // Truly unreferenced — eligible for deletion
        const action: RepairAction = {
          kind: 'delete-unreferenced-blob',
          sha256,
          filePath,
          reason: `Not referenced by attachments table, blobs manifest, or docs-publications ledger`,
        };
        actions.push(action);

        if (!dryRun) {
          try {
            await unlink(filePath);
            unreferencedBlobsDeletedCount++;
          } catch {
            // Best-effort — if the file disappears between scan and delete, that's fine
          }

          await appendAuditLine(cwd, {
            ts: new Date().toISOString(),
            event: 'attachment-repair:delete-unreferenced-blob',
            sha256,
            filePath: relative(cwd, filePath),
            summary: 'Unreferenced blob file deleted after grace period',
          });
        } else {
          unreferencedBlobsDeletedCount++;
        }
      }
    }
  }

  const rowsWithoutFilesCount = actions.filter((a) => a.kind === 'mark-row-without-file').length;
  const mutated = !dryRun && (rowsWithoutFilesCount > 0 || unreferencedBlobsDeletedCount > 0);

  return {
    mutated,
    dryRun,
    rowsWithoutFilesCount,
    unreferencedBlobsDeletedCount,
    gracePeriodSkipCount,
    referencedSkipCount,
    actions,
  };
}
