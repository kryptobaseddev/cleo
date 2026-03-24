/**
 * MCP lock file management
 *
 * Tracks installed MCP servers with source and agent metadata.
 * Stored in the canonical CAAMP lock file (shared with skills lock).
 */

import type { LockEntry, SourceType } from "../../types.js";
import { readLockFile, updateLockFile } from "../lock-utils.js";

/**
 * Read and parse the CAAMP lock file from the canonical lock path.
 *
 * Returns the full {@link CaampLockFile} structure. Creates a default lock file
 * if one does not exist.
 *
 * @remarks
 * The lock file is stored at the canonical CAAMP lock path and is shared
 * between MCP and skills tracking. If the file does not exist or cannot be
 * parsed, a default empty lock structure is returned.
 *
 * @returns The parsed lock file contents
 *
 * @example
 * ```typescript
 * const lock = await readLockFile();
 * console.log(Object.keys(lock.mcpServers));
 * ```
 *
 * @public
 */
export { readLockFile } from "../lock-utils.js";

/**
 * Record an MCP server installation in the lock file.
 *
 * Creates or updates an entry in `lock.mcpServers`. If the server already exists,
 * the agent list is merged and `updatedAt` is refreshed while `installedAt` is preserved.
 *
 * @remarks
 * Uses an atomic read-modify-write pattern via `updateLockFile`. When updating
 * an existing entry, the agent list is deduplicated using a `Set` to prevent
 * duplicate provider IDs. The `installedAt` timestamp is preserved from the
 * original entry while `updatedAt` is always refreshed.
 *
 * @param serverName - Name/key of the MCP server
 * @param source - Original source string
 * @param sourceType - Classified source type
 * @param agents - Provider IDs the server was installed to
 * @param isGlobal - Whether this is a global installation
 * @param version - Optional version string for the installed package
 *
 * @example
 * ```typescript
 * await recordMcpInstall("filesystem", "@mcp/server-fs", "package", ["claude-code"], true, "1.0.0");
 * ```
 *
 * @public
 */
export async function recordMcpInstall(
  serverName: string,
  source: string,
  sourceType: SourceType,
  agents: string[],
  isGlobal: boolean,
  version?: string,
): Promise<void> {
  await updateLockFile((lock) => {
    const now = new Date().toISOString();
    const existing = lock.mcpServers[serverName];

    lock.mcpServers[serverName] = {
      name: serverName,
      scopedName: serverName,
      source,
      sourceType,
      version: version ?? existing?.version,
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
      agents: [...new Set([...(existing?.agents ?? []), ...agents])],
      canonicalPath: "",
      isGlobal,
    };
  });
}

/**
 * Remove an MCP server entry from the lock file.
 *
 * @remarks
 * Uses an atomic read-modify-write pattern. If the server name is not present
 * in the lock file, the file is not modified and `false` is returned.
 *
 * @param serverName - Name/key of the MCP server to remove
 * @returns `true` if the entry was found and removed, `false` if not found
 *
 * @example
 * ```typescript
 * const removed = await removeMcpFromLock("filesystem");
 * if (removed) {
 *   console.log("Server removed from lock file");
 * }
 * ```
 *
 * @public
 */
export async function removeMcpFromLock(serverName: string): Promise<boolean> {
  let removed = false;
  await updateLockFile((lock) => {
    if (!(serverName in lock.mcpServers)) return;
    delete lock.mcpServers[serverName];
    removed = true;
  });
  return removed;
}

/**
 * Get all MCP servers tracked in the lock file.
 *
 * @remarks
 * Returns the `mcpServers` section of the lock file as a record. Each key
 * is a server name and each value contains installation metadata including
 * source, agents, timestamps, and scope.
 *
 * @returns Record of server name to lock entry
 *
 * @example
 * ```typescript
 * const servers = await getTrackedMcpServers();
 * for (const [name, entry] of Object.entries(servers)) {
 *   console.log(`${name}: installed ${entry.installedAt}`);
 * }
 * ```
 *
 * @public
 */
export async function getTrackedMcpServers(): Promise<Record<string, LockEntry>> {
  const lock = await readLockFile();
  return lock.mcpServers;
}

/**
 * Save the last selected agent IDs to the lock file for UX persistence.
 *
 * Used to remember the user's agent selection between CLI invocations.
 *
 * @remarks
 * Persists the `lastSelectedAgents` field in the lock file so subsequent
 * CLI invocations can default to the same agent selection. This avoids
 * requiring the user to re-select agents each time.
 *
 * @param agents - Array of provider IDs to remember
 *
 * @example
 * ```typescript
 * await saveLastSelectedAgents(["claude-code", "cursor"]);
 * ```
 *
 * @public
 */
export async function saveLastSelectedAgents(agents: string[]): Promise<void> {
  await updateLockFile((lock) => {
    lock.lastSelectedAgents = agents;
  });
}

/**
 * Retrieve the last selected agent IDs from the lock file.
 *
 * @remarks
 * Returns the `lastSelectedAgents` field from the lock file, which is
 * set by {@link saveLastSelectedAgents}. Returns `undefined` if no
 * selection has been persisted yet.
 *
 * @returns Array of provider IDs, or `undefined` if none were saved
 *
 * @example
 * ```typescript
 * const agents = await getLastSelectedAgents();
 * // ["claude-code", "cursor"] or undefined
 * ```
 *
 * @public
 */
export async function getLastSelectedAgents(): Promise<string[] | undefined> {
  const lock = await readLockFile();
  return lock.lastSelectedAgents;
}
