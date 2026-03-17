/**
 * node:sqlite adapter for drizzle-orm/sqlite-proxy
 *
 * Provides the AsyncRemoteCallback that sqlite-proxy expects, backed by
 * Node.js built-in node:sqlite DatabaseSync. This gives us:
 *
 * - Zero native npm dependencies (uses Node.js built-in node:sqlite)
 * - File-backed SQLite with real WAL mode for multi-process concurrency
 * - 100% cross-platform: Windows, Linux, macOS — no compilation required
 * - Async drizzle API (sqlite-proxy returns Promises)
 *
 * Requires: Node.js >= 24.0.0 (ADR-006, ADR-010)
 *
 * @epic T4817
 */
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
type DatabaseSync = _DatabaseSyncType;
declare const DatabaseSync: new (path: import("fs").PathLike, options?: import("node:sqlite").DatabaseSyncOptions | undefined) => DatabaseSync;
/**
 * Open a node:sqlite DatabaseSync with CLEO standard pragmas.
 *
 * CRITICAL: WAL mode is verified, not just requested. If another process holds
 * an EXCLUSIVE lock in DELETE mode, PRAGMA journal_mode=WAL silently returns
 * 'delete'. This caused data loss (T5173) when concurrent MCP servers opened
 * the same database — writes were silently dropped under lock contention.
 */
export declare function openNativeDatabase(path: string, options?: {
    readonly?: boolean;
    timeout?: number;
    enableWal?: boolean;
    allowExtension?: boolean;
}): DatabaseSync;
/**
 * Create the sqlite-proxy callback that drizzle-orm expects.
 *
 * The callback signature is:
 *   (sql: string, params: any[], method: 'run' | 'all' | 'values' | 'get') => Promise<{ rows: any[] }>
 *
 * We execute synchronous node:sqlite calls and wrap them in a Promise.
 * The actual disk I/O happens synchronously in the Node.js SQLite binding,
 * but from drizzle's perspective this is async.
 */
export declare function createDrizzleCallback(db: DatabaseSync): (sql: string, params: unknown[], method: "run" | "all" | "values" | "get") => Promise<{
    rows: unknown[];
}>;
/**
 * Create a batch callback for drizzle-orm sqlite-proxy batch operations.
 */
export declare function createBatchCallback(db: DatabaseSync): (batch: {
    sql: string;
    params: unknown[];
    method: "run" | "all" | "values" | "get";
}[]) => Promise<{
    rows: unknown[];
}[]>;
export {};
//# sourceMappingURL=node-sqlite-adapter.d.ts.map