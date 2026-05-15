/**
 * Shim: provides a cleoLlmCallInner stub for callers not yet migrated to
 * ConcreteExecutor / LlmTransport.
 *
 * The implementation always throws because the ProviderBackend layer was
 * removed in T9289 (W2c). Callers are expected to migrate in T9298 (W5).
 *
 * TODO(T9298 W5): delete this file once api.ts and tool-loop.ts migrate to
 * ConcreteExecutor / LlmTransport event stream.
 *
 * @module llm/shim-executor
 * @deprecated Use {@link ConcreteExecutor} via {@link getLlmExecutor} instead.
 * @task T9292
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { LlmCallInnerParams } from './legacy-types.js';
import type { LLMCallResponse, LLMStreamChunk } from './types.js';

export type { LlmCallInnerParams };

/**
 * Stub replacement for the removed cleoLlmCallInner function.
 *
 * Always throws — the ProviderBackend transport layer was removed in T9289.
 * Callers must migrate to {@link ConcreteExecutor} (T9298 W5).
 *
 * @deprecated Migrate to ConcreteExecutor / getLlmExecutor (T9298 W5).
 */
export async function cleoLlmCallInner(
  params: LlmCallInnerParams & { stream: true },
): Promise<AsyncGenerator<LLMStreamChunk>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams & { stream?: false },
): Promise<LLMCallResponse<unknown>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams,
): Promise<LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>>;
export async function cleoLlmCallInner(
  params: LlmCallInnerParams,
): Promise<LLMCallResponse<unknown> | AsyncGenerator<LLMStreamChunk>> {
  throw new Error(
    `cleoLlmCallInner: ProviderBackend removed (T9289). ` +
      `Migrate to ConcreteExecutor / getLlmExecutor for provider='${params.provider}' ` +
      `model='${params.model}'. See T9298 W5.`,
  );
}
