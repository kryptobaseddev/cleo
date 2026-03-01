/**
 * Research commands and manifest operations.
 * @task T4465
 * @epic T4454
 */

import { readJsonRequired, saveJson, appendJsonl, readJson } from '../../store/json.js';
import { safeReadFile, atomicWrite } from '../../store/atomic.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TaskFile } from '../../types/task.js';
import { getTaskPath, getBackupDir, getLogPath, getCleoDirAbsolute, getManifestPath as getCentralManifestPath, getManifestArchivePath, getProjectRoot } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Research entry attached to a task. */
export interface ResearchEntry {
  id: string;
  taskId: string;
  topic: string;
  findings: string[];
  sources: string[];
  status: 'pending' | 'complete' | 'partial';
  createdAt: string;
  updatedAt: string;
}

/** Manifest entry (JSONL line). */
export interface ManifestEntry {
  id: string;
  file: string;
  title: string;
  date: string;
  status: 'completed' | 'partial' | 'blocked';
  agent_type: string;
  topics: string[];
  key_findings: string[];
  actionable: boolean;
  needs_followup: string[];
  linked_tasks: string[];
}

/** Options for adding research. */
export interface AddResearchOptions {
  taskId: string;
  topic: string;
  findings?: string[];
  sources?: string[];
}

/** Options for listing research. */
export interface ListResearchOptions {
  taskId?: string;
  status?: 'pending' | 'complete' | 'partial';
}

/** Manifest query options. */
export interface ManifestQueryOptions {
  status?: string;
  agentType?: string;
  topic?: string;
  taskId?: string;
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
 * @task T4465
 */
export async function addResearch(options: AddResearchOptions, cwd?: string, accessor?: DataAccessor): Promise<ResearchEntry> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));

  // Validate task exists
  const task = data.tasks.find(t => t.id === options.taskId);
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
  await logOperation(getLogPath(cwd), 'research_added', entry.id, {
    taskId: options.taskId,
    topic: options.topic,
  }, accessor);

  return entry;
}

/**
 * Show a specific research entry.
 * @task T4465
 */
export async function showResearch(researchId: string, cwd?: string): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  return entry;
}

/**
 * List research entries with optional filtering.
 * @task T4465
 */
export async function listResearch(options: ListResearchOptions = {}, cwd?: string): Promise<ResearchEntry[]> {
  const research = await readResearch(cwd);
  let entries = research.entries;

  if (options.taskId) {
    entries = entries.filter(e => e.taskId === options.taskId);
  }
  if (options.status) {
    entries = entries.filter(e => e.status === options.status);
  }

  return entries;
}

/**
 * List pending research entries.
 * @task T4465
 */
export async function pendingResearch(cwd?: string): Promise<ResearchEntry[]> {
  return listResearch({ status: 'pending' }, cwd);
}

/**
 * Link a research entry to a task.
 * @task T4465
 */
export async function linkResearch(
  researchId: string,
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ researchId: string; taskId: string }> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

  if (!entry) {
    throw new CleoError(ExitCode.NOT_FOUND, `Research entry not found: ${researchId}`);
  }

  // Validate task exists
  const taskData = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));
  const task = taskData.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  entry.taskId = taskId;
  entry.updatedAt = new Date().toISOString();

  await saveJson(getResearchPath(cwd), research, { backupDir: getBackupDir(cwd) });

  return { researchId, taskId };
}

/**
 * Update research findings.
 * @task T4465
 */
export async function updateResearch(
  researchId: string,
  updates: { findings?: string[]; sources?: string[]; status?: 'pending' | 'complete' | 'partial' },
  cwd?: string,
): Promise<ResearchEntry> {
  const research = await readResearch(cwd);
  const entry = research.entries.find(e => e.id === researchId);

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
 * @task T4474
 */
export async function linksResearch(taskId: string, cwd?: string): Promise<ResearchEntry[]> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }
  const research = await readResearch(cwd);
  return research.entries.filter(e => e.taskId === taskId);
}

/**
 * Archive old research entries by status.
 * Moves 'complete' entries older than a threshold to an archive,
 * or returns summary of archivable entries.
 * @task T4474
 */
export async function archiveResearch(cwd?: string): Promise<{
  action: string;
  entriesArchived: number;
  entriesRemaining: number;
}> {
  const research = await readResearch(cwd);
  const completed = research.entries.filter(e => e.status === 'complete');
  const remaining = research.entries.filter(e => e.status !== 'complete');

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
 * Read manifest entries from MANIFEST.jsonl.
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
 * @task T4465
 */
export async function appendManifest(entry: ManifestEntry, cwd?: string): Promise<void> {
  const manifestPath = getManifestPath(cwd);
  await appendJsonl(manifestPath, entry);
}

/**
 * Query manifest entries.
 * @task T4465
 */
export async function queryManifest(
  options: ManifestQueryOptions = {},
  cwd?: string,
): Promise<ManifestEntry[]> {
  let entries = await readManifest(cwd);

  if (options.status) {
    entries = entries.filter(e => e.status === options.status);
  }
  if (options.agentType) {
    entries = entries.filter(e => e.agent_type === options.agentType);
  }
  if (options.topic) {
    entries = entries.filter(e => e.topics.includes(options.topic!));
  }
  if (options.taskId) {
    entries = entries.filter(e => e.linked_tasks.includes(options.taskId!));
  }
  if (options.limit && options.limit > 0) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

// ============================================================================
// Engine-compatible manifest operations (extended fields)
// These are used by the MCP engine layer for research domain support.
// ============================================================================

/** Extended manifest entry with optional fields used by the engine. */
export interface ExtendedManifestEntry extends ManifestEntry {
  confidence?: number;
  file_checksum?: string;
  duration_seconds?: number;
}

/** Research filter criteria used by the engine. */
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
 * Read all manifest entries as extended entries.
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
 * @task T4787
 */
export function filterManifestEntries(entries: ExtendedManifestEntry[], filter: ResearchFilter): ExtendedManifestEntry[] {
  let filtered = entries;

  if (filter.taskId) {
    const taskId = filter.taskId;
    filtered = filtered.filter(
      e => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId),
    );
  }

  if (filter.status) {
    filtered = filtered.filter(e => e.status === filter.status);
  }

  if (filter.agent_type) {
    filtered = filtered.filter(e => e.agent_type === filter.agent_type);
  }

  if (filter.topic) {
    filtered = filtered.filter(e => e.topics.includes(filter.topic!));
  }

  if (filter.actionable !== undefined) {
    filtered = filtered.filter(e => e.actionable === filter.actionable);
  }

  if (filter.dateAfter) {
    filtered = filtered.filter(e => e.date > filter.dateAfter!);
  }

  if (filter.dateBefore) {
    filtered = filtered.filter(e => e.date < filter.dateBefore!);
  }

  if (filter.limit && filter.limit > 0) {
    filtered = filtered.slice(0, filter.limit);
  }

  return filtered;
}

/**
 * Show a manifest entry by ID with optional file content.
 * @task T4787
 */
export async function showManifestEntry(
  researchId: string,
  cwd?: string,
): Promise<ExtendedManifestEntry & { fileContent: string | null; fileExists: boolean }> {
  const entries = await readExtendedManifest(cwd);
  const entry = entries.find(e => e.id === researchId);

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
 * @task T4787
 */
export async function searchManifest(
  query: string,
  options?: { confidence?: number; limit?: number },
  cwd?: string,
): Promise<Array<ExtendedManifestEntry & { relevanceScore: number }>> {
  const entries = await readExtendedManifest(cwd);
  const queryLower = query.toLowerCase();

  const scored = entries.map(entry => {
    let score = 0;

    if (entry.title.toLowerCase().includes(queryLower)) {
      score += 0.5;
    }

    if (entry.topics.some(t => t.toLowerCase().includes(queryLower))) {
      score += 0.3;
    }

    if (entry.key_findings?.some(f => f.toLowerCase().includes(queryLower))) {
      score += 0.2;
    }

    if (entry.id.toLowerCase().includes(queryLower)) {
      score += 0.1;
    }

    return { entry, score };
  });

  const minConfidence = options?.confidence ?? 0.1;
  let results = scored
    .filter(s => s.score >= minConfidence)
    .sort((a, b) => b.score - a.score);

  if (options?.limit && options.limit > 0) {
    results = results.slice(0, options.limit);
  }

  return results.map(r => ({
    ...r.entry,
    relevanceScore: Math.round(r.score * 100) / 100,
  }));
}

/**
 * Get pending manifest entries (partial, blocked, or needing followup).
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
    e =>
      e.status === 'partial' ||
      e.status === 'blocked' ||
      (e.needs_followup && e.needs_followup.length > 0),
  );

  if (epicId) {
    pending = pending.filter(
      e => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId),
    );
  }

  return {
    entries: pending,
    total: pending.length,
    byStatus: {
      partial: pending.filter(e => e.status === 'partial').length,
      blocked: pending.filter(e => e.status === 'blocked').length,
      needsFollowup: pending.filter(
        e => e.needs_followup && e.needs_followup.length > 0,
      ).length,
    },
  };
}

/**
 * Get manifest-based research statistics.
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
    filtered = entries.filter(
      e => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId),
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
    total: filtered.length,
    byStatus,
    byType,
    actionable,
    needsFollowup,
    averageFindings:
      filtered.length > 0
        ? Math.round((totalFindings / filtered.length) * 10) / 10
        : 0,
  };
}

/**
 * Link a manifest entry to a task (adds taskId to linked_tasks array).
 * @task T4787
 */
export async function linkManifestEntry(
  taskId: string,
  researchId: string,
  cwd?: string,
): Promise<{ taskId: string; researchId: string; alreadyLinked: boolean }> {
  const manifestPath = getManifestPath(cwd);
  const entries = await readExtendedManifest(cwd);

  const entryIndex = entries.findIndex(e => e.id === researchId);
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

  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  await atomicWrite(manifestPath, content);

  return { taskId, researchId, alreadyLinked: false };
}

/**
 * Append an extended manifest entry.
 * Validates required fields before appending.
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
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `Invalid manifest entry: ${errors.join(', ')}`,
    );
  }

  const manifestPath = getManifestPath(cwd);
  await appendJsonl(manifestPath, entry);

  return { entryId: entry.id, file: getManifestPath() };
}

/**
 * Archive manifest entries older than a date.
 * @task T4787
 */
export async function archiveManifestEntries(
  beforeDate: string,
  cwd?: string,
): Promise<{ archived: number; remaining: number; archiveFile: string }> {
  const manifestPath = getManifestPath(cwd);
  const archivePath = getManifestArchivePath(cwd);
  const entries = await readExtendedManifest(cwd);

  const toArchive = entries.filter(e => e.date < beforeDate);
  const toKeep = entries.filter(e => e.date >= beforeDate);

  if (toArchive.length === 0) {
    return {
      archived: 0,
      remaining: entries.length,
      archiveFile: getManifestArchivePath(),
    };
  }

  // Append archived entries to archive file
  const existingArchive = await safeReadFile(archivePath);
  const archiveContent = toArchive.map(e => JSON.stringify(e)).join('\n') + '\n';
  const fullArchive = existingArchive
    ? existingArchive.trimEnd() + '\n' + archiveContent
    : archiveContent;
  await atomicWrite(archivePath, fullArchive);

  // Rewrite main manifest with remaining entries
  const remainingContent = toKeep.length > 0
    ? toKeep.map(e => JSON.stringify(e)).join('\n') + '\n'
    : '';
  await atomicWrite(manifestPath, remainingContent);

  return {
    archived: toArchive.length,
    remaining: toKeep.length,
    archiveFile: getManifestArchivePath(),
  };
}

/** Contradiction detail between two manifest entries. */
export interface ContradictionDetail {
  entryA: ExtendedManifestEntry;
  entryB: ExtendedManifestEntry;
  topic: string;
  conflictDetails: string;
}

/**
 * Find manifest entries with overlapping topics but conflicting key_findings.
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
    [/\bnot\s+(?:available|supported|possible|recommended)\b/i, /\b(?:available|supported|possible|recommended)\b(?!.*\bnot\b)/i],
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
      } catch {
        continue;
      }
    }
  }

  if (!protocolContent || !protocolPath) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Protocol '${protocolType}' not found in protocols/, skills/_shared/, or agents/cleo-subagent/protocols/`,
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
 * Compact MANIFEST.jsonl by removing duplicate/stale entries.
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

  const compactedContent = compacted.length > 0
    ? compacted.map(e => JSON.stringify(e)).join('\n') + '\n'
    : '';
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

  const linked = entries.filter(
    e => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId),
  );

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
    if (!entry.id) issues.push({ entryId: entry.id || '(unknown)', issue: 'Missing id', severity: 'error' });
    if (!entry.file) issues.push({ entryId: entry.id, issue: 'Missing file path', severity: 'error' });
    if (!entry.title) issues.push({ entryId: entry.id, issue: 'Missing title', severity: 'error' });
    if (!entry.date) issues.push({ entryId: entry.id, issue: 'Missing date', severity: 'error' });
    if (!entry.status) issues.push({ entryId: entry.id, issue: 'Missing status', severity: 'error' });
    if (!entry.agent_type) issues.push({ entryId: entry.id, issue: 'Missing agent_type', severity: 'error' });

    if (entry.status && !['completed', 'partial', 'blocked'].includes(entry.status)) {
      issues.push({ entryId: entry.id, issue: `Invalid status: ${entry.status}`, severity: 'error' });
    }

    if (entry.file) {
      const filePath = resolve(root, entry.file);
      if (!existsSync(filePath)) {
        issues.push({ entryId: entry.id, issue: `Output file not found: ${entry.file}`, severity: 'warning' });
      }
    }

    if (entry.agent_type === 'research' && (!entry.key_findings || entry.key_findings.length === 0)) {
      issues.push({ entryId: entry.id, issue: 'Research entry missing key_findings', severity: 'warning' });
    }
  }

  return {
    taskId,
    valid: issues.filter(i => i.severity === 'error').length === 0,
    entriesFound: linked.length,
    issues,
    errorCount: issues.filter(i => i.severity === 'error').length,
    warningCount: issues.filter(i => i.severity === 'warning').length,
  };
}

// === BRAIN Memory modules (brain.db backed) ===
export * from './decisions.js';
export * from './brain-migration.js';
export * from './brain-search.js';
export * from './brain-links.js';

// === JSONL Memory modules (legacy, still active) ===
export * from './patterns.js';
export * from './learnings.js';
