/**
 * buildRetrievalBundle — SDK tool wrapping the multi-pass retrieval bundle builder.
 *
 * Executes up to three passes in parallel (cold/warm/hot) to assemble a
 * structured context bundle for agent briefing within a token budget.
 *
 * @arch SDK Tool (Category B) — pure-functional, contracts-typed, no I/O at top level
 * @task T10070
 * @epic T9835
 */

import type { BuildRetrievalBundleInput, BuildRetrievalBundleOutput } from '@cleocode/contracts';
import type { JsonSchema, RegisteredSdkTool } from '../task-tools/sdk-tool.js';
import { defineSdkTool } from '../task-tools/sdk-tool.js';

const INPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    req: {
      type: 'object',
      description: 'Retrieval request: peerId, sessionId, optional query and passMask.',
      properties: {
        peerId: { type: 'string', description: 'CANT peer identifier.' },
        sessionId: { type: 'string', description: 'Active session identifier.' },
        query: { type: 'string', description: 'Optional search term to scope learnings.' },
        tokenBudget: {
          type: 'number',
          description: 'Maximum tokens for the bundle (default 4000).',
        },
        passMask: {
          type: 'object',
          description: 'Enable/disable cold, warm, and hot passes.',
          properties: {
            cold: { type: 'boolean' },
            warm: { type: 'boolean' },
            hot: { type: 'boolean' },
          },
        },
      },
      required: ['peerId', 'sessionId'],
    },
    projectRoot: { type: 'string', description: 'Absolute path to the project root.' },
  },
  required: ['req', 'projectRoot'],
};

const OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    bundle: {
      type: 'object',
      description: 'Multi-pass retrieval bundle with cold/warm/hot passes and token counts.',
      properties: {
        cold: { type: 'object', description: 'User profile + peer instructions + sigil card.' },
        warm: { type: 'object', description: 'Peer learnings + patterns + decisions.' },
        hot: {
          type: 'object',
          description: 'Session narrative + recent observations + active tasks.',
        },
        tokenCounts: {
          type: 'object',
          description: 'Per-pass and total token estimate.',
          properties: {
            cold: { type: 'number' },
            warm: { type: 'number' },
            hot: { type: 'number' },
            total: { type: 'number' },
          },
        },
      },
    },
  },
};

/**
 * Build a multi-pass BRAIN retrieval bundle for agent briefing.
 *
 * Delegates to `buildRetrievalBundle` from the memory/retrieval module.
 * Runs cold (20%), warm (50%), and hot (30%) passes in parallel and
 * enforces token budget by trimming the hot pass first.
 *
 * @param input - Retrieval request and project root
 * @returns Fully-structured retrieval bundle with token accounting
 *
 * @example
 * ```typescript
 * const output = await buildRetrievalBundle.invoke({
 *   req: {
 *     peerId: 'cleo-prime',
 *     sessionId: 'ses_abc',
 *     passMask: { cold: true, warm: true, hot: false },
 *   },
 *   projectRoot: '/mnt/projects/cleocode',
 * });
 * console.assert(typeof output.bundle.tokenCounts.total === 'number');
 * console.assert(Array.isArray(output.bundle.warm.peerLearnings));
 * ```
 */
async function buildRetrievalBundleFn(
  input: BuildRetrievalBundleInput,
): Promise<BuildRetrievalBundleOutput> {
  const { buildRetrievalBundle: build } = await import(
    '../memory/retrieval/build-retrieval-bundle.js'
  );
  const bundle = await build(input.req, input.projectRoot);
  return { bundle };
}

/** Registered SDK tool for building multi-pass BRAIN retrieval bundles. */
export const buildRetrievalBundle: RegisteredSdkTool<
  BuildRetrievalBundleInput,
  Promise<BuildRetrievalBundleOutput>
> = defineSdkTool({
  identity: {
    name: 'build-retrieval-bundle',
    description:
      'Build a multi-pass BRAIN retrieval bundle (cold/warm/hot) for agent briefing within a token budget.',
    version: '1.0.0',
  },
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  fn: buildRetrievalBundleFn,
});
