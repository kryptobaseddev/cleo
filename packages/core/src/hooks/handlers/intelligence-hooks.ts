/**
 * Intelligence Hook Handlers — Wave 5-D/E of T549
 *
 * Best-effort intelligence side-effects wired into task lifecycle events.
 *
 * On task start → calculate risk; if riskScore exceeds the HIGH threshold
 * (≥ 0.8), store a warning observation so future agents see it.
 *
 * All handlers are fire-and-forget: failures MUST NOT propagate or block the
 * operation that triggered them.
 *
 * @task T549
 * @epic T549
 */

import { hooks } from '../registry.js';
import type { PreToolUsePayload } from '../types.js';

// Risk thresholds — mirror RISK_THRESHOLDS in intelligence/prediction.ts
const RISK_HIGH = 0.8;

// ============================================================================
// Task Start — Risk Detection
// ============================================================================

/**
 * Handle task start: calculate risk and store a warning observation if the
 * riskScore is at or above the HIGH threshold (≥ 0.8).
 *
 * Uses deferred imports so this module can be imported in environments where
 * not all transitive dependencies (brain.db, tasks.db) are present.
 *
 * Best-effort: any error is silently swallowed.
 */
export async function handleTaskStartIntelligence(
  projectRoot: string,
  payload: PreToolUsePayload,
): Promise<void> {
  try {
    // Deferred relative imports — avoids circular dependency issues and keeps
    // this module loadable in environments where brain.db is not initialised.
    const { getAccessor } = await import('../../store/data-accessor.js');
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const { calculateTaskRisk } = await import('../../intelligence/prediction.js');
    const { observeBrain } = await import('../../memory/brain-retrieval.js');

    const [accessor, brain] = await Promise.all([
      getAccessor(projectRoot),
      getBrainAccessor(projectRoot),
    ]);

    const risk = await calculateTaskRisk(payload.taskId, accessor, brain);

    if (risk.riskScore >= RISK_HIGH) {
      const level = risk.riskScore >= 0.95 ? 'critical' : 'high';
      const factorNames = risk.factors.map((f) => f.name).join(', ');
      await observeBrain(projectRoot, {
        text: `Risk alert for ${payload.taskId} (score ${risk.riskScore.toFixed(2)}): ${factorNames}. ${risk.recommendation}`,
        title: `Task risk: ${level} — ${payload.taskId}`,
        type: 'discovery',
        sourceType: 'agent',
      });
    }
  } catch {
    // Best-effort — never block task start
  }
}

// ============================================================================
// Registration
// ============================================================================

hooks.register({
  id: 'intelligence-task-start',
  event: 'PreToolUse',
  handler: handleTaskStartIntelligence,
  // Priority 50: runs after brain-tool-start (100) so the task observation is
  // already persisted before we assess risk.
  priority: 50,
});
