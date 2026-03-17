/**
 * File utility helpers for CLEO data access.
 *
 * File utility helpers for CLEO data access including atomic writes,
 * file locking, and backup rotation.
 *
 * @task T4833
 * @epic T4654
 */
/**
 * Write a JSON file atomically with backup rotation.
 *
 * Pattern: write temp -> backup original -> rename temp to target
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param indent - JSON indentation (default: 2 spaces)
 */
export declare function writeJsonFileAtomic<T>(filePath: string, data: T, indent?: number): void;
/**
 * Read a JSON file, returning parsed content or null if not found.
 *
 * @param filePath - Path to the JSON file
 */
export declare function readJsonFile<T = unknown>(filePath: string): T | null;
/**
 * Get the path to a CLEO data file within a project root.
 *
 * @param projectRoot - Root directory of the project
 * @param filename - Filename within .cleo/ directory
 */
export declare function getDataPath(projectRoot: string, filename: string): string;
/**
 * Resolve the project root directory.
 * Checks CLEO_ROOT env, then falls back to cwd.
 */
export declare function resolveProjectRoot(): string;
/**
 * Read and write a JSON file with exclusive locking.
 *
 * Acquires a cross-process lock, reads current state, applies the
 * transform function, validates, and writes back atomically.
 *
 * @param filePath - File to lock and modify
 * @param transform - Function that receives current data and returns new data
 * @returns The transformed data
 */
export declare function withLock<T>(filePath: string, transform: (current: T | null) => T): Promise<T>;
/**
 * Acquire a file lock and execute an operation.
 * Unlike withLock, this doesn't read/write the file - caller manages I/O.
 * The return type R is independent of the file content type.
 */
export declare function withFileLock<R>(filePath: string, operation: () => R | Promise<R>): Promise<R>;
/**
 * Acquire locks on multiple files in correct order.
 * Used for operations that need to modify multiple files atomically
 * (e.g., coordinated updates across task data and config).
 *
 * @param filePaths - Files to lock
 * @param operation - Function to execute while locks are held
 */
export declare function withMultiLock<T>(filePaths: string[], operation: () => T | Promise<T>): Promise<T>;
/**
 * Check if a CLEO project directory exists at the given path
 */
export declare function isProjectInitialized(projectRoot: string): boolean;
/**
 * List backup files for a given data file
 */
export declare function listBackups(filePath: string): string[];
//# sourceMappingURL=file-utils.d.ts.map