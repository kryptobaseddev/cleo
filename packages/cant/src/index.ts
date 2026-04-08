// JIT Agent Composer (ULTRAPLAN Wave 5)
export { composeSpawnPayload, escalateTier, estimateTokens, TIER_CAPS } from './composer.js';
export type {
  AgentDefinition,
  ContextProvider,
  ContextSlice,
  MentalModelSlice,
  SpawnPayload,
  Tier,
} from './composer.js';
// Re-export from @cleocode/lafs for convenience
export type { LAFSEnvelope, LAFSError, LAFSMeta, MVILevel } from '@cleocode/lafs';
export type {
  AgentEntry,
  BundleDiagnostic,
  CompiledBundle,
  ParsedCantDocument,
  TeamEntry,
  ToolEntry,
} from './bundle';
// Bundle compiler
export { compileBundle } from './bundle';
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
  ConvertedFile,
  MigrationOptions,
  MigrationResult,
  UnconvertedSection,
} from './migrate/index';
// Migration engine
export { migrateMarkdown, serializeCantDocument, showDiff, showSummary } from './migrate/index';
export type {
  NativeDiagnostic,
  NativeParseDocumentResult,
  NativeParseError,
  NativeParseResult,
  NativePipelineResult,
  NativePipelineStep,
  NativeValidateResult,
} from './native-loader';
// Native loader (replaces wasm-loader)
export {
  cantClassifyDirectiveNative,
  cantExecutePipelineNative,
  cantExtractAgentProfilesNative,
  cantParseDocumentNative,
  cantParseNative,
  cantValidateDocumentNative,
  initWasm,
  isNativeAvailable,
  isWasmAvailable,
} from './native-loader';
export type { ParsedCANTMessage } from './parse';
// Parser
export { initCantParser, parseCANTMessage } from './parse';
// 3-tier hierarchy enforcement (ULTRAPLAN Wave 7)
export {
  filterToolsForRole,
  LEAD_FORBIDDEN_TOOLS,
  ORCHESTRATOR_FORBIDDEN_TOOLS,
  validateSpawnRequest,
} from './hierarchy.js';
export type { Role, SpawnValidation, TeamDefinition, TeamRouting } from './hierarchy.js';
// Types
export type { DirectiveType } from './types';
