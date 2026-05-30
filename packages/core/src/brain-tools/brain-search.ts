/**
 * searchBrain — SDK tool wrapping searchBrainCompact from memory/retrieval.
 *
 * Layer 1 of the 3-layer BRAIN retrieval pattern (search → timeline → fetch).
 * Returns compact index-level hits (~50 tokens/hit) for cheap candidate scanning.
 *
 * @arch SDK Tool (Category B) — pure-functional, contracts-typed, no I/O at top level
 * @task T10070
 * @epic T9835
 */

import type { SearchBrainInput, SearchBrainOutput } from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
    params: {
      type: 'object',
      description: 'Search parameters forwarded to searchBrainCompact.',
      properties: {
        query: { type: 'string', description: 'Free-text search query.' },
        limit: { type: 'number', description: 'Maximum hits to return.' },
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to specific BRAIN tables.',
        },
        mode: { type: 'string', description: 'Ranking mode: hybrid | lexical | recency.' },
      },
      required: ['query'],
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
        results: { type: 'array', description: 'Compact BRAIN hits.' },
        total: { type: 'number', description: 'Total matches before limit.' },
        tokensEstimated: { type: 'number', description: 'Approximate token cost.' },
      },
    },
  },
};

/**
 * Search the BRAIN for compact hits matching a query.
 *
 * Delegates to `searchBrainCompact` from the memory/retrieval module.
 * The implementation is async and performs DB I/O internally but is
 * wrapped here as a pure-signature SDK tool for harness-agnostic registration.
 *
 * @param input - Project root and search params
 * @returns Compact search result envelope
 *
 * @example
 * ```typescript
 * const output = await searchBrain.invoke({
 *   projectRoot: '/mnt/projects/cleocode',
 *   params: { query: 'auth decisions', limit: 5 },
 * });
 * console.assert(Array.isArray(output.result.results));
 * ```
 */
async function searchBrainFn(input: SearchBrainInput): Promise<SearchBrainOutput> {
  const { searchBrainCompact } = await import('../memory/retrieval/search.js');
  const result = await searchBrainCompact(input.projectRoot, input.params);
  return { result };
}

/** Registered SDK tool for BRAIN compact search (Layer 1). */
export const searchBrain: RegisteredSdkTool<
  SearchBrainInput,
  Promise<SearchBrainOutput>
> = defineSdkTool({
  identity: {
    name: 'search-brain',
    description:
      'Token-efficient compact search across BRAIN tables (Layer 1 of the 3-layer retrieval pattern).',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: searchBrainFn,
});
