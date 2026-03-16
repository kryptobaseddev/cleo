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
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import { getLastHandoff } from '../sessions/handoff.js';

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
      lines.push(`- [${d.id}] ${d.decision.slice(0, 120)} (${date})`);
    }
    lines.push('');
  }

  // --- Learnings ---
  const learnings = queryHighConfidenceLearnings(nativeDb, cfg.maxLearnings);
  if (learnings.length > 0) {
    lines.push('## Key Learnings');
    lines.push('');
    for (const l of learnings) {
      lines.push(`- [${l.id}] ${l.insight.slice(0, 150)} (confidence: ${l.confidence})`);
    }
    lines.push('');
  }

  // --- Patterns (follow) ---
  const followPatterns = queryPatterns(nativeDb, 'success', cfg.maxPatterns);
  if (followPatterns.length > 0) {
    lines.push('## Patterns to Follow');
    lines.push('');
    for (const p of followPatterns) {
      lines.push(`- [${p.id}] ${p.pattern.slice(0, 150)} (${p.type})`);
    }
    lines.push('');
  }

  // --- Anti-patterns (avoid) ---
  if (cfg.includeAntiPatterns) {
    const avoidPatterns = queryPatterns(nativeDb, 'failure', cfg.maxPatterns);
    if (avoidPatterns.length > 0) {
      lines.push('## Anti-Patterns to Avoid');
      lines.push('');
      for (const p of avoidPatterns) {
        lines.push(`- [${p.id}] AVOID: ${p.pattern.slice(0, 150)}`);
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
      lines.push(`- [${o.id}] ${date}: ${o.title.slice(0, 120)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write memory bridge content to .cleo/memory-bridge.md.
 */
export async function writeMemoryBridge(
  projectRoot: string,
  config?: Partial<MemoryBridgeConfig>,
): Promise<{ path: string; written: boolean }> {
  const cleoDir = join(projectRoot, '.cleo');
  const bridgePath = join(cleoDir, 'memory-bridge.md');

  try {
    const content = await generateMemoryBridgeContent(projectRoot, config);

    if (!existsSync(cleoDir)) {
      mkdirSync(cleoDir, { recursive: true });
    }

    // Only write if content changed (avoid unnecessary git noise)
    if (existsSync(bridgePath)) {
      const existing = readFileSync(bridgePath, 'utf-8');
      // Compare without the timestamp line
      const stripTimestamp = (s: string) =>
        s.replace(/^> Auto-generated at .*/m, '');
      if (stripTimestamp(existing) === stripTimestamp(content)) {
        return { path: bridgePath, written: false };
      }
    }

    writeFileSync(bridgePath, content, 'utf-8');
    return { path: bridgePath, written: true };
  } catch (err) {
    console.error('[CLEO] Failed to write memory bridge:', err instanceof Error ? err.message : String(err));
    return { path: bridgePath, written: false };
  }
}

/**
 * Best-effort refresh: call from session.end, tasks.complete, or memory.observe.
 * Never throws.
 */
export async function refreshMemoryBridge(projectRoot: string): Promise<void> {
  try {
    await writeMemoryBridge(projectRoot);
  } catch (err) {
    console.error('[CLEO] Memory bridge refresh failed:', err instanceof Error ? err.message : String(err));
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

function queryRecentDecisions(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  limit: number,
): DecisionRow[] {
  try {
    return db
      .prepare(
        'SELECT id, decision, created_at FROM brain_decisions ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit) as unknown as DecisionRow[];
  } catch {
    return [];
  }
}

function queryHighConfidenceLearnings(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  limit: number,
): LearningRow[] {
  try {
    return db
      .prepare(
        `SELECT id, insight, confidence, created_at FROM brain_learnings
         ORDER BY confidence DESC, created_at DESC
         LIMIT ?`,
      )
      .all(limit) as unknown as LearningRow[];
  } catch {
    return [];
  }
}

function queryPatterns(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  type: string,
  limit: number,
): PatternRow[] {
  try {
    return db
      .prepare(
        'SELECT id, pattern, type, impact, extracted_at FROM brain_patterns WHERE type = ? ORDER BY extracted_at DESC LIMIT ?',
      )
      .all(type, limit) as unknown as PatternRow[];
  } catch {
    return [];
  }
}

function queryRecentObservations(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  limit: number,
): ObservationRow[] {
  try {
    return db
      .prepare(
        `SELECT id, title, type, created_at FROM brain_observations
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as ObservationRow[];
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
