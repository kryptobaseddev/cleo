/**
 * Research commands and manifest operations.
 *
 * @packageDocumentation
 * @task T4465
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import {
  getBackupDir,
  getManifestPath as getCentralManifestPath,
  getCleoDirAbsolute,
  getManifestArchivePath,
  getProjectRoot,
} from '../paths.js';
import { atomicWrite, safeReadFile } from '../store/atomic.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { appendJsonl, readJson, saveJson } from '../store/json.js';
import { logOperation } from '../tasks/add.js';

/** Research entry attached to a task. */
export interface ResearchEntry {
  /** Unique research entry identifier. */
  id: string;
  /** Task ID this research is linked to. */
  taskId: string;
  /** Research topic or question. */
  topic: string;
  /** Accumulated research findings. */
  findings: string[];
  /** Source URLs or references. */
  sources: string[];
  /** Current research status. */
  status: 'pending' | 'complete' | 'partial';
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of last update. */
  updatedAt: string;
}

/** Manifest entry (JSONL line). */
export interface ManifestEntry {
  /** Unique manifest entry identifier. */
  id: string;
  /** Output file path for this entry. */
  file: string;
  /** Human-readable title of the research output. */
  title: string;
  /** ISO date string when the entry was created. */
  date: string;
  /** Completion status of the research. */
  status: 'completed' | 'partial' | 'blocked';
  /** Type of agent that produced this entry. */
  agent_type: string;
  /** Topic tags associated with the entry. */
  topics: string[];
  /** Key findings from the research. */
  key_findings: string[];
  /** Whether the findings are actionable. */
  actionable: boolean;
  /** Items that need follow-up investigation. */
  needs_followup: string[];
  /** Task IDs linked to this manifest entry. */
  linked_tasks: string[];
}

/** Options for adding research. */
export interface AddResearchOptions {
  /** Task ID to attach the research to. */
  taskId: string;
  /** Research topic or question. */
  topic: string;
  /** Initial findings (if any). */
  findings?: string[];
  /** Source URLs or references. */
  sources?: string[];
}

/** Options for listing research. */
export interface ListResearchOptions {
  /** Filter by linked task ID. */
  taskId?: string;
  /** Filter by research status. */
  status?: 'pending' | 'complete' | 'partial';
}

/** Manifest query options. */
export interface ManifestQueryOptions {
  /** Filter by completion status. */
  status?: string;
  /** Filter by agent type. */
  agentType?: string;
  /** Filter by topic tag. */
  topic?: string;
  /** Filter by linked task ID. */
  taskId?: string;
  /** Maximum entries to return. */
  limit?: number;
}

/**
 * Get the research file path.
 * @task T4465
 */
function getResearchPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'research.json');
}

/**
 * Get the manifest file path.
 * @task T4465
 */
function getManifestPath(cwd?: string): string {
  return getCentralManifestPath(cwd);
}

/**
 * Read or initialize the research file.
 * @task T4465
 */
async function readResearch(cwd?: string): Promise<{ entries: ResearchEntry[] }> {
  const path = getResearchPath(cwd);
  const data = await readJson<{ entries: ResearchEntry[] }>(path);
  return data ?? { entries: [] };
}

/**
 * Add a research entry.
 *
 * @param options - Research entry data including taskId and topic
 * @param cwd - Optional working directory for path resolution
 * @param accessor - Data accessor for task validation
 * @returns The created ResearchEntry
 *
 * @remarks
 * Validates the linked task exists, generates a unique ID, and persists
 * the entry to research.json. Logs the operation to the audit log.
 *
 * @example
 * ```typescript
 * const entry = await addResearch({ taskId: 'T042', topic: 'Auth patterns' }, '/project', accessor);
 * ```
 *
 * @task T4465
 */
export async function addResearch(
  options: AddResearchOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<ResearchEntry> {
  // Validate task exists
  const task = await accessor!.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`);
  }

  if (!options.topic || options.topic.trim().length === 0) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Research topic is required');
  }

  const research = await readResearch(cwd);
  const now = new Date().toISOString();

  const entry: ResearchEntry = {
    id: `R${Date.now().toString(36)}`,
    taskId: options.taskId,
    topic: options.topic.trim(),
    findings: options.findings ?? [],
    sources: options.sources ?? [],
    status: (options.findings?.length ?? 0) > 0 ? 'complete' : 'pending',
    createdAt: now,
    updatedAt: now,
  };

  research.entries.push(entry);

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });
  await logOperation(
    'research_added',
    entry.id,
    {
      taskId: options.taskId,
      topic: options.topic,
    },
    accessor,
  );

  return entry;
}

/**
 * Show a specific research entry.
 *
 * @param researchId - The research entry ID to look up
 * @param cwd - Optional working directory for path resolution
 * @returns The matching ResearchEntry
 *
 * @remarks
 * Throws a CleoError with NOT_FOUND if the entry does not exist.
 *
 * @example
 * ```typescript
 * const entry = await showResearch('Rlk1abc2', '/project');
 * ```
 *
 * @task T4465
 */
export async function showResearch(researchId: string, cwd?: string): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find((e) => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  return entry;
}

/**
 * List research entries with optional filtering.
 *
 * @param options - Optional filters for taskId and status
 * @param cwd - Optional working directory for path resolution
 * @returns Filtered array of ResearchEntry records
 *
 * @remarks
 * Returns all entries when no filters are provided.
 *
 * @example
 * ```typescript
 * const entries = await listResearch({ status: 'pending' }, '/project');
 * ```
 *
 * @task T4465
 */
export async function listResearch(
  options: ListResearchOptions = {},
  cwd?: string,
): Promise<ResearchEntry[]> {
  const research = await readResearch(cwd);
  let entries = research.entries;

  if (options.taskId) {
    entries = entries.filter((e) => e.taskId === options.taskId);
  }
  if (options.status) {
    entries = entries.filter((e) => e.status === options.status);
  }

  return entries;
}

/**
 * List pending research entries.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Array of research entries with status "pending"
 *
 * @remarks
 * Convenience wrapper around listResearch with status filter pre-set.
 *
 * @example
 * ```typescript
 * const pending = await pendingResearch('/project');
 * ```
 *
 * @task T4465
 */
export async function pendingResearch(cwd?: string): Promise<ResearchEntry[]> {
  return listResearch({ status: 'pending' }, cwd);
}

/**
 * Link a research entry to a task.
 *
 * @param researchId - The research entry ID to link
 * @param taskId - The target task ID
 * @param cwd - Optional working directory for path resolution
 * @param accessor - Data accessor for task validation
 * @returns Confirmation with researchId and taskId
 *
 * @remarks
 * Updates the research entry's taskId field and persists the change.
 * Validates both the research entry and target task exist.
 *
 * @example
 * ```typescript
 * await linkResearch('Rlk1abc2', 'T050', '/project', accessor);
 * ```
 *
 * @task T4465
 */
export async function linkResearch(
  researchId: string,
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ researchId: string; taskId: string }> {
  const research = await readResearch(cwd);
  const entry = research.entries.find((e) => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  // Validate task exists
  const linkedTask = await accessor!.loadSingleTask(taskId);
  if (!linkedTask) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  entry.taskId = taskId;
  entry.updatedAt = new Date().toISOString();

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });

  return { researchId, taskId };
}

/**
 * Update research findings.
 *
 * @param researchId - The research entry ID to update
 * @param updates - Fields to update (findings, sources, and/or status)
 * @param cwd - Optional working directory for path resolution
 * @returns The updated ResearchEntry
 *
 * @remarks
 * Only provided fields are updated; others are left unchanged.
 * Updates the `updatedAt` timestamp automatically.
 *
 * @example
 * ```typescript
 * const entry = await updateResearch('Rlk1abc2', { status: 'complete', findings: ['JWT is used'] });
 * ```
 *
 * @task T4465
 */
export async function updateResearch(
  researchId: string,
  updates: { findings?: string[]; sources?: string[]; status?: 'pending' | 'complete' | 'partial' },
  cwd?: string,
): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find((e) => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  if (updates.findings) entry.findings = updates.findings;
  if (updates.sources) entry.sources = updates.sources;
  if (updates.status) entry.status = updates.status;
  entry.updatedAt = new Date().toISOString();

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });

  return entry;
}

/**
 * Get research statistics.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Total count and breakdowns by status and topic
 *
 * @remarks
 * Aggregates all research entries into status and topic distributions.
 *
 * @example
 * ```typescript
 * const stats = await statsResearch('/project');
 * console.log(`${stats.total} entries, ${stats.byStatus.pending ?? 0} pending`);
 * ```
 *
 * @task T4474
 */
export async function statsResearch(cwd?: string): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byTopic: Record<string, number>;
}> {
  const research = await readResearch(cwd);
  const byStatus: Record<string, number> = {};
  const byTopic: Record<string, number> = {};

  for (const entry of research.entries) {
    byStatus[entry.status] = (byStatus[entry.status] || 0) + 1;
    byTopic[entry.topic] = (byTopic[entry.topic] || 0) + 1;
  }

  return {
    total: research.entries.length,
    byStatus,
    byTopic,
  };
}

/**
 * Get research entries linked to a specific task.
 *
 * @param taskId - The task ID to find linked research for
 * @param cwd - Optional working directory for path resolution
 * @returns Array of research entries linked to the given task
 *
 * @remarks
 * Filters research entries by taskId. Throws if taskId is empty.
 *
 * @example
 * ```typescript
 * const linked = await linksResearch('T042', '/project');
 * ```
 *
 * @task T4474
 */
export async function linksResearch(taskId: string, cwd?: string): Promise<ResearchEntry[]> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }
  const research = await readResearch(cwd);
  return research.entries.filter((e) => e.taskId === taskId);
}

/**
 * Archive old research entries by status.
 * Moves 'complete' entries to an archive and keeps non-complete ones.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Summary with count of archived and remaining entries
 *
 * @remarks
 * Removes all "complete" entries from the active research file and reports
 * how many were archived vs. retained.
 *
 * @example
 * ```typescript
 * const result = await archiveResearch('/project');
 * console.log(`Archived ${result.entriesArchived} entries`);
 * ```
 *
 * @task T4474
 */
export async function archiveResearch(cwd?: string): Promise<{
  action: string;
  entriesArchived: number;
  entriesRemaining: number;
}> {
  const research = await readResearch(cwd);
  const completed = research.entries.filter((e) => e.status === 'complete');
  const remaining = research.entries.filter((e) => e.status !== 'complete');

  // Write back only non-complete entries
  await saveJson(getResearchPath(cwd), { entries: remaining }, { backupDir: getBackupDir(cwd) });

  return {
    action: 'archive',
    entriesArchived: completed.length,
    entriesRemaining: remaining.length,
  };
}

// === MANIFEST OPERATIONS ===

/**
 * Read manifest entries from the legacy agent-outputs flat-file (deprecated).
 * @deprecated Use `cleo manifest list` — reads from pipeline_manifest SQLite table per ADR-027.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Array of parsed ManifestEntry records from the JSONL file
 *
 * @remarks
 * Reads the file line by line, skipping blank and malformed lines.
 * Returns an empty array if the file does not exist.
 *
 * @example
 * ```typescript
 * const entries = await readManifest('/project');
 * ```
 *
 * @task T4465
 */
export async function readManifest(cwd?: string): Promise<ManifestEntry[]> {
  const manifestPath = getManifestPath(cwd);
  const content = await safeReadFile(manifestPath);
  if (!content) return [];

  const entries: ManifestEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ManifestEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Append a manifest entry.
 *
 * @param entry - The ManifestEntry to append
 * @param cwd - Optional working directory for path resolution
 *
 * @remarks
 * Appends a single JSON line to the legacy agent-outputs flat-file (deprecated).
 * @deprecated Use `cleo manifest append` — writes to pipeline_manifest SQLite table per ADR-027.
 *
 * @example
 * ```typescript
 * await appendManifest({ id: 'M001', file: 'report.md', ... }, '/project');
 * ```
 *
 * @task T4465
 */
export async function appendManifest(entry: ManifestEntry, cwd?: string): Promise<void> {
  const manifestPath = getManifestPath(cwd);
  await appendJsonl(manifestPath, entry);
}

/**
 * Query manifest entries with filtering.
 *
 * @param options - Filter criteria (status, agentType, topic, taskId, limit)
 * @param cwd - Optional working directory for path resolution
 * @returns Filtered array of ManifestEntry records
 *
 * @remarks
 * Applies filters sequentially: status, agentType, topic, taskId, then limit.
 * Returns all entries when no filters are provided.
 *
 * @example
 * ```typescript
 * const entries = await queryManifest({ status: 'completed', limit: 5 }, '/project');
 * ```
 *
 * @task T4465
 */
export async function queryManifest(
  options: ManifestQueryOptions = {},
  cwd?: string,
): Promise<ManifestEntry[]> {
  let entries = await readManifest(cwd);

  if (options.status) {
    entries = entries.filter((e) => e.status === options.status);
  }
  if (options.agentType) {
    entries = entries.filter((e) => e.agent_type === options.agentType);
  }
  if (options.topic) {
    entries = entries.filter((e) => e.topics.includes(options.topic!));
  }
  if (options.taskId) {
    entries = entries.filter((e) => e.linked_tasks.includes(options.taskId!));
  }
  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

// ============================================================================
// Engine-compatible manifest operations (extended fields)
// These are used by the dispatch engine layer for research domain support.
// ============================================================================

/** Extended manifest entry with optional fields used by the engine. */
export interface ExtendedManifestEntry extends ManifestEntry {
  /** Confidence score for the research findings. */
  confidence?: number;
  /** SHA checksum of the output file. */
  file_checksum?: string;
  /** Duration of the research in seconds. */
  duration_seconds?: number;
}

/** Research filter criteria used by the engine. */
export interface ResearchFilter {
  /** Filter by linked task ID. */
  taskId?: string;
  /** Filter by completion status. */
  status?: string;
  /** Filter by agent type. */
  agent_type?: string;
  /** Filter by topic tag. */
  topic?: string;
  /** Maximum entries to return. */
  limit?: number;
  /** Number of entries to skip before applying limit. */
  offset?: number;
  /** Filter by actionable flag. */
  actionable?: boolean;
  /** Filter entries created after this ISO date. */
  dateAfter?: string;
  /** Filter entries created before this ISO date. */
  dateBefore?: string;
}

/**
 * Read all manifest entries as extended entries.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Array of parsed ExtendedManifestEntry records
 *
 * @remarks
 * Same as readManifest but typed as ExtendedManifestEntry to include
 * optional engine fields (confidence, file_checksum, duration_seconds).
 *
 * @example
 * ```typescript
 * const entries = await readExtendedManifest('/project');
 * ```
 *
 * @task T4787
 */
export async function readExtendedManifest(cwd?: string): Promise<ExtendedManifestEntry[]> {
  const manifestPath = getManifestPath(cwd);
  const content = await safeReadFile(manifestPath);
  if (!content) return [];

  const entries: ExtendedManifestEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ExtendedManifestEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Filter manifest entries by criteria.
 *
 * @param entries - Array of manifest entries to filter
 * @param filter - Filter criteria to apply
 * @returns Filtered subset of entries
 *
 * @remarks
 * Applies filters in order: taskId, status, agent_type, topic, actionable,
 * dateAfter, dateBefore, offset, then limit.
 *
 * @example
 * ```typescript
 * const filtered = filterManifestEntries(entries, { status: 'completed', limit: 10 });
 * ```
 *
 * @task T4787
 */
export function filterManifestEntries(
  entries: ExtendedManifestEntry[],
  filter: ResearchFilter,
): ExtendedManifestEntry[] {
  let filtered = entries;

  if (filter.taskId) {
    const taskId = filter.taskId;
    filtered = filtered.filter((e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId));
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

  if (filter.offset && filter.offset > 0) {
    filtered = filtered.slice(filter.offset);
  }

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

/**
 * Show a manifest entry by ID with optional file content.
 *
 * @param researchId - The manifest entry ID to look up
 * @param cwd - Optional working directory for path resolution
 * @returns The manifest entry with file content and existence flag
 *
 * @remarks
 * Reads the output file referenced by the entry if it exists on disk.
 * Throws CleoError NOT_FOUND if the entry ID is not found.
 *
 * @example
 * ```typescript
 * const entry = await showManifestEntry('T042-auth-research', '/project');
 * if (entry.fileExists) console.log(entry.fileContent);
 * ```
 *
 * @task T4787
 */
export async function showManifestEntry(
  researchId: string,
  cwd?: string,
): Promise<ExtendedManifestEntry & { fileContent: string | null; fileExists: boolean }> {
  const entries = await readExtendedManifest(cwd);
  const entry = entries.find((e) => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry '${researchId}' not found`);
  }

  const root = getProjectRoot(cwd);
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
    ...entry,
    fileContent,
    fileExists: fileContent !== null,
  };
}

/**
 * Search manifest entries by text with relevance scoring.
 *
 * @param query - Text query to match against titles, topics, and findings
 * @param options - Optional confidence threshold and limit
 * @param cwd - Optional working directory for path resolution
 * @returns Manifest entries with relevance scores, sorted by relevance descending
 *
 * @remarks
 * Scores entries by matching against title (0.5), topics (0.3), key findings (0.2),
 * and ID (0.1). Filters by minimum confidence threshold (default 0.1).
 *
 * @example
 * ```typescript
 * const results = await searchManifest('authentication', { limit: 5 }, '/project');
 * ```
 *
 * @task T4787
 */
export async function searchManifest(
  query: string,
  options?: { confidence?: number; limit?: number },
  cwd?: string,
): Promise<Array<ExtendedManifestEntry & { relevanceScore: number }>> {
  const entries = await readExtendedManifest(cwd);
  const queryLower = query.toLowerCase();

  const scored = entries.map((entry) => {
    let score = 0;

    if (entry.title.toLowerCase().includes(queryLower)) {
      score += 0.5;
    }

    if (entry.topics.some((t) => t.toLowerCase().includes(queryLower))) {
      score += 0.3;
    }

    if (entry.key_findings?.some((f) => f.toLowerCase().includes(queryLower))) {
      score += 0.2;
    }

    if (entry.id.toLowerCase().includes(queryLower)) {
      score += 0.1;
    }

    return { entry, score };
  });

  const minConfidence = options?.confidence ?? 0.1;
  let results = scored.filter((s) => s.score >= minConfidence).sort((a, b) => b.score - a.score);

  if (options?.limit && options.limit > 0) {
    results = results.slice(0, options.limit);
  }

  return results.map((r) => ({
    ...r.entry,
    relevanceScore: Math.round(r.score * 100) / 100,
  }));
}

/**
 * Get pending manifest entries (partial, blocked, or needing followup).
 *
 * @param epicId - Optional epic ID to scope results
 * @param cwd - Optional working directory for path resolution
 * @returns Pending entries with total count and status breakdown
 *
 * @remarks
 * Includes entries with status "partial", "blocked", or any non-empty
 * needs_followup array. Optionally scopes to entries linked to an epic.
 *
 * @example
 * ```typescript
 * const { entries, total } = await pendingManifestEntries('T001', '/project');
 * ```
 *
 * @task T4787
 */
export async function pendingManifestEntries(
  epicId?: string,
  cwd?: string,
): Promise<{
  entries: ExtendedManifestEntry[];
  total: number;
  byStatus: { partial: number; blocked: number; needsFollowup: number };
}> {
  const entries = await readExtendedManifest(cwd);

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
    entries: pending,
    total: pending.length,
    byStatus: {
      partial: pending.filter((e) => e.status === 'partial').length,
      blocked: pending.filter((e) => e.status === 'blocked').length,
      needsFollowup: pending.filter((e) => e.needs_followup && e.needs_followup.length > 0).length,
    },
  };
}

/**
 * Get manifest-based research statistics.
 *
 * @param epicId - Optional epic ID to scope statistics
 * @param cwd - Optional working directory for path resolution
 * @returns Totals, status/type distributions, actionable count, and average findings
 *
 * @remarks
 * Aggregates manifest entries by status, agent type, and actionability.
 * Calculates average key findings per entry.
 *
 * @example
 * ```typescript
 * const stats = await manifestStats(undefined, '/project');
 * console.log(`${stats.total} entries, ${stats.actionable} actionable`);
 * ```
 *
 * @task T4787
 */
export async function manifestStats(
  epicId?: string,
  cwd?: string,
): Promise<{
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  actionable: number;
  needsFollowup: number;
  averageFindings: number;
}> {
  const entries = await readExtendedManifest(cwd);

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
    total: filtered.length,
    byStatus,
    byType,
    actionable,
    needsFollowup,
    averageFindings:
      filtered.length > 0 ? Math.round((totalFindings / filtered.length) * 10) / 10 : 0,
  };
}

/**
 * Link a manifest entry to a task (adds taskId to linked_tasks array).
 *
 * @param taskId - The task ID to link
 * @param researchId - The manifest entry ID to link to
 * @param cwd - Optional working directory for path resolution
 * @returns Confirmation with link details and whether it was already linked
 *
 * @remarks
 * Appends the taskId to the entry's linked_tasks array if not already present.
 * Rewrites the entire legacy agent-outputs flat-file after modification (deprecated).
 * @deprecated Flat-file agent-outputs retired per ADR-027. Use pipeline_manifest via `cleo manifest` CLI.
 *
 * @example
 * ```typescript
 * const result = await linkManifestEntry('T042', 'M001', '/project');
 * ```
 *
 * @task T4787
 */
export async function linkManifestEntry(
  taskId: string,
  researchId: string,
  cwd?: string,
): Promise<{ taskId: string; researchId: string; alreadyLinked: boolean }> {
  const manifestPath = getManifestPath(cwd);
  const entries = await readExtendedManifest(cwd);

  const entryIndex = entries.findIndex((e) => e.id === researchId);
  if (entryIndex === -1) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry '${researchId}' not found`);
  }

  const entry = entries[entryIndex];

  if (entry.linked_tasks?.includes(taskId)) {
    return { taskId, researchId, alreadyLinked: true };
  }

  if (!entry.linked_tasks) {
    entry.linked_tasks = [];
  }
  entry.linked_tasks.push(taskId);

  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await atomicWrite(manifestPath, content);

  return { taskId, researchId, alreadyLinked: false };
}

/**
 * Append an extended manifest entry.
 * Validates required fields before appending.
 *
 * @param entry - The ExtendedManifestEntry to append
 * @param cwd - Optional working directory for path resolution
 * @returns Confirmation with the entry ID and manifest file path
 *
 * @remarks
 * Validates that all required fields (id, file, title, date, status, agent_type,
 * topics, actionable) are present before writing.
 *
 * @example
 * ```typescript
 * const result = await appendExtendedManifest({ id: 'M002', ... }, '/project');
 * ```
 *
 * @task T4787
 */
export async function appendExtendedManifest(
  entry: ExtendedManifestEntry,
  cwd?: string,
): Promise<{ entryId: string; file: string }> {
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
    throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid manifest entry: ${errors.join(', ')}`);
  }

  const manifestPath = getManifestPath(cwd);
  await appendJsonl(manifestPath, entry);

  return { entryId: entry.id, file: getManifestPath() };
}

/**
 * Archive manifest entries older than a date.
 *
 * @param beforeDate - ISO date string; entries older than this are archived
 * @param cwd - Optional working directory for path resolution
 * @returns Counts of archived and remaining entries, and the archive file path
 *
 * @remarks
 * Moves entries with a date before the threshold to MANIFEST.archive.jsonl
 * and rewrites the main legacy agent-outputs flat-file with the remaining entries.
 * @deprecated Flat-file agent-outputs retired per ADR-027. Use pipeline_manifest via `cleo manifest` CLI.
 *
 * @example
 * ```typescript
 * const result = await archiveManifestEntries('2026-01-01', '/project');
 * console.log(`Archived ${result.archived} entries`);
 * ```
 *
 * @task T4787
 */
export async function archiveManifestEntries(
  beforeDate: string,
  cwd?: string,
): Promise<{ archived: number; remaining: number; archiveFile: string }> {
  const manifestPath = getManifestPath(cwd);
  const archivePath = getManifestArchivePath(cwd);
  const entries = await readExtendedManifest(cwd);

  const toArchive = entries.filter((e) => e.date < beforeDate);
  const toKeep = entries.filter((e) => e.date >= beforeDate);

  if (toArchive.length === 0) {
    return {
      archived: 0,
      remaining: entries.length,
      archiveFile: getManifestArchivePath(),
    };
  }

  // Append archived entries to archive file
  const existingArchive = await safeReadFile(archivePath);
  const archiveContent = toArchive.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const fullArchive = existingArchive
    ? existingArchive.trimEnd() + '\n' + archiveContent
    : archiveContent;
  await atomicWrite(archivePath, fullArchive);

  // Rewrite main manifest with remaining entries
  const remainingContent =
    toKeep.length > 0 ? toKeep.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  await atomicWrite(manifestPath, remainingContent);

  return {
    archived: toArchive.length,
    remaining: toKeep.length,
    archiveFile: getManifestArchivePath(),
  };
}

/** Contradiction detail between two manifest entries. */
export interface ContradictionDetail {
  /** First conflicting entry. */
  entryA: ExtendedManifestEntry;
  /** Second conflicting entry. */
  entryB: ExtendedManifestEntry;
  /** Shared topic where the conflict was detected. */
  topic: string;
  /** Description of the conflicting findings. */
  conflictDetails: string;
}

/**
 * Find manifest entries with overlapping topics but conflicting key_findings.
 *
 * @param cwd - Optional working directory for path resolution
 * @param params - Optional filter by topic
 * @returns Array of contradiction details between conflicting entries
 *
 * @remarks
 * Groups entries by shared topics and compares key_findings for disagreements.
 * Only returns pairs where findings actually differ.
 *
 * @example
 * ```typescript
 * const contradictions = await findContradictions('/project', { topic: 'auth' });
 * ```
 *
 * @task T4787
 */
export async function findContradictions(
  cwd?: string,
  params?: { topic?: string },
): Promise<ContradictionDetail[]> {
  const entries = await readExtendedManifest(cwd);

  const byTopic = new Map<string, ExtendedManifestEntry[]>();
  for (const entry of entries) {
    if (!entry.key_findings || entry.key_findings.length === 0) continue;
    for (const topic of entry.topics) {
      if (params?.topic && topic !== params.topic) continue;
      if (!byTopic.has(topic)) {
        byTopic.set(topic, []);
      }
      byTopic.get(topic)!.push(entry);
    }
  }

  const contradictions: ContradictionDetail[] = [];

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

  return contradictions;
}

/** Superseded entry detail. */
export interface SupersededDetail {
  old: ExtendedManifestEntry;
  replacement: ExtendedManifestEntry;
  topic: string;
}

/**
 * Identify research entries replaced by newer work on same topic.
 *
 * @param cwd - Optional working directory for path resolution
 * @param params - Optional filter by topic
 * @returns Array of superseded entry pairs with the replacement and obsoleted entries
 *
 * @remarks
 * Groups entries by shared topics and identifies older entries that have been
 * superseded by newer ones on the same subject.
 *
 * @example
 * ```typescript
 * const superseded = await findSuperseded('/project');
 * ```
 *
 * @task T4787
 */
export async function findSuperseded(
  cwd?: string,
  params?: { topic?: string },
): Promise<SupersededDetail[]> {
  const entries = await readExtendedManifest(cwd);

  const byTopicAndType = new Map<string, ExtendedManifestEntry[]>();
  for (const entry of entries) {
    for (const topic of entry.topics) {
      if (params?.topic && topic !== params.topic) continue;
      const key = `${topic}::${entry.agent_type}`;
      if (!byTopicAndType.has(key)) {
        byTopicAndType.set(key, []);
      }
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

      superseded.push({
        old: sorted[i],
        replacement: sorted[sorted.length - 1],
        topic,
      });
    }
  }

  return superseded;
}

/**
 * Read protocol injection content for a given protocol type.
 *
 * @param protocolType - Protocol name (e.g. "consensus", "contribution")
 * @param params - Optional parameters for template resolution
 * @param cwd - Optional working directory for path resolution
 * @returns Protocol content, file path, and metadata
 *
 * @remarks
 * Reads protocol template files from the agent-outputs directory and
 * resolves variables like taskId within the content.
 *
 * @example
 * ```typescript
 * const result = await readProtocolInjection('consensus', { taskId: 'T042' }, '/project');
 * console.log(result.content);
 * ```
 *
 * @task T4787
 */
export async function readProtocolInjection(
  protocolType: string,
  params?: { taskId?: string; variant?: string },
  cwd?: string,
): Promise<{
  protocolType: string;
  content: string;
  path: string;
  contentLength: number;
  estimatedTokens: number;
  taskId: string | null;
  variant: string | null;
}> {
  const root = getProjectRoot(cwd);

  const protocolLocations = [
    resolve(root, 'protocols', `${protocolType}.md`),
    resolve(root, 'skills', '_shared', `${protocolType}.md`),
    resolve(root, 'agents', 'cleo-subagent', 'protocols', `${protocolType}.md`),
  ];

  let protocolContent: string | null = null;
  let protocolPath: string | null = null;

  for (const loc of protocolLocations) {
    if (existsSync(loc)) {
      try {
        protocolContent = readFileSync(loc, 'utf-8');
        protocolPath = loc.replace(root + '/', '');
        break;
      } catch {}
    }
  }

  if (!protocolContent || !protocolPath) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Protocol '${protocolType}' not found in src/protocols/, skills/_shared/, or agents/cleo-subagent/protocols/`,
    );
  }

  return {
    protocolType,
    content: protocolContent,
    path: protocolPath,
    contentLength: protocolContent.length,
    estimatedTokens: Math.ceil(protocolContent.length / 4),
    taskId: params?.taskId || null,
    variant: params?.variant || null,
  };
}

/**
 * Compact the legacy agent-outputs flat-file by removing duplicate/stale entries.
 * @deprecated Flat-file agent-outputs retired per ADR-027. Use pipeline_manifest via `cleo manifest` CLI.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Compaction summary with counts of removed entries
 *
 * @remarks
 * Removes malformed lines and deduplicates entries by ID (keeping the last
 * occurrence). Rewrites the file atomically.
 *
 * @example
 * ```typescript
 * const result = await compactManifest('/project');
 * console.log(`Removed ${result.duplicatesRemoved} duplicates`);
 * ```
 *
 * @task T4787
 */
export async function compactManifest(cwd?: string): Promise<{
  compacted: boolean;
  originalLines: number;
  malformedRemoved: number;
  duplicatesRemoved: number;
  remainingEntries: number;
}> {
  const manifestPath = getManifestPath(cwd);
  const content = await safeReadFile(manifestPath);

  if (!content) {
    return {
      compacted: false,
      originalLines: 0,
      malformedRemoved: 0,
      duplicatesRemoved: 0,
      remainingEntries: 0,
    };
  }

  const lines = content.split('\n');
  const entries: ExtendedManifestEntry[] = [];
  let malformedCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ExtendedManifestEntry);
    } catch {
      malformedCount++;
    }
  }

  const originalCount = entries.length + malformedCount;

  const idMap = new Map<string, ExtendedManifestEntry>();
  for (const entry of entries) {
    idMap.set(entry.id, entry);
  }

  const compacted = Array.from(idMap.values());
  const duplicatesRemoved = entries.length - compacted.length;

  const compactedContent =
    compacted.length > 0 ? compacted.map((e) => JSON.stringify(e)).join('\n') + '\n' : '';
  await atomicWrite(manifestPath, compactedContent);

  return {
    compacted: true,
    originalLines: originalCount,
    malformedRemoved: malformedCount,
    duplicatesRemoved,
    remainingEntries: compacted.length,
  };
}

/**
 * Validate research entries for a task.
 *
 * @param taskId - The task ID to validate manifest entries for
 * @param cwd - Optional working directory for path resolution
 * @returns Validation result with issue details and severity counts
 *
 * @remarks
 * Checks linked manifest entries for missing output files, empty key findings,
 * and incomplete status. Reports issues at error or warning severity.
 *
 * @example
 * ```typescript
 * const result = await validateManifestEntries('T042', '/project');
 * if (!result.valid) console.log(result.issues);
 * ```
 *
 * @task T4787
 */
export async function validateManifestEntries(
  taskId: string,
  cwd?: string,
): Promise<{
  taskId: string;
  valid: boolean;
  entriesFound: number;
  issues: Array<{ entryId: string; issue: string; severity: 'error' | 'warning' }>;
  errorCount: number;
  warningCount: number;
}> {
  const root = getProjectRoot(cwd);
  const entries = await readExtendedManifest(cwd);

  const linked = entries.filter((e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId));

  if (linked.length === 0) {
    return {
      taskId,
      valid: true,
      entriesFound: 0,
      issues: [],
      errorCount: 0,
      warningCount: 0,
    };
  }

  const issues: Array<{ entryId: string; issue: string; severity: 'error' | 'warning' }> = [];

  for (const entry of linked) {
    if (!entry.id)
      issues.push({ entryId: entry.id || '(unknown)', issue: 'Missing id', severity: 'error' });
    if (!entry.file)
      issues.push({ entryId: entry.id, issue: 'Missing file path', severity: 'error' });
    if (!entry.title) issues.push({ entryId: entry.id, issue: 'Missing title', severity: 'error' });
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
      const filePath = resolve(root, entry.file);
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
    taskId,
    valid: issues.filter((i) => i.severity === 'error').length === 0,
    entriesFound: linked.length,
    issues,
    errorCount: issues.filter((i) => i.severity === 'error').length,
    warningCount: issues.filter((i) => i.severity === 'warning').length,
  };
}

// === T549 Wave 3: Consolidator (contradiction detection) ===
export * from './brain-consolidator.js';
// === BRAIN Lifecycle (temporal decay, consolidation, tier promotion) ===
export * from './brain-lifecycle.js';
export * from './brain-links.js';
export * from './brain-migration.js';
// === BRAIN Retrieval functions (3-layer pattern + budget-aware) ===
export * from './brain-retrieval.js';
export * from './brain-search.js';
// === BRAIN Memory modules (brain.db backed) ===
export * from './decisions.js';
// === T626-M1: Canonical edge-type constants ===
export * from './edge-types.js';
// === T549 Wave 2: Extraction Gate ===
export * from './extraction-gate.js';
export * from './learnings.js';
// === Manifest Ingestion (T1099) — RCASD + loose files into pipeline_manifest ===
export * from './manifest-builder.js';
export * from './manifest-ingestion.js';
// === JSONL Memory modules (legacy, still active) ===
export * from './patterns.js';
// === BRAIN Quality Feedback Loop (T555) ===
export * from './quality-feedback.js';
