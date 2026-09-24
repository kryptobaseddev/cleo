/**
 * Portable bundle (manifest v2) — contract types for lossless machine migration.
 *
 * The v1 `.cleobundle` format (see `backup-manifest.ts`) snapshots a fixed list
 * of pre-E6 database filenames. After the E6 cutover (ADR-068) none of those
 * files is the live store any more, so a v1 export of a healthy project
 * captured nothing but three JSON files and reported success. Manifest v2
 * records what was actually exported, what was deliberately excluded (with its
 * size), which secrets were omitted, and the per-table row counts that the
 * import side re-counts to prove the restore is lossless.
 *
 * @task T12318
 * @epic T12317
 * @module portable-bundle
 */

// ============================================================================
// Scope
// ============================================================================

/**
 * Export scope for a portable bundle.
 *
 * - `project` — one project's `.cleo/` tree.
 * - `global`  — the global CLEO home (and config home).
 * - `all`     — `project` + `global`.
 * - `machine` — `global` + every registered project that still exists and
 *   holds a live store (temp and test-fixture paths are skipped).
 */
export type PortableBundleScope = 'project' | 'global' | 'all' | 'machine';

// ============================================================================
// Entries
// ============================================================================

/**
 * Role of a SQLite database inside a bundle section.
 *
 * - `primary`   — the live consolidated store (`cleo.db`) for that scope.
 * - `legacy`    — a pre-E6 per-domain file (`tasks.db`, `brain.db`, …) that
 *   still exists on disk. Kept for provenance; nothing reads it after E6.
 * - `auxiliary` — any other SQLite file found in the tree (e.g. the llmtxt or
 *   blob-manifest stores, `*.bak` snapshots).
 */
export type PortableDatabaseRole = 'primary' | 'legacy' | 'auxiliary';

/** A SQLite database captured with `VACUUM INTO` (consistent under WAL). */
export interface PortableDatabaseEntry {
  /** Path relative to the section root, POSIX separators (e.g. `cleo.db`). */
  relPath: string;
  /** Path inside the archive. */
  bundlePath: string;
  /** Primary / legacy / auxiliary classification. */
  role: PortableDatabaseRole;
  /** Byte size of the snapshot. */
  size: number;
  /** SHA-256 hex of the snapshot bytes. */
  sha256: string;
  /** Row count of every ordinary table, keyed by table name. */
  rowCounts: Record<string, number>;
  /**
   * Tables that could not be counted, with the reason. Virtual tables are
   * listed here (their data lives in shadow tables, which ARE counted).
   */
  uncountedTables: Record<string, string>;
}

/** A regular file captured byte-for-byte. */
export interface PortableFileEntry {
  /** Path relative to the section root, POSIX separators. */
  relPath: string;
  /** Path inside the archive. */
  bundlePath: string;
  /** Byte size. */
  size: number;
  /** SHA-256 hex of the file bytes. */
  sha256: string;
  /** True when the file was classified as a secret (only present in encrypted bundles). */
  secret: boolean;
}

/** A symbolic link inside the root whose target also stays inside the root. */
export interface PortableSymlinkEntry {
  /** Link path relative to the section root. */
  relPath: string;
  /** Link target exactly as stored (relative targets stay relative). */
  target: string;
}

/** Material deliberately left out of the bundle. */
export interface PortableExclusion {
  /** Path relative to the section root (a directory or a file). */
  relPath: string;
  /** Why it was excluded. */
  reason: string;
  /** Bytes measured under this path (a lower bound when `sizeComplete` is false). */
  bytes: number;
  /** Files measured under this path (a lower bound when `sizeComplete` is false). */
  fileCount: number;
  /** False when measurement stopped at its entry budget; `bytes` is then a lower bound. */
  sizeComplete: boolean;
}

/** A secret that an unencrypted bundle omitted, and what the user must redo. */
export interface PortableOmittedSecret {
  /** Path relative to the section root. */
  relPath: string;
  /** What must be redone on the target machine. */
  remedy: string;
}

// ============================================================================
// Sections
// ============================================================================

/** Common shape of one exported root (a project `.cleo/`, the CLEO home, the config home). */
export interface PortableSectionBase {
  /** Absolute path of the root on the source machine. */
  originalRoot: string;
  /** Archive directory holding this section's files. */
  bundlePrefix: string;
  /** SQLite snapshots. */
  databases: PortableDatabaseEntry[];
  /** Byte-for-byte files. */
  files: PortableFileEntry[];
  /** Symlinks recreated on import (targets inside the root only). */
  symlinks: PortableSymlinkEntry[];
  /** Deliberately excluded material, with sizes. */
  excluded: PortableExclusion[];
  /** Secrets omitted because the bundle is not encrypted. */
  omittedSecrets: PortableOmittedSecret[];
}

/** The key per-project record counts surfaced in results (subset of `rowCounts`). */
export type PortableKeyCounts = Record<string, number>;

/** One project's `.cleo/` directory. */
export interface PortableProjectSection extends PortableSectionBase {
  /** Absolute project root on the source machine (parent of `.cleo/`). */
  originalPath: string;
  /** `projectId` from `.cleo/project-info.json`, or null when absent. */
  projectId: string | null;
  /** Project name (project-info.json `name`, else the directory basename). */
  name: string;
  /** Counts of the key tables (tasks, sessions, brain records) in the primary store. */
  keyCounts: PortableKeyCounts;
}

/** The global CLEO home plus the config home. */
export interface PortableGlobalSection {
  /** `<cleoHome>` content. */
  home: PortableSectionBase;
  /** `<configHome>` content, or null when the directory does not exist. */
  config: PortableSectionBase | null;
  /** Counts of the key tables in the global primary store. */
  keyCounts: PortableKeyCounts;
}

/**
 * Why `machine` scope skipped a registered project.
 *
 * - `path-missing`   — the registered directory no longer exists.
 * - `no-live-store`  — the directory has no `.cleo/cleo.db`.
 * - `temp-path`      — the path is a temp or test-fixture directory.
 * - `duplicate-path` — resolves to a project already included.
 * - `is-global-home` — its `.cleo/` resolves to the global CLEO home (exported as the global section).
 */
export type PortableSkipReason =
  | 'path-missing'
  | 'no-live-store'
  | 'temp-path'
  | 'duplicate-path'
  | 'is-global-home';

/** A registered project that `machine` scope did not export, and why. */
export interface PortableSkippedProject {
  /** Registered absolute path. */
  path: string;
  /** Registered projectId (may be empty for malformed rows). */
  projectId: string;
  /** Reason code. */
  reason: PortableSkipReason;
}

// ============================================================================
// Manifest
// ============================================================================

/** Root of `manifest.json` in a v2 portable bundle. */
export interface PortableBundleManifest {
  /** Format marker. */
  format: 'cleo-portable-bundle';
  /** Manifest version; major 2 distinguishes it from v1 `.cleobundle` manifests. */
  manifestVersion: '2.0.0';
  /** Provenance. */
  backup: {
    /** ISO-8601 creation time. */
    createdAt: string;
    /** CLEO version that wrote the bundle. */
    cleoVersion: string;
    /** Export scope. */
    scope: PortableBundleScope;
    /** Advisory label (the export name). */
    label: string;
    /** Host name of the source machine (advisory). */
    sourceHost: string;
    /** Whether the archive is encrypted. */
    encrypted: boolean;
    /** Whether secrets are present in the archive (true only when encrypted). */
    secretsIncluded: boolean;
  };
  /** Global section, present for `global` / `all` / `machine`. */
  global: PortableGlobalSection | null;
  /** Project sections. */
  projects: PortableProjectSection[];
  /** Registered projects skipped by `machine` scope. */
  skippedProjects: PortableSkippedProject[];
  /** Integrity block. */
  integrity: {
    /** Always sha256. */
    algorithm: 'sha256';
    /** SHA-256 of this manifest serialised with `manifestHash` set to "". */
    manifestHash: string;
  };
}

// ============================================================================
// Results
// ============================================================================

/** Result of exporting a portable bundle. */
export interface PortableExportResult {
  /** Absolute path of the written bundle. */
  bundlePath: string;
  /** Bundle size in bytes. */
  size: number;
  /** Export scope. */
  scope: PortableBundleScope;
  /** Whether the bundle is encrypted. */
  encrypted: boolean;
  /** Whether secrets were included. */
  secretsIncluded: boolean;
  /** Per-section summary. */
  sections: Array<{
    /** `global-home`, `global-config`, or `project`. */
    kind: 'global-home' | 'global-config' | 'project';
    /** Source root. */
    root: string;
    /** Project name (projects only). */
    name?: string;
    /** Number of databases captured. */
    databases: number;
    /** Number of files captured. */
    files: number;
    /** Key table counts. */
    keyCounts?: PortableKeyCounts;
    /** Excluded material with sizes. */
    excluded: PortableExclusion[];
    /** Secrets omitted (unencrypted bundles). */
    omittedSecrets: PortableOmittedSecret[];
  }>;
  /** Machine scope: included/skipped tallies. */
  machine?: {
    /** Registered projects considered. */
    registered: number;
    /** Projects exported. */
    included: number;
    /** Skipped projects grouped by reason. */
    skippedByReason: Partial<Record<PortableSkipReason, number>>;
  };
}

/** Per-table comparison of manifest vs restored row counts. */
export interface PortableTableComparison {
  /** Table name. */
  table: string;
  /** Row count recorded at export. */
  expected: number;
  /** Row count re-counted after restore (null when uncountable). */
  actual: number | null;
}

/** An absolute path encountered while relocating, reported by location. */
export interface PortablePathFinding {
  /** Where it was found: `<db relPath>:<table>.<column>` or a file relPath. */
  location: string;
  /** Number of values (rows or occurrences) affected. */
  count: number;
  /** Example value (truncated). */
  example?: string;
}

/** Relocation report for one project. */
export interface PortableRelocationReport {
  /** Original project root. */
  fromRoot: string;
  /** New project root. */
  toRoot: string;
  /** Values rewritten from the old root to the new one. */
  rewritten: PortablePathFinding[];
  /** Values that still reference the old root and were deliberately left (historical record). */
  leftUnderOldRoot: PortablePathFinding[];
  /** Absolute paths outside the old root, left unchanged. */
  leftOutsideRoot: PortablePathFinding[];
  /**
   * Rewritten locators whose new target does not exist on this machine at
   * import time (e.g. the repository has not been cloned there yet, or the
   * project was re-rooted into a subdirectory that does not contain it).
   */
  rewrittenTargetMissing: PortablePathFinding[];
}

/** Restore outcome for one section. */
export interface PortableImportSectionResult {
  /** Section kind. */
  kind: 'global-home' | 'global-config' | 'project';
  /** Source root recorded in the bundle. */
  originalRoot: string;
  /** Destination root written. */
  destinationRoot: string;
  /** Project name (projects only). */
  name?: string;
  /** projectId (projects only). */
  projectId?: string | null;
  /** Files written. */
  filesWritten: number;
  /** Databases written. */
  databasesWritten: number;
  /** Tables compared across all databases in the section. */
  tablesCompared: number;
  /** Tables whose restored count differs from the manifest (empty = lossless). */
  mismatches: Array<PortableTableComparison & { database: string }>;
  /** Key counts, expected vs actual. */
  keyCounts: Array<PortableTableComparison>;
  /** Relocation report (projects placed at a different root only). */
  relocation?: PortableRelocationReport;
  /** Global registry update for this project (projects only). */
  registry?: {
    /** Outcome. */
    status: 'updated' | 'registered' | 'unchanged' | 'not-in-registry' | 'skipped' | 'failed';
    /** Detail. */
    detail: string;
  };
}

/** Result of importing a portable bundle. */
export interface PortableImportResult {
  /** Bundle imported. */
  bundlePath: string;
  /** Scope recorded in the bundle. */
  scope: PortableBundleScope;
  /** Per-section outcomes. */
  sections: PortableImportSectionResult[];
  /** True when every table in every section matched. */
  lossless: boolean;
  /** Whether secrets were present in the bundle. */
  secretsIncluded: boolean;
  /** Secrets the user must recreate (unencrypted bundles). */
  omittedSecrets: Array<PortableOmittedSecret & { section: string }>;
}
