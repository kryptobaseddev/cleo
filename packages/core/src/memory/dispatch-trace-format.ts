/**
 * Dispatch-trace text format — how a {@link DispatchTrace} was serialized into
 * BRAIN.
 *
 * The writer (`dispatch-trace.ts`, called on every agent resolution) is gone
 * (T13946): it produced 14,680 of 14,761 `brain_patterns` rows and no reader
 * ever used them. The rows it left behind remain, so readers still need to
 * RECOGNISE a stored trace: recall excludes them
 * (`memory/eligibility.ts#autoRowExclusionClause`) and the spawn-prompt
 * PSYCHE-MEMORY budget drops them. Stored traces carry no distinguishing
 * column — they sit in `brain_patterns` as `type='workflow'`, exactly like real
 * patterns — so the text prefix is the only reliable marker.
 *
 * @module dispatch-trace-format
 * @task T1325
 * @task T12519
 * @task T13946
 */

import type { DispatchTrace } from '@cleocode/contracts';

/** Leading text of every stored dispatch trace; readers use it to identify them. */
export const DISPATCH_TRACE_TEXT_PREFIX = 'Dispatch trace for task ';

/**
 * Serialize a {@link DispatchTrace} into the plain-text format stored in BRAIN.
 *
 * Kept so tests can build fixtures in the exact stored shape.
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
