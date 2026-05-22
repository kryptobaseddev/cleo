/**
 * fetchBrainEntries — SDK tool wrapping fetchBrainEntries from memory/retrieval.
 *
 * Layer 3 of the 3-layer BRAIN retrieval pattern (search → timeline → fetch).
 * Batch-fetches full entry details by IDs, grouped by type prefix.
 *
 * @arch SDK Tool (Category B) — pure-functional, contracts-typed, no I/O at top level
 * @task T10070
 * @epic T9835
 */

import type { FetchBrainEntriesInput, FetchBrainEntriesOutput } from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
    params: {
      type: 'object',
      description: 'Fetch parameters forwarded to fetchBrainEntries.',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entry identifiers to fetch in a single batch.',
        },
      },
      required: ['ids'],
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
        results: { type: 'array', description: 'Resolved entries with full row payload.' },
        notFound: { type: 'array', description: 'IDs that could not be resolved.' },
        tokensEstimated: { type: 'number', description: 'Approximate token cost.' },
      },
    },
  },
};

/**
 * Batch-fetch full BRAIN entry details by IDs.
 *
 * Delegates to `fetchBrainEntries` from the memory/retrieval module.
 * Groups IDs by prefix (D-, P-, L-, O-) to query the correct tables.
 *
 * @param input - Project root and fetch params with IDs
 * @returns Full entry data for each resolved ID, plus not-found list
 *
 * @example
 * ```typescript
 * const output = await fetchBrainEntries.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   params: { ids: ['D-arch-001', 'O-abc123'] },
 * });
 * console.assert(Array.isArray(output.result.results));
 * console.assert(Array.isArray(output.result.notFound));
 * ```
 */
async function fetchBrainEntriesFn(
  input: FetchBrainEntriesInput,
): Promise<FetchBrainEntriesOutput> {
  const { fetchBrainEntries: fetch } = await import('../../memory/retrieval/fetch.js');
  const result = await fetch(input.projectRoot, input.params);
  return { result };
}

/** Registered SDK tool for batch-fetching full BRAIN entry details (Layer 3). */
export const fetchBrainEntries: RegisteredSdkTool<
  FetchBrainEntriesInput,
  Promise<FetchBrainEntriesOutput>
> = defineSdkTool({
  identity: {
    name: 'fetch-brain-entries',
    description:
      'Batch-fetch full BRAIN entry details by IDs (Layer 3 of the 3-layer retrieval pattern).',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: fetchBrainEntriesFn,
});
