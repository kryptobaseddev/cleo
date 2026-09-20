/**
 * BackupManifest — Contract types for the .cleobundle portable backup format.
 *
 * Describes the structure of manifest.json written at the root of every
 * .cleobundle.tar.gz archive produced by `cleo backup export`. The bundled
 * JSON Schema at `schemas/manifest-v1.json` provides runtime validation.
 *
 * @task T343
 * @epic T311
 * @why ADR-038 §3 — manifest.json format for .cleobundle tarballs.
 *      Bundled JSON Schema at schemas/manifest-v1.json inside the bundle.
 * @what BackupManifest describes metadata, databases, json files,
 *       global files, and integrity block for a portable CLEO backup.
 * @see .cleo/rcasd/T311/specification/T311-specification.md §3
 * @see .cleo/adrs/ADR-038-backup-portability.md §3
 * @module backup-manifest
 */

// ============================================================================
// Scope
// ============================================================================

/** Export scope — determines which database tiers and file sets are included. */
export type BackupScope = 'project' | 'global' | 'all';

// ============================================================================
// Backup metadata block
// ============================================================================

/**
 * Top-level metadata for the backup bundle, recording provenance and
 * portability context at export time.
 */
export interface BackupMetadata {
  /** ISO-8601 UTC timestamp when the bundle was created. */
  createdAt: string;
  /** Human-readable cleo version string, e.g. "cleo v2026.4.13". */
  createdBy: string;
  /** Export scope. Determines target restore paths. */
  scope: BackupScope;
  /** Project name at export time. Advisory only. */
  projectName?: string;
  /**
   * SHA-256 of project-info.json at export time, hex-encoded (64 chars).
   * Null for global-only scope. Advisory warning if mismatch on import.
   */
  projectFingerprint?: string;
  /**
   * SHA-256 of `$XDG_DATA_HOME/cleo/machine-key`, hex-encoded (64 chars).
   * Privacy-safe machine identity proxy — not the key itself.
   */
  machineFingerprint: string;
  /** Machine-parseable CalVer string, e.g. "2026.4.13". */
  cleoVersion: string;
  /** True if this bundle was produced with --encrypt. */
  encrypted: boolean;
}

// ============================================================================
// Database entry
// ============================================================================

/**
 * Metadata for a single SQLite database file included in the bundle.
 * One entry per in-scope database (tasks, brain, conduit, nexus, signaldock).
 */
export interface BackupDatabaseEntry {
  /** Logical database name. */
  name: 'tasks' | 'brain' | 'conduit' | 'nexus' | 'signaldock';
  /** Relative path inside the archive, e.g. "databases/tasks.db". */
  filename: string;
  /** Byte size of the decompressed .db file. */
  size: number;
  /** SHA-256 hex of the decompressed .db bytes (64 lowercase hex chars). */
  sha256: string;
  /**
   * Latest applied migration identifier.
   * For Drizzle-managed DBs: folderMillis string (e.g. "20260327000000").
   * For signaldock.db: AGENT_REGISTRY_SCHEMA_VERSION constant.
   */
  schemaVersion: string;
  /**
   * Per-table row counts captured at export time.
   * Displayed by `cleo backup inspect`. Optional at import time.
   */
  rowCounts?: Record<string, number>;
}

// ============================================================================
// JSON file entry
// ============================================================================

/**
 * Metadata for a managed JSON configuration file included in the bundle.
 * Filename is the path relative to the archive root (includes the `json/` prefix).
 */
export interface BackupJsonEntry {
  /** Relative path inside the archive. */
  filename: 'json/config.json' | 'json/project-info.json' | 'json/project-context.json';
  /** Byte size of the file. */
  size: number;
  /** SHA-256 hex of the file bytes (64 lowercase hex chars). */
  sha256: string;
}

// ============================================================================
// Global file entry
// ============================================================================

/**
 * Metadata for a global-tier file included in the bundle.
 * Currently only `global-salt` is a managed global file.
 *
 * WARNING: Including global-salt invalidates all agent API keys on the
 * target machine. Agents require re-authentication after import.
 */
export interface BackupGlobalFileEntry {
  /** Relative path inside the archive. */
  filename: 'global/global-salt';
  /** Byte size of the file. */
  size: number;
  /** SHA-256 hex of the file bytes (64 lowercase hex chars). */
  sha256: string;
}

// ============================================================================
// Integrity block
// ============================================================================

/**
 * Integrity metadata for the bundle.
 * Covers both the checksums file (per-file) and the manifest self-hash.
 */
export interface BackupIntegrity {
  /** Hash algorithm used. Always "sha256" for v1 bundles. */
  algorithm: 'sha256';
  /**
   * Name of the GNU-format checksums file in the archive.
   * Always "checksums.sha256" for v1 bundles.
   */
  checksumsFile: 'checksums.sha256';
  /**
   * SHA-256 of this manifest JSON with the `manifestHash` field set to an
   * empty string (`""`), then hex-encoded (64 lowercase hex chars).
   * Used by Layer 2 integrity verification (ADR-038 §4.2).
   */
  manifestHash?: string;
}

// ============================================================================
// Top-level manifest
// ============================================================================

/**
 * Root structure of `manifest.json` at the root of every .cleobundle archive.
 *
 * The manifest MUST be the first entry in the tar archive to enable efficient
 * streaming inspection without reading the full bundle (ADR-038 §1).
 *
 * The `$schema` field references the bundled JSON Schema at
 * `./schemas/manifest-v1.json` — a relative bundle-root path, ensuring
 * offline validation without network access (T311 spec §3.1, Q6=C).
 */
export interface BackupManifest {
  /** Relative path to the bundled JSON Schema for IDE and runtime validation. */
  $schema: './schemas/manifest-v1.json';
  /** Manifest format version. Follows semver; major increments on breaking change. */
  manifestVersion: '1.0.0';
  /** Provenance and portability metadata captured at export time. */
  backup: BackupMetadata;
  /**
   * SQLite database files included in this bundle.
   * Exactly reflects what was exported for the given scope.
   */
  databases: BackupDatabaseEntry[];
  /**
   * Managed JSON configuration files included in this bundle.
   * Exactly reflects what was exported for the given scope.
   */
  json: BackupJsonEntry[];
  /**
   * Global-tier files included in this bundle.
   * Present only when --scope global or --scope all was used.
   * Inclusion of global-salt triggers warnings at export and import time.
   */
  globalFiles?: BackupGlobalFileEntry[];
  /** Bundle integrity metadata (algorithm, checksums file, manifest self-hash). */
  integrity: BackupIntegrity;
}

/** Lossless SQLite value representation for an authentic observation payload. */
export type BackupObservationValue =
  | { type: 'null' }
  | { type: 'integer'; decimal: string }
  | { type: 'real'; ieee754Hex: string }
  | { type: 'text' | 'blob'; bytesBase64: string };

/** Explicit inputs for inspecting one snapshot; no ambient live-store routing. */
export interface BackupObservationInspectOptions {
  /** Absolute path to one authorized SQLite snapshot, never a live-store role. */
  snapshotPath: string;
  /** Exact observation identity; no substring or semantic matching. */
  recordId: string;
  /** Original caller-supplied backup label; advisory, never used for routing. */
  label?: string;
  /** Stable expected project identity, compared only with recorded project_id. */
  expectedProjectId?: string;
  /** Source byte ceiling, at most 1 GiB; default 512 MiB. */
  maxSnapshotBytes?: number;
  /** Sum of stored column byte lengths; at most 16 MiB, default 1 MiB. */
  maxPayloadBytes?: number;
}

/** Supported diagnostic categories; none establish absence of a historical record. */
export type BackupObservationInspectFailure =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_SOURCE'
  | 'SOURCE_CHANGED'
  | 'JOURNAL_PRESENT'
  | 'SOURCE_LIMIT'
  | 'PAYLOAD_LIMIT'
  | 'INVALID_SNAPSHOT'
  | 'UNSUPPORTED_SCHEMA'
  | 'AMBIGUOUS_RECORD'
  | 'PROJECT_MISMATCH';

/** Authentic observation extracted from one exact, ordinary indexed table. */
export interface BackupObservationRecord {
  /** Actual table containing the row, independent of snapshot filename. */
  table: 'brain_observations' | 'observations';
  /** Exact column names mapped to lossless tagged SQLite values. */
  payload: Record<string, BackupObservationValue>;
  /** SHA256 of UTF-8 JSON for column-name-sorted [name, taggedValue] pairs. */
  payloadSha256: string;
  /** Sum of stored column byte lengths before JSON/base64 expansion. */
  payloadBytes: number;
}

/** Scoped read-only result; not-found never means all backups were searched. */
export interface BackupObservationInspection {
  /** Whether this exact ID occurred in a supported table in this snapshot. */
  status: 'found' | 'not-found';
  /** Exact requested identity. */
  recordId: string;
  /** Canonical source path and byte identity, rechecked after inspection. */
  source: {
    path: string;
    label: string | null;
    sha256: string;
    bytes: number;
    mtimeNs: string;
    ctimeNs: string;
    atimeNs: string;
  };
  /** Actual SQLite schema marker; not an inferred product/schema version. */
  userVersion: number;
  /** Every supported table found and queried with indexed exact equality. */
  inspectedTables: Array<'brain_observations' | 'observations'>;
  /** Caller expectation is separate from recorded identity and never fills it in. */
  projectIdentity: {
    expected: string | null;
    recorded: string | null;
    status: 'matched' | 'recorded' | 'unknown';
    evidence: string | null;
  };
  /** Full authentic row, or null only after eligible tables were inspected. */
  record: BackupObservationRecord | null;
  /** Explicit boundaries on completeness, identity and synchronous execution. */
  limitations: string[];
}
