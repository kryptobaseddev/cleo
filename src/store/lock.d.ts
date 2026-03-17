/**
 * File locking using proper-lockfile.
 * Prevents concurrent modifications to CLEO data files.
 * @epic T4454
 * @task T4457
 */
/** A release function returned by acquireLock. */
export type ReleaseFn = () => Promise<void>;
/**
 * Acquire an exclusive lock on a file.
 * Returns a release function that must be called when done.
 */
export declare function acquireLock(filePath: string, options?: {
    stale?: number;
    retries?: number;
}): Promise<ReleaseFn>;
/**
 * Check if a file is currently locked.
 */
export declare function isLocked(filePath: string): Promise<boolean>;
/**
 * Execute a function while holding an exclusive lock on a file.
 * The lock is automatically released when the function completes (or throws).
 */
export declare function withLock<T>(filePath: string, fn: () => Promise<T>, options?: {
    stale?: number;
    retries?: number;
}): Promise<T>;
//# sourceMappingURL=lock.d.ts.map