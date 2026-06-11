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
// Table-first catalog read chokepoint — models_catalog SSoT → disk → seed (T11737 · E8)
export type {
  CatalogResolutionSource,
  CatalogResolverDeps,
  ResolvedCatalogEntry,
} from './catalog-resolver.js';
export {
  _resetCatalogResolverCache,
  loadShippedSeed,
  openCatalogAtPath,
  resolveCatalogEntry,
} from './catalog-resolver.js';
// Catalog seeder — populates models_catalog from the shipped offline seed (T11734 · E8)
export type { SeedCatalogDeps, SeedCatalogResult } from './catalog-seeder.js';
export {
  flattenCatalogToRows,
  loadAndValidateSeed,
  openSeederAtPath,
  seedModelsCatalog,
} from './catalog-seeder.js';
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
// Shared onboarding front-door orchestrator — the single function every
// front-door entry point (login / auth login / llm login) dispatches to (T11725 · M3)
export type {
  AcquiredOAuthToken,
  FrontDoorDeps,
  FrontDoorLoginOptions,
  OAuthTokenAcquirer,
} from './onboarding/front-door.js';
export { resolveAuthMode, runFrontDoorLogin } from './onboarding/front-door.js';
// 3-step onboarding login engine — connect → select → bind → validate (T11724 · M3)
export type {
  OnboardingDeps,
  OnboardingLoginOptions,
  OnboardingResolution,
} from './onboarding/login-engine.js';
export { runOnboardingLogin } from './onboarding/login-engine.js';
// M3 Provider SSoT (T11702/T11703/T11704 · epic T11667) — declarative providers
export type { ProviderAliasIndex } from './provider-registry/provider-alias.js';
export {
  buildAliasIndex,
  resolveProviderId,
} from './provider-registry/provider-alias.js';
export {
  builtinProviderDefs,
  toProviderDef,
} from './provider-registry/provider-defs.js';
export type { SeedProvidersDeps, SeedProvidersResult } from './provider-registry/provider-seed.js';
export {
  openProviderSeederAtPath,
  providerDefToRow,
  seedProviders,
} from './provider-registry/provider-seed.js';
// Credential seeders — unified pool foundation (E-CONFIG-AUTH-UNIFY E2a / T9408)
// T9409 adds the concrete `EnvSeeder` and the `./register.js` barrel that
// populates `BUILTIN_SEEDERS` at module load. Importing this `llm/index.js`
// implicitly imports `register.js` so consumers of `@cleocode/core/llm` get
// the populated singleton without an explicit second import.
import './credential-seeders/register.js';

// L1 complexity classifier — tier proposer that feeds resolveLLMForSystem (T11906)
export type {
  Classification,
  ComplexityTier,
  PromptFeatures,
} from './complexity-classifier.js';
export {
  classify,
  classifyComplexity,
  complexityTierToRole,
  escalateTier,
  extractFeatures,
  proposeRoleForPrompt,
  THRESHOLD_HIGH,
  THRESHOLD_MID,
  WEIGHT_DOMAIN_SPECIFICITY,
  WEIGHT_REASONING_DEPTH,
  WEIGHT_SYNTACTIC_COMPLEXITY,
  WEIGHT_TOKEN_COUNT,
  WEIGHT_TOUCHES_FILES_COUNT,
} from './complexity-classifier.js';
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
// Local model fit ranking — wizard building block (T11982)
export type {
  HardwareSnapshot,
  LocalModelCandidate,
  LocalModelFitEnvelope,
  LocalModelFitResult,
  OllamaPulledModel,
  VramInfo,
} from './local-model-fit.js';
export {
  captureHardwareSnapshot,
  LOCAL_FIT_FLOOR_GB,
  LOCAL_MODEL_CANDIDATES,
  listOllamaPulledModels,
  rankLocalModelFit,
} from './local-model-fit.js';
export type { ModelMetadata } from './model-metadata.js';
// Model metadata — context window resolution (T9264 / T-LLM-CRED Phase 3)
export {
  DEFAULT_CONTEXT_LENGTH,
  getModelContextLength,
  getModelMetadata,
  usesMaxCompletionTokens,
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
// Sealed credential handle — E10 on-demand-decrypt impl (T11753)
export type { MakeSealedCredentialParams } from './sealed-credential.js';
export { makeSealedCredential } from './sealed-credential.js';
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
// E9 System-of-Use codec + runtime registry (T11751)
export { formatSystemKey, parseSystemKey, systemKeyKind } from './system-key.js';
export {
  clearRegisteredSystemsOfUse,
  getRegisteredSystemDefault,
  isResolvableSystemDefault,
  listSystemsOfUse,
  registerSystemOfUse,
  registerSystemOfUseDescriptor,
} from './system-of-use-registry.js';
// E9 System-of-Use chokepoint (T11749)
export type { ResolvedLLMForSystem } from './system-resolver.js';
export { resolveLLMForSystem } from './system-resolver.js';
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
