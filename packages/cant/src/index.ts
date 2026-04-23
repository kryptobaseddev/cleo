// JIT Agent Composer (ULTRAPLAN Wave 5)
// Wave 7a: BRAIN-backed ContextProvider (T432)

// Re-export from @cleocode/lafs for convenience
export type { LAFSEnvelope, LAFSError, LAFSMeta, MVILevel } from '@cleocode/lafs';
export type {
  AgentEntry,
  BundleDiagnostic,
  CompiledBundle,
  ParsedCantDocument,
  TeamEntry,
  ToolEntry,
  TypedAgentEntry,
} from './bundle';
// Bundle compiler
export { compileBundle, toCantAgentV3 } from './bundle';
export type {
  AgentDefinition,
  ContextProvider,
  ContextSlice,
  MentalModelSlice,
  PathPermissions,
  SpawnPayload,
  Tier,
} from './composer.js';
export { composeSpawnPayload, escalateTier, estimateTokens, TIER_CAPS } from './composer.js';
export { brainContextProvider } from './context-provider-brain.js';
export type {
  CantDocumentResult,
  CantListResult,
  CantPipelineResult,
  CantValidationResult,
  SectionKind,
} from './document';
// High-level API (replaces standalone cant-cli binary)
export {
  executePipeline,
  listSections,
  parseDocument,
  validateDocument,
} from './document';
export type {
  Role,
  SpawnValidation,
  StripSpawnToolsResult,
  TeamDefinition,
  TeamRouting,
  ThinAgentToolsStrippedWarning,
} from './hierarchy.js';
// 3-tier hierarchy enforcement (ULTRAPLAN Wave 7) + T931 thin-agent strip.
export {
  filterToolsForRole,
  LEAD_FORBIDDEN_TOOLS,
  ORCHESTRATOR_FORBIDDEN_TOOLS,
  stripSpawnToolsForWorker,
  THIN_AGENT_TOOLS_STRIPPED,
  validateSpawnRequest,
  WORKER_FORBIDDEN_SPAWN_TOOLS,
} from './hierarchy.js';
export type {
  ConsolidateOptions,
  MentalModel,
  MentalModelObservation,
  MentalModelScope,
  MentalModelStore,
  ObservationTrigger,
  SessionOutput,
} from './mental-model.js';
// Mental Model Manager (ULTRAPLAN Wave 8)
export {
  consolidate,
  createEmptyModel,
  harvestObservations,
  renderMentalModel,
} from './mental-model.js';
export type {
  ConvertedFile,
  MigrationOptions,
  MigrationResult,
  UnconvertedSection,
} from './migrate/index';
// Migration engine
export { migrateMarkdown, serializeCantDocument, showDiff, showSummary } from './migrate/index';
export type {
  AgentProfile,
  NativeDiagnostic,
  NativeParseDocumentResult,
  NativeParseError,
  NativeParseResult,
  NativePipelineResult,
  NativePipelineStep,
  NativeValidateResult,
  SeedPersonaId,
} from './native-loader';
// Native loader (replaces wasm-loader)
export {
  cantClassifyDirectiveNative,
  cantExecutePipelineNative,
  cantExtractAgentProfilesNative,
  cantParseDocumentNative,
  cantParseNative,
  cantValidateDocumentNative,
  extractAgentProfilesTyped,
  extractAgentSkills,
  initWasm,
  isNativeAvailable,
  isWasmAvailable,
  // T1210 — PeerIdentity SDK surface
  loadSeedAgentIdentities,
  SEED_PERSONA_IDS,
  validateAgentCantPath,
} from './native-loader';
export type { ParsedCANTMessage } from './parse';
// Parser
export { initCantParser, parseCANTMessage } from './parse';
// Types
export type {
  CantAgentV3,
  CantContextSourceDef,
  CantContractBlock,
  CantContractClause,
  CantMentalModelRef,
  CantOverflowStrategy,
  CantPathPermissions,
  CantTier,
  DirectiveType,
} from './types';
export { isCantAgentV3 } from './types';
export type {
  MergeResult,
  WorktreeConfig,
  WorktreeEntry,
  WorktreeHandle,
  WorktreeRequest,
} from './worktree.js';
// Worktree isolation (ULTRAPLAN Wave 9)
export {
  createWorktree,
  listWorktrees,
  mergeWorktree,
  resolveWorktreeRoot,
} from './worktree.js';
