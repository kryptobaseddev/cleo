/**
 * Research Engine
 *
 * Native TypeScript implementation of research domain operations.
 * Reads/writes MANIFEST.jsonl and RCSD data directly without CLI subprocess.
 *
 * Supports: show, list, query/search, pending, stats, manifest.read,
 *           link, manifest.append, manifest.archive, contradictions, superseded
 *
 * @task T4474
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync} from 'fs';
import { resolve, dirname } from 'path';
import { resolveProjectRoot} from './store.js';
import { getManifestPath as getCentralManifestPath, getManifestArchivePath } from '../../core/paths.js';

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
  return getCentralManifestPath(projectRoot);
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
      file: getCentralManifestPath(),
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
      archiveFile: getManifestArchivePath(),
    },
  };
}

/**
 * Contradiction detail between two manifest entries
 */
interface ContradictionDetail {
  entryA: ManifestEntry;
  entryB: ManifestEntry;
  topic: string;
  conflictDetails: string;
}

/**
 * research.contradictions - Find entries with overlapping topics but conflicting key_findings
 *
 * Scans MANIFEST.jsonl for entries that share topics but have contradictory
 * key_findings. Compares entries pairwise within each topic and flags conflicts
 * using keyword-based heuristic detection.
 *
 * @task T4474
 */
export function researchContradictions(
  projectRoot?: string,
  params?: { topic?: string }
): EngineResult<{ contradictions: ContradictionDetail[] }> {
  const entries = readManifestEntries(projectRoot);

  // Group entries by topic
  const byTopic = new Map<string, ManifestEntry[]>();
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

  // Negation patterns that indicate contradiction
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

    // Pairwise comparison
    for (let i = 0; i < topicEntries.length; i++) {
      for (let j = i + 1; j < topicEntries.length; j++) {
        const a = topicEntries[i];
        const b = topicEntries[j];

        const conflicts: string[] = [];

        // Compare each finding from A against each finding from B
        for (const findingA of a.key_findings!) {
          for (const findingB of b.key_findings!) {
            // Check negation pairs
            for (const [patternNeg, patternPos] of negationPairs) {
              if (
                (patternNeg.test(findingA) && patternPos.test(findingB)) ||
                (patternPos.test(findingA) && patternNeg.test(findingB))
              ) {
                conflicts.push(
                  `"${findingA}" vs "${findingB}"`
                );
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

  return {
    success: true,
    data: { contradictions },
  };
}

/**
 * Superseded entry detail
 */
interface SupersededDetail {
  old: ManifestEntry;
  replacement: ManifestEntry;
  topic: string;
}

/**
 * research.superseded - Identify research entries replaced by newer work on same topic
 *
 * Groups manifest entries by topic and finds entries where a newer entry
 * exists on the same topic, indicating the older entry has been superseded.
 * Only considers entries of the same agent_type (e.g., research supersedes research).
 *
 * @task T4474
 */
export function researchSuperseded(
  projectRoot?: string,
  params?: { topic?: string }
): EngineResult<{ superseded: SupersededDetail[] }> {
  const entries = readManifestEntries(projectRoot);

  // Group entries by (topic, agent_type) for meaningful supersession
  const byTopicAndType = new Map<string, ManifestEntry[]>();
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

    // Sort by date ascending (oldest first)
    const sorted = [...groupEntries].sort((a, b) => a.date.localeCompare(b.date));

    // Each entry except the newest is superseded by the next newer entry
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

  return {
    success: true,
    data: { superseded },
  };
}

/**
 * research.inject - Read protocol injection content for a given protocol type
 * Returns the protocol file content for use in agent context injection.
 * @task T4632
 */
export function researchInject(
  protocolType: string,
  params?: { taskId?: string; variant?: string },
  projectRoot?: string
): EngineResult {
  if (!protocolType) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'protocolType is required' },
    };
  }

  const root = projectRoot || resolveProjectRoot();

  // Look for protocol files in standard locations
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
      error: {
        code: 'E_NOT_FOUND',
        message: `Protocol '${protocolType}' not found in protocols/, skills/_shared/, or agents/cleo-subagent/protocols/`,
      },
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

/**
 * research.compact - Compact MANIFEST.jsonl by removing duplicate/stale entries
 * Keeps only the latest entry per ID and removes malformed lines.
 * @task T4632
 */
export function researchCompact(
  projectRoot?: string
): EngineResult {
  const manifestPath = getManifestPath(projectRoot);

  if (!existsSync(manifestPath)) {
    return {
      success: true,
      data: {
        compacted: false,
        message: 'No manifest file found',
      },
    };
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const lines = content.split('\n');

    const entries: ManifestEntry[] = [];
    let malformedCount = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        entries.push(JSON.parse(trimmed) as ManifestEntry);
      } catch {
        malformedCount++;
      }
    }

    const originalCount = entries.length + malformedCount;

    // Keep only the latest entry per ID (last occurrence wins)
    const idMap = new Map<string, ManifestEntry>();
    for (const entry of entries) {
      idMap.set(entry.id, entry);
    }

    const compacted = Array.from(idMap.values());
    const duplicatesRemoved = entries.length - compacted.length;

    // Write back compacted entries
    const compactedContent = compacted.length > 0
      ? compacted.map((e) => JSON.stringify(e)).join('\n') + '\n'
      : '';
    writeFileSync(manifestPath, compactedContent, 'utf-8');

    return {
      success: true,
      data: {
        compacted: true,
        originalLines: originalCount,
        malformedRemoved: malformedCount,
        duplicatesRemoved,
        remainingEntries: compacted.length,
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

/**
 * research.validate - Validate research entries for a task
 * Checks manifest entries linked to the task for completeness and correctness.
 * @task T4632
 */
export function researchValidate(
  taskId: string,
  projectRoot?: string
): EngineResult {
  if (!taskId) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId is required' },
    };
  }

  const root = projectRoot || resolveProjectRoot();
  const entries = readManifestEntries(root);

  // Find entries linked to the task
  const linked = entries.filter(
    (e) => e.id.startsWith(taskId) || e.linked_tasks?.includes(taskId)
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
    // Required fields check
    if (!entry.id) issues.push({ entryId: entry.id || '(unknown)', issue: 'Missing id', severity: 'error' });
    if (!entry.file) issues.push({ entryId: entry.id, issue: 'Missing file path', severity: 'error' });
    if (!entry.title) issues.push({ entryId: entry.id, issue: 'Missing title', severity: 'error' });
    if (!entry.date) issues.push({ entryId: entry.id, issue: 'Missing date', severity: 'error' });
    if (!entry.status) issues.push({ entryId: entry.id, issue: 'Missing status', severity: 'error' });
    if (!entry.agent_type) issues.push({ entryId: entry.id, issue: 'Missing agent_type', severity: 'error' });

    // Check status enum
    if (entry.status && !['complete', 'partial', 'blocked'].includes(entry.status)) {
      issues.push({ entryId: entry.id, issue: `Invalid status: ${entry.status}`, severity: 'error' });
    }

    // Check if output file exists
    if (entry.file) {
      const filePath = resolve(root, entry.file);
      if (!existsSync(filePath)) {
        issues.push({ entryId: entry.id, issue: `Output file not found: ${entry.file}`, severity: 'warning' });
      }
    }

    // Check key_findings for research entries
    if (entry.agent_type === 'research' && (!entry.key_findings || entry.key_findings.length === 0)) {
      issues.push({ entryId: entry.id, issue: 'Research entry missing key_findings', severity: 'warning' });
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
}
