/**
 * Docs Core Module
 *
 * Barrel export for documentation attachment operations and llmtxt primitives.
 * Provides the API surface for registering, searching, and managing docs
 * attached to CLEO entities (tasks, sessions, observations).
 *
 * ADR discovery: every ADR in `.cleo/adrs/*.md` is registered into the docs
 * system via `cleo docs add <taskId> <path>` so that
 * `cleo docs list --task <id>` surfaces the ADRs a task implements or affects.
 * This module is project-agnostic — it works for any project that runs `cleo init`.
 *
 * @see ADR-027 — pipeline_manifest SQLite-backed SSoT
 * @see ADR-061 — project-agnostic evidence tools
 * @task T1612
 */

export type {
  AdrAllocateErr,
  AdrAllocateOk,
  AdrAllocateResult,
  AllocateAdrOptions,
} from './adr-allocator.js';
export {
  allocateAdrSlug,
  assembleAdrSlug,
  findHighestAdrNumber,
  MAX_ADR_ALLOCATION_ATTEMPTS,
} from './adr-allocator.js';

export type { GenerateDocsOptions, GenerateDocsResult } from './docs-generator.js';
export { generateDocsLlmsTxt } from './docs-generator.js';
export type {
  DocsDriftItem,
  DocsGraphEdge,
  DocsGraphNode,
  DocsGraphResult,
  DocsMergeResult,
  DocsPublicationRecord,
  DocsPublishResult,
  DocsRankHit,
  DocsRankResult,
  DocsSearchHit,
  DocsSearchResult,
  DocsStatusResult,
  DocsSyncFromGitResult,
  DocsVersionEntry,
  DocsVersionsResult,
} from './docs-ops.js';
export {
  buildDocsGraph,
  listDocVersions,
  listPublications,
  mergeDocs,
  publishDocs,
  rankDocs,
  recordPublication,
  searchDocs,
  statusDocs,
  syncFromGit,
} from './docs-ops.js';

export type { ExportDocumentOptions, ExportDocumentResult } from './export-document.js';
export { exportDocument } from './export-document.js';
// ── T10361 — slug similarity warn at docs add write-time ────────────────────
export type {
  CheckSlugSimilarityOptions,
  SimilarityCheckResult,
  SimilarityConfig,
  SimilarityMode,
} from './similarity-check.js';
export {
  checkSlugSimilarity,
  DEFAULT_SIMILARITY_MODE,
  DEFAULT_SIMILARITY_THRESHOLD,
  parseSimilarityConfig,
} from './similarity-check.js';
// ── T10162 — atomic supersede transaction (lifecycle flip + lineage edge) ───
export type {
  SupersedeDocInput,
  SupersedeDocParams,
  SupersedeDocResult,
} from './supersede.js';
export {
  SUPERSEDE_NOT_FOUND_CODE,
  SUPERSEDE_SAME_SLUG_CODE,
  supersedeDoc,
} from './supersede.js';
// ── T10160 — body schema validation per DocKind (requiredSections[]) ────────
export type { ValidateDocBodyResult } from './validate-body.js';
export { validateDocBody } from './validate-body.js';

// ── T9639 — cleo docs import (legacy .md migration) ─────────────────────────

// T9791 — AttachmentStore-backed DocsAccessor for the production import path.
export {
  AttachmentStoreDocsAccessor,
  createAttachmentStoreDocsAccessor,
  IMPORT_OWNER_TYPE,
  IMPORT_PROJECT_OWNER_ID,
  inferOwnerIdFromPath,
} from './import/attachment-store-accessor.js';
export type {
  ImportAction,
  ImportCounters,
  ImportManifest,
  ImportManifestEntry,
  WriteManifestOptions,
} from './import/audit.js';
export {
  createCounters,
  defaultManifestPath,
  writeAuditManifest,
} from './import/audit.js';
export type { DedupDecision, DedupOptions } from './import/dedup.js';
export { decideDedupAction } from './import/dedup.js';
export type { RunDocsImportOptions, RunDocsImportResult } from './import/import-orchestrator.js';
export {
  CounterMismatchError,
  importTypeToDocKind,
  runDocsImport,
} from './import/import-orchestrator.js';
export type {
  DocImportType,
  ScannedFile,
  ScanOptions,
} from './import/scanner.js';
export {
  classifyByRelPath,
  DEFAULT_EXCLUDE_DIRS,
  makeClassifierForScanRoot,
  SOURCE_DIR_TO_TYPE,
  scanDirectory,
} from './import/scanner.js';
export type { GenerateSlugOptions, SlugResult } from './import/slug.js';
export {
  generateSlug,
  RESERVED_SLUGS,
  SlugCollisionLimitError,
  SlugReservedError,
  slugify,
  stripMdExtension,
} from './import/slug.js';

// ── T9716 / T9718 — cleo docs publish-pr (foundation + new-doc flow) ────────

export type {
  ProvisionResult,
  PublishPrError,
  PublishPrOptions,
  PublishPrResult,
  PublishPrRunners,
  PublishPrSuccess,
} from './publish-pr.js';
export {
  branchForSlug,
  buildPublishFrontmatter,
  defaultPublishPrBody,
  defaultRun,
  execMsg,
  KNOWN_DOC_TYPES,
  knownDocTypesForProject,
  parseGhPrUrl,
  pickRunner,
  provisionPublishPrWorktree,
  publishDirForType,
  publishDocsAsPr,
  publishPrError,
  stripExistingFrontmatter,
  teardownPublishPrWorktree,
  tempWorktreeDirForSlug,
  validatePublishSlug,
} from './publish-pr.js';
