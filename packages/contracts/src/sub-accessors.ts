/**
 * Sub-accessor interfaces for UmbrellaDataAccessor role-specific databases.
 *
 * Each interface provides typed access to a specific CLEO database role.
 * These are returned by UmbrellaDataAccessor.getSubAccessor(role).
 *
 * Implementors:
 *   - BrainAccessor        → brain.db (memory observations, semantic graph)
 *   - ConduitAccessor      → conduit.db (project-scoped messaging)
 *   - NexusAccessor        → nexus.db (code intelligence graph)
 *   - SignaldockAccessor   → signaldock.db (global agent identity)
 *   - TelemetryAccessor    → (future — telemetry collection)
 *
 * See DocsAccessor in docs-accessor.ts for the docs/llmtxt sub-accessor.
 *
 * @task T9188
 * @epic T9048
 * @see ADR-068 (DB Charter — per-DB write ownership)
 * @see ADR-069 (Coordination Layers — Storage Layer contract)
 */

// ---------------------------------------------------------------------------
// BrainAccessor
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link BrainAccessor.observe}.
 */
export interface BrainObserveParams {
  /** Free-text observation content. */
  text: string;
  /** Human-readable title. */
  title?: string;
  /** Memory type / entry type. */
  type?: string;
  /** Source session ID linking this observation to a session. */
  sourceSessionId?: string;
  /** Agent identifier that produced this observation. */
  agent?: string;
}

/**
 * A memory hit returned by {@link BrainAccessor.find}.
 */
export interface BrainMemoryHit {
  /** Unique entry ID. */
  readonly id: string;
  /** Entry text. */
  readonly text: string;
  /** Entry title. */
  readonly title: string | null;
  /** Similarity or relevance score (0–1). */
  readonly score: number;
  /** Entry type. */
  readonly type: string | null;
}

/**
 * BrainAccessor — typed interface for brain.db (memory / observation store).
 *
 * Consumers depend on BrainAccessor, NOT on brain-retrieval internals.
 *
 * @task T9188
 * @epic T9048
 */
export interface BrainAccessor {
  /**
   * Store a new observation in brain.db.
   *
   * @param text - Observation text (required, non-empty).
   * @param params - Additional observation metadata.
   * @returns ID of the stored observation.
   */
  observe(text: string, params?: Omit<BrainObserveParams, 'text'>): Promise<string>;

  /**
   * Find memory entries matching the given query.
   *
   * @param query - Free-text search query.
   * @param limit - Maximum results (default: 10).
   * @returns Ranked memory hits.
   */
  find(query: string, limit?: number): Promise<BrainMemoryHit[]>;

  /**
   * Release resources held by this accessor.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ConduitAccessor
// ---------------------------------------------------------------------------

/**
 * ConduitAccessor — typed interface for conduit.db (project-scoped messaging).
 *
 * Minimal surface for T9188; full messaging API lives in conduit-sqlite.ts.
 *
 * @task T9188
 * @epic T9048
 */
export interface ConduitAccessor {
  /**
   * Publish a message to a conduit topic.
   *
   * @param topic - Topic identifier.
   * @param payload - Message payload (JSON-serializable).
   */
  publish(topic: string, payload: unknown): Promise<void>;

  /**
   * Check whether conduit.db is open and accessible.
   *
   * @returns True if the database is healthy.
   */
  ping(): Promise<boolean>;

  /**
   * Release resources held by this accessor.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// NexusAccessor
// ---------------------------------------------------------------------------

/**
 * NexusAccessor — typed interface for nexus.db (code intelligence).
 *
 * Minimal surface for T9188; full nexus API lives in nexus-sqlite.ts.
 *
 * @task T9188
 * @epic T9048
 */
export interface NexusAccessor {
  /**
   * Check whether nexus.db is open and accessible.
   *
   * @returns True if the database is healthy.
   */
  ping(): Promise<boolean>;

  /**
   * Release resources held by this accessor.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SignaldockAccessor
// ---------------------------------------------------------------------------

/**
 * SignaldockAccessor — typed interface for signaldock.db (global agent identity).
 *
 * Minimal surface for T9188; full signaldock API lives in signaldock-sqlite.ts.
 *
 * @task T9188
 * @epic T9048
 */
export interface SignaldockAccessor {
  /**
   * Check whether signaldock.db is open and accessible.
   *
   * @returns True if the database is healthy.
   */
  ping(): Promise<boolean>;

  /**
   * Release resources held by this accessor.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TelemetryAccessor
// ---------------------------------------------------------------------------

/**
 * TelemetryAccessor — typed interface for telemetry collection (future DB).
 *
 * Placeholder for T9188 contract completeness. Full implementation deferred.
 *
 * @task T9188
 * @epic T9048
 */
export interface TelemetryAccessor {
  /**
   * Record a telemetry event.
   *
   * @param event - Event name.
   * @param data - Event payload (JSON-serializable).
   */
  record(event: string, data?: Record<string, unknown>): Promise<void>;

  /**
   * Check whether telemetry collection is available.
   *
   * @returns True if collection is operational.
   */
  ping(): Promise<boolean>;

  /**
   * Release resources held by this accessor.
   */
  close(): Promise<void>;
}
