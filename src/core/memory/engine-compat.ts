/**
 * Memory Engine Compatibility Layer
 *
 * Async wrappers around core/memory functions that return EngineResult<T>
 * format for consumption by the dispatch layer. Replaces the sync
 * mcp/engine/research-engine.ts middleman.
 *
 * @epic T4820
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getManifestPath as getCentralManifestPath, getManifestArchivePath, getProjectRoot } from '../paths.js';
import {
  filterManifestEntries,
  type ExtendedManifestEntry,
  type ResearchFilter,
  type ContradictionDetail,
  type SupersededDetail,
} from './index.js';

// BRAIN memory imports (T4770)
import {
  storePattern,
  searchPatterns,
  patternStats,
  type StorePatternParams,
  type SearchPatternParams,
} from './patterns.js';
import {
  storeLearning,
  searchLearnings,
  learningStats,
  type StoreLearningParams,
  type SearchLearningParams,
} from './learnings.js';

// Re-export types for consumers
export type ManifestEntry = ExtendedManifestEntry;
export type { ResearchFilter, ContradictionDetail, SupersededDetail };
export { filterManifestEntries };

import type { EngineResult } from '../../dispatch/engines/_error.js';

// ============================================================================
// Internal I/O helpers
// ============================================================================

function getManifestPath(projectRoot?: string): string {
  return getCentralManifestPath(projectRoot);
}

function resolveRoot(projectRoot?: string): string {
  return projectRoot || getProjectRoot();
}

/**
 * Read all manifest entries from MANIFEST.jsonl.
 */
export function readManifestEntries(projectRoot?: string): ExtendedManifestEntry[] {
  const manifestPath = getManifestPath(projectRoot);

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const entries: ExtendedManifestEntry[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        entries.push(JSON.parse(trimmed) as ExtendedManifestEntry);
      } catch {
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
 * Filter manifest entries by criteria.
 * Delegates to core filterManifestEntries.
 */
export function filterEntries(entries: ExtendedManifestEntry[], filter: ResearchFilter): ExtendedManifestEntry[] {
  return filterManifestEntries(entries, filter);
}

// ============================================================================
// EngineResult-wrapped functions
// ============================================================================

/** memory.show - Get research entry details by ID */
export function memoryShow(
  researchId: string,
  projectRoot?: string,
): EngineResult {
  if (!researchId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'researchId is required' } };
  }

  const entries = readManifestEntries(projectRoot);
  const entry = entries.find(e => e.id === researchId);

  if (!entry) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` },
    };
  }

  const root = resolveRoot(projectRoot);
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
    data: { ...entry, fileContent, fileExists: fileContent !== null },
  };
}

/** memory.list - List research entries with filters */
export function memoryList(
  params: ResearchFilter & { type?: string },
  projectRoot?: string,
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  const filter: ResearchFilter = { ...params };
  if (params.type) {
    filter.agent_type = params.type;
  }

  const filtered = filterManifestEntries(entries, filter);

  return {
    success: true,
    data: { entries: filtered, total: filtered.length },
  };
}

/** memory.query / memory.find - Find research entries by text */
export function memoryQuery(
  query: string,
  options?: { confidence?: number; limit?: number },
  projectRoot?: string,
): EngineResult {
  if (!query) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'query is required' } };
  }

  const entries = readManifestEntries(projectRoot);
  const queryLower = query.toLowerCase();

  const scored = entries.map(entry => {
    let score = 0;
    if (entry.title.toLowerCase().includes(queryLower)) score += 0.5;
    if (entry.topics.some(t => t.toLowerCase().includes(queryLower))) score += 0.3;
    if (entry.key_findings?.some(f => f.toLowerCase().includes(queryLower))) score += 0.2;
    if (entry.id.toLowerCase().includes(queryLower)) score += 0.1;
    return { entry, score };
  });

  const minConfidence = options?.confidence ?? 0.1;
  let results = scored
    .filter(s => s.score >= minConfidence)
    .sort((a, b) => b.score - a.score);

  if (options?.limit && options.limit > 0) {
    results = results.slice(0, options.limit);
  }

  return {
    success: true,
    data: {
      query,
      results: results.map(r => ({ ...r.entry, relevanceScore: Math.round(r.score * 100) / 100 })),
      total: results.length,
    },
  };
}

/** memory.pending - Get pending research items */
export function memoryPending(
  epicId?: string,
  projectRoot?: string,
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  let pending = entries.filter(
    e => e.status === 'partial' || e.status === 'blocked' || (e.needs_followup && e.needs_followup.length > 0),
  );

  if (epicId) {
    pending = pending.filter(e => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId));
  }

  return {
    success: true,
    data: {
      entries: pending,
      total: pending.length,
      byStatus: {
        partial: pending.filter(e => e.status === 'partial').length,
        blocked: pending.filter(e => e.status === 'blocked').length,
        needsFollowup: pending.filter(e => e.needs_followup && e.needs_followup.length > 0).length,
      },
    },
  };
}

/** memory.stats - Research statistics */
export function memoryStats(
  epicId?: string,
  projectRoot?: string,
): EngineResult {
  const entries = readManifestEntries(projectRoot);

  let filtered = entries;
  if (epicId) {
    filtered = entries.filter(e => e.id.startsWith(epicId) || e.linked_tasks?.includes(epicId));
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
      averageFindings: filtered.length > 0 ? Math.round((totalFindings / filtered.length) * 10) / 10 : 0,
    },
  };
}

/** memory.manifest.read - Read manifest entries with optional filter */
export function memoryManifestRead(
  filter?: ResearchFilter,
  projectRoot?: string,
): EngineResult {
  const entries = readManifestEntries(projectRoot);
  const filtered = filter ? filterManifestEntries(entries, filter) : entries;

  return {
    success: true,
    data: { entries: filtered, total: filtered.length, filter: filter || {} },
  };
}

/** memory.link - Link research entry to a task */
export function memoryLink(
  taskId: string,
  researchId: string,
  notes?: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !researchId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId and researchId are required' } };
  }

  const root = resolveRoot(projectRoot);
  const manifestPath = getManifestPath(root);
  const entries = readManifestEntries(root);

  const entryIndex = entries.findIndex(e => e.id === researchId);
  if (entryIndex === -1) {
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Research entry '${researchId}' not found` } };
  }

  const entry = entries[entryIndex];

  if (entry.linked_tasks?.includes(taskId)) {
    return { success: true, data: { taskId, researchId, linked: true, alreadyLinked: true } };
  }

  if (!entry.linked_tasks) {
    entry.linked_tasks = [];
  }
  entry.linked_tasks.push(taskId);

  const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(manifestPath, content, 'utf-8');

  return { success: true, data: { taskId, researchId, linked: true, notes: notes || null } };
}

/** memory.manifest.append - Append entry to MANIFEST.jsonl */
export function memoryManifestAppend(
  entry: ExtendedManifestEntry,
  projectRoot?: string,
): EngineResult {
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
    return { success: false, error: { code: 'E_VALIDATION_FAILED', message: `Invalid manifest entry: ${errors.join(', ')}` } };
  }

  const manifestPath = getManifestPath(projectRoot);
  const dir = dirname(manifestPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const serialized = JSON.stringify(entry);
  appendFileSync(manifestPath, serialized + '\n', 'utf-8');

  return { success: true, data: { appended: true, entryId: entry.id, file: getCentralManifestPath() } };
}

/** memory.manifest.archive - Archive old manifest entries */
export function memoryManifestArchive(
  beforeDate: string,
  projectRoot?: string,
): EngineResult {
  if (!beforeDate) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'beforeDate is required (ISO-8601 format: YYYY-MM-DD)' } };
  }

  const root = resolveRoot(projectRoot);
  const manifestPath = getManifestPath(root);
  const archivePath = getManifestArchivePath(root);
  const entries = readManifestEntries(root);

  const toArchive = entries.filter(e => e.date < beforeDate);
  const toKeep = entries.filter(e => e.date >= beforeDate);

  if (toArchive.length === 0) {
    return { success: true, data: { archived: 0, remaining: entries.length, message: 'No entries found before the specified date' } };
  }

  const archiveDir = dirname(archivePath);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  const archiveContent = toArchive.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(archivePath, archiveContent, 'utf-8');

  const remainingContent = toKeep.length > 0 ? toKeep.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
  writeFileSync(manifestPath, remainingContent, 'utf-8');

  return { success: true, data: { archived: toArchive.length, remaining: toKeep.length, archiveFile: getManifestArchivePath() } };
}

/** memory.contradictions - Find entries with overlapping topics but conflicting key_findings */
export function memoryContradictions(
  projectRoot?: string,
  params?: { topic?: string },
): EngineResult<{ contradictions: ContradictionDetail[] }> {
  const entries = readManifestEntries(projectRoot);

  const byTopic = new Map<string, ExtendedManifestEntry[]>();
  for (const entry of entries) {
    if (!entry.key_findings || entry.key_findings.length === 0) continue;
    for (const topic of entry.topics) {
      if (params?.topic && topic !== params.topic) continue;
      if (!byTopic.has(topic)) byTopic.set(topic, []);
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
          contradictions.push({ entryA: a, entryB: b, topic, conflictDetails: conflicts.join('; ') });
        }
      }
    }
  }

  return { success: true, data: { contradictions } };
}

/** memory.superseded - Identify research entries replaced by newer work on same topic */
export function memorySuperseded(
  projectRoot?: string,
  params?: { topic?: string },
): EngineResult<{ superseded: SupersededDetail[] }> {
  const entries = readManifestEntries(projectRoot);

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
}

/** memory.inject - Read protocol injection content for a given protocol type */
export function memoryInject(
  protocolType: string,
  params?: { taskId?: string; variant?: string },
  projectRoot?: string,
): EngineResult {
  if (!protocolType) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'protocolType is required' } };
  }

  const root = resolveRoot(projectRoot);

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

  if (!protocolContent) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Protocol '${protocolType}' not found in protocols/, skills/_shared/, or agents/cleo-subagent/protocols/` },
    };
  }

  return {
    success: true,
    data: {
      protocolType,
      content: protocolContent,
      path: protocolPath,
      contentLength: protocolContent.length,
      estimatedTokens: Math.ceil(protocolContent.length / 4),
      taskId: params?.taskId || null,
      variant: params?.variant || null,
    },
  };
}

/** memory.compact - Compact MANIFEST.jsonl by removing duplicate/stale entries */
export function memoryCompact(
  projectRoot?: string,
): EngineResult {
  const manifestPath = getManifestPath(projectRoot);

  if (!existsSync(manifestPath)) {
    return { success: true, data: { compacted: false, message: 'No manifest file found' } };
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
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

    const compactedContent = compacted.length > 0 ? compacted.map(e => JSON.stringify(e)).join('\n') + '\n' : '';
    writeFileSync(manifestPath, compactedContent, 'utf-8');

    return {
      success: true,
      data: { compacted: true, originalLines: originalCount, malformedRemoved: malformedCount, duplicatesRemoved, remainingEntries: compacted.length },
    };
  } catch (error) {
    return { success: false, error: { code: 'E_COMPACT_FAILED', message: error instanceof Error ? error.message : String(error) } };
  }
}

// ============================================================================
// BRAIN Memory Operations (T4770)
// ============================================================================

/** memory.pattern.store - Store a pattern to BRAIN memory */
export function memoryPatternStore(
  params: StorePatternParams,
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const result = storePattern(root, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_STORE', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.pattern.search - Search patterns in BRAIN memory */
export function memoryPatternSearch(
  params: SearchPatternParams,
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const results = searchPatterns(root, params);
    return { success: true, data: { patterns: results, total: results.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.pattern.stats - Get pattern memory statistics */
export function memoryPatternStats(
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const stats = patternStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: { code: 'E_PATTERN_STATS', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.learning.store - Store a learning to BRAIN memory */
export function memoryLearningStore(
  params: StoreLearningParams,
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const result = storeLearning(root, params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_STORE', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.learning.search - Search learnings in BRAIN memory */
export function memoryLearningSearch(
  params: SearchLearningParams,
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const results = searchLearnings(root, params);
    return { success: true, data: { learnings: results, total: results.length } };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_SEARCH', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.learning.stats - Get learning memory statistics */
export function memoryLearningStats(
  projectRoot?: string,
): EngineResult {
  try {
    const root = resolveRoot(projectRoot);
    const stats = learningStats(root);
    return { success: true, data: stats };
  } catch (error) {
    return { success: false, error: { code: 'E_LEARNING_STATS', message: error instanceof Error ? error.message : String(error) } };
  }
}

/** memory.validate - Validate research entries for a task */
export function memoryValidate(
  taskId: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const root = resolveRoot(projectRoot);
  const entries = readManifestEntries(root);

  const linked = entries.filter(e => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId));

  if (linked.length === 0) {
    return {
      success: true,
      data: { taskId, valid: true, entriesFound: 0, message: `No research entries found for task ${taskId}`, issues: [] },
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
    success: true,
    data: {
      taskId,
      valid: issues.filter(i => i.severity === 'error').length === 0,
      entriesFound: linked.length,
      issues,
      errorCount: issues.filter(i => i.severity === 'error').length,
      warningCount: issues.filter(i => i.severity === 'warning').length,
    },
  };
}
