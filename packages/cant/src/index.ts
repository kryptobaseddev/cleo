// Re-export from @cleocode/lafs for convenience
export type {
  LAFSEnvelope,
  LAFSError,
  LAFSMeta,
  MVILevel,
} from '@cleocode/lafs';
export type { ParsedCANTMessage } from './parse';
// Parser
export { initCantParser, parseCANTMessage } from './parse';
// Types
export type { DirectiveType } from './types';
// Native loader (replaces wasm-loader)
export { isNativeAvailable, initWasm, isWasmAvailable } from './native-loader';
// Migration engine
export { migrateMarkdown, serializeCantDocument, showDiff, showSummary } from './migrate/index';
export type {
  ConvertedFile,
  MigrationOptions,
  MigrationResult,
  UnconvertedSection,
} from './migrate/index';
