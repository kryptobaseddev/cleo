/**
 * JSON read/write with schema validation, locking, and backup.
 * This is the primary data access layer for CLEO data files.
 * @epic T4454
 * @task T4457
 */
/**
 * Read and parse a JSON file.
 * Returns null if the file does not exist.
 */
export declare function readJson<T = unknown>(filePath: string): Promise<T | null>;
/**
 * Read a JSON file, throwing if it doesn't exist.
 */
export declare function readJsonRequired<T = unknown>(filePath: string): Promise<T>;
/**
 * Compute a truncated SHA-256 checksum of a value.
 * Used for integrity verification (matches Bash CLI's 16-char hex format).
 */
export declare function computeChecksum(data: unknown): string;
/** Options for saveJson. */
export interface SaveJsonOptions {
    /** Directory for backups. If omitted, no backup is created. */
    backupDir?: string;
    /** Maximum number of backups to retain. Default: 5. */
    maxBackups?: number;
    /** JSON indentation. Default: 2. */
    indent?: number;
    /** Validation function. Called before write; throw to abort. */
    validate?: (data: unknown) => void | Promise<void>;
}
/**
 * Save JSON data with optional locking, backup, and validation.
 * Follows the CLEO atomic write pattern:
 *   1. Acquire lock
 *   2. Validate data
 *   3. Create backup of existing file
 *   4. Atomic write (temp file -> rename)
 *   5. Release lock
 */
export declare function saveJson(filePath: string, data: unknown, options?: SaveJsonOptions): Promise<void>;
/**
 * Append a line to a JSONL file atomically.
 * Used for manifest entries and audit logs.
 */
export declare function appendJsonl(filePath: string, entry: unknown): Promise<void>;
/**
 * Read log entries from a hybrid JSON/JSONL file.
 * Handles three formats:
 *   1. Pure JSON: `{ "entries": [...] }` (legacy bash format)
 *   2. Pure JSONL: one JSON object per line (new TS format)
 *   3. Hybrid: JSON object followed by JSONL lines (migration state)
 * Returns a flat array of all entries found.
 * @task T4622
 */
export declare function readLogEntries(filePath: string): Promise<Record<string, unknown>[]>;
//# sourceMappingURL=json.d.ts.map