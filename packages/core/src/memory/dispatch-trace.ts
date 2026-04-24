/**
 * Dispatch-trace BRAIN hook.
 *
 * Emits a structured {@link DispatchTrace} observation into the BRAIN memory
 * pipeline at the agent-resolver decision point. Each trace captures the
 * classifier's prediction alongside the registry outcome, enabling future
 * training data extraction for the FP peer-note guardrail.
 *
 * Storage contract:
 * - Routes through `verifyAndStore` — never bypasses the extraction gate.
 * - `memoryType = 'pattern'` — procedural knowledge about dispatch behaviour.
 * - `sourceConfidence = 'speculative'` — unverified tier-2 training candidate
 *   until a ground-truth channel is added.
 * - Errors are swallowed (fire-and-forget) so the synchronous resolver path
 *   is never blocked or disrupted by BRAIN write failures.
 *
 * @module dispatch-trace
 * @task T1325
 * @epic T1323
 */

import type { DispatchTrace } from '@cleocode/contracts';
import { verifyAndStore } from './extraction-gate.js';

// ============================================================================
// Public API
// ============================================================================

/**
 * Emit a dispatch-trace observation into the BRAIN memory pipeline.
 *
 * The write is fire-and-forget relative to the synchronous `resolveAgent`
 * path — callers do NOT await this function inside the resolver. Use
 * `.catch(() => undefined)` at the call site to suppress promise-rejection
 * noise when BRAIN is unavailable.
 *
 * @param projectRoot - Absolute path to the project root (for `brain.db` access).
 * @param trace       - The resolved dispatch trace to persist.
 * @returns A promise that resolves when the BRAIN write completes (or is gated/rejected).
 *
 * @task T1325
 */
export async function emitDispatchTrace(projectRoot: string, trace: DispatchTrace): Promise<void> {
  const text = buildTraceText(trace);

  await verifyAndStore(projectRoot, {
    text,
    title: `dispatch-trace: ${trace.predictedAgentId} → ${trace.fallbackUsed ? 'universal-fallback' : 'registry-hit'}`,
    // Dispatch traces are procedural knowledge (process/dispatch behaviour).
    // The task spec names this 'pattern' but the BRAIN schema uses 'procedural'
    // for process knowledge — patterns.ts uses the same value.
    memoryType: 'procedural',
    tier: 'short',
    confidence: 0.5,
    source: 'task-completion',
    sourceConfidence: 'speculative',
  });
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Serialize a {@link DispatchTrace} into the plain-text format stored in BRAIN.
 *
 * The format is intentionally human-readable so the extract pipeline can parse
 * it without JSON parsing — LLM extraction works on prose, not structured data.
 *
 * @param trace - The dispatch trace to serialize.
 * @returns Plain-text representation suitable for BRAIN storage.
 */
function buildTraceText(trace: DispatchTrace): string {
  const lines: string[] = [
    `Dispatch trace for task ${trace.taskId}:`,
    `  predictedAgentId: ${trace.predictedAgentId}`,
    `  confidence: ${trace.confidence}`,
    `  registryHit: ${trace.registryHit}`,
    `  fallbackUsed: ${trace.fallbackUsed}`,
    `  reason: ${trace.reason}`,
    `  resolvedAt: ${trace.resolvedAt}`,
  ];

  if (trace.resolverWarning) {
    lines.push(`  resolverWarning: ${trace.resolverWarning}`);
  }

  return lines.join('\n');
}
