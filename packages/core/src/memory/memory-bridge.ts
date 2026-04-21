/**
 * Memory Bridge Generator
 *
 * Generates .cleo/memory-bridge.md from brain.db content. This file is
 * @-referenced by CLEO-INJECTION.md so that any provider (Claude Code,
 * OpenCode, Cursor, etc.) automatically loads project memory context.
 *
 * Content assembly:
 *   - Last session handoff summary
 *   - High-confidence learnings
 *   - Active patterns (follow + avoid)
 *   - Recent decisions
 *   - Recent observations
 *
 * Regeneration triggers:
 *   - session.end
 *   - tasks.complete
 *   - memory.observe (high-confidence observations only)
 *   - Manual: cleo refresh-memory
 *
 * @task T5240
 * @epic T5149
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getLastHandoff } from '../sessions/handoff.js';
import { resolveBridgeMode } from '../system/bridge-mode.js';

/** Configuration for memory bridge content generation. */
export interface MemoryBridgeConfig {
  maxObservations: number;
  maxLearnings: number;
  maxPatterns: number;
  maxDecisions: number;
  includeHandoff: boolean;
  includeAntiPatterns: boolean;
}

/** Default configuration. */
const DEFAULT_CONFIG: MemoryBridgeConfig = {
  maxObservations: 10,
  maxLearnings: 8,
  maxPatterns: 8,
  maxDecisions: 5,
  includeHandoff: true,
  includeAntiPatterns: true,
};

// ============================================================================
// Memory Decay Configuration (T028)
// ============================================================================

/**
 * Confidence decay for old memories.
 *
 * effectiveConfidence = confidence * decayRate ^ (ageDays / halfLifeDays)
 *
 * With defaults: confidence halves every 90 days.
 * A 0.9-confidence learning that is 180 days old has effective confidence:
 *   0.9 * 0.5^(180/90) = 0.9 * 0.25 = 0.225 → would be filtered out (< 0.6 threshold).
 *
 * Memories with an `updated_at` timestamp use that instead of `created_at`,
 * so referenced/updated memories decay more slowly.
 */
const DECAY_RATE = 0.5;
const DECAY_HALF_LIFE_DAYS = 90;
const DECAY_MIN_CONFIDENCE_THRESHOLD = 0.6;

/** Type-safe wrapper for StatementSync.all(). */
function typedAll<T>(db: DatabaseSync, sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Raw row shapes from native SQL queries. */
interface DecisionRow {
  id: string;
  decision: string;
  created_at: string;
}

interface PatternRow {
  id: string;
  pattern: string;
  type: string;
  impact: string;
  extracted_at: string;
}

interface LearningRow {
  id: string;
  insight: string;
  confidence: string;
  created_at: string;
  updated_at: string | null;
}

interface ObservationRow {
  id: string;
  title: string;
  type: string;
  created_at: string;
}

/**
 * Generate memory bridge content from brain.db.
 * Returns the markdown string (does not write to disk).
 */
export async function generateMemoryBridgeContent(
  projectRoot: string,
  config?: Partial<MemoryBridgeConfig>,
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // Ensure brain.db is initialized
  const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return buildEmptyBridge();
  }

  const lines: string[] = [
    '# CLEO Memory Bridge',
    '',
    `> Auto-generated at ${new Date().toISOString().slice(0, 19)}`,
    '> Do not edit manually. Regenerate with `cleo refresh-memory`.',
    '',
  ];

  // --- Last session handoff ---
  if (cfg.includeHandoff) {
    const handoffData = await getLastHandoffSafe(projectRoot);
    if (handoffData) {
      const h = handoffData.handoff;
      lines.push('## Last Session');
      lines.push('');
      lines.push(`- **Session**: ${handoffData.sessionId}`);
      if (h.lastTask) {
        lines.push(`- **Last focused task**: ${h.lastTask}`);
      }
      if (h.tasksCompleted.length > 0) {
        lines.push(`- **Completed**: ${h.tasksCompleted.join(', ')}`);
      }
      if (h.nextSuggested.length > 0) {
        lines.push(`- **Next suggested**: ${h.nextSuggested.join(', ')}`);
      }
      if (h.openBlockers.length > 0) {
        lines.push(`- **Open blockers**: ${h.openBlockers.join(', ')}`);
      }
      if (h.note) {
        lines.push(`- **Note**: ${h.note}`);
      }
      lines.push('');
    }
  }

  // --- Decisions ---
  const decisions = queryRecentDecisions(nativeDb, cfg.maxDecisions);
  if (decisions.length > 0) {
    lines.push('## Recent Decisions');
    lines.push('');
    for (const d of decisions) {
      const date = (d.created_at ?? '').slice(0, 10);
      lines.push(`- [${d.id}] ${d.decision.slice(0, 300)} (${date})`);
    }
    lines.push('');
  }

  // --- Learnings ---
  const learnings = queryHighConfidenceLearnings(nativeDb, cfg.maxLearnings);
  if (learnings.length > 0) {
    lines.push('## Key Learnings');
    lines.push('');
    for (const l of learnings) {
      lines.push(`- [${l.id}] ${l.insight.slice(0, 400)} (confidence: ${l.confidence})`);
    }
    lines.push('');
  }

  // --- Patterns to Follow (success, workflow, optimization) ---
  const followPatterns = queryUsefulPatterns(nativeDb, 'follow', cfg.maxPatterns);
  if (followPatterns.length > 0) {
    lines.push('## Patterns to Follow');
    lines.push('');
    for (const p of followPatterns) {
      lines.push(`- [${p.id}] ${p.pattern.slice(0, 300)} (${p.type})`);
    }
    lines.push('');
  }

  // --- Anti-Patterns to Avoid (failure, blocker) ---
  if (cfg.includeAntiPatterns) {
    const avoidPatterns = queryUsefulPatterns(nativeDb, 'avoid', cfg.maxPatterns);
    if (avoidPatterns.length > 0) {
      lines.push('## Anti-Patterns to Avoid');
      lines.push('');
      for (const p of avoidPatterns) {
        lines.push(`- [${p.id}] AVOID: ${p.pattern.slice(0, 300)}`);
      }
      lines.push('');
    }
  }

  // --- Recent observations ---
  const observations = queryRecentObservations(nativeDb, cfg.maxObservations);
  if (observations.length > 0) {
    lines.push('## Recent Observations');
    lines.push('');
    for (const o of observations) {
      const date = (o.created_at ?? '').slice(0, 10);
      lines.push(`- [${o.id}] ${date}: ${o.title.slice(0, 200)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write memory bridge content to .cleo/memory-bridge.md.
 *
 * When `brain.memoryBridge.mode` is `'cli'` (default), the file write is skipped
 * and the function returns `{ written: false }` without error (T999).
 * Set mode to `'file'` to restore legacy file-based injection behavior.
 */
export async function writeMemoryBridge(
  projectRoot: string,
  config?: Partial<MemoryBridgeConfig>,
): Promise<{ path: string; written: boolean }> {
  const cleoDir = join(projectRoot, '.cleo');
  const bridgePath = join(cleoDir, 'memory-bridge.md');

  try {
    // Mode gate (T999): skip file write when mode='cli'
    const mode = await resolveBridgeMode(projectRoot);
    if (mode === 'cli') {
      return { path: bridgePath, written: false };
    }

    const content = await generateMemoryBridgeContent(projectRoot, config);

    if (!existsSync(cleoDir)) {
      mkdirSync(cleoDir, { recursive: true });
    }

    // Only write if content changed (avoid unnecessary git noise)
    if (existsSync(bridgePath)) {
      const existing = readFileSync(bridgePath, 'utf-8');
      // Compare without the timestamp line
      const stripTimestamp = (s: string) => s.replace(/^> Auto-generated at .*/m, '');
      if (stripTimestamp(existing) === stripTimestamp(content)) {
        return { path: bridgePath, written: false };
      }
    }

    writeFileSync(bridgePath, content, 'utf-8');
    return { path: bridgePath, written: true };
  } catch (err) {
    console.error(
      '[CLEO] Failed to write memory bridge:',
      err instanceof Error ? err.message : String(err),
    );
    return { path: bridgePath, written: false };
  }
}

/**
 * Best-effort refresh: call from session.end, tasks.complete, or memory.observe.
 * Never throws.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param scope - Optional session scope for context-aware generation (T139).
 * @param currentTaskId - Optional current task ID for scoped context (T139).
 */
export async function refreshMemoryBridge(
  projectRoot: string,
  scope?: string,
  currentTaskId?: string,
): Promise<void> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);

    if (config.brain?.memoryBridge?.contextAware && scope) {
      await generateContextAwareContent(projectRoot, scope, currentTaskId);
    } else {
      await writeMemoryBridge(projectRoot);
    }
  } catch (err) {
    console.error(
      '[CLEO] Memory bridge refresh failed:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Generate context-aware memory bridge content and write to disk.
 *
 * When `brain.memoryBridge.contextAware` is true and a scope is available,
 * uses hybridSearch() to surface memories relevant to the current scope,
 * then enforces the `brain.memoryBridge.maxTokens` budget.
 *
 * Falls back to standard generation if hybrid search is unavailable.
 * Never throws.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param scope - Session scope string (e.g. 'global', 'epic:T###').
 * @param currentTaskId - Optional current task ID for narrower scoping.
 * @task T139 @epic T134
 */
export async function generateContextAwareContent(
  projectRoot: string,
  scope: string,
  currentTaskId?: string,
): Promise<void> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    const maxTokens = config.brain?.memoryBridge?.maxTokens ?? 2000;

    // Mode gate (T999): skip file write when mode='cli'
    const bridgeMode = await resolveBridgeMode(projectRoot);
    if (bridgeMode === 'cli') {
      return;
    }

    // Build a search query from scope + currentTaskId
    const query = currentTaskId ? `${scope} ${currentTaskId}` : scope;

    let contextSections: string[] = [];
    try {
      const { hybridSearch } = await import('./brain-search.js');
      const hits = await hybridSearch(query, projectRoot, { limit: 10 });
      if (hits && hits.length > 0) {
        contextSections = hits
          .slice(0, 5)
          .map((h) => `- [${h.id}] ${h.title ?? h.text?.slice(0, 120) ?? ''}`);
      }
    } catch {
      // Hybrid search unavailable — fall back to standard generation
      await writeMemoryBridge(projectRoot);
      return;
    }

    // Build content with token budget enforcement (rough estimate: 4 chars/token)
    const charsPerToken = 4;
    const budgetChars = maxTokens * charsPerToken;

    const cleoDir = join(projectRoot, '.cleo');
    const bridgePath = join(cleoDir, 'memory-bridge.md');

    const headerLines = [
      '# CLEO Memory Bridge',
      '',
      `> Auto-generated at ${new Date().toISOString().slice(0, 19)} (context-aware: ${scope})`,
      '> Do not edit manually. Regenerate with `cleo refresh-memory`.',
      '',
    ];

    const contextBlock =
      contextSections.length > 0 ? ['## Relevant Context', '', ...contextSections, ''] : [];

    // Append standard content but enforce token budget
    const standardContent = await generateMemoryBridgeContent(projectRoot);
    const combined = [...headerLines, ...contextBlock].join('\n');
    const remainingChars = budgetChars - combined.length;

    const finalContent =
      remainingChars > 200 ? combined + '\n' + standardContent.slice(0, remainingChars) : combined;

    if (!existsSync(cleoDir)) {
      mkdirSync(cleoDir, { recursive: true });
    }

    writeFileSync(bridgePath, finalContent, 'utf-8');
  } catch {
    // Best-effort — fall through to standard generation
    try {
      await writeMemoryBridge(projectRoot);
    } catch {
      // Ignore
    }
  }
}

// ============================================================================
// Query helpers
// ============================================================================

/** Wrapper around getLastHandoff that never throws. */
async function getLastHandoffSafe(
  projectRoot: string,
): Promise<Awaited<ReturnType<typeof getLastHandoff>> | null> {
  try {
    return await getLastHandoff(projectRoot);
  } catch {
    return null;
  }
}

function queryRecentDecisions(db: DatabaseSync, limit: number): DecisionRow[] {
  try {
    return typedAll<DecisionRow>(
      db,
      'SELECT id, decision, created_at FROM brain_decisions ORDER BY created_at DESC LIMIT ?',
      limit,
    );
  } catch {
    return [];
  }
}

function queryHighConfidenceLearnings(db: DatabaseSync, limit: number): LearningRow[] {
  try {
    // Fetch more than needed so we can apply decay filtering client-side.
    // We fetch 3x the limit to account for entries that will be filtered out.
    const candidates = typedAll<LearningRow>(
      db,
      `SELECT id, insight, confidence, created_at, updated_at FROM brain_learnings
         WHERE CAST(confidence AS REAL) >= 0.3
           AND insight NOT LIKE 'Completed:%'
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      limit * 3,
    );

    // Apply confidence decay based on age (T028).
    // Uses updated_at if available (referenced memories decay slower),
    // otherwise falls back to created_at.
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    return candidates
      .map((row) => {
        const referenceDate = row.updated_at || row.created_at;
        const ageDays = Math.max(0, (now - new Date(referenceDate).getTime()) / MS_PER_DAY);
        const rawConfidence = parseFloat(row.confidence) || 0;
        const effectiveConfidence = rawConfidence * DECAY_RATE ** (ageDays / DECAY_HALF_LIFE_DAYS);
        return { ...row, effectiveConfidence };
      })
      .filter((row) => row.effectiveConfidence >= DECAY_MIN_CONFIDENCE_THRESHOLD)
      .sort((a, b) => b.effectiveConfidence - a.effectiveConfidence)
      .slice(0, limit)
      .map(({ effectiveConfidence, ...row }) => ({
        ...row,
        // Override displayed confidence with effective value for transparency
        confidence: effectiveConfidence.toFixed(2),
      }));
  } catch {
    return [];
  }
}

function queryUsefulPatterns(
  db: DatabaseSync,
  mode: 'follow' | 'avoid',
  limit: number,
): PatternRow[] {
  try {
    const typeFilter =
      mode === 'follow'
        ? "type IN ('success', 'workflow', 'optimization')"
        : "type IN ('failure', 'blocker')";

    return typedAll<PatternRow>(
      db,
      `SELECT id, pattern, type, impact, extracted_at FROM brain_patterns
         WHERE ${typeFilter}
           AND pattern NOT LIKE 'Recurring label%'
           AND pattern NOT LIKE 'Test pattern%'
           AND pattern NOT LIKE 'test'
           AND pattern NOT LIKE 'Audit probe:%'
           AND LENGTH(pattern) > 20
         ORDER BY extracted_at DESC
         LIMIT ?`,
      limit,
    );
  } catch {
    return [];
  }
}

function queryRecentObservations(db: DatabaseSync, limit: number): ObservationRow[] {
  try {
    return typedAll<ObservationRow>(
      db,
      `SELECT id, title, type, created_at FROM brain_observations
         WHERE type != 'change'
           AND title NOT LIKE 'File changed:%'
           AND title NOT LIKE 'Task start:%'
           AND title NOT LIKE 'Task complete:%'
           AND title NOT LIKE '[hook]%'
         ORDER BY created_at DESC LIMIT ?`,
      limit,
    );
  } catch {
    return [];
  }
}

// ============================================================================
// Helpers
// ============================================================================

function buildEmptyBridge(): string {
  return [
    '# CLEO Memory Bridge',
    '',
    `> Auto-generated at ${new Date().toISOString().slice(0, 19)}`,
    '',
    'No brain.db data available yet. Observations will appear here as you work.',
    '',
  ].join('\n');
}
