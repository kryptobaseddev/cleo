/**
 * Nexus Wiki Index Operations - Contract Layer
 *
 * Defines types for generating a community-grouped wiki index
 * from the nexus code graph.
 *
 * @task T1060
 * @task T1109
 * @epic T1042
 */

/**
 * Statistics for a single community in the wiki index.
 */
export interface CommunityWikiStats {
  /** Community node ID (e.g. "community:42") */
  communityId: string;
  /** Number of symbols in this community */
  memberCount: number;
}

/**
 * Result of wiki index generation.
 */
export interface NexusWikiResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Output directory where files were written */
  outputDir: string;
  /** Number of communities processed */
  communityCount: number;
  /** Total number of files written (community files + overview) */
  fileCount: number;
  /** Stats per community */
  communities: CommunityWikiStats[];
  /** Error message if success is false */
  error?: string;
  /** IDs of communities that were skipped (incremental mode) */
  skippedCommunities?: string[];
  /** Whether LOOM LLM narrative was generated */
  loomEnabled?: boolean;
}

/**
 * Symbol metadata as it appears in the wiki index.
 */
export interface WikiSymbolRow {
  /** Symbol name */
  name: string;
  /** Symbol kind (function, class, interface, etc.) */
  kind: string;
  /** File path relative to project root */
  filePath: string | null;
  /** Number of symbols that call this symbol */
  callerCount: number;
  /** Number of symbols this symbol calls */
  calleeCount: number;
}

/**
 * Subset of SQLite-compatible parameter values accepted by `DatabaseSync.prepare()`.
 * Mirrors node:sqlite's `SQLInputValue` without importing from node internals.
 */
export type WikiSqlParam = null | number | bigint | string | Uint8Array;

/**
 * Minimal interface for an injectable SQLite database handle.
 * Used in tests to provide an isolated in-memory or temp-file database
 * instead of the real nexus.db singleton.
 *
 * Matches the subset of `DatabaseSync` (node:sqlite) used by the wiki generator.
 */
export interface WikiDbHandle {
  /**
   * Prepare a SQL statement and return a statement object with
   * `all(...params)` and `get(...params)` accessors.
   * Compatible with both `DatabaseSync.prepare()` and test mocks.
   */
  prepare: (sql: string) => {
    all: (...params: WikiSqlParam[]) => Record<string, WikiSqlParam>[];
    get: (...params: WikiSqlParam[]) => Record<string, WikiSqlParam> | undefined;
  };
}

/**
 * Options for generating the nexus wiki index.
 */
export interface GenerateNexusWikiOptions {
  /**
   * Filter generation to a single community ID.
   * When set, only that community's markdown file is generated.
   * The overview.md is NOT generated in single-community mode.
   */
  communityFilter?: string;
  /**
   * Enable incremental mode: use `cleo nexus diff` data to skip
   * communities whose symbols have not changed since the last wiki run.
   *
   * Reads `.cleo/wiki-state.json` for the last-run commit SHA.
   * On first run (no state file), performs a full generation and writes
   * the state file.
   */
  incremental?: boolean;
  /**
   * LOOM provider function for generating narrative module summaries.
   * Injected by the caller (CLI or test harness). When `null`, scaffold
   * mode is used (no LLM narrative).
   *
   * Signature: `(prompt: string) => Promise<string>`
   */
  loomProvider?: ((prompt: string) => Promise<string>) | null;
  /**
   * Project root directory (used for resolving `.cleo/wiki-state.json`
   * and running git operations). Defaults to `process.cwd()`.
   */
  projectRoot?: string;
  /**
   * Injectable database handle for testing.
   * When provided, this handle is used instead of the real nexus.db singleton.
   * Allows unit/integration tests to use isolated in-memory SQLite databases.
   */
  _dbForTesting?: WikiDbHandle;
}

/**
 * State file persisted to `.cleo/wiki-state.json` for incremental mode.
 */
export interface WikiStateFile {
  /** Git commit SHA of the last full or incremental wiki generation run. */
  lastRunCommit: string;
  /** List of community IDs generated in the last run. */
  generatedCommunities: string[];
}
