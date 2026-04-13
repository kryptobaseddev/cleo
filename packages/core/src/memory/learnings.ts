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
import { getBrainAccessor } from '../store/brain-accessor.js';
import { upsertGraphNode } from './graph-auto-populate.js';
import { computeLearningQuality } from './quality-scoring.js';

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
export async function storeLearning(projectRoot: string, params: StoreLearningParams) {
  if (!params.insight?.trim()) {
    throw new Error('Insight text is required');
  }
  if (!params.source?.trim()) {
    throw new Error('Source is required');
  }
  if (params.confidence < 0 || params.confidence > 1) {
    throw new Error('Confidence must be between 0.0 and 1.0');
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Check for duplicate insight by normalized text
  const existingLearnings = await accessor.findLearnings();
  const normalizedInput = params.insight.trim().toLowerCase();
  const duplicate = existingLearnings.find(
    (e) => e.insight.trim().toLowerCase() === normalizedInput,
  );

  if (duplicate) {
    // Take the higher confidence value and update the timestamp
    const maxConfidence = Math.max(duplicate.confidence, params.confidence);
    await accessor.updateLearning(duplicate.id, {
      confidence: maxConfidence,
    });

    const updated = await accessor.getLearning(duplicate.id);

    // Refresh graph node for the updated learning (best-effort, T537).
    upsertGraphNode(
      projectRoot,
      `learning:${duplicate.id}`,
      'learning',
      duplicate.insight.substring(0, 200),
      duplicate.qualityScore ?? 0.5,
      duplicate.insight + (duplicate.application ?? ''),
      { source: duplicate.source, confidence: maxConfidence, actionable: duplicate.actionable },
    ).catch(() => {
      /* best-effort */
    });

    return {
      ...updated!,
      applicableTypes: JSON.parse(updated!.applicableTypesJson || '[]'),
    };
  }

  // T549 Wave 1-A: Tier routing for learnings.
  // Learnings are short-term semantic entries — they start unverified and must earn promotion.
  // sourceConfidence routing (spec §4.1 Decision Tree):
  //   - source contains 'manual' → 'owner' (manually entered learnings are owner-stated)
  //   - source contains 'transcript:ses_' → 'speculative' (transcript-extracted, low confidence)
  //   - otherwise → 'agent' (agent-generated during session grading, hooks, etc.)
  // memoryTier routing:
  //   - source contains 'manual' → 'medium' (owner-stated facts skip short-term)
  //   - otherwise → 'short' (auto/agent learnings start short-term, consolidator promotes)
  // memoryType routing (spec §4.1 Decision Tree for memoryType):
  //   - source contains 'transcript:ses_' → 'episodic' (event-specific insight)
  //   - otherwise → 'semantic' (declarative factual learning)
  // Owner-stated learnings are ground truth (auto-verified).
  // Transcript-extracted and agent-inferred start unverified — consolidator promotes.
  const isManual = params.source.includes('manual');
  const isTranscript = params.source.includes('transcript:ses_');
  const sourceConfidence = isManual
    ? ('owner' as const)
    : isTranscript
      ? ('speculative' as const)
      : ('agent' as const);
  const memoryTier = isManual ? ('medium' as const) : ('short' as const);
  const memoryType = isTranscript ? ('episodic' as const) : ('semantic' as const);
  const verified = isManual;

  // Compute quality score from confidence, actionability, content richness,
  // and T549 source multiplier.
  const qualityScore = computeLearningQuality({
    confidence: params.confidence,
    actionable: params.actionable ?? false,
    insight: params.insight.trim(),
    application: params.application ?? null,
    sourceConfidence,
    memoryTier,
  });

  // Create new entry
  const entry = {
    id: generateLearningId(),
    insight: params.insight.trim(),
    source: params.source.trim(),
    confidence: params.confidence,
    actionable: params.actionable ?? false,
    application: params.application ?? null,
    applicableTypesJson: params.applicableTypes ? JSON.stringify(params.applicableTypes) : '[]',
    qualityScore,
    // T549 Wave 1-A: tier/type/confidence assigned at write time
    memoryTier,
    memoryType,
    sourceConfidence,
    verified,
  };

  const saved = await accessor.addLearning(entry);

  // Auto-populate graph node for the new learning (best-effort, T537).
  upsertGraphNode(
    projectRoot,
    `learning:${saved.id}`,
    'learning',
    saved.insight.substring(0, 200),
    qualityScore,
    saved.insight + (saved.application ?? ''),
    { source: saved.source, confidence: saved.confidence, actionable: saved.actionable },
  ).catch(() => {
    /* best-effort */
  });

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
export async function searchLearnings(projectRoot: string, params: SearchLearningParams = {}) {
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
        e.application?.toLowerCase().includes(q),
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
    averageConfidence:
      entries.length > 0 ? Math.round((totalConfidence / entries.length) * 100) / 100 : 0,
    bySource,
    highConfidence,
    lowConfidence,
  };
}
