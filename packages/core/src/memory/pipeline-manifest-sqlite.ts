/**
 * Pipeline Manifest SQLite Implementation
 *
 * Reimplements all 14 pipeline manifest operations using Drizzle ORM +
 * Canonical docs_pipeline_manifest writes and provenance-aware legacy history reads.
 *
 * Provides a one-time migration function to import existing MANIFEST.jsonl
 * entries into the new table.
 *
 * @task T5581
 * @epic T5576
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ManifestWithProvenance } from '@cleocode/contracts/operations/research';
import { eq, like, or } from 'drizzle-orm';
import { z } from 'zod';
import { createDocsReadModel } from '../docs/docs-read-model.js';
import { type EngineFailure, type EngineResult, EngineResultError } from '../engine-result.js';
import { captureProjectScope, worktreeScope } from '../project-scope.js';
import { docsPipelineManifest as pipelineManifest } from '../store/schema/cleo-project/docs.js';
import { pipelineManifest as legacyManifest } from '../store/schema/manifest.js';

function manifestScope(cwd?: string) {
  return captureProjectScope(cwd ?? getProjectRoot(), worktreeScope.getStore());
}

async function getBinding(cwd?: string) {
  const scope = manifestScope(cwd);
  const { bindTasksDomain } = await import('../store/sqlite.js');
  return worktreeScope.run(scope, () => bindTasksDomain(scope.worktreeRoot));
}

import { createPage } from '../pagination.js';
import { getProjectRoot, resolveCleoDir } from '../paths.js';
import type {
  ContradictionDetail,
  ExtendedManifestEntry,
  ResearchFilter,
  SupersededDetail,
} from './index.js';
import { filterManifestEntries } from './manifest-filter.js';

// Re-export types for consumers that previously imported them from pipeline-manifest-compat
export type ManifestEntry = ExtendedManifestEntry;
export type { ContradictionDetail, ResearchFilter, SupersededDetail };
export { filterManifestEntries };

interface PipelineManifestListParams extends ResearchFilter {
  type?: string;
  offset?: number;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return typeof limit === 'number' && limit > 0 ? limit : undefined;
}

function normalizeOffset(offset: number | undefined): number | undefined {
  return typeof offset === 'number' && offset > 0 ? offset : undefined;
}

function effectivePageLimit(
  limit: number | undefined,
  offset: number | undefined,
): number | undefined {
  return limit ?? (offset !== undefined ? 50 : undefined);
}

// ============================================================================
// Internal helpers
// ============================================================================

function readStoredRows(
  binding: Awaited<ReturnType<typeof getBinding>>,
  includeArchived = false,
  id?: string,
): Array<ManifestWithProvenance<typeof pipelineManifest.$inferSelect>> {
  const { db, store } = binding;
  const modern = db
    .select()
    .from(pipelineManifest)
    .where(id ? eq(pipelineManifest.id, id) : undefined)
    .all();
  const legacy = db
    .select()
    .from(legacyManifest)
    .where(id ? eq(legacyManifest.id, id) : undefined)
    .all();
  const rows = new Map<string, ManifestWithProvenance<typeof pipelineManifest.$inferSelect>>();
  for (const [table, sourceRows] of [
    [pipelineManifest, modern],
    [legacyManifest, legacy],
  ] as const) {
    const tableName = table === pipelineManifest ? 'docs_pipeline_manifest' : 'pipeline_manifest';
    for (const row of sourceRows) {
      const existing = rows.get(row.id);
      if (existing) {
        const { provenance, ...stored } = existing;
        // Compare every persisted scalar, including raw content/metadata bytes and archival state.
        // A short content hash or the lossy public projection cannot establish equality.
        if (!isDeepStrictEqual(stored, row)) {
          throw new EngineResultError({
            code: 'E_MANIFEST_ID_CONFLICT',
            message: `Manifest '${row.id}' has conflicting stored payloads; inspect both sources before repair.`,
            details: {
              entryId: row.id,
              databasePath: store.dbPath,
              candidates: [
                {
                  table: provenance.tables[0],
                  payload: stored,
                  sha256: createHash('sha256').update(JSON.stringify(stored)).digest('hex'),
                },
                {
                  table: tableName,
                  payload: row,
                  sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex'),
                },
              ],
            },
          });
        }
        provenance.tables.push(tableName);
      } else {
        rows.set(row.id, {
          ...row,
          provenance: { databasePath: store.dbPath, tables: [tableName] },
        });
      }
    }
  }
  return [...rows.values()]
    .filter((row) => includeArchived || row.archivedAt === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

async function readRows(projectRoot?: string, includeArchived = false, id?: string) {
  const binding = await getBinding(projectRoot);
  return binding.db.transaction(() => readStoredRows(binding, includeArchived, id));
}

function requireModernRows(
  rows: Array<ManifestWithProvenance<typeof pipelineManifest.$inferSelect>>,
): void {
  const legacy = rows.filter((row) => row.provenance.tables.includes('pipeline_manifest'));
  if (legacy.length) {
    throw new EngineResultError({
      code: 'E_MANIFEST_LEGACY_REPAIR_REQUIRED',
      message: 'Legacy manifest evidence requires an explicit guarded repair before mutation.',
      details: { entries: legacy.map((row) => ({ entryId: row.id, provenance: row.provenance })) },
    });
  }
}

function manifestFailure(code: string, error: Error): EngineFailure {
  if (error instanceof EngineResultError) {
    return {
      success: false,
      error: { code: error.code, message: error.message, details: error.details },
    };
  }
  const causes: string[] = [];
  const seen = new Set<Error>();
  let cause = error;
  while (!seen.has(cause)) {
    seen.add(cause);
    causes.push(cause.message);
    if (!(cause.cause instanceof Error)) break;
    cause = cause.cause;
  }
  return { success: false, error: { code, message: causes.join(' → ') } };
}

/**
 * Insert authentic prepared manifest rows in one guarded project transaction.
 *
 * @remarks
 * Preserves caller handle ownership and both storage histories. Identical complete
 * payloads are idempotent; differing identities and legacy rows never authorize
 * replacement. Any batch failure rolls back all inserted rows.
 * @param rows - Complete persisted payloads, including raw content and metadata.
 * @param projectRoot - Explicit project identity captured before asynchronous binding.
 * @param expectedDb - Caller-owned canonical task-domain handle for this project.
 * @returns Number of newly inserted rows; identical stored rows are skipped.
 * @throws If database identity, historical evidence, or any transactional write fails.
 * @example
 * ```ts
 * const inserted = await insertManifestRows(preparedRows, projectRoot, db);
 * ```
 */
export async function insertManifestRows(
  rows: ReadonlyArray<typeof pipelineManifest.$inferSelect>,
  projectRoot: string,
  expectedDb: Awaited<ReturnType<typeof getBinding>>['db'],
): Promise<number> {
  try {
    const binding = await getBinding(projectRoot);
    if (expectedDb !== binding.db) {
      throw new EngineResultError({
        code: 'E_MANIFEST_DATABASE_MISMATCH',
        message:
          'Supplied database is not the captured canonical project binding; ownership is unverified.',
        details: { databasePath: binding.store.dbPath },
      });
    }
    return binding.db.transaction(
      () => {
        let inserted = 0;
        for (const row of rows) {
          const existing = readStoredRows(binding, true, row.id);
          requireModernRows(existing);
          if (existing[0]) {
            const { provenance, ...stored } = existing[0];
            if (!isDeepStrictEqual(stored, row)) {
              throw new EngineResultError({
                code: 'E_MANIFEST_ID_CONFLICT',
                message: `Manifest '${row.id}' differs from the supplied payload; explicit repair is required.`,
                details: { entryId: row.id, provenance, stored, incoming: row },
              });
            }
            continue;
          }
          binding.db.insert(pipelineManifest).values(row).run();
          inserted++;
        }
        return inserted;
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    throw new EngineResultError(
      manifestFailure(
        'E_MANIFEST_INGEST',
        error instanceof Error ? error : new Error(String(error)),
      ).error,
    );
  }
}

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function computeContentHash(content: string): string {
  return createHash('sha256')
    .update(content || '')
    .digest('hex')
    .slice(0, 16);
}

/** Validate only fields projected by the canonical reader; retain other provenance. */
const manifestMetadataSchema = z.looseObject({
  file: z.string().optional(),
  title: z.string().optional(),
  topics: z.array(z.string()).optional(),
  key_findings: z.array(z.string()).optional(),
  actionable: z.boolean().optional(),
  needs_followup: z.array(z.string()).optional(),
  linked_tasks: z.array(z.string()).optional(),
  confidence: z.number().optional(),
  file_checksum: z.string().optional(),
  duration_seconds: z.number().optional(),
});

function readRowMetadata(row: ManifestWithProvenance<typeof pipelineManifest.$inferSelect>) {
  const details = {
    entryId: row.id,
    tables: row.provenance.tables,
    metadataSha256: createHash('sha256')
      .update(row.metadataJson ?? '')
      .digest('hex'),
  };
  let parsed: ReturnType<typeof manifestMetadataSchema.safeParse>;
  try {
    parsed = manifestMetadataSchema.safeParse(
      row.metadataJson === null ? {} : JSON.parse(row.metadataJson),
    );
  } catch (error) {
    throw new EngineResultError({
      code: 'E_MANIFEST_METADATA_INVALID',
      message: `Manifest '${row.id}' metadata is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      details: { ...details, field: 'metadata_json' },
    });
  }
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'metadata_json',
      message: issue.message,
    }));
    throw new EngineResultError({
      code: 'E_MANIFEST_METADATA_INVALID',
      message: `Manifest '${row.id}' metadata violates the stored field contract`,
      details: { ...details, field: issues[0]?.field ?? 'metadata_json', issues },
    });
  }
  return parsed.data;
}

/**
 * Convert a validated canonical or historical row without rewriting stored bytes.
 */
function rowToEntry(
  row: ManifestWithProvenance<typeof pipelineManifest.$inferSelect>,
): ManifestWithProvenance<ExtendedManifestEntry> {
  const meta = readRowMetadata(row);
  return {
    id: row.id,
    provenance: row.provenance,
    file: meta.file ?? row.sourceFile ?? '',
    title: meta.title ?? row.type,
    date: row.createdAt.slice(0, 10),
    status: (row.status === 'active' ? 'completed' : row.status) as ExtendedManifestEntry['status'],
    agent_type: row.type,
    topics: meta.topics ?? [],
    key_findings: meta.key_findings ?? [],
    actionable: meta.actionable ?? true,
    needs_followup: meta.needs_followup ?? [],
    linked_tasks: meta.linked_tasks ?? (row.taskId ? [row.taskId] : []),
    confidence: meta.confidence,
    file_checksum: meta.file_checksum,
    duration_seconds: meta.duration_seconds,
  };
}

/**
 * Convert an ExtendedManifestEntry to a pipeline_manifest row for insertion.
 */
function entryToRow(entry: ExtendedManifestEntry): typeof pipelineManifest.$inferInsert {
  const serializedContent = JSON.stringify(entry);
  const contentHash = computeContentHash(serializedContent);

  // Extract the first linked task (primary association)
  const primaryTaskId = entry.linked_tasks?.[0] ?? null;

  // Store full entry in metadataJson for round-trip fidelity
  const metadataJson = JSON.stringify({
    file: entry.file,
    title: entry.title,
    topics: entry.topics ?? [],
    key_findings: entry.key_findings ?? [],
    actionable: entry.actionable,
    needs_followup: entry.needs_followup ?? [],
    linked_tasks: entry.linked_tasks ?? [],
    confidence: entry.confidence,
    file_checksum: entry.file_checksum,
    duration_seconds: entry.duration_seconds,
  });

  // Normalize status: completed → active for storage
  let storedStatus: string = entry.status;
  if (storedStatus === 'completed') storedStatus = 'active';

  return {
    id: entry.id,
    taskId: primaryTaskId,
    type: entry.agent_type,
    content: serializedContent,
    contentHash,
    status: storedStatus,
    distilled: false,
    sourceFile: entry.file || null,
    metadataJson,
    createdAt: entry.date + ' 00:00:00',
    archivedAt: null,
  };
}

// ============================================================================
// EngineResult-wrapped functions
// ============================================================================

/**
 * Retrieve a manifest and resolve its local file or canonical document reference.
 *
 * @remarks
 * Supports `cleo://docs/<reference>` where the single percent-encoded segment is
 * a document slug, attachment ID, or SHA-256 accepted by the canonical docs read
 * model. URI syntax establishes no authority. Unsupported URIs and failed reads
 * are explicit failures; missing ordinary files retain `fileExists: false`.
 * @param researchId - Exact manifest identity, including historical entries.
 * @param projectRoot - Explicit project directory used for both manifest and docs.
 * @returns Manifest provenance and content, or a structured resolution failure.
 * @example
 * ```ts
 * const result = await pipelineManifestShow('T001-report', '/project');
 * ```
 */
export async function pipelineManifestShow(
  researchId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!researchId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'researchId is required' },
    };
  }

  try {
    const scope = manifestScope(projectRoot);
    const rows = await readRows(scope.worktreeRoot, true, researchId);

    if (rows.length === 0) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` },
      };
    }

    const entry = rowToEntry(rows[0]);
    let fileContent: string | null = null;
    if (/^[a-z][a-z\d+.-]*:/i.test(entry.file) && !/^[a-z]:[\\/]/i.test(entry.file)) {
      const details = { entryId: researchId, reference: entry.file };
      if (!entry.file.startsWith('cleo://docs/')) {
        throw new EngineResultError({
          code: 'E_MANIFEST_REFERENCE_UNSUPPORTED',
          message:
            'Only cleo://docs/<reference> document URIs are supported; no network lookup was attempted.',
          details,
        });
      }
      const encoded = entry.file.slice('cleo://docs/'.length);
      let reference: string;
      try {
        reference = decodeURIComponent(encoded);
      } catch {
        throw new EngineResultError({
          code: 'E_MANIFEST_REFERENCE_INVALID',
          message: 'Document reference contains invalid percent encoding.',
          details,
        });
      }
      if (
        !reference ||
        reference === '.' ||
        reference === '..' ||
        /[/\\?#\s\x00-\x1f]/.test(reference)
      ) {
        throw new EngineResultError({
          code: 'E_MANIFEST_REFERENCE_INVALID',
          message:
            'Document URI requires one nonempty reference without path, query, or fragment components.',
          details,
        });
      }
      fileContent = await worktreeScope.run(scope, async () => {
        const model = createDocsReadModel(scope.worktreeRoot);
        const doc =
          (await model.resolveLatest(reference)) ?? (await model.resolveByAttachmentId(reference));
        if (!doc) {
          throw new EngineResultError({
            code: 'E_MANIFEST_DOC_NOT_FOUND',
            message: 'Document reference was not found in the selected project.',
            details,
          });
        }
        const content = await model.fetchContent(doc);
        if (content === null) {
          throw new EngineResultError({
            code: 'E_MANIFEST_DOC_CONTENT_UNAVAILABLE',
            message: 'Document metadata resolved but its content is unavailable.',
            details: { ...details, attachmentId: doc.id, sha256: doc.sha256 },
          });
        }
        return content;
      });
    } else if (entry.file) {
      try {
        fileContent = readFileSync(join(scope.worktreeRoot, entry.file), 'utf-8');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }

    return {
      success: true,
      data: { ...entry, fileContent, fileExists: fileContent !== null },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_SHOW',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.list - List manifest entries with filters */
export async function pipelineManifestList(
  params: PipelineManifestListParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const entries = (await readRows(projectRoot)).map(rowToEntry);
    const limit = normalizeLimit(params.limit);
    const offset = normalizeOffset(params.offset);
    const pageLimit = effectivePageLimit(limit, offset);
    const filtered = filterManifestEntries(entries, {
      ...params,
      agent_type: params.type ?? params.agent_type,
      limit: undefined,
      offset: undefined,
    });
    const start = offset ?? 0;
    return {
      success: true,
      data: {
        entries: filtered.slice(start, pageLimit === undefined ? undefined : start + pageLimit),
        total: entries.length,
        filtered: filtered.length,
      },
      page: createPage({ total: filtered.length, limit: pageLimit, offset }),
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_LIST',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.find - Find manifest entries by text (LIKE search on content + type) */
export async function pipelineManifestFind(
  query: string,
  options?: { confidence?: number; limit?: number },
  projectRoot?: string,
): Promise<EngineResult> {
  if (!query) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'query is required' } };
  }

  try {
    const binding = await getBinding(projectRoot);
    const rows = binding.db.transaction(() => {
      const merged = readStoredRows(binding);
      const ids = new Set(
        [
          ...binding.db
            .select({ id: pipelineManifest.id })
            .from(pipelineManifest)
            .where(
              or(
                like(pipelineManifest.content, `%${query}%`),
                like(pipelineManifest.type, `%${query}%`),
              ),
            )
            .all(),
          ...binding.db
            .select({ id: legacyManifest.id })
            .from(legacyManifest)
            .where(
              or(
                like(legacyManifest.content, `%${query}%`),
                like(legacyManifest.type, `%${query}%`),
              ),
            )
            .all(),
        ].map((row) => row.id),
      );
      return merged.filter((row) => ids.has(row.id));
    });

    const queryLower = query.toLowerCase();
    const entries = rows.map(rowToEntry);

    const scored = entries.map((entry) => {
      let score = 0;
      if (entry.title.toLowerCase().includes(queryLower)) score += 0.5;
      if (entry.topics.some((t) => t.toLowerCase().includes(queryLower))) score += 0.3;
      if (entry.key_findings?.some((f) => f.toLowerCase().includes(queryLower))) score += 0.2;
      if (entry.id.toLowerCase().includes(queryLower)) score += 0.1;
      return { entry, score };
    });

    const minConfidence = options?.confidence ?? 0.1;
    let results = scored.filter((s) => s.score >= minConfidence).sort((a, b) => b.score - a.score);

    if (options?.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return {
      success: true,
      data: {
        query,
        results: results.map((r) => ({
          ...r.entry,
          relevanceScore: Math.round(r.score * 100) / 100,
        })),
        total: results.length,
      },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_FIND',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.pending - Get pending manifest items */
export async function pipelineManifestPending(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const rows = await readRows(projectRoot);

    const entries = rows.map(rowToEntry);

    let pending = entries.filter(
      (e) =>
        e.status === 'partial' ||
        e.status === 'blocked' ||
        (e.needs_followup && e.needs_followup.length > 0),
    );

    if (epicId) {
      pending = pending.filter((e) => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId));
    }

    return {
      success: true,
      data: {
        entries: pending,
        total: pending.length,
        byStatus: {
          partial: pending.filter((e) => e.status === 'partial').length,
          blocked: pending.filter((e) => e.status === 'blocked').length,
          needsFollowup: pending.filter((e) => e.needs_followup && e.needs_followup.length > 0)
            .length,
        },
      },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_PENDING',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.stats - Manifest statistics */
export async function pipelineManifestStats(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const rows = await readRows(projectRoot);

    const entries = rows.map(rowToEntry);

    let filtered = entries;
    if (epicId) {
      filtered = entries.filter((e) => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId));
    }

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    let actionable = 0;
    let needsFollowup = 0;
    let totalFindings = 0;

    for (const entry of filtered) {
      byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
      byType[entry.agent_type] = (byType[entry.agent_type] || 0) + 1;
      if (entry.actionable) actionable++;
      if (entry.needs_followup && entry.needs_followup.length > 0) needsFollowup++;
      if (entry.key_findings) totalFindings += entry.key_findings.length;
    }

    return {
      success: true,
      data: {
        total: filtered.length,
        byStatus,
        byType,
        actionable,
        needsFollowup,
        averageFindings:
          filtered.length > 0 ? Math.round((totalFindings / filtered.length) * 10) / 10 : 0,
      },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_STATS',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.read - Read manifest entries with optional filter */
export async function pipelineManifestRead(
  filter?: ResearchFilter,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const rows = await readRows(projectRoot);

    const entries = rows.map(rowToEntry);
    const filtered = filter ? filterManifestEntries(entries, filter) : entries;

    return {
      success: true,
      data: { entries: filtered, total: filtered.length, filter: filter || {} },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_READ',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** Append to canonical manifest storage after checking both histories for unresolved identities. */
export async function pipelineManifestAppend(
  entry: ExtendedManifestEntry,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!entry) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'entry is required' } };
  }

  const errors: string[] = [];
  if (!entry.id) errors.push('id is required');
  if (!entry.file) errors.push('file is required');
  if (!entry.title) errors.push('title is required');
  if (!entry.date) errors.push('date is required');
  if (!entry.status) errors.push('status is required');
  if (!entry.agent_type) errors.push('agent_type is required');
  if (!entry.topics) errors.push('topics is required');
  if (entry.actionable === undefined) errors.push('actionable is required');

  if (errors.length > 0) {
    return {
      success: false,
      error: {
        code: 'E_VALIDATION_FAILED',
        message: `Invalid manifest entry: ${errors.join(', ')}`,
      },
    };
  }

  try {
    const binding = await getBinding(projectRoot);
    const row = entryToRow(entry);
    binding.db.transaction(
      () => {
        requireModernRows(readStoredRows(binding, true, entry.id));
        binding.db
          .insert(pipelineManifest)
          .values(row)
          .onConflictDoUpdate({
            target: pipelineManifest.id,
            set: {
              content: row.content,
              contentHash: row.contentHash,
              status: row.status,
              metadataJson: row.metadataJson,
              sourceFile: row.sourceFile,
              taskId: row.taskId,
            },
          })
          .run();
      },
      { behavior: 'immediate' },
    );

    return { success: true, data: { appended: true, entryId: entry.id } };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_APPEND',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.archive - Archive old manifest entries by date */
export async function pipelineManifestArchive(
  beforeDate: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!beforeDate) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'beforeDate is required (ISO-8601 format: YYYY-MM-DD)',
      },
    };
  }

  try {
    const binding = await getBinding(projectRoot);
    return binding.db.transaction(
      () => {
        const rows = readStoredRows(binding);
        const toArchive = rows.filter((row) => row.createdAt.slice(0, 10) < beforeDate);
        requireModernRows(toArchive);
        const archivedAt = now();
        for (const row of toArchive) {
          binding.db
            .update(pipelineManifest)
            .set({ archivedAt })
            .where(eq(pipelineManifest.id, row.id))
            .run();
        }
        return {
          success: true,
          data: { archived: toArchive.length, remaining: rows.length - toArchive.length },
        };
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_ARCHIVE',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.compact - Dedup by contentHash (keep newest by createdAt) */
export async function pipelineManifestCompact(projectRoot?: string): Promise<EngineResult> {
  try {
    const binding = await getBinding(projectRoot);
    return binding.db.transaction(
      () => {
        const rows = readStoredRows(binding);
        requireModernRows(rows);
        if (!rows.length)
          return { success: true, data: { compacted: false, message: 'No entries found' } };
        // Hashes can collide; only the full stored content establishes duplicate payloads.
        const seen = new Set<string>();
        const toDelete: string[] = [];
        for (const row of rows) {
          if (seen.has(row.content)) toDelete.push(row.id);
          else seen.add(row.content);
        }
        for (const id of toDelete)
          binding.db.delete(pipelineManifest).where(eq(pipelineManifest.id, id)).run();
        return {
          success: true,
          data: {
            compacted: true,
            originalLines: rows.length,
            malformedRemoved: 0,
            duplicatesRemoved: toDelete.length,
            remainingEntries: rows.length - toDelete.length,
          },
        };
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    return manifestFailure(
      'E_COMPACT_FAILED',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/**
 * Validate available manifest evidence explicitly linked to one task.
 *
 * @remarks
 * This exported SDK helper is not a registered CLI operation. Selection uses
 * exact linked-task membership; manifest ID wording establishes no ownership.
 * Absent evidence, missing output, and blank output invalidate the assessment.
 * Canonical document/read failures retain their structured diagnostics. Content
 * availability does not establish implementation, testing, review, or authority.
 * @param taskId - Exact task identity whose linked evidence is assessed.
 * @param projectRoot - Project captured before any asynchronous store access.
 * @returns Field and content assessment, or a structured diagnostic failure.
 * @example
 * ```ts
 * const result = await pipelineManifestValidate('T001', '/project');
 * ```
 */
export async function pipelineManifestValidate(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const root = manifestScope(projectRoot).worktreeRoot;
    const entries = await readManifestEntries(root);
    const linked = entries.filter((entry) => entry.linked_tasks?.includes(taskId));

    if (linked.length === 0) {
      return {
        success: true,
        data: {
          taskId,
          valid: false,
          entriesFound: 0,
          message: `No research entries found for task ${taskId}`,
          issues: [
            { entryId: taskId, issue: 'No explicitly linked evidence found', severity: 'error' },
          ],
          errorCount: 1,
          warningCount: 0,
        },
      };
    }

    const issues: Array<{ entryId: string; issue: string; severity: 'error' | 'warning' }> = [];

    for (const entry of linked) {
      if (!entry.id)
        issues.push({ entryId: entry.id || '(unknown)', issue: 'Missing id', severity: 'error' });
      if (!entry.file)
        issues.push({ entryId: entry.id, issue: 'Missing file path', severity: 'error' });
      if (!entry.title)
        issues.push({ entryId: entry.id, issue: 'Missing title', severity: 'error' });
      if (!entry.date) issues.push({ entryId: entry.id, issue: 'Missing date', severity: 'error' });
      if (!entry.status)
        issues.push({ entryId: entry.id, issue: 'Missing status', severity: 'error' });
      if (!entry.agent_type)
        issues.push({ entryId: entry.id, issue: 'Missing agent_type', severity: 'error' });

      if (entry.status && !['completed', 'partial', 'blocked'].includes(entry.status)) {
        issues.push({
          entryId: entry.id,
          issue: `Invalid status: ${entry.status}`,
          severity: 'error',
        });
      }

      if (entry.file) {
        const output = await pipelineManifestShow(entry.id, root);
        if (!output.success) return output;
        const data = output.data;
        if (
          !data ||
          typeof data !== 'object' ||
          !('fileExists' in data) ||
          typeof data.fileExists !== 'boolean' ||
          !('fileContent' in data) ||
          (data.fileExists ? typeof data.fileContent !== 'string' : data.fileContent !== null)
        ) {
          throw new EngineResultError({
            code: 'E_MANIFEST_RESULT_INVALID',
            message: 'Canonical manifest show did not disclose consistent output availability',
            details: { entryId: entry.id },
          });
        }
        if (!data.fileExists) {
          issues.push({
            entryId: entry.id,
            issue: `Output file not found: ${entry.file}`,
            severity: 'error',
          });
        } else if (typeof data.fileContent === 'string' && data.fileContent.trim().length === 0) {
          issues.push({
            entryId: entry.id,
            issue: `Output content is empty: ${entry.file}`,
            severity: 'error',
          });
        }
      }

      if (
        entry.agent_type === 'research' &&
        (!entry.key_findings || entry.key_findings.length === 0)
      ) {
        issues.push({
          entryId: entry.id,
          issue: 'Research entry missing key_findings',
          severity: 'warning',
        });
      }
    }

    return {
      success: true,
      data: {
        taskId,
        valid: issues.filter((i) => i.severity === 'error').length === 0,
        entriesFound: linked.length,
        issues,
        errorCount: issues.filter((i) => i.severity === 'error').length,
        warningCount: issues.filter((i) => i.severity === 'warning').length,
      },
    };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_VALIDATE',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.contradictions - Find entries with overlapping topics but conflicting key_findings */
export async function pipelineManifestContradictions(
  projectRoot?: string,
  params?: { topic?: string },
): Promise<EngineResult<{ contradictions: ContradictionDetail[] }>> {
  try {
    const rows = await readRows(projectRoot);

    const entries = rows.map(rowToEntry);

    // In-memory negation pattern matching (same logic as compat layer)
    const byTopic = new Map<string, ExtendedManifestEntry[]>();
    for (const entry of entries) {
      if (!entry.key_findings || entry.key_findings.length === 0) continue;
      for (const topic of entry.topics) {
        if (params?.topic && topic !== params.topic) continue;
        if (!byTopic.has(topic)) byTopic.set(topic, []);
        byTopic.get(topic)!.push(entry);
      }
    }

    const negationPairs: Array<[RegExp, RegExp]> = [
      [/\bdoes NOT\b/i, /\bdoes\b(?!.*\bnot\b)/i],
      [/\bcannot\b/i, /\bcan\b(?!.*\bnot\b)/i],
      [/\bno\s+\w+\s+required\b/i, /\brequired\b(?!.*\bno\b)/i],
      [
        /\bnot\s+(?:available|supported|possible|recommended)\b/i,
        /\b(?:available|supported|possible|recommended)\b(?!.*\bnot\b)/i,
      ],
      [/\bwithout\b/i, /\brequires?\b/i],
      [/\bavoid\b/i, /\buse\b/i],
      [/\bdeprecated\b/i, /\brecommended\b/i],
      [/\banti-pattern\b/i, /\bbest practice\b/i],
    ];

    const contradictions: ContradictionDetail[] = [];

    for (const [topic, topicEntries] of byTopic) {
      if (topicEntries.length < 2) continue;

      for (let i = 0; i < topicEntries.length; i++) {
        for (let j = i + 1; j < topicEntries.length; j++) {
          const a = topicEntries[i];
          const b = topicEntries[j];
          const conflicts: string[] = [];

          for (const findingA of a.key_findings!) {
            for (const findingB of b.key_findings!) {
              for (const [patternNeg, patternPos] of negationPairs) {
                if (
                  (patternNeg.test(findingA) && patternPos.test(findingB)) ||
                  (patternPos.test(findingA) && patternNeg.test(findingB))
                ) {
                  conflicts.push(`"${findingA}" vs "${findingB}"`);
                  break;
                }
              }
            }
          }

          if (conflicts.length > 0) {
            contradictions.push({
              entryA: a,
              entryB: b,
              topic,
              conflictDetails: conflicts.join('; '),
            });
          }
        }
      }
    }

    return { success: true, data: { contradictions } };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_CONTRADICTIONS',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.superseded - Identify entries replaced by newer work on same topic */
export async function pipelineManifestSuperseded(
  projectRoot?: string,
  params?: { topic?: string },
): Promise<EngineResult<{ superseded: SupersededDetail[] }>> {
  try {
    const rows = await readRows(projectRoot);

    const entries = rows.map(rowToEntry);

    const byTopicAndType = new Map<string, ExtendedManifestEntry[]>();
    for (const entry of entries) {
      for (const topic of entry.topics) {
        if (params?.topic && topic !== params.topic) continue;
        const key = `${topic}::${entry.agent_type}`;
        if (!byTopicAndType.has(key)) byTopicAndType.set(key, []);
        byTopicAndType.get(key)!.push(entry);
      }
    }

    const superseded: SupersededDetail[] = [];
    const seenPairs = new Set<string>();

    for (const [key, groupEntries] of byTopicAndType) {
      if (groupEntries.length < 2) continue;

      const topic = key.split('::')[0];
      const sorted = [...groupEntries].sort((a, b) => a.date.localeCompare(b.date));

      for (let i = 0; i < sorted.length - 1; i++) {
        const pairKey = `${sorted[i].id}::${sorted[sorted.length - 1].id}::${topic}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        superseded.push({ old: sorted[i], replacement: sorted[sorted.length - 1], topic });
      }
    }

    return { success: true, data: { superseded } };
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_SUPERSEDED',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** pipeline.manifest.link - Link manifest entry to a task */
export async function pipelineManifestLink(
  taskId: string,
  researchId: string,
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !researchId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and researchId are required' },
    };
  }

  try {
    const binding = await getBinding(projectRoot);
    return binding.db.transaction(
      () => {
        const rows = readStoredRows(binding, true, researchId);
        if (!rows.length)
          throw new EngineResultError({
            code: 'E_NOT_FOUND',
            message: `Research entry '${researchId}' not found`,
          });
        requireModernRows(rows);
        const row = rows[0];
        const entry = rowToEntry(row);

        if (entry.linked_tasks?.includes(taskId)) {
          return { success: true, data: { taskId, researchId, linked: true, alreadyLinked: true } };
        }

        // Update linked_tasks in metadataJson
        const updatedLinkedTasks = [...(entry.linked_tasks ?? []), taskId];
        const meta = readRowMetadata(row);
        meta['linked_tasks'] = updatedLinkedTasks;

        binding.db
          .update(pipelineManifest)
          .set({
            taskId: row.taskId ?? taskId,
            metadataJson: JSON.stringify(meta),
          })
          .where(eq(pipelineManifest.id, researchId))
          .run();

        return { success: true, data: { taskId, researchId, linked: true, notes: notes || null } };
      },
      { behavior: 'immediate' },
    );
  } catch (error) {
    return manifestFailure(
      'E_MANIFEST_LINK',
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

// ============================================================================
// Helper exported for compat consumers
// ============================================================================

/**
 * Read unarchived entries from both manifest histories with physical provenance.
 * @param projectRoot - Explicit project root; takes priority over ambient project pins.
 * @returns Entries retaining the existing fields and observed source tables/database path.
 * @throws EngineResultError when the same identity has conflicting persisted payloads.
 * @throws Error when storage reads fail; failure is never represented as an empty history.
 * @remarks Identical rows are deduplicated only after comparing every stored scalar.
 * Legacy-only evidence remains readable and is never implicitly migrated or rewritten.
 * @example
 * ```ts
 * const entries = await readManifestEntries('/project');
 * const sources = entries.map((entry) => entry.provenance.tables);
 * ```
 */
export async function readManifestEntries(
  projectRoot?: string,
): Promise<Array<ManifestWithProvenance<ExtendedManifestEntry>>> {
  return (await readRows(projectRoot)).map(rowToEntry);
}

/**
 * Filter manifest entries by criteria (alias for backward compatibility).
 */
export function filterEntries(
  entries: ExtendedManifestEntry[],
  filter: ResearchFilter,
): ExtendedManifestEntry[] {
  return filterManifestEntries(entries, filter);
}

// ============================================================================
// Distillation stub (Phase 3)
// ============================================================================

/**
 * Distill a manifest entry to brain.db observation (Phase 3, pending).
 */
export async function distillManifestEntry(
  _entryId: string,
  _projectRoot?: string,
): Promise<EngineResult> {
  return { success: true, data: { skipped: true, reason: 'distillation_pending_phase3' } };
}

// ============================================================================
// One-time migration: MANIFEST.jsonl → SQLite
// ============================================================================

/**
 * Migrate existing .cleo/MANIFEST.jsonl entries into the pipeline_manifest table.
 * Skips entries that already exist (by id). Renames MANIFEST.jsonl to
 * MANIFEST.jsonl.migrated when done.
 *
 * @returns Count of migrated and skipped entries.
 */
export async function migrateManifestJsonlToSqlite(
  projectRoot?: string,
): Promise<{ migrated: number; skipped: number }> {
  const root = manifestScope(projectRoot).worktreeRoot;
  const manifestPath = join(resolveCleoDir(root), 'MANIFEST.jsonl');

  if (!existsSync(manifestPath)) {
    return { migrated: 0, skipped: 0 };
  }

  const content = readFileSync(manifestPath, 'utf-8');
  const lines = content.split('\n');

  const entries: ExtendedManifestEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ExtendedManifestEntry);
    } catch {
      // skip malformed lines
    }
  }

  if (entries.length === 0) {
    return { migrated: 0, skipped: 0 };
  }

  const binding = await getBinding(projectRoot);
  const db = binding.db;

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.id) {
      skipped++;
      continue;
    }

    const inserted = db.transaction(
      () => {
        const existing = readStoredRows(binding, true, entry.id);
        requireModernRows(existing);
        if (existing.length) return false;
        db.insert(pipelineManifest).values(entryToRow(entry)).run();
        return true;
      },
      { behavior: 'immediate' },
    );
    if (inserted) migrated++;
    else skipped++;
  }

  // Rename MANIFEST.jsonl to MANIFEST.jsonl.migrated
  try {
    renameSync(manifestPath, manifestPath + '.migrated');
  } catch {
    // Non-fatal — file may already be renamed or locked
  }

  return { migrated, skipped };
}
