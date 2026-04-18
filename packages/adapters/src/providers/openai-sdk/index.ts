/**
 * @packageDocumentation
 *
 * CLEO provider adapter for the OpenAI provider, backed by the Vercel AI SDK.
 * Default export is the adapter class for dynamic loading by AdapterManager.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 */

import { OpenAiSdkAdapter } from './adapter.js';

export { OpenAiSdkAdapter } from './adapter.js';
export type {
  CleoGuardrailResult,
  CleoInputGuardrail,
  CleoInputGuardrailFunctionArgs,
  InputGuardrail,
} from './guardrails.js';
export {
  buildDefaultGuardrails,
  buildPathGuardrail,
  buildToolAllowlistGuardrail,
  evaluateGuardrails,
  isPathAllowed,
} from './guardrails.js';
export type { Agent, CleoAgent, TopologyOptions, WorkerArchetype } from './handoff.js';
export {
  buildAgentTopology,
  buildLeadAgent,
  buildStandaloneAgent,
  buildWorkerAgent,
  WORKER_ARCHETYPES,
} from './handoff.js';
export { OpenAiSdkInstallProvider } from './install.js';
export type { OpenAiSdkSpawnOptions } from './spawn.js';
export {
  OpenAiSdkSpawnProvider,
  registerTraceProcessor,
  setTracingDisabled,
  unregisterTraceProcessor,
} from './spawn.js';
export type {
  CleoAgentSpanData,
  CleoFunctionSpanData,
  CleoGenericSpanData,
  CleoHandoffSpanData,
  CleoSpan,
  CleoSpanData,
  CleoSpanKind,
  CleoTrace,
  CleoTraceProcessor,
} from './tracing.js';
export { CleoConduitTraceProcessor } from './tracing.js';

export default OpenAiSdkAdapter;

/**
 * Factory function for creating adapter instances.
 * Used by AdapterManager's dynamic import fallback.
 *
 * @remarks
 * This is the primary entry point for dynamic adapter loading.
 * AdapterManager calls this function when it resolves the openai-sdk
 * provider via its import-based discovery mechanism.
 *
 * @returns A new {@link OpenAiSdkAdapter} instance ready for initialization.
 *
 * @example
 * ```typescript
 * import { createAdapter } from '@cleocode/adapters/providers/openai-sdk';
 *
 * const adapter = createAdapter();
 * await adapter.initialize('/path/to/project');
 * ```
 */
export function createAdapter(): OpenAiSdkAdapter {
  return new OpenAiSdkAdapter();
}
