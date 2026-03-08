/**
 * Pipeline Manifest SQLite Implementation
 *
 * Reimplements all 14 pipeline manifest operations using Drizzle ORM +
 * SQLite (tasks.db pipeline_manifest table) instead of JSONL file I/O.
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
import { and, count, desc, eq, gte, isNull, like, lte, or, type SQL } from 'drizzle-orm';
import type { EngineResult } from '../../dispatch/engines/_error.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { pipelineManifest } from '../../store/tasks-schema.js';
import { createPage } from '../pagination.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import {
  type ContradictionDetail,
  type ExtendedManifestEntry,
  filterManifestEntries,
  type ResearchFilter,
  type SupersededDetail,
} from './index.js';

// Re-export types for consumers that previously imported them from pipeline-manifest-compat
export type ManifestEntry = ExtendedManifestEntry;
export type { ResearchFilter, ContradictionDetail, SupersededDetail };
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

function buildManifestSqlFilters(filter: ResearchFilter): {
  conditions: SQL[];
  requiresInMemoryFiltering: boolean;
} {
  const conditions: SQL[] = [isNull(pipelineManifest.archivedAt)];

  if (filter.status) {
    const storedStatus = filter.status === 'completed' ? 'active' : filter.status;
    conditions.push(eq(pipelineManifest.status, storedStatus));
  }

  if (filter.agent_type) {
    conditions.push(eq(pipelineManifest.type, filter.agent_type));
  }

  if (filter.dateAfter) {
    conditions.push(gte(pipelineManifest.createdAt, `${filter.dateAfter} 00:00:00`));
  }

  if (filter.dateBefore) {
    conditions.push(lte(pipelineManifest.createdAt, `${filter.dateBefore} 23:59:59`));
  }

  return {
    conditions,
    requiresInMemoryFiltering:
      filter.taskId !== undefined || filter.topic !== undefined || filter.actionable !== undefined,
  };
}

function applyManifestMemoryOnlyFilters(
  entries: ExtendedManifestEntry[],
  filter: ResearchFilter,
): ExtendedManifestEntry[] {
  const inMemoryFilter: ResearchFilter = {
    taskId: filter.taskId,
    topic: filter.topic,
    actionable: filter.actionable,
  };

  return filterManifestEntries(entries, inMemoryFilter);
}

// ============================================================================
// Internal helpers
// ============================================================================

function now(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function computeContentHash(content: string): string {
  return createHash('sha256')
    .update(content || '')
    .digest('hex')
    .slice(0, 16);
}

/**
 * Convert a pipeline_manifest row back to ExtendedManifestEntry format
 * for backward-compatible output.
 */
function rowToEntry(row: typeof pipelineManifest.$inferSelect): ExtendedManifestEntry {
  let meta: Record<string, unknown> = {};
  if (row.metadataJson) {
    try {
      meta = JSON.parse(row.metadataJson) as Record<string, unknown>;
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    id: row.id,
    file: (meta['file'] as string) ?? row.sourceFile ?? '',
    title: (meta['title'] as string) ?? row.type,
    date: row.createdAt.slice(0, 10),
    status: (row.status === 'active' ? 'completed' : row.status) as ExtendedManifestEntry['status'],
    agent_type: row.type,
    topics: (meta['topics'] as string[]) ?? [],
    key_findings: (meta['key_findings'] as string[]) ?? [],
    actionable: (meta['actionable'] as boolean) ?? true,
    needs_followup: (meta['needs_followup'] as string[]) ?? [],
    linked_tasks: (meta['linked_tasks'] as string[]) ?? (row.taskId ? [row.taskId] : []),
    confidence: meta['confidence'] as number | undefined,
    file_checksum: meta['file_checksum'] as string | undefined,
    duration_seconds: meta['duration_seconds'] as number | undefined,
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

/** pipeline.manifest.show - Get manifest entry details by ID */
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
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(eq(pipelineManifest.id, researchId))
      .limit(1);

    if (rows.length === 0) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` },
      };
    }

    const entry = rowToEntry(rows[0]);
    const root = getProjectRoot(projectRoot);

    let fileContent: string | null = null;
    try {
      const filePath = join(root, entry.file);
      if (existsSync(filePath)) {
        fileContent = readFileSync(filePath, 'utf-8');
      }
    } catch {
      // File may not exist or be unreadable
    }

    return {
      success: true,
      data: { ...entry, fileContent, fileExists: fileContent !== null },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_SHOW',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.list - List manifest entries with filters */
export async function pipelineManifestList(
  params: PipelineManifestListParams,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const db = await getDb(projectRoot);
    const filter: ResearchFilter = { ...params };
    if (params.type) {
      filter.agent_type = params.type;
    }

    const limit = normalizeLimit(params.limit);
    const offset = normalizeOffset(params.offset);
    const pageLimit = effectivePageLimit(limit, offset);
    const { conditions, requiresInMemoryFiltering } = buildManifestSqlFilters(filter);
    const whereClause = and(...conditions);

    const totalRow = await db
      .select({ count: count() })
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt))
      .get();
    const total = totalRow?.count ?? 0;

    if (!requiresInMemoryFiltering) {
      const filteredRow = await db
        .select({ count: count() })
        .from(pipelineManifest)
        .where(whereClause)
        .get();
      const filtered = filteredRow?.count ?? 0;

      let query = db
        .select()
        .from(pipelineManifest)
        .where(whereClause)
        .orderBy(desc(pipelineManifest.createdAt));

      if (pageLimit !== undefined) {
        query = query.limit(pageLimit) as typeof query;
      }
      if (offset !== undefined) {
        query = query.offset(offset) as typeof query;
      }

      const rows = await query;

      return {
        success: true,
        data: { entries: rows.map(rowToEntry), total, filtered },
        page: createPage({ total: filtered, limit: pageLimit, offset }),
      };
    }

    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(whereClause)
      .orderBy(desc(pipelineManifest.createdAt));

    const filteredEntries = applyManifestMemoryOnlyFilters(rows.map(rowToEntry), filter);
    const filtered = filteredEntries.length;
    const start = offset ?? 0;
    const pagedEntries =
      pageLimit !== undefined
        ? filteredEntries.slice(start, start + pageLimit)
        : filteredEntries.slice(start);

    return {
      success: true,
      data: { entries: pagedEntries, total, filtered },
      page: createPage({ total: filtered, limit: pageLimit, offset }),
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_LIST',
        message: error instanceof Error ? error.message : String(error),
      },
    };
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
    const db = await getDb(projectRoot);
    const likePattern = `%${query}%`;

    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(
        and(
          isNull(pipelineManifest.archivedAt),
          or(like(pipelineManifest.content, likePattern), like(pipelineManifest.type, likePattern)),
        ),
      )
      .orderBy(desc(pipelineManifest.createdAt));

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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_FIND',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.pending - Get pending manifest items */
export async function pipelineManifestPending(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt))
      .orderBy(desc(pipelineManifest.createdAt));

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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_PENDING',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.stats - Manifest statistics */
export async function pipelineManifestStats(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt));

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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_STATS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.read - Read manifest entries with optional filter */
export async function pipelineManifestRead(
  filter?: ResearchFilter,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt))
      .orderBy(desc(pipelineManifest.createdAt));

    const entries = rows.map(rowToEntry);
    const filtered = filter ? filterManifestEntries(entries, filter) : entries;

    return {
      success: true,
      data: { entries: filtered, total: filtered.length, filter: filter || {} },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_READ',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.append - Append entry to pipeline_manifest table */
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
    const db = await getDb(projectRoot);
    const row = entryToRow(entry);

    await db
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
      });

    return { success: true, data: { appended: true, entryId: entry.id } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_APPEND',
        message: error instanceof Error ? error.message : String(error),
      },
    };
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
    const db = await getDb(projectRoot);
    const nativeDb = getNativeDb();

    if (!nativeDb) {
      return {
        success: false,
        error: { code: 'E_DB_NOT_INITIALIZED', message: 'Database not initialized' },
      };
    }

    // Find entries to archive (before date, not already archived)
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt));

    const toArchive = rows.filter((r) => r.createdAt.slice(0, 10) < beforeDate);

    if (toArchive.length === 0) {
      const remaining = rows.length;
      return {
        success: true,
        data: { archived: 0, remaining, message: 'No entries found before the specified date' },
      };
    }

    const archivedAt = now();
    for (const row of toArchive) {
      await db.update(pipelineManifest).set({ archivedAt }).where(eq(pipelineManifest.id, row.id));
    }

    const remaining = rows.length - toArchive.length;
    return { success: true, data: { archived: toArchive.length, remaining } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_ARCHIVE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.compact - Dedup by contentHash (keep newest by createdAt) */
export async function pipelineManifestCompact(projectRoot?: string): Promise<EngineResult> {
  try {
    const db = await getDb(projectRoot);

    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt))
      .orderBy(desc(pipelineManifest.createdAt));

    const originalCount = rows.length;
    if (originalCount === 0) {
      return { success: true, data: { compacted: false, message: 'No entries found' } };
    }

    // Dedup by contentHash — keep newest (first seen due to DESC order)
    const seenHashes = new Set<string>();
    const seenIds = new Set<string>();
    const toDelete: string[] = [];

    for (const row of rows) {
      const hash = row.contentHash ?? computeContentHash(row.content);
      if (seenHashes.has(hash) || seenIds.has(row.id)) {
        toDelete.push(row.id);
      } else {
        seenHashes.add(hash);
        seenIds.add(row.id);
      }
    }

    for (const id of toDelete) {
      await db.delete(pipelineManifest).where(eq(pipelineManifest.id, id));
    }

    return {
      success: true,
      data: {
        compacted: true,
        originalLines: originalCount,
        malformedRemoved: 0,
        duplicatesRemoved: toDelete.length,
        remainingEntries: originalCount - toDelete.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_COMPACT_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.validate - Validate manifest entries for a task */
export async function pipelineManifestValidate(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const db = await getDb(projectRoot);
    const root = getProjectRoot(projectRoot);

    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt));

    const entries = rows.map(rowToEntry);
    const linked = entries.filter(
      (e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId),
    );

    if (linked.length === 0) {
      return {
        success: true,
        data: {
          taskId,
          valid: true,
          entriesFound: 0,
          message: `No research entries found for task ${taskId}`,
          issues: [],
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
        const filePath = join(root, entry.file);
        if (!existsSync(filePath)) {
          issues.push({
            entryId: entry.id,
            issue: `Output file not found: ${entry.file}`,
            severity: 'warning',
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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_VALIDATE',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.contradictions - Find entries with overlapping topics but conflicting key_findings */
export async function pipelineManifestContradictions(
  projectRoot?: string,
  params?: { topic?: string },
): Promise<EngineResult<{ contradictions: ContradictionDetail[] }>> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt));

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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_CONTRADICTIONS',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** pipeline.manifest.superseded - Identify entries replaced by newer work on same topic */
export async function pipelineManifestSuperseded(
  projectRoot?: string,
  params?: { topic?: string },
): Promise<EngineResult<{ superseded: SupersededDetail[] }>> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt));

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
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_SUPERSEDED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
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
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(eq(pipelineManifest.id, researchId))
      .limit(1);

    if (rows.length === 0) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` },
      };
    }

    const row = rows[0];
    const entry = rowToEntry(row);

    if (entry.linked_tasks?.includes(taskId)) {
      return { success: true, data: { taskId, researchId, linked: true, alreadyLinked: true } };
    }

    // Update linked_tasks in metadataJson
    const updatedLinkedTasks = [...(entry.linked_tasks ?? []), taskId];
    let meta: Record<string, unknown> = {};
    try {
      meta = row.metadataJson ? (JSON.parse(row.metadataJson) as Record<string, unknown>) : {};
    } catch {
      // ignore
    }
    meta['linked_tasks'] = updatedLinkedTasks;

    await db
      .update(pipelineManifest)
      .set({
        taskId: row.taskId ?? taskId,
        metadataJson: JSON.stringify(meta),
      })
      .where(eq(pipelineManifest.id, researchId));

    return { success: true, data: { taskId, researchId, linked: true, notes: notes || null } };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_MANIFEST_LINK',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

// ============================================================================
// Helper exported for compat consumers
// ============================================================================

/**
 * Read all manifest entries from the pipeline_manifest table.
 * Replaces readManifestEntries() from pipeline-manifest-compat.
 */
export async function readManifestEntries(projectRoot?: string): Promise<ExtendedManifestEntry[]> {
  try {
    const db = await getDb(projectRoot);
    const rows = await db
      .select()
      .from(pipelineManifest)
      .where(isNull(pipelineManifest.archivedAt))
      .orderBy(desc(pipelineManifest.createdAt));
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
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
  const root = getProjectRoot(projectRoot);
  const manifestPath = join(getCleoDirAbsolute(root), 'MANIFEST.jsonl');

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

  const db = await getDb(projectRoot);

  let migrated = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.id) {
      skipped++;
      continue;
    }

    // Check if already exists
    const existing = await db
      .select({ id: pipelineManifest.id })
      .from(pipelineManifest)
      .where(eq(pipelineManifest.id, entry.id))
      .limit(1);

    if (existing.length > 0) {
      skipped++;
      continue;
    }

    try {
      const row = entryToRow(entry);
      await db.insert(pipelineManifest).values(row);
      migrated++;
    } catch {
      skipped++;
    }
  }

  // Rename MANIFEST.jsonl to MANIFEST.jsonl.migrated
  try {
    renameSync(manifestPath, manifestPath + '.migrated');
  } catch {
    // Non-fatal — file may already be renamed or locked
  }

  return { migrated, skipped };
}
