/**
 * ModelConfig and related types for the CLEO LLM layer.
 *
 * All five core LLM types (`ModelTransport`, `PromptCachePolicyMode`,
 * `PromptCachePolicy`, `ModelConfig`, `LLMCallResult`) are re-exported from
 * the canonical SSoT in `@cleocode/contracts/operations/llm` (T1716).
 *
 * @task T1386
 */

export type { DaemonLLMConfig, LlmConfig, LlmProviderEntry } from '@cleocode/contracts';
export type {
  LLMCallParams,
  LLMCallResult,
  ModelConfig,
  ModelTransport,
  PromptCachePolicy,
  PromptCachePolicyMode,
  ToolCallParams,
  ToolResult,
} from '@cleocode/contracts/operations/llm';
