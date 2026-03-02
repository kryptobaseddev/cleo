/**
 * Migrate BRAIN memory from JSONL files to brain.db SQLite tables.
 * Reads .cleo/memory/patterns.jsonl and .cleo/memory/learnings.jsonl
 * and inserts into brain_patterns and brain_learnings tables.
 *
 * Idempotent: checks for existing entries by ID to skip duplicates.
 *
 * @task T5129
 * @epic T5149
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getBrainAccessor } from '../../store/brain-accessor.js';
import type { NewBrainPatternRow, NewBrainLearningRow } from '../../store/brain-schema.js';

/** Result from a migration run. */
export interface BrainMigrationResult {
  patternsImported: number;
  learningsImported: number;
  duplicatesSkipped: number;
  errors: string[];
}

/** JSONL pattern format (from patterns.ts). */
interface JsonlPattern {
  id: string;
  type: string;
  pattern: string;
  context: string;
  frequency: number;
  successRate: number | null;
  impact: string | null;
  antiPattern: string | null;
  mitigation: string | null;
  examples: string[];
  extractedAt: string;
  updatedAt: string | null;
}

/** JSONL learning format (from learnings.ts). */
interface JsonlLearning {
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

/**
 * Read a JSONL file and parse each line as JSON.
 * Returns parsed objects and any parse error messages.
 */
function readJsonlFile<T>(filePath: string): { entries: T[]; errors: string[] } {
  if (!existsSync(filePath)) {
    return { entries: [], errors: [] };
  }

  const content = readFileSync(filePath, 'utf-8').trim();
  if (!content) {
    return { entries: [], errors: [] };
  }

  const entries: T[] = [];
  const errors: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch (err) {
      errors.push(`Failed to parse line: ${trimmed.slice(0, 80)}...`);
    }
  }

  return { entries, errors };
}

/**
 * Migrate BRAIN memory data from JSONL files to brain.db.
 *
 * Reads:
 * - .cleo/memory/patterns.jsonl -> brain_patterns table
 * - .cleo/memory/learnings.jsonl -> brain_learnings table
 *
 * Skips entries where the ID already exists in the database (idempotent).
 *
 * @task T5129
 */
export async function migrateBrainData(projectRoot: string): Promise<BrainMigrationResult> {
  const accessor = await getBrainAccessor(projectRoot);
  const result: BrainMigrationResult = {
    patternsImported: 0,
    learningsImported: 0,
    duplicatesSkipped: 0,
    errors: [],
  };

  // Migrate patterns
  const patternsPath = join(projectRoot, '.cleo', 'memory', 'patterns.jsonl');
  const { entries: patterns, errors: patternErrors } = readJsonlFile<JsonlPattern>(patternsPath);
  result.errors.push(...patternErrors);

  for (const p of patterns) {
    try {
      // Check if already exists
      const existing = await accessor.getPattern(p.id);
      if (existing) {
        result.duplicatesSkipped++;
        continue;
      }

      const row: NewBrainPatternRow = {
        id: p.id,
        type: mapPatternType(p.type),
        pattern: p.pattern,
        context: p.context,
        frequency: p.frequency ?? 1,
        successRate: p.successRate ?? null,
        impact: mapImpact(p.impact),
        antiPattern: p.antiPattern ?? null,
        mitigation: p.mitigation ?? null,
        examplesJson: JSON.stringify(p.examples ?? []),
        extractedAt: p.extractedAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
        updatedAt: p.updatedAt?.replace('T', ' ').slice(0, 19) ?? null,
      };

      await accessor.addPattern(row);
      result.patternsImported++;
    } catch (err) {
      result.errors.push(`Pattern ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Migrate learnings
  const learningsPath = join(projectRoot, '.cleo', 'memory', 'learnings.jsonl');
  const { entries: learnings, errors: learningErrors } = readJsonlFile<JsonlLearning>(learningsPath);
  result.errors.push(...learningErrors);

  for (const l of learnings) {
    try {
      // Check if already exists
      const existing = await accessor.getLearning(l.id);
      if (existing) {
        result.duplicatesSkipped++;
        continue;
      }

      const row: NewBrainLearningRow = {
        id: l.id,
        insight: l.insight,
        source: l.source,
        confidence: l.confidence,
        actionable: l.actionable ?? false,
        application: l.application ?? null,
        applicableTypesJson: JSON.stringify(l.applicableTypes ?? []),
        createdAt: l.createdAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
        updatedAt: l.updatedAt?.replace('T', ' ').slice(0, 19) ?? null,
      };

      await accessor.addLearning(row);
      result.learningsImported++;
    } catch (err) {
      result.errors.push(`Learning ${l.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * Map JSONL pattern type to brain schema enum.
 * Falls back to 'workflow' for unrecognized types.
 */
function mapPatternType(type: string): NewBrainPatternRow['type'] {
  const valid = ['workflow', 'blocker', 'success', 'failure', 'optimization'] as const;
  if (valid.includes(type as (typeof valid)[number])) {
    return type as NewBrainPatternRow['type'];
  }
  return 'workflow';
}

/**
 * Map JSONL impact level to brain schema enum.
 * Returns null for unrecognized values.
 */
function mapImpact(impact: string | null | undefined): NewBrainPatternRow['impact'] {
  if (!impact) return null;
  const valid = ['low', 'medium', 'high'] as const;
  if (valid.includes(impact as (typeof valid)[number])) {
    return impact as NewBrainPatternRow['impact'];
  }
  return null;
}
