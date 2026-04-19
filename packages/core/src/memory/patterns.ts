/**
 * Pattern Memory system for CLEO BRAIN.
 *
 * Extracts, stores, and queries workflow/blocker/success/failure/optimization
 * patterns from completed tasks and epics.
 *
 * Storage: SQLite brain_patterns table per ADR-009 Section 3.2.
 *
 * @task T4768, T5241
 * @epic T4763
 */

import { createHash, randomBytes } from 'node:crypto';
import { getBrainAccessor } from '../store/memory-accessor.js';
import { upsertGraphNode } from './graph-auto-populate.js';
import { computePatternQuality } from './quality-scoring.js';
import { detectSupersession, supersedeMemory } from './temporal-supersession.js';

/** Pattern types from ADR-009. */
export type PatternType = 'workflow' | 'blocker' | 'success' | 'failure' | 'optimization';

/** Impact level. */
export type PatternImpact = 'low' | 'medium' | 'high';

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
  /**
   * T549 Wave 1-A: origin of this pattern.
   * Used to route sourceConfidence at write time.
   * Values starting with 'auto' map to 'speculative'; otherwise 'agent'.
   */
  source?: string;
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
 * Generate a pattern ID.
 */
function generatePatternId(): string {
  return `P-${randomBytes(4).toString('hex')}`;
}

/**
 * Store a new pattern.
 * If a similar pattern already exists (same type + matching text), increments frequency.
 * @task T4768, T5241
 */
export async function storePattern(projectRoot: string, params: StorePatternParams) {
  if (!params.pattern?.trim()) {
    throw new Error('Pattern description is required');
  }
  if (!params.context?.trim()) {
    throw new Error('Pattern context is required');
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Search for duplicate pattern by normalized text within same type
  const existingPatterns = await accessor.findPatterns({ type: params.type });
  const normalizedInput = params.pattern.trim().toLowerCase();
  const duplicate = existingPatterns.find(
    (e) => e.pattern.trim().toLowerCase() === normalizedInput,
  );

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (duplicate) {
    // Merge examples arrays (union of task IDs)
    const existingExamples: string[] = JSON.parse(duplicate.examplesJson || '[]');
    const newExamples: string[] = params.examples ?? [];
    const mergedExamples = Array.from(new Set([...existingExamples, ...newExamples]));

    await accessor.updatePattern(duplicate.id, {
      frequency: duplicate.frequency + 1,
      extractedAt: now,
      examplesJson: JSON.stringify(mergedExamples),
    });

    const updated = await accessor.getPattern(duplicate.id);

    // Refresh graph node for the updated (incremented) pattern (best-effort, T537).
    upsertGraphNode(
      projectRoot,
      `pattern:${duplicate.id}`,
      'pattern',
      duplicate.pattern.substring(0, 200),
      duplicate.qualityScore ?? 0.5,
      duplicate.pattern + duplicate.context,
      {
        type: duplicate.type,
        impact: duplicate.impact ?? undefined,
        frequency: duplicate.frequency + 1,
      },
    ).catch(() => {
      /* best-effort */
    });

    return {
      ...updated!,
      examples: mergedExamples,
    };
  }

  // T549 Wave 1-A: Tier routing for patterns.
  // Patterns are medium-term procedural entries — they describe how things work.
  // sourceConfidence routing (spec §4.1 Decision Tree):
  //   - source starts with 'auto' → 'speculative' (auto-extracted, unconfirmed)
  //   - otherwise → 'agent' (agent-observed during work)
  // memoryTier = 'medium' (patterns have more than one observation and are project-scoped)
  // memoryType = 'procedural' (patterns are always process knowledge)
  // verified = false (patterns need validation through repetition, not boolean gate)
  const memoryTier = 'medium' as const;
  const memoryType = 'procedural' as const;
  const sourceConfidence = params.source?.startsWith('auto')
    ? ('speculative' as const)
    : ('agent' as const);
  const verified = false;

  // Compute quality score based on type, content richness, examples,
  // and T549 source multiplier.
  const examplesJson = params.examples ? JSON.stringify(params.examples) : '[]';
  const qualityScore = computePatternQuality({
    type: params.type,
    pattern: params.pattern.trim(),
    context: params.context.trim(),
    examples_json: examplesJson,
    sourceConfidence,
    memoryTier,
  });

  // T737: compute content hash for hash-dedup gating
  const contentHashValue = createHash('sha256')
    .update(params.pattern.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);

  // Create new entry
  const entry = {
    id: generatePatternId(),
    type: params.type,
    pattern: params.pattern.trim(),
    context: params.context.trim(),
    frequency: 1,
    successRate: params.successRate ?? null,
    impact: params.impact ?? null,
    antiPattern: params.antiPattern ?? null,
    mitigation: params.mitigation ?? null,
    examplesJson,
    extractedAt: now,
    qualityScore,
    // T549 Wave 1-A: tier/type/confidence assigned at write time
    memoryTier,
    memoryType,
    sourceConfidence,
    verified,
    // T737: content hash for dedup gating
    contentHash: contentHashValue,
  };

  const saved = await accessor.addPattern(entry);

  // Auto-populate graph node for the new pattern (best-effort, T537).
  upsertGraphNode(
    projectRoot,
    `pattern:${saved.id}`,
    'pattern',
    saved.pattern.substring(0, 200),
    qualityScore,
    saved.pattern + saved.context,
    { type: saved.type, impact: saved.impact ?? undefined },
  ).catch(() => {
    /* best-effort */
  });

  // T738: Auto-fire detectSupersession only for high-trust writes.
  // Agent/speculative confidence patterns rely on sleep-consolidation dedup instead.
  // Only 'owner' or 'task-outcome' sourceConfidence triggers write-time supersession.
  if ((sourceConfidence as string) === 'owner' || (sourceConfidence as string) === 'task-outcome') {
    detectSupersession(projectRoot, {
      id: saved.id,
      text: saved.pattern + ' ' + saved.context,
      createdAt: saved.extractedAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
    })
      .then((candidates) => {
        for (const candidate of candidates) {
          supersedeMemory(
            projectRoot,
            candidate.existingId,
            saved.id,
            'auto:pattern-supersedes — high overlap detected at store time',
          ).catch(() => {
            /* best-effort */
          });
        }
      })
      .catch(() => {
        /* best-effort */
      });
  }

  return {
    ...saved,
    examples: JSON.parse(saved.examplesJson || '[]'),
  };
}

/**
 * Search patterns by criteria.
 * @task T4768, T5241
 */
export async function searchPatterns(projectRoot: string, params: SearchPatternParams = {}) {
  const accessor = await getBrainAccessor(projectRoot);

  // Note: findPatterns from accessor handles basic filtering
  let entries = await accessor.findPatterns({
    type: params.type,
    impact: params.impact,
    minFrequency: params.minFrequency,
    limit: params.limit,
  });

  if (params.query) {
    const q = params.query.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.pattern.toLowerCase().includes(q) ||
        e.context.toLowerCase().includes(q) ||
        e.antiPattern?.toLowerCase().includes(q) ||
        e.mitigation?.toLowerCase().includes(q),
    );
  }

  return entries.map((e) => ({
    ...e,
    examples: JSON.parse(e.examplesJson || '[]'),
  }));
}

/**
 * Get pattern statistics.
 * @task T4768, T5241
 */
export async function patternStats(projectRoot: string) {
  const accessor = await getBrainAccessor(projectRoot);
  const entries = await accessor.findPatterns(); // get all

  const byType: Record<string, number> = {
    workflow: 0,
    blocker: 0,
    success: 0,
    failure: 0,
    optimization: 0,
  };
  const byImpact: Record<string, number> = { low: 0, medium: 0, high: 0, unknown: 0 };

  let highest: { pattern: string; frequency: number } | null = null;

  for (const entry of entries) {
    byType[entry.type] = (byType[entry.type] || 0) + 1;
    byImpact[entry.impact ?? 'unknown'] = (byImpact[entry.impact ?? 'unknown'] || 0) + 1;
    if (!highest || entry.frequency > highest.frequency) {
      highest = { pattern: entry.pattern, frequency: entry.frequency };
    }
  }

  return {
    total: entries.length,
    byType,
    byImpact,
    highestFrequency: highest,
  };
}
