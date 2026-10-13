/**
 * `cleo docs doctor` — store health diagnostics + safe repairs — T13447.
 *
 * Audits the CleoDocs store (`cleo.db` `attachments`/`docs_wikilinks` tables
 * plus the on-disk legacy surfaces) for six known drift classes and, when
 * invoked with `apply: true`, performs the repairs that are safe to run
 * in-place:
 *
 *   - `dangling-pointers`   — rows whose recorded local `path` is gone from
 *                             disk or lives inside a worktree/tmp directory.
 *                             Rows already `lifecycle_status = 'archived'`
 *                             are excluded (T13562). Repair for a missing
 *                             `local-file` target archives the row; a
 *                             `blob`-kind payload carrying a stale legacy
 *                             `path` whose content still resolves in the
 *                             content-addressed blob store is re-pointed
 *                             instead — the stale `path` field is cleared
 *                             (`clear-stale-path`, T13562) since the bytes
 *                             are alive. Existing files are left alone
 *                             (content capture is T13360's scope).
 *   - `doc-version-skew`    — slugged rows whose `docVersion` trails the
 *                             revision count in `.cleo/audit/docs-versioning.jsonl`
 *                             (the T13351 bug left historical rows at 1). Repair
 *                             sets `docVersion = revisions + 1`.
 *   - `empty-provenance`    — slugged text docs with NULL/empty `topics` AND
 *                             `related_tasks` whose content is retrievable.
 *                             Repair re-derives both columns via
 *                             {@link deriveDocLinks} (T13357 semantics).
 *   - `wikilinks-drift`     — expected edges (derived from the current
 *                             provenance columns) missing from `docs_wikilinks`.
 *                             Repair is a full {@link rebuildDocsWikilinks}.
 *   - `legacy-store-present`— `.cleo/attachments/index.db`,
 *                             `.cleo/docs-publications.json` and/or
 *                             `.cleo/attachments/sha256/` still on disk.
 *   - `stale-drafts`        — slugged docs still `draft` after
 *                             `--older-than-days` (default 30).
 *
 * SAFETY: `apply: true` REFUSES to run without a backup receipt
 * ({@link DocsDoctorOptions.backupReceiptPath}) whose mtime is at most
 * {@link DOCS_DOCTOR_BACKUP_MAX_AGE_MS} old. The dispatch layer creates the
 * backup itself (same `createBackup` as `cleo backup add`) and passes the
 * receipt path automatically; a dry run needs no receipt.
 *
 * The module never logs to console — every outcome flows through the
 * returned report.
 *
 * @task T13447 (Epic T13340 / Saga T13339)
 * @see docs-update.ts — audit-log version semantics (version = revisions + 1)
 * @see derive-links.ts — topics/related_tasks derivation (T13357)
 * @see wikilinks.ts — derived edge table + rebuild (T11826)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { getCleoWorktreesRoot } from '@cleocode/paths';
import { eq } from 'drizzle-orm';
import { resolveCleoDir } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { blobContentExists } from '../store/blob-keep.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';
import { docsAttachments } from '../store/tasks-schema.js';
import {
  type DerivedDocLinks,
  deriveDocLinks,
  isScannableTextMime,
  linksJsonOrNull,
} from './derive-links.js';
import { DOCS_VERSIONING_AUDIT_FILE } from './docs-update.js';
import { deriveWikilinkEdges, rebuildDocsWikilinks, type WikilinkEdge } from './wikilinks.js';

/**
 * Maximum age of the backup receipt accepted before an `apply` run.
 *
 * A receipt older than this is treated as stale: the operator (or the
 * dispatch layer) must create a fresh backup before repairs proceed.
 *
 * @task T13447
 */
export const DOCS_DOCTOR_BACKUP_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * Default age threshold for the `stale-drafts` diagnostic (days).
 *
 * @task T13447
 */
export const DOCS_DOCTOR_DEFAULT_OLDER_THAN_DAYS = 30;

/**
 * Per-diagnostic detail cap — the report stays readable on stores with
 * hundreds of offenders; the full count is always reported.
 *
 * @task T13447
 */
export const DOCS_DOCTOR_MAX_DETAIL_ITEMS = 50;

/**
 * The six diagnostic classes {@link runDocsDoctor} checks for.
 *
 * @task T13447
 */
export type DocsDoctorDiagnosticKind =
  | 'dangling-pointers'
  | 'doc-version-skew'
  | 'empty-provenance'
  | 'wikilinks-drift'
  | 'legacy-store-present'
  | 'stale-drafts';

/**
 * One diagnostic class in the report: severity, total offender count, and a
 * capped detail list.
 *
 * @task T13447
 */
export interface DocsDoctorDiagnostic {
  /** Which check produced this entry. */
  readonly kind: DocsDoctorDiagnosticKind;
  /** `error` blocks nothing but should be fixed; `info` is observational. */
  readonly severity: 'info' | 'warn' | 'error';
  /** Total offenders found (may exceed `items.length`). */
  readonly count: number;
  /** Capped per-item detail (see {@link DOCS_DOCTOR_MAX_DETAIL_ITEMS}). */
  readonly items: ReadonlyArray<Record<string, unknown>>;
  /** True when `count` exceeded the detail cap. */
  readonly truncated: boolean;
}

/**
 * One planned or executed repair step.
 *
 * @task T13447
 */
export interface DocsDoctorRepairAction {
  /** Diagnostic class this repair addresses. */
  readonly kind: DocsDoctorDiagnosticKind;
  /** Machine-readable action verb (e.g. `set-doc-version`). */
  readonly action: string;
  /** False on a dry run (the action is a plan, not a write). */
  readonly applied: boolean;
  /** Doc slug the action touched, when row-scoped. */
  readonly slug?: string;
  /** Attachment id the action touched, when row-scoped. */
  readonly attachmentId?: string;
  /** Human-readable detail (old→new values, derived counts, …). */
  readonly detail: string;
}

/**
 * Structured outcome of a {@link runDocsDoctor} run.
 *
 * @task T13447
 */
export interface DocsDoctorReport {
  /** True when repairs were written (`opts.apply === true`). */
  readonly applied: boolean;
  /** Age threshold used for the `stale-drafts` check. */
  readonly olderThanDays: number;
  /** Backup receipt that authorised this run (null on dry runs). */
  readonly backupReceiptPath: string | null;
  /** All six diagnostics, in declaration order. */
  readonly diagnostics: readonly DocsDoctorDiagnostic[];
  /** Repair plan (dry run) or executed repairs (apply). */
  readonly repairs: readonly DocsDoctorRepairAction[];
  /** One-line human summary. */
  readonly summary: string;
}

/**
 * Options accepted by {@link runDocsDoctor}.
 *
 * @task T13447
 */
export interface DocsDoctorOptions {
  /**
   * Execute repairs instead of producing a dry-run plan. Requires
   * {@link backupReceiptPath} — see the module docblock for the safety rule.
   */
  readonly apply?: boolean;
  /** Age threshold (days) for the `stale-drafts` diagnostic. Default 30. */
  readonly olderThanDays?: number;
  /**
   * Path to a backup artifact created within the last
   * {@link DOCS_DOCTOR_BACKUP_MAX_AGE_MS} milliseconds (checked via mtime).
   * Required when {@link apply} is true.
   */
  readonly backupReceiptPath?: string;
}

/**
 * Discriminated outcome of {@link runDocsDoctor}.
 *
 * The failure arm covers the backup-gate refusals
 * (`E_DOCS_DOCTOR_BACKUP_REQUIRED` / `E_DOCS_DOCTOR_BACKUP_STALE`); the
 * dispatch layer maps it onto a LAFS error envelope.
 *
 * @task T13447
 */
export type RunDocsDoctorResult =
  | { readonly ok: true; readonly report: DocsDoctorReport }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

/** Shape of a docs-versioning audit line (mirrors docs-update.ts). */
interface AuditLine {
  readonly op?: string;
  readonly slug?: string;
  readonly revisions?: readonly unknown[];
}

/** Narrow view of an attachments row used by the checks. */
interface DoctorRow {
  readonly id: string;
  readonly sha256: string;
  readonly slug: string | null;
  readonly attachmentJson: string;
  readonly lifecycleStatus: string;
  readonly docVersion: number;
  readonly createdAt: string;
  readonly topics: string | null;
  readonly relatedTasks: string | null;
  readonly supersedes: string | null;
  readonly supersededBy: string | null;
}

/** Parsed `local-file` attachment payload. */
interface LocalFilePayload {
  readonly kind: 'local-file';
  readonly path: string;
  readonly mime?: string;
  readonly labels?: readonly string[];
}

/**
 * Parse a row's `attachment_json` defensively. Malformed JSON yields null —
 * such rows are skipped by kind-scoped checks rather than failing the run.
 *
 * @internal
 */
function parseAttachmentJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Narrow a parsed payload to the `local-file` shape. @internal */
function asLocalFile(payload: Record<string, unknown>): LocalFilePayload | null {
  if (payload['kind'] !== 'local-file') return null;
  const path = payload['path'];
  if (typeof path !== 'string' || path.length === 0) return null;
  const mime = payload['mime'];
  const labels = payload['labels'];
  return {
    kind: 'local-file',
    path,
    ...(typeof mime === 'string' ? { mime } : {}),
    ...(Array.isArray(labels)
      ? { labels: labels.filter((l): l is string => typeof l === 'string') }
      : {}),
  };
}

/**
 * A `blob`-kind payload carrying a legacy `path` field.
 *
 * Historical write paths recorded the source file on blob payloads; the
 * current {@link BlobAttachment} contract has no `path` (content lives
 * content-addressed under `.cleo/attachments/sha256/`). Rows whose legacy
 * `path` went stale dangle even though the bytes are retrievable by sha256.
 */
interface BlobWithPathPayload {
  readonly kind: 'blob';
  readonly path: string;
}

/**
 * Narrow a parsed payload to the legacy `blob`-with-`path` shape. The current
 * contract never writes `path` on a blob payload, so any hit is legacy data.
 * @internal
 */
function asBlobWithPath(payload: Record<string, unknown>): BlobWithPathPayload | null {
  if (payload['kind'] !== 'blob') return null;
  const path = payload['path'];
  if (typeof path !== 'string' || path.length === 0) return null;
  return { kind: 'blob', path };
}

/**
 * True when the row's content is retrievable from the content-addressed blob
 * store right now (primary file or a live keep-link). Read-only — safe in a
 * dry-run planning pass.
 * @internal
 */
function blobRowContentAlive(
  row: DoctorRow,
  payload: Record<string, unknown>,
  projectRoot: string,
): boolean {
  const mimeRaw = payload['mime'];
  const mime = typeof mimeRaw === 'string' ? mimeRaw : 'application/octet-stream';
  return blobContentExists(resolveCleoDir(projectRoot), row.sha256, mime);
}

/**
 * True when `absPath` points inside a worktree or temp directory:
 * the canonical CLEO worktrees root, a `.claude/worktrees/` agent spawn, or
 * the OS temp dir. Such paths are ephemeral — a `local-file` pointer into
 * them dangles as soon as the worktree is cleaned up.
 *
 * @internal
 */
function isWorktreeOrTmpPath(absPath: string): 'worktree' | 'tmp' | null {
  const worktreesRoot = getCleoWorktreesRoot();
  if (absPath === worktreesRoot || absPath.startsWith(`${worktreesRoot}${sep}`)) {
    return 'worktree';
  }
  if (absPath.includes(`${sep}.claude${sep}worktrees${sep}`)) return 'worktree';
  const tmp = tmpdir();
  if (absPath.startsWith(`${tmp}${sep}`) || absPath.startsWith(`${sep}tmp${sep}`)) return 'tmp';
  return null;
}

/**
 * Sum the audit-log revisions per slug. Mirrors the
 * `countVersionsForSlug` semantics in `docs-update.ts`: the expected
 * `docVersion` for a slug is `1 + total revisions`.
 *
 * @internal
 */
function readAuditRevisionCounts(projectRoot: string): Map<string, number> {
  const counts = new Map<string, number>();
  let raw: string;
  try {
    raw = readFileSync(join(projectRoot, DOCS_VERSIONING_AUDIT_FILE), 'utf-8');
  } catch {
    return counts;
  }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let entry: AuditLine;
    try {
      entry = JSON.parse(line) as AuditLine;
    } catch {
      continue;
    }
    if (entry.op !== 'docs.update' || typeof entry.slug !== 'string') continue;
    const revisions = Array.isArray(entry.revisions) ? entry.revisions.length : 0;
    counts.set(entry.slug, (counts.get(entry.slug) ?? 0) + revisions);
  }
  return counts;
}

/** True when a JSON-array TEXT column is NULL, empty, or `'[]'`. @internal */
function isEmptyJsonArray(raw: string | null): boolean {
  if (raw === null || raw.trim().length === 0) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/**
 * Refuse an apply run without a fresh backup receipt.
 *
 * @internal
 */
function checkBackupReceipt(
  receiptPath: string | undefined,
): { code: string; message: string } | null {
  if (receiptPath === undefined || receiptPath.length === 0) {
    return {
      // @sync-invariant none:input-shape a precondition refusal before any repair write; nothing was written
      code: 'E_DOCS_DOCTOR_BACKUP_REQUIRED',
      message:
        'docs doctor --apply requires a backup receipt created within the last ' +
        `${DOCS_DOCTOR_BACKUP_MAX_AGE_MS / 60000} minutes — run \`cleo backup add\` first ` +
        '(the CLI does this automatically)',
    };
  }
  let mtimeMs: number;
  try {
    mtimeMs = statSync(receiptPath).mtimeMs;
  } catch {
    return {
      // @sync-invariant none:input-shape a precondition refusal before any repair write; nothing was written
      code: 'E_DOCS_DOCTOR_BACKUP_REQUIRED',
      message: `backup receipt not found: ${receiptPath}`,
    };
  }
  if (Date.now() - mtimeMs > DOCS_DOCTOR_BACKUP_MAX_AGE_MS) {
    return {
      // @sync-invariant none:input-shape a precondition refusal before any repair write; nothing was written
      code: 'E_DOCS_DOCTOR_BACKUP_STALE',
      message:
        `backup receipt is older than ${DOCS_DOCTOR_BACKUP_MAX_AGE_MS / 60000} minutes: ` +
        `${receiptPath} — create a fresh backup (\`cleo backup add\`) before applying repairs`,
    };
  }
  return null;
}

/**
 * Fetch a row's decoded UTF-8 content when it is a scannable text doc.
 *
 * Blob rows read through the AttachmentStore; `llms-txt` rows carry inline
 * content. Returns null for binary kinds or unreadable blobs.
 *
 * @internal
 */
async function fetchRowContent(
  row: DoctorRow,
  payload: Record<string, unknown> | null,
  projectRoot: string,
): Promise<string | null> {
  if (!payload) return null;
  const kind = payload['kind'];
  if (kind === 'llms-txt') {
    const content = payload['content'];
    return typeof content === 'string' ? content : null;
  }
  if (kind !== 'blob') return null;
  const mime = payload['mime'];
  if (!isScannableTextMime(typeof mime === 'string' ? mime : undefined)) return null;
  const store = createAttachmentStore();
  try {
    const result = await store.get(row.sha256, projectRoot);
    return result ? result.bytes.toString('utf-8') : null;
  } catch {
    return null;
  }
}

/** One empty-provenance backfill candidate with its derived links. */
interface BackfillCandidate {
  readonly row: DoctorRow;
  readonly content: string;
  readonly labels: readonly string[] | undefined;
  readonly derived: DerivedDocLinks;
}

/** Inputs for the dangling-pointers repairs. */
interface DanglingScan {
  /** Rows whose missing local-file target gets archived. */
  readonly archivable: ReadonlyArray<{ row: DoctorRow; path: string }>;
  /** Blob rows with a stale legacy `path` whose content is alive in the store. */
  readonly clearable: ReadonlyArray<{
    row: DoctorRow;
    path: string;
    payload: Record<string, unknown>;
  }>;
}

/** Result of one full diagnostic scan over the current store state. */
interface DoctorScan {
  readonly diagnostics: DocsDoctorDiagnostic[];
  readonly dangling: DanglingScan;
  readonly skewed: ReadonlyArray<{ row: DoctorRow; expected: number }>;
  readonly backfillable: readonly BackfillCandidate[];
  /** Edges expected from the CURRENT columns but absent from docs_wikilinks. */
  readonly missingEdges: readonly WikilinkEdge[];
  /**
   * Whether an apply run must rebuild docs_wikilinks: either drift already
   * exists, or a provenance backfill will change the derived edge set (T13561).
   */
  readonly needsWikilinksRebuild: boolean;
}

/**
 * Scan the store and compute diagnostics + repair inputs in one pass.
 *
 * The function is pure with respect to the database — it is called twice on
 * an apply run (before repairs, to build the plan; after repairs, so the
 * report's diagnostics reflect POST-repair state, T13560).
 *
 * @internal
 */
async function scanStore(
  projectRoot: string,
  db: Awaited<ReturnType<typeof getDb>>,
  olderThanDays: number,
): Promise<DoctorScan> {
  const rows: readonly DoctorRow[] = await db.select().from(docsAttachments).all();
  const payloadById = new Map<string, Record<string, unknown> | null>();
  for (const row of rows) payloadById.set(row.id, parseAttachmentJson(row.attachmentJson));

  // ── dangling-pointers ──────────────────────────────────────────────────────
  const danglingItems: Record<string, unknown>[] = [];
  let danglingCount = 0;
  const archivable: Array<{ row: DoctorRow; path: string }> = [];
  const clearable: Array<{ row: DoctorRow; path: string; payload: Record<string, unknown> }> = [];
  for (const row of rows) {
    // Archived rows already had their repair — counting them again would make
    // the post-apply count unchanged (T13562a).
    if (row.lifecycleStatus === 'archived') continue;
    const payload = payloadById.get(row.id) ?? null;
    const localFile = payload === null ? null : asLocalFile(payload);
    const blobWithPath = payload === null ? null : asBlobWithPath(payload);
    const pointer = localFile ?? blobWithPath;
    if (!pointer) continue;
    const absPath = isAbsolute(pointer.path) ? pointer.path : resolve(projectRoot, pointer.path);
    const exists = existsSync(absPath);
    const ephemeral = isWorktreeOrTmpPath(absPath);
    if (exists && ephemeral === null) continue;
    danglingCount += 1;
    const reason = !exists ? 'missing' : (ephemeral ?? 'missing');
    if (localFile && !exists) {
      // A superseded doc keeps its status (docs.lifecycle.transitions, T12945):
      // it is reported dangling, never archived out of 'superseded'.
      if (row.lifecycleStatus !== 'superseded') archivable.push({ row, path: absPath });
    } else if (
      blobWithPath &&
      !exists &&
      payload !== null &&
      blobRowContentAlive(row, payload, projectRoot)
    ) {
      // The blob bytes are retrievable by sha256 — re-point the metadata at
      // the content-addressed store by clearing the stale path (T13562b).
      clearable.push({ row, path: absPath, payload });
    }
    if (danglingItems.length < DOCS_DOCTOR_MAX_DETAIL_ITEMS) {
      danglingItems.push({
        attachmentId: row.id,
        slug: row.slug,
        path: absPath,
        exists,
        reason,
        ...(blobWithPath ? { kind: 'blob' } : {}),
      });
    }
  }

  // ── doc-version-skew ───────────────────────────────────────────────────────
  const revisionCounts = readAuditRevisionCounts(projectRoot);
  const skewItems: Record<string, unknown>[] = [];
  let skewCount = 0;
  const skewed: Array<{ row: DoctorRow; expected: number }> = [];
  for (const row of rows) {
    if (row.slug === null) continue;
    const expected = (revisionCounts.get(row.slug) ?? 0) + 1;
    if (row.docVersion >= expected) continue;
    skewCount += 1;
    skewed.push({ row, expected });
    if (skewItems.length < DOCS_DOCTOR_MAX_DETAIL_ITEMS) {
      skewItems.push({
        attachmentId: row.id,
        slug: row.slug,
        docVersion: row.docVersion,
        expected,
      });
    }
  }

  // ── empty-provenance ───────────────────────────────────────────────────────
  const provItems: Record<string, unknown>[] = [];
  let provCount = 0;
  const backfillable: BackfillCandidate[] = [];
  for (const row of rows) {
    if (row.slug === null) continue;
    if (!isEmptyJsonArray(row.topics) || !isEmptyJsonArray(row.relatedTasks)) continue;
    const payload = payloadById.get(row.id) ?? null;
    const content = await fetchRowContent(row, payload, projectRoot);
    if (content === null) continue;
    const labelsRaw = payload?.['labels'];
    const labels = Array.isArray(labelsRaw)
      ? labelsRaw.filter((l): l is string => typeof l === 'string')
      : undefined;
    provCount += 1;
    backfillable.push({ row, content, labels, derived: deriveDocLinks(content, labels) });
    if (provItems.length < DOCS_DOCTOR_MAX_DETAIL_ITEMS) {
      provItems.push({ attachmentId: row.id, slug: row.slug });
    }
  }

  // ── wikilinks-drift ────────────────────────────────────────────────────────
  const slugById = new Map<string, string>();
  for (const row of rows) {
    if (row.slug !== null) slugById.set(row.id, row.slug);
  }
  const expectedEdges = deriveWikilinkEdges(
    rows
      .filter((r): r is DoctorRow & { slug: string } => r.slug !== null)
      .map((r) => ({
        slug: r.slug,
        supersedesSlug: r.supersedes ? (slugById.get(r.supersedes) ?? null) : null,
        supersededBySlug: r.supersededBy ? (slugById.get(r.supersededBy) ?? null) : null,
        relatedTasks: r.relatedTasks,
        topics: r.topics,
      })),
  );
  const existingEdges = await db
    .select({
      fromSlug: docsWikilinks.fromSlug,
      toSlug: docsWikilinks.toSlug,
      relation: docsWikilinks.relation,
    })
    .from(docsWikilinks)
    .all();
  const existingKeys = new Set(existingEdges.map((e) => `${e.fromSlug}|${e.toSlug}|${e.relation}`));
  const missingEdges = expectedEdges.filter(
    (e) => !existingKeys.has(`${e.fromSlug}|${e.toSlug}|${e.relation}`),
  );
  const driftItems = missingEdges
    .slice(0, DOCS_DOCTOR_MAX_DETAIL_ITEMS)
    .map((e) => ({ fromSlug: e.fromSlug, toSlug: e.toSlug, relation: e.relation }));

  // A backfill changes the topics/related_tasks columns, so the derived edge
  // set changes even when the pre-repair drift is zero — the rebuild must be
  // planned whenever a backfill will actually write columns (T13561).
  const backfillChangesLinks = backfillable.some(
    (b) => b.derived.topics.length + b.derived.relatedTasks.length > 0,
  );

  // ── legacy-store-present ───────────────────────────────────────────────────
  const legacyCandidates = [
    {
      path: join(projectRoot, '.cleo', 'attachments', 'index.db'),
      what: 'legacy attachment index',
    },
    {
      path: join(projectRoot, '.cleo', 'docs-publications.json'),
      what: 'publication ledger',
    },
    {
      path: join(projectRoot, '.cleo', 'attachments', 'sha256'),
      what: 'legacy fs blob store',
    },
  ];
  const legacyItems = legacyCandidates
    .filter((c) => existsSync(c.path))
    .map((c) => ({ path: c.path, what: c.what }));

  // ── stale-drafts ───────────────────────────────────────────────────────────
  const cutoffIso = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const staleRows = rows.filter(
    (r) => r.slug !== null && r.lifecycleStatus === 'draft' && r.createdAt < cutoffIso,
  );
  const staleItems = staleRows
    .slice(0, DOCS_DOCTOR_MAX_DETAIL_ITEMS)
    .map((r) => ({ attachmentId: r.id, slug: r.slug, createdAt: r.createdAt }));

  const diagnostics: DocsDoctorDiagnostic[] = [
    {
      kind: 'dangling-pointers',
      severity: 'warn',
      count: danglingCount,
      items: danglingItems,
      truncated: danglingCount > danglingItems.length,
    },
    {
      kind: 'doc-version-skew',
      severity: 'warn',
      count: skewCount,
      items: skewItems,
      truncated: skewCount > skewItems.length,
    },
    {
      kind: 'empty-provenance',
      severity: 'info',
      count: provCount,
      items: provItems,
      truncated: provCount > provItems.length,
    },
    {
      kind: 'wikilinks-drift',
      severity: 'warn',
      count: missingEdges.length,
      items: driftItems,
      truncated: missingEdges.length > driftItems.length,
    },
    {
      kind: 'legacy-store-present',
      severity: 'info',
      count: legacyItems.length,
      items: legacyItems,
      truncated: false,
    },
    {
      kind: 'stale-drafts',
      severity: 'info',
      count: staleRows.length,
      items: staleItems,
      truncated: staleRows.length > staleItems.length,
    },
  ];

  return {
    diagnostics,
    dangling: { archivable, clearable },
    skewed,
    backfillable,
    missingEdges,
    needsWikilinksRebuild: missingEdges.length > 0 || backfillChangesLinks,
  };
}

/**
 * Run the docs store health check.
 *
 * Dry run (default): every diagnostic is reported and every repair is
 * listed as a plan item with `applied: false` — nothing is written.
 * Apply: the backup gate runs first, then repairs execute in dependency
 * order (doc-version-skew, empty-provenance, dangling-pointers, and finally
 * the wikilinks rebuild, which re-derives from the freshly repaired columns).
 * On apply the report's diagnostics are re-scanned AFTER the repairs so the
 * envelope reflects POST-repair state and the summary counts match it
 * (T13560); a dry run reports the pre-repair state unchanged.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param opts - Apply flag, stale-draft threshold, backup receipt.
 * @returns The structured report, or a backup-gate refusal.
 * @task T13447
 */
// @sync-invariant docs.lifecycle.transitions the only lifecycle write is draft→archived for dangling rows, a legal matrix transition
export async function runDocsDoctor(
  projectRoot: string,
  opts: DocsDoctorOptions = {},
): Promise<RunDocsDoctorResult> {
  const apply = opts.apply === true;
  const olderThanDays = opts.olderThanDays ?? DOCS_DOCTOR_DEFAULT_OLDER_THAN_DAYS;

  if (apply) {
    const refusal = checkBackupReceipt(opts.backupReceiptPath);
    if (refusal) return { ok: false, error: refusal };
  }

  const db = await getDb(projectRoot);
  const pre = await scanStore(projectRoot, db, olderThanDays);

  const repairs: DocsDoctorRepairAction[] = [];
  for (const { row, path } of pre.dangling.archivable) {
    repairs.push({
      kind: 'dangling-pointers',
      action: 'archive-dangling',
      applied: apply,
      attachmentId: row.id,
      ...(row.slug !== null ? { slug: row.slug } : {}),
      detail: `marked-dangling: local-file target missing (${path}) → lifecycle_status = 'archived'`,
    });
  }
  for (const { row, path } of pre.dangling.clearable) {
    repairs.push({
      kind: 'dangling-pointers',
      action: 'clear-stale-path',
      applied: apply,
      attachmentId: row.id,
      ...(row.slug !== null ? { slug: row.slug } : {}),
      detail:
        `cleared stale legacy path (${path}) — content alive in the blob store ` +
        `(sha256 ${row.sha256.slice(0, 12)}…)`,
    });
  }
  for (const { row, expected } of pre.skewed) {
    repairs.push({
      kind: 'doc-version-skew',
      action: 'set-doc-version',
      applied: apply,
      attachmentId: row.id,
      ...(row.slug !== null ? { slug: row.slug } : {}),
      detail: `audit-note: docVersion ${row.docVersion} → ${expected} (audit log revisions + 1)`,
    });
  }
  for (const { row, derived } of pre.backfillable) {
    const derivedCount = derived.topics.length + derived.relatedTasks.length;
    repairs.push({
      kind: 'empty-provenance',
      action: 'backfill-provenance',
      applied: apply && derivedCount > 0,
      attachmentId: row.id,
      ...(row.slug !== null ? { slug: row.slug } : {}),
      detail:
        derivedCount > 0
          ? `derived topics=[${derived.topics.join(',')}] related_tasks=[${derived.relatedTasks.join(',')}]`
          : 'no derivable topics or task mentions — columns stay NULL',
    });
  }
  if (pre.needsWikilinksRebuild) {
    repairs.push({
      kind: 'wikilinks-drift',
      action: 'rebuild-wikilinks',
      applied: apply,
      detail:
        pre.missingEdges.length > 0
          ? `${pre.missingEdges.length} expected edge(s) absent from docs_wikilinks → full re-derivation`
          : 'provenance backfill changes derived edges → full re-derivation',
    });
  }

  // ── Apply repairs (backup gate already passed) ─────────────────────────────
  if (apply) {
    for (const { row, expected } of pre.skewed) {
      await db
        .update(docsAttachments)
        .set({ docVersion: expected })
        .where(eq(docsAttachments.id, row.id))
        .run();
    }
    for (const { row, derived } of pre.backfillable) {
      if (derived.topics.length + derived.relatedTasks.length === 0) continue;
      await db
        .update(docsAttachments)
        .set({
          topics: linksJsonOrNull(derived.topics),
          relatedTasks: linksJsonOrNull(derived.relatedTasks),
        })
        .where(eq(docsAttachments.id, row.id))
        .run();
    }
    for (const { row } of pre.dangling.archivable) {
      await db
        .update(docsAttachments)
        .set({ lifecycleStatus: 'archived' })
        .where(eq(docsAttachments.id, row.id))
        .run();
    }
    for (const { row, payload } of pre.dangling.clearable) {
      const cleaned: Record<string, unknown> = { ...payload };
      delete cleaned['path'];
      await db
        .update(docsAttachments)
        .set({ attachmentJson: JSON.stringify(cleaned) })
        .where(eq(docsAttachments.id, row.id))
        .run();
    }
    if (pre.needsWikilinksRebuild) {
      await rebuildDocsWikilinks({ projectRoot });
    }
  }

  // T13560: on apply, re-scan so the envelope's diagnostics (and the summary
  // computed from them) describe POST-repair state, consistent with a
  // follow-up dry run. Dry runs keep the pre-repair scan.
  const post = apply ? await scanStore(projectRoot, db, olderThanDays) : pre;
  const findings = post.diagnostics.reduce((sum, d) => sum + d.count, 0);
  const summary = apply
    ? `docs doctor applied ${repairs.filter((r) => r.applied).length} repair(s); ${findings} finding(s) remain post-repair`
    : `docs doctor found ${findings} finding(s); ${repairs.length} repair(s) planned (dry-run — pass --apply to execute)`;

  return {
    ok: true,
    report: {
      applied: apply,
      olderThanDays,
      backupReceiptPath: apply ? (opts.backupReceiptPath ?? null) : null,
      diagnostics: post.diagnostics,
      repairs,
      summary,
    },
  };
}
