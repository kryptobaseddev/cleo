/**
 * Session Store for Claude SDK Spawn Provider
 *
 * Maintains an in-memory map of active SDK sessions keyed by instanceId.
 * Each entry records the session ID returned by the SDK, the task ID, and
 * the start time. Session IDs can be used with `options: { resume: sessionId }`
 * in subsequent `query()` calls for multi-turn continuations.
 *
 * Persistence to conduit.db is intentionally deferred: the in-memory store
 * is sufficient for single-process lifetimes and avoids coupling the spawn
 * provider to the conduit subsystem at construction time.
 *
 * @task T581
 */

/** A single tracked SDK session entry. */
export interface SessionEntry {
  /** Unique instance ID assigned at spawn time. */
  instanceId: string;
  /** Claude SDK session ID returned in the first SDK message (if captured). */
  sessionId: string | undefined;
  /** CLEO task ID this session is executing. */
  taskId: string;
  /** ISO timestamp when the session was created. */
  startTime: string;
}

/**
 * In-memory store for active Claude SDK sessions.
 *
 * Provides CRUD operations over a `Map<instanceId, SessionEntry>`.
 * Thread-safe within a single Node.js process (single-threaded event loop).
 */
export class SessionStore {
  private readonly store = new Map<string, SessionEntry>();

  /**
   * Register a new session entry.
   *
   * @param entry - The session entry to add
   */
  add(entry: SessionEntry): void {
    this.store.set(entry.instanceId, entry);
  }

  /**
   * Update the SDK session ID for an existing entry once it is received
   * from the first SDK message.
   *
   * No-op if the instanceId is not found.
   *
   * @param instanceId - ID of the spawn instance
   * @param sessionId - SDK-assigned session identifier
   */
  setSessionId(instanceId: string, sessionId: string): void {
    const entry = this.store.get(instanceId);
    if (entry) {
      entry.sessionId = sessionId;
    }
  }

  /**
   * Retrieve an entry by instance ID.
   *
   * @param instanceId - ID of the spawn instance
   * @returns The session entry, or undefined if not found
   */
  get(instanceId: string): SessionEntry | undefined {
    return this.store.get(instanceId);
  }

  /**
   * Remove an entry by instance ID.
   *
   * @param instanceId - ID of the spawn instance to remove
   */
  remove(instanceId: string): void {
    this.store.delete(instanceId);
  }

  /**
   * List all active session entries.
   *
   * @returns Array of all tracked session entries
   */
  listActive(): SessionEntry[] {
    return Array.from(this.store.values());
  }

  /**
   * Return the number of tracked sessions.
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Clear all tracked sessions. Intended for testing only.
   */
  clear(): void {
    this.store.clear();
  }
}
