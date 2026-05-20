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

// ── T9639 — cleo docs import (legacy .md migration) ─────────────────────────

export type {
  DocImportType,
  ScannedFile,
  ScanOptions,
} from './import/scanner.js';
export {
  classifyByRelPath,
  DEFAULT_EXCLUDE_DIRS,
  scanDirectory,
} from './import/scanner.js';
