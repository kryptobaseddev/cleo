/**
 * Pattern Memory system for CLEO BRAIN.
 *
 * Extracts, stores, and queries workflow/blocker/success/failure/optimization
 * patterns from completed tasks and epics.
 *
 * Storage: JSONL append-only at .cleo/memory/patterns.jsonl
 * Future: SQLite brain_patterns table per ADR-009 Section 3.2.
 *
 * @task T4768
 * @epic T4763
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Pattern types from ADR-009. */
export type PatternType = 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';

/** Impact level. */
export type PatternImpact = 'low' | 'medium' | 'high';

/** A single pattern memory entry. */
export interface PatternEntry {
  id: string;
  type: PatternType;
  pattern: string;
  context: string;
  frequency: number;
  successRate: number | null;
  impact: PatternImpact | null;
  antiPattern: string | null;
  mitigation: string | null;
  examples: string[];
  extractedAt: string;
  updatedAt: string | null;
}

/** Parameters for storing a new pattern. */
export interface StorePatternParams {
  type: PatternType;
  pattern: string;
  context: string;
  impact?: PatternImpact;
  antiPattern?: string;
  mitigation?: string;
  examples?: string[];
  successRate?: number;
}

/** Parameters for searching patterns. */
export interface SearchPatternParams {
  type?: PatternType;
  impact?: PatternImpact;
  query?: string;
  minFrequency?: number;
  limit?: number;
}

/**
 * Get the patterns storage directory, creating if needed.
 */
function getMemoryDir(projectRoot: string): string {
  const memDir = join(projectRoot, '.cleo', 'memory');
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true });
  }
  return memDir;
}

/**
 * Get the patterns JSONL file path.
 */
function getPatternsPath(projectRoot: string): string {
  return join(getMemoryDir(projectRoot), 'patterns.jsonl');
}

/**
 * Generate a pattern ID.
 */
function generatePatternId(): string {
  return `P${randomBytes(4).toString('hex')}`;
}

/**
 * Read all patterns from the JSONL store.
 * @task T4768
 */
export function readPatterns(projectRoot: string): PatternEntry[] {
  const path = getPatternsPath(projectRoot);
  if (!existsSync(path)) return [];

  const content = readFileSync(path, 'utf-8').trim();
  if (!content) return [];

  const entries: PatternEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PatternEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Store a new pattern.
 * If a similar pattern already exists (same type + matching text), increments frequency.
 * @task T4768
 */
export function storePattern(
  projectRoot: string,
  params: StorePatternParams,
): PatternEntry {
  if (!params.pattern || !params.pattern.trim()) {
    throw new Error('Pattern description is required');
  }
  if (!params.context || !params.context.trim()) {
    throw new Error('Pattern context is required');
  }

  const existing = readPatterns(projectRoot);
  const now = new Date().toISOString();

  // Check for duplicate pattern (same type and similar text)
  const duplicate = existing.find(
    (e) => e.type === params.type && e.pattern.toLowerCase() === params.pattern.toLowerCase(),
  );

  if (duplicate) {
    // Increment frequency and merge examples
    duplicate.frequency += 1;
    duplicate.updatedAt = now;
    if (params.examples) {
      const newExamples = params.examples.filter((ex) => !duplicate.examples.includes(ex));
      duplicate.examples.push(...newExamples);
    }
    if (params.successRate !== undefined) {
      // Running average
      duplicate.successRate = duplicate.successRate !== null
        ? (duplicate.successRate * (duplicate.frequency - 1) + params.successRate) / duplicate.frequency
        : params.successRate;
    }

    // Rewrite the file with updated entry
    const path = getPatternsPath(projectRoot);
    const updated = existing.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(path, updated, 'utf-8');

    return duplicate;
  }

  // Create new entry
  const entry: PatternEntry = {
    id: generatePatternId(),
    type: params.type,
    pattern: params.pattern.trim(),
    context: params.context.trim(),
    frequency: 1,
    successRate: params.successRate ?? null,
    impact: params.impact ?? null,
    antiPattern: params.antiPattern ?? null,
    mitigation: params.mitigation ?? null,
    examples: params.examples ?? [],
    extractedAt: now,
    updatedAt: null,
  };

  const path = getPatternsPath(projectRoot);
  appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8');

  return entry;
}

/**
 * Search patterns by criteria.
 * @task T4768
 */
export function searchPatterns(
  projectRoot: string,
  params: SearchPatternParams = {},
): PatternEntry[] {
  let entries = readPatterns(projectRoot);

  if (params.type) {
    entries = entries.filter((e) => e.type === params.type);
  }

  if (params.impact) {
    entries = entries.filter((e) => e.impact === params.impact);
  }

  if (params.minFrequency && params.minFrequency > 0) {
    entries = entries.filter((e) => e.frequency >= params.minFrequency!);
  }

  if (params.query) {
    const q = params.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.pattern.toLowerCase().includes(q) ||
        e.context.toLowerCase().includes(q) ||
        (e.antiPattern && e.antiPattern.toLowerCase().includes(q)) ||
        (e.mitigation && e.mitigation.toLowerCase().includes(q)),
    );
  }

  // Sort by frequency (most common first)
  entries.sort((a, b) => b.frequency - a.frequency);

  if (params.limit && params.limit > 0) {
    entries = entries.slice(0, params.limit);
  }

  return entries;
}

/**
 * Get pattern statistics.
 * @task T4768
 */
export function patternStats(projectRoot: string): {
  total: number;
  byType: Record<PatternType, number>;
  byImpact: Record<string, number>;
  highestFrequency: { pattern: string; frequency: number } | null;
} {
  const entries = readPatterns(projectRoot);

  const byType: Record<string, number> = {
    workflow: 0,
    blocker: 0,
    success: 0,
    failure: 0,
    optimization: 0,
  };
  const byImpact: Record<string, number> = { low: 0, medium: 0, high: 0, unknown: 0 };

  let highest: PatternEntry | null = null;

  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    byImpact[entry.impact ?? 'unknown'] = (byImpact[entry.impact ?? 'unknown'] || 0) + 1;
    if (!highest || entry.frequency > highest.frequency) {
      highest = entry;
    }
  }

  return {
    total: entries.length,
    byType: byType as Record<PatternType, number>,
    byImpact,
    highestFrequency: highest
      ? { pattern: highest.pattern, frequency: highest.frequency }
      : null,
  };
}
