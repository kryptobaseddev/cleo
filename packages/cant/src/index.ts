// Re-export from @cleocode/lafs for convenience
export type { LAFSEnvelope, LAFSError, LAFSMeta, MVILevel } from '@cleocode/lafs';
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
// Types
export type { DirectiveType } from './types';
