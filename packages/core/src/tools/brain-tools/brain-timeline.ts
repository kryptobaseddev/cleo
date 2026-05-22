/**
 * timelineBrain — SDK tool wrapping timelineBrain from memory/retrieval.
 *
 * Layer 2 of the 3-layer BRAIN retrieval pattern (search → timeline → fetch).
 * Surfaces chronological neighbors around an anchor entry for context reconstruction.
 *
 * @arch SDK Tool (Category B) — pure-functional, contracts-typed, no I/O at top level
 * @task T10070
 * @epic T9835
 */

import type { TimelineBrainInput, TimelineBrainOutput } from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
    params: {
      type: 'object',
      description: 'Timeline parameters forwarded to timelineBrain.',
      properties: {
        anchor: { type: 'string', description: 'Anchor entry ID to build the timeline around.' },
        depthBefore: {
          type: 'number',
          description: 'Chronologically-earlier neighbors to include (default 3).',
        },
        depthAfter: {
          type: 'number',
          description: 'Chronologically-later neighbors to include (default 3).',
        },
      },
      required: ['anchor'],
    },
  },
  required: ['projectRoot', 'params'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    result: {
      type: 'object',
      properties: {
        anchor: { description: 'Anchor entry with full row payload, or null.' },
        before: { type: 'array', description: 'Chronologically-earlier neighbors.' },
        after: { type: 'array', description: 'Chronologically-later neighbors.' },
      },
    },
  },
};

/**
 * Get chronological context around an anchor BRAIN entry.
 *
 * Delegates to `timelineBrain` from the memory/retrieval module.
 * Queries all 4 BRAIN tables via UNION ALL to find neighbors.
 *
 * @param input - Project root and timeline params with anchor ID
 * @returns Anchor entry with surrounding chronological neighbor entries
 *
 * @example
 * ```typescript
 * const output = await timelineBrain.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   params: { anchor: 'O-abc123', depthBefore: 5, depthAfter: 5 },
 * });
 * console.assert(Array.isArray(output.result.before));
 * console.assert(Array.isArray(output.result.after));
 * ```
 */
async function timelineBrainFn(input: TimelineBrainInput): Promise<TimelineBrainOutput> {
  const { timelineBrain: timeline } = await import('../../memory/retrieval/timeline.js');
  const result = await timeline(input.projectRoot, input.params);
  return { result };
}

/** Registered SDK tool for BRAIN chronological timeline (Layer 2). */
export const timelineBrain: RegisteredSdkTool<
  TimelineBrainInput,
  Promise<TimelineBrainOutput>
> = defineSdkTool({
  identity: {
    name: 'timeline-brain',
    description:
      'Get chronological context around a BRAIN anchor entry (Layer 2 of the 3-layer retrieval pattern).',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: timelineBrainFn,
});
