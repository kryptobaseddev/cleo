/**
 * observeBrain — SDK tool wrapping the observeBrain write path from memory/retrieval.
 *
 * Unified BRAIN write path that persists agent observations into brain_observations.
 * Auto-classifies observation type from text when not provided.
 *
 * @arch SDK Tool (Category B) — pure-functional, contracts-typed, no I/O at top level
 * @task T10070
 * @epic T9835
 */

import type { ObserveBrainInput, ObserveBrainOutput } from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
    params: {
      type: 'object',
      description: 'Observation data forwarded to observeBrain.',
      properties: {
        text: { type: 'string', description: 'Observation narrative to persist.' },
        title: {
          type: 'string',
          description: 'Optional display title; auto-derived when omitted.',
        },
        type: { type: 'string', description: 'Observation type (feature, bugfix, decision, …).' },
        sourceType: { type: 'string', description: 'How the observation was created.' },
        agent: { type: 'string', description: 'Agent provenance identifier.' },
      },
      required: ['text'],
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
        id: { type: 'string', description: 'ID of the newly-persisted observation.' },
        type: { type: 'string', description: 'Resolved observation type.' },
        createdAt: { type: 'string', description: 'ISO 8601 creation timestamp.' },
      },
    },
  },
};

/**
 * Save an observation to the BRAIN.
 *
 * Delegates to `observeBrain` from the memory/retrieval module.
 * Auto-classifies type from text when `params.type` is omitted.
 *
 * @param input - Project root and observation params
 * @returns Created observation ID, type, and timestamp
 *
 * @example
 * ```typescript
 * const output = await observeBrain.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   params: {
 *     text: 'Decided to use ESM-only imports for better tree-shaking.',
 *     title: 'ESM-only import decision',
 *     type: 'decision',
 *   },
 * });
 * console.assert(output.result.id.startsWith('O-'));
 * ```
 */
async function observeBrainFn(input: ObserveBrainInput): Promise<ObserveBrainOutput> {
  const { observeBrain: observe } = await import('../../memory/retrieval/observe.js');
  const result = await observe(input.projectRoot, input.params);
  return { result };
}

/** Registered SDK tool for saving BRAIN observations. */
export const observeBrain: RegisteredSdkTool<
  ObserveBrainInput,
  Promise<ObserveBrainOutput>
> = defineSdkTool({
  identity: {
    name: 'observe-brain',
    description: 'Unified BRAIN write path — saves an observation to brain_observations.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: observeBrainFn,
});
