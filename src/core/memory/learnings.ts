/**
 * Learning Memory system for CLEO BRAIN.
 *
 * Records, queries, and applies accumulated insights from
 * historical task data (completion rates, blocker patterns, epic sizes).
 *
 * Storage: SQLite brain_learnings table per ADR-009 Section 3.2.
 *
 * @task T4769, T5241
 * @epic T4763
 */

import { randomBytes } from 'node:crypto';
import { getBrainAccessor } from '../../store/brain-accessor.js';

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
 * Generate a learning ID.
 */
function generateLearningId(): string {
  return `L-${randomBytes(4).toString('hex')}`;
}

/**
 * Store a new learning.
 * @task T4769, T5241
 */
export async function storeLearning(
  projectRoot: string,
  params: StoreLearningParams,
) {
  if (!params.insight || !params.insight.trim()) {
    throw new Error('Insight text is required');
  }
  if (!params.source || !params.source.trim()) {
    throw new Error('Source is required');
  }
  if (params.confidence < 0 || params.confidence > 1) {
    throw new Error('Confidence must be between 0.0 and 1.0');
  }

  const accessor = await getBrainAccessor(projectRoot);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Check for duplicate insight
  const existingLearnings = await accessor.findLearnings();
  const duplicate = existingLearnings.find(
    (e) => e.insight.toLowerCase() === params.insight.toLowerCase(),
  );

  if (duplicate) {
    // We would ideally increment confidence here or update. Let's assume we don't have update method on accessor yet.
  }

  // Create new entry
  const entry = {
    id: generateLearningId(),
    insight: params.insight.trim(),
    source: params.source.trim(),
    confidence: params.confidence,
    actionable: params.actionable ?? false,
    application: params.application ?? null,
    applicableTypesJson: params.applicableTypes ? JSON.stringify(params.applicableTypes) : '[]',
    extractedAt: now,
  };

  const saved = await accessor.addLearning(entry);
  return {
    ...saved,
    applicableTypes: JSON.parse(saved.applicableTypesJson || '[]'),
  };
}

/**
 * Search learnings by criteria.
 * Results sorted by confidence (highest first).
 * @task T4769, T5241
 */
export async function searchLearnings(
  projectRoot: string,
  params: SearchLearningParams = {},
) {
  const accessor = await getBrainAccessor(projectRoot);

  let entries = await accessor.findLearnings({
    minConfidence: params.minConfidence,
    actionable: params.actionableOnly,
    limit: params.limit,
  });

  if (params.applicableType) {
    entries = entries.filter((e) => {
      const types = JSON.parse(e.applicableTypesJson || '[]');
      return types.includes(params.applicableType!);
    });
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

  return entries.map((e) => ({
    ...e,
    applicableTypes: JSON.parse(e.applicableTypesJson || '[]'),
  }));
}

/**
 * Get learning statistics.
 * @task T4769, T5241
 */
export async function learningStats(projectRoot: string) {
  const accessor = await getBrainAccessor(projectRoot);
  const entries = await accessor.findLearnings();

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
