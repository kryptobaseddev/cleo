/**
 * Learning Memory system for CLEO BRAIN.
 *
 * Records, queries, and applies accumulated insights from
 * historical task data (completion rates, blocker patterns, epic sizes).
 *
 * Storage: JSONL append-only at .cleo/memory/learnings.jsonl
 * Future: SQLite brain_learnings table per ADR-009 Section 3.2.
 *
 * @task T4769
 * @epic T4763
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** A single learning memory entry. */
export interface LearningEntry {
  id: string;
  insight: string;
  source: string;
  confidence: number;
  actionable: boolean;
  application: string | null;
  applicableTypes: string[];
  createdAt: string;
  updatedAt: string | null;
}

/** Parameters for storing a new learning. */
export interface StoreLearningParams {
  insight: string;
  source: string;
  confidence: number;
  actionable?: boolean;
  application?: string;
  applicableTypes?: string[];
}

/** Parameters for searching learnings. */
export interface SearchLearningParams {
  query?: string;
  minConfidence?: number;
  actionableOnly?: boolean;
  applicableType?: string;
  limit?: number;
}

/**
 * Get the memory directory, creating if needed.
 */
function getMemoryDir(projectRoot: string): string {
  const memDir = join(projectRoot, '.cleo', 'memory');
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }
  return memDir;
}

/**
 * Get the learnings JSONL file path.
 */
function getLearningsPath(projectRoot: string): string {
  return join(getMemoryDir(projectRoot), 'learnings.jsonl');
}

/**
 * Generate a learning ID.
 */
function generateLearningId(): string {
  return `L${randomBytes(4).toString('hex')}`;
}

/**
 * Read all learnings from the JSONL store.
 * @task T4769
 */
export function readLearnings(projectRoot: string): LearningEntry[] {
  const path = getLearningsPath(projectRoot);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];

  const entries: LearningEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LearningEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Store a new learning.
 * If a very similar insight exists (same text), updates confidence via running average.
 * @task T4769
 */
export function storeLearning(
  projectRoot: string,
  params: StoreLearningParams,
): LearningEntry {
  if (!params.insight || !params.insight.trim()) {
    throw new Error('Insight text is required');
  }
  if (!params.source || !params.source.trim()) {
    throw new Error('Source is required');
  }
  if (params.confidence < 0 || params.confidence > 1) {
    throw new Error('Confidence must be between 0.0 and 1.0');
  }

  const existing = readLearnings(projectRoot);
  const now = new Date().toISOString();

  // Check for duplicate insight
  const duplicate = existing.find(
    (e) => e.insight.toLowerCase() === params.insight.toLowerCase(),
  );

  if (duplicate) {
    // Update confidence (average of old and new)
    duplicate.confidence = (duplicate.confidence + params.confidence) / 2;
    duplicate.updatedAt = now;
    if (params.applicableTypes) {
      const newTypes = params.applicableTypes.filter(
        (t) => !duplicate.applicableTypes.includes(t),
      );
      duplicate.applicableTypes.push(...newTypes);
    }

    // Rewrite file
    const path = getLearningsPath(projectRoot);
    const updated = existing.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(path, updated, 'utf-8');

    return duplicate;
  }

  // Create new entry
  const entry: LearningEntry = {
    id: generateLearningId(),
    insight: params.insight.trim(),
    source: params.source.trim(),
    confidence: params.confidence,
    actionable: params.actionable ?? false,
    application: params.application ?? null,
    applicableTypes: params.applicableTypes ?? [],
    createdAt: now,
    updatedAt: null,
  };

  const path = getLearningsPath(projectRoot);
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

  return entry;
}

/**
 * Search learnings by criteria.
 * Results sorted by confidence (highest first).
 * @task T4769
 */
export function searchLearnings(
  projectRoot: string,
  params: SearchLearningParams = {},
): LearningEntry[] {
  let entries = readLearnings(projectRoot);

  if (params.minConfidence !== undefined) {
    entries = entries.filter((e) => e.confidence >= params.minConfidence!);
  }

  if (params.actionableOnly) {
    entries = entries.filter((e) => e.actionable);
  }

  if (params.applicableType) {
    entries = entries.filter((e) => e.applicableTypes.includes(params.applicableType!));
  }

  if (params.query) {
    const q = params.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.insight.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q) ||
        (e.application && e.application.toLowerCase().includes(q)),
    );
  }

  // Sort by confidence (highest first)
  entries.sort((a, b) => b.confidence - a.confidence);

  if (params.limit && params.limit > 0) {
    entries = entries.slice(0, params.limit);
  }

  return entries;
}

/**
 * Get learning statistics.
 * @task T4769
 */
export function learningStats(projectRoot: string): {
  total: number;
  actionable: number;
  averageConfidence: number;
  bySource: Record<string, number>;
  highConfidence: number;
  lowConfidence: number;
} {
  const entries = readLearnings(projectRoot);

  const bySource: Record<string, number> = {};
  let totalConfidence = 0;
  let actionable = 0;
  let highConfidence = 0;
  let lowConfidence = 0;

  for (const entry of entries) {
    bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    totalConfidence += entry.confidence;
    if (entry.actionable) actionable++;
    if (entry.confidence >= 0.8) highConfidence++;
    if (entry.confidence < 0.3) lowConfidence++;
  }

  return {
    total: entries.length,
    actionable,
    averageConfidence: entries.length > 0
      ? Math.round((totalConfidence / entries.length) * 100) / 100
      : 0,
    bySource,
    highConfidence,
    lowConfidence,
  };
}
