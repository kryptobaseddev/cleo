/**
 * CLEO LLM layer barrel — exports the public API surface.
 *
 * IMPORTANT (R8): This barrel MUST NOT export types that conflict with
 * the Vercel AI SDK exports used by packages/core/src/memory/llm-backend-resolver.ts.
 * The new raw-SDK orchestration layer and the Vercel AI SDK path are orthogonal.
 *
 * @task T1400 (T1386-W14)
 * @epic T1386
 */

export type { CleoLlmCallParams } from './api.js';
// Public entrypoint
export { cleoLlmCall } from './api.js';
// Multi-provider auxiliary fallback chain (T9319)
export type {
  AllProvidersExhaustedError,
  AuxiliaryFallbackChain,
  AuxiliaryFallbackEntry,
  AuxiliaryFallbackMeta,
  AuxiliaryFallbackResult,
  AuxiliaryProvider,
  FallbackChainStep,
} from './auxiliary-fallback.js';
export {
  DEFAULT_AUXILIARY_FALLBACK_CHAIN,
  parseAuxiliaryFallbackChain,
  runAuxiliaryWithFallback,
} from './auxiliary-fallback.js';
// Backend types — canonical CompletionResult / ProviderBackend shapes used by request-builder, history-adapters, structured-output
export type {
  BackendCallParams,
  CompletionResult,
  ProviderBackend,
  StreamChunk,
  ToolCallResult,
} from './backend.js';
export { makeCompletionResult } from './backend.js';
// Backends (for direct use / custom wiring — AnthropicBackend migrated to transports/anthropic.ts)
export type { GeminiCacheHandle } from './caching.js';
// Caching
export { buildCacheKey, geminiCacheStore, InMemoryGeminiCacheStore } from './caching.js';
export type {
  ModelContextIndex,
  ModelsCatalogEntry,
  ModelsCatalogFile,
  ModelsCatalogProvider,
} from './catalog-cache.js';
// Live catalog cache — models.dev fetch + disk persistence (T9314)
export {
  CatalogRefreshError,
  getCatalogDir,
  loadDiskCatalogIndex,
  MODELS_DEV_URL,
} from './catalog-cache.js';
// Catalog-driven model resolution + validation (T11773 · E8)
export {
  catalogKeyForProvider,
  resolveProviderDefaultModel,
  validateModelForProvider,
} from './catalog-model-resolver.js';
// `cleo llm` CLI / dispatch engine ops (T9258 — T-LLM-CRED Phase 2 / T-llm-4)
export {
  llmAdd,
  llmAuxiliaryStatus,
  llmList,
  llmProfile,
  llmRemove,
  llmTest,
  llmUse,
  llmWhoami,
  resolveAuxiliaryFallbackChain,
} from './cli-ops.js';
// New Phase 4 executor layer (T9290/T9291)
export type { ConcreteExecutorOptions } from './concrete-executor.js';
export { ConcreteExecutor } from './concrete-executor.js';
// ContextEngine plugin registry (T9312)
export {
  _resetContextEngineRegistryForTesting,
  getContextEngine,
  listContextEngines as listContextEnginesByName,
  registerContextEngine as registerNamedContextEngine,
} from './context-engines/index.js';
// RuleBasedTruncationEngine (T9312)
export {
  KEEP_TAIL,
  MIN_TRUNCATION_TOKENS,
  RuleBasedTruncationEngine,
  TRUNCATION_RATIO,
} from './context-engines/rule-based-truncation.js';
// Conversation utilities
export { countMessageTokens, truncateMessagesToFit } from './conversation.js';
// Credential removal — RemovalStep registry + suppression state
// (E-CONFIG-AUTH-UNIFY E2a / T9415)
export type {
  RemovalResult,
  RemovalStep,
  SuppressionEntry,
  SuppressionFile,
} from './credential-removal.js';
export {
  addSuppression,
  buildBuiltinRemovalRegistry,
  CLAUDE_CODE_REMOVAL_STEP,
  CLEO_PKCE_REMOVAL_STEP,
  CODEX_CLI_REMOVAL_STEP,
  ENV_REMOVAL_STEP,
  GEMINI_CLI_REMOVAL_STEP,
  GH_CLI_REMOVAL_STEP,
  isSuppressed,
  MANUAL_REMOVAL_STEP,
  REMOVAL_REGISTRY,
  RemovalRegistry,
  readSuppressionFile,
  removeSuppression,
  suppressionStatePath,
  writeSuppressionFile,
} from './credential-removal.js';
// Credential seeders — unified pool foundation (E-CONFIG-AUTH-UNIFY E2a / T9408)
// T9409 adds the concrete `EnvSeeder` and the `./register.js` barrel that
// populates `BUILTIN_SEEDERS` at module load. Importing this `llm/index.js`
// implicitly imports `register.js` so consumers of `@cleocode/core/llm` get
// the populated singleton without an explicit second import.
import './credential-seeders/register.js';

// Unified credential pool — seed/pick/list singleton (E-CONFIG-AUTH-UNIFY E2a / T9412)
export type {
  PoolSeedResult,
  SeederStatus,
  UnifiedPoolPickOptions,
} from './credential-pool.js';
export {
  _resetCredentialPoolSingletonForTests,
  getCredentialPool,
  POOL_SEED_CACHE_TTL_MS,
  UnifiedCredentialPool,
} from './credential-pool.js';
export {
  ENV_SEEDER_PRIORITY,
  EnvSeeder,
  registerEnvSeeders,
} from './credential-seeders/env-seeder.js';
export type {
  CredentialSeeder,
  SeederCredentialEntry,
  SeederResult,
  SeederSourceId,
} from './credential-seeders/index.js';
export { BUILTIN_SEEDERS, SeederRegistry } from './credential-seeders/index.js';
export type {
  AuthType,
  CredentialResolveOptions,
  CredentialResult,
  CredentialSource,
} from './credentials.js';
// Credential resolver (T1677 + T-LLM-CRED-CENTRALIZATION Phase 1)
// T9403: `cleoHomeDir` removed — callers MUST use `getCleoHome` from
// `@cleocode/paths` directly so the `CLEO_HOME` env override applies.
export {
  authHeaders,
  clearAnthropicKeyCache,
  defaultTransportApiKey,
  OAUTH_STATUS_PROVIDERS,
  resolveCredentials,
  resolveModelCredentials,
  resolveProviderStatus,
  storeAnthropicApiKey,
} from './credentials.js';
// Credential pool / multi-credential storage (T-LLM-CRED-CENTRALIZATION Phase 2)
export type {
  CredentialsStoreData,
  CredentialsStoreStrategy,
  StoredAuthType,
  StoredCredential,
} from './credentials-store.js';
export {
  addCredential,
  credentialsStorePath,
  getCredentialByLabel,
  listCredentials,
  pickCredentialForProvider,
  pickCredentialForProviderSync,
  removeCredential,
} from './credentials-store.js';
export {
  clearLlmExecutorCache,
  DefaultLlmExecutorFactory,
  getLlmExecutor,
  listContextEngines,
  registerContextEngine,
} from './executor-factory.js';
// History adapters
export {
  AnthropicHistoryAdapter,
  GeminiHistoryAdapter,
  historyAdapterForProvider,
  OpenAIHistoryAdapter,
} from './history-adapters.js';
// One-shot legacy flat-key migration (T9406 — E-CONFIG-AUTH-UNIFY E1)
export type {
  LegacyFlatKeyImportResult,
  LegacyFlatKeyImportStatus,
} from './legacy-flat-key-import.js';
export {
  _resetLegacyFlatKeyImportLatch,
  ensureLegacyFlatAnthropicKeyImported,
  importLegacyFlatAnthropicKey,
  LEGACY_FLAT_KEY_BAK_SUFFIX,
  LEGACY_FLAT_KEY_LABEL,
  LEGACY_FLAT_KEY_MARKER,
} from './legacy-flat-key-import.js';
export type { ModelMetadata } from './model-metadata.js';
// Model metadata — context window resolution (T9264 / T-LLM-CRED Phase 3)
export {
  DEFAULT_CONTEXT_LENGTH,
  getModelContextLength,
  getModelMetadata,
} from './model-metadata.js';
// Prompt-caching strategies (Anthropic) — T9269 / T-LLM-CRED Phase 3
export type {
  CacheControlMarker,
  CacheTtl,
  PromptCachingStrategy,
} from './prompt-caching.js';
export { injectCacheBreakpoints } from './prompt-caching.js';
// Registry — all factory exports retired (D-ph4-01 complete, T9356/T9370)
// clientForModelConfig, buildAnthropicSdkClient removed; historyAdapterForProvider → history-adapters.js
// Role-based LLM resolver (T-LLM-CRED-CENTRALIZATION Phase 2 / T9255)
export type {
  LLMClient,
  ResolutionSource,
  ResolvedLLM,
  ResolveLLMForRoleOptions,
} from './role-resolver.js';
export {
  HYGIENE_FALLBACK_MODEL,
  IMPLICIT_FALLBACK_MODEL,
  IMPLICIT_FALLBACK_PROVIDER,
  resolveAnthropicForRole,
  resolveLLMForRole,
} from './role-resolver.js';
// Runtime
export type { AttemptPlan } from './runtime.js';
export { effectiveTemperature, makeAttemptRef, planAttempt } from './runtime.js';
export type { StructuredOutputFailurePolicy } from './structured-output.js';
// Structured output utilities
export {
  attemptStructuredOutputRepair,
  emptyStructuredOutput,
  executeStructuredOutputCall,
  repairResponseModelJson,
  StructuredOutputError,
  validateStructuredOutput,
} from './structured-output.js';
// Transports (Phase-4/5 LlmTransport implementations)
export type { AnthropicTransportOptions } from './transports/anthropic.js';
export { AnthropicTransport } from './transports/anthropic.js';
// Anthropic client factory — thin factory, D-ph4-01 grep-guard compliant (T9356)
export { buildAnthropicClient } from './transports/anthropic-client-factory.js';
export type { BedrockTransportOptions } from './transports/bedrock.js';
export { BedrockTransport } from './transports/bedrock.js';
export type { CodexResponsesTransportOptions } from './transports/codex-responses.js';
export { CodexResponsesTransport } from './transports/codex-responses.js';
export type { GeminiTransportOptions } from './transports/gemini.js';
export { GeminiTransport } from './transports/gemini.js';
export type { OpenAITransportOptions } from './transports/openai.js';
export { OpenAITransport, usesMaxCompletionTokens } from './transports/openai.js';
// Response / stream types (scoped names to avoid collision with Vercel AI SDK)
export type {
  IterationCallback,
  IterationData,
  LLMCallResponse,
  LLMStreamChunk,
  ModelTransport,
  ProviderClient,
  ReasoningEffortType,
  VerbosityType,
} from './types.js';
export { StreamingResponseWithMetadata } from './types.js';
// Config types (re-exported from contracts)
export type {
  LlmConfig,
  LlmProviderEntry,
  ModelConfig,
  PromptCachePolicy,
} from './types-config.js';
