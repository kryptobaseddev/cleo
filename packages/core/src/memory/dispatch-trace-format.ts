/**
 * Dispatch-trace text format — the single owner of how a {@link DispatchTrace}
 * is serialized into BRAIN.
 *
 * Split out of `dispatch-trace.ts` (T12519) so readers that need to RECOGNISE a
 * stored trace (the spawn-prompt PSYCHE-MEMORY budget) can import the format
 * without loading the extraction-gate write path. Stored traces carry no
 * distinguishing column — they land in `brain_patterns` as
 * `type='workflow'`, `source_confidence='agent'`, exactly like real patterns —
 * so the writer-owned text prefix is the only reliable marker.
 *
 * @module dispatch-trace-format
 * @task T1325
 * @task T12519
 */

import type { DispatchTrace } from '@cleocode/contracts';

/**
 * Leading text of every serialized dispatch trace. Readers use it to identify
 * stored traces; the writer uses it to produce them, so the two cannot drift.
 */
export const DISPATCH_TRACE_TEXT_PREFIX = 'Dispatch trace for task ';

/**
 * Serialize a {@link DispatchTrace} into the plain-text format stored in BRAIN.
 *
 * The format is intentionally human-readable so the extract pipeline can parse
 * it without JSON parsing — LLM extraction works on prose, not structured data.
 *
 * @param trace - The dispatch trace to serialize.
 * @returns Plain-text representation suitable for BRAIN storage.
 */
export function buildTraceText(trace: DispatchTrace): string {
  const lines: string[] = [
    `${DISPATCH_TRACE_TEXT_PREFIX}${trace.taskId}:`,
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

/**
 * Whether stored memory text is a serialized dispatch trace.
 *
 * @param text - Stored BRAIN text (e.g. a `brain_patterns.pattern` value).
 * @returns `true` when the text was produced by {@link buildTraceText}.
 */
export function isDispatchTraceText(text: string): boolean {
  return text.startsWith(DISPATCH_TRACE_TEXT_PREFIX);
}
