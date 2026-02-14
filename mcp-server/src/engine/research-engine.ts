/**
 * Research Engine
 *
 * Native TypeScript implementation of research domain operations.
 * Reads/writes MANIFEST.jsonl and RCSD data directly without CLI subprocess.
 *
 * Supports: show, list, query/search, pending, stats, manifest.read,
 *           link, manifest.append, manifest.archive
 *
 * @task T4474
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { resolveProjectRoot, readJsonFile, writeJsonFileAtomic, getDataPath } from './store.js';

/**
 * Manifest entry as stored in MANIFEST.jsonl
 */
export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'complete' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings?: string[];
  actionable: boolean;
  needs_followup?: string[];
  linked_tasks?: string[];
  confidence?: number;
  file_checksum?: string;
  duration_seconds?: number;
}

/**
 * Research filter criteria
 */
export interface ResearchFilter {
  taskId?: string;
  status?: string;
  agent_type?: string;
  topic?: string;
  limit?: number;
  actionable?: boolean;
  dateAfter?: string;
  dateBefore?: string;
}

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Get the manifest file path
 */
function getManifestPath(projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return resolve(root, 'claudedocs/agent-outputs/MANIFEST.jsonl');
}

/**
 * Get the manifest archive path
 */
function getManifestArchivePath(projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return resolve(root, 'claudedocs/agent-outputs/MANIFEST.archive.jsonl');
}

/**
 * Read all manifest entries from MANIFEST.jsonl
 */
export function readManifestEntries(projectRoot?: string): ManifestEntry[] {
  const manifestPath = getManifestPath(projectRoot);

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const entries: ManifestEntry[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        entries.push(JSON.parse(trimmed) as ManifestEntry);
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

/**
 * Filter manifest entries by criteria
 */
export function filterEntries(entries: ManifestEntry[], filter: ResearchFilter): ManifestEntry[] {
  let filtered = entries;

  if (filter.taskId) {
    const taskId = filter.taskId;
    filtered = filtered.filter(
      (e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId)
    );
  }

  if (filter.status) {
    filtered = filtered.filter((e) => e.status === filter.status);
  }

  if (filter.agent_type) {
    filtered = filtered.filter((e) => e.agent_type === filter.agent_type);
  }

  if (filter.topic) {
    filtered = filtered.filter((e) => e.topics.includes(filter.topic!));
  }

  if (filter.actionable !== undefined) {
    filtered = filtered.filter((e) => e.actionable === filter.actionable);
  }

  if (filter.dateAfter) {
    filtered = filtered.filter((e) => e.date > filter.dateAfter!);
  }

  if (filter.dateBefore) {
    filtered = filtered.filter((e) => e.date < filter.dateBefore!);
  }

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

/**
 * research.show - Get research entry details by ID
 * @task T4474
 */
export function researchShow(
  researchId: string,
  projectRoot?: string
): EngineResult {
  if (!researchId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'researchId is required' } };
  }

  const entries = readManifestEntries(projectRoot);
  const entry = entries.find((e) => e.id === researchId);

  if (!entry) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Research entry '${researchId}' not found`,
      },
    };
  }

  // Try to read the output file content
  const root = projectRoot || resolveProjectRoot();
  let fileContent: string | null = null;
  try {
    const filePath = resolve(root, entry.file);
    if (existsSync(filePath)) {
      fileContent = readFileSync(filePath, 'utf-8');
    }
  } catch {
    // File may not exist or be unreadable
  }

  return {
    success: true,
    data: {
      ...entry,
      fileContent,
      fileExists: fileContent !== null,
    },
  };
}

/**
 * research.list - List research entries with filters
 * @task T4474
 */
export function researchList(
  params: ResearchFilter & { type?: string },
  projectRoot?: string
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  const filter: ResearchFilter = { ...params };
  if (params.type) {
    filter.agent_type = params.type;
  }

  const filtered = filterEntries(entries, filter);

  return {
    success: true,
    data: {
      entries: filtered,
      total: filtered.length,
    },
  };
}

/**
 * research.query / research.search - Search research entries by text
 * @task T4474
 */
export function researchQuery(
  query: string,
  options?: { confidence?: number; limit?: number },
  projectRoot?: string
): EngineResult {
  if (!query) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'query is required' } };
  }

  const entries = readManifestEntries(projectRoot);
  const queryLower = query.toLowerCase();

  // Score each entry based on text match relevance
  const scored = entries.map((entry) => {
    let score = 0;

    // Title match (highest weight)
    if (entry.title.toLowerCase().includes(queryLower)) {
      score += 0.5;
    }

    // Topic match
    if (entry.topics.some((t) => t.toLowerCase().includes(queryLower))) {
      score += 0.3;
    }

    // Key findings match
    if (entry.key_findings?.some((f) => f.toLowerCase().includes(queryLower))) {
      score += 0.2;
    }

    // ID match
    if (entry.id.toLowerCase().includes(queryLower)) {
      score += 0.1;
    }

    return { entry, score };
  });

  // Filter by minimum confidence
  const minConfidence = options?.confidence ?? 0.1;
  let results = scored
    .filter((s) => s.score >= minConfidence)
    .sort((a, b) => b.score - a.score);

  // Apply limit
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
}

/**
 * research.pending - Get pending research items
 * @task T4474
 */
export function researchPending(
  epicId?: string,
  projectRoot?: string
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  // Find entries that need followup or are partial/blocked
  let pending = entries.filter(
    (e) =>
      e.status === 'partial' ||
      e.status === 'blocked' ||
      (e.needs_followup && e.needs_followup.length > 0)
  );

  // Filter by epic if provided
  if (epicId) {
    pending = pending.filter(
      (e) => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId)
    );
  }

  return {
    success: true,
    data: {
      entries: pending,
      total: pending.length,
      byStatus: {
        partial: pending.filter((e) => e.status === 'partial').length,
        blocked: pending.filter((e) => e.status === 'blocked').length,
        needsFollowup: pending.filter(
          (e) => e.needs_followup && e.needs_followup.length > 0
        ).length,
      },
    },
  };
}

/**
 * research.stats - Research statistics
 * @task T4474
 */
export function researchStats(
  epicId?: string,
  projectRoot?: string
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  let filtered = entries;
  if (epicId) {
    filtered = entries.filter(
      (e) => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId)
    );
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
        filtered.length > 0
          ? Math.round((totalFindings / filtered.length) * 10) / 10
          : 0,
    },
  };
}

/**
 * research.manifest.read - Read manifest entries with optional filter
 * @task T4474
 */
export function researchManifestRead(
  filter?: ResearchFilter,
  projectRoot?: string
): EngineResult {
  const entries = readManifestEntries(projectRoot);
  const filtered = filter ? filterEntries(entries, filter) : entries;

  return {
    success: true,
    data: {
      entries: filtered,
      total: filtered.length,
      filter: filter || {},
    },
  };
}

/**
 * research.link - Link research entry to a task
 * Updates the manifest entry's linked_tasks array
 * @task T4474
 */
export function researchLink(
  taskId: string,
  researchId: string,
  notes?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId || !researchId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and researchId are required' },
    };
  }

  const root = projectRoot || resolveProjectRoot();
  const manifestPath = getManifestPath(root);
  const entries = readManifestEntries(root);

  const entryIndex = entries.findIndex((e) => e.id === researchId);
  if (entryIndex === -1) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` },
    };
  }

  const entry = entries[entryIndex];

  // Check if already linked
  if (entry.linked_tasks?.includes(taskId)) {
    return {
      success: true,
      data: {
        taskId,
        researchId,
        linked: true,
        alreadyLinked: true,
      },
    };
  }

  // Add task to linked_tasks
  if (!entry.linked_tasks) {
    entry.linked_tasks = [];
  }
  entry.linked_tasks.push(taskId);

  // Rewrite the entire manifest
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(manifestPath, content, 'utf-8');

  return {
    success: true,
    data: {
      taskId,
      researchId,
      linked: true,
      notes: notes || null,
    },
  };
}

/**
 * research.manifest.append - Append entry to MANIFEST.jsonl
 * @task T4474
 */
export function researchManifestAppend(
  entry: ManifestEntry,
  projectRoot?: string
): EngineResult {
  if (!entry) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'entry is required' },
    };
  }

  // Validate required fields
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
      error: { code: 'E_VALIDATION_FAILED', message: `Invalid manifest entry: ${errors.join(', ')}` },
    };
  }

  const manifestPath = getManifestPath(projectRoot);
  const dir = dirname(manifestPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const serialized = JSON.stringify(entry);
  appendFileSync(manifestPath, serialized + '\n', 'utf-8');

  return {
    success: true,
    data: {
      appended: true,
      entryId: entry.id,
      file: 'claudedocs/agent-outputs/MANIFEST.jsonl',
    },
  };
}

/**
 * research.manifest.archive - Archive old manifest entries
 * @task T4474
 */
export function researchManifestArchive(
  beforeDate: string,
  projectRoot?: string
): EngineResult {
  if (!beforeDate) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'beforeDate is required (ISO-8601 format: YYYY-MM-DD)' },
    };
  }

  const root = projectRoot || resolveProjectRoot();
  const manifestPath = getManifestPath(root);
  const archivePath = getManifestArchivePath(root);
  const entries = readManifestEntries(root);

  const toArchive = entries.filter((e) => e.date < beforeDate);
  const toKeep = entries.filter((e) => e.date >= beforeDate);

  if (toArchive.length === 0) {
    return {
      success: true,
      data: {
        archived: 0,
        remaining: entries.length,
        message: 'No entries found before the specified date',
      },
    };
  }

  // Append archived entries to archive file
  const archiveDir = dirname(archivePath);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  const archiveContent = toArchive.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(archivePath, archiveContent, 'utf-8');

  // Rewrite main manifest with remaining entries
  const remainingContent = toKeep.length > 0
    ? toKeep.map((e) => JSON.stringify(e)).join('\n') + '\n'
    : '';
  writeFileSync(manifestPath, remainingContent, 'utf-8');

  return {
    success: true,
    data: {
      archived: toArchive.length,
      remaining: toKeep.length,
      archiveFile: 'claudedocs/agent-outputs/MANIFEST.archive.jsonl',
    },
  };
}
