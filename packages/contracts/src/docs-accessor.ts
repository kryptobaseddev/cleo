/**
 * DocsAccessor — unified interface for all document operations in CLEO.
 *
 * Abstracts the scattered document surfaces behind a single typed API:
 *   - llmtxt/sdk (AgentSession, receipt, version patches)
 *   - llmtxt/blob (content-addressed blob store)
 *   - llmtxt/graph (KnowledgeGraph)
 *   - raw filesystem agent-outputs (migrated via T9064)
 *
 * Consumers depend on DocsAccessor, NOT on llmtxt/* subpaths directly.
 * The llmtxt SDK becomes an implementation detail of DocsAccessorImpl.
 *
 * DB storage split (ADR-068 — DB Charter):
 *   - storeDoc(kind=session-receipt | transcript) → writes to llmtxt.db
 *   - storeDoc(kind=adr | agent-output | attachment) → writes to manifest.db (blob store)
 *   - searchDocs() → queries llmtxt.db via llmtxt/similarity
 *   - listDocs(kind=knowledge-graph-node) → queries llmtxt.db graph tables
 *
 * Coordination model (ADR-069 — Coordination Layers):
 *   - DocsAccessor is a read/write accessor in the Storage Layer.
 *   - CLI commands go through the Dispatch Layer; they accept a DocsAccessor
 *     injected via the existing createDataAccessor() → UmbrellaDataAccessor chain.
 *   - No direct SQLite access in consumers — all queries route through DocsAccessor.
 *
 * @task T9063
 * @epic T9048
 * @see ADR-068 (DB Charter — per-DB write ownership)
 * @see ADR-069 (Coordination Layers — Storage Layer contract)
 * @see T1824 (Decision Storage Consolidation — DocsAccessor becomes the write path for ADRs)
 * @see T1825 (ADR migration — ADR files ingest via storeDoc(kind='adr'))
 */

// ---------------------------------------------------------------------------
// Document kind discriminated union
// ---------------------------------------------------------------------------

/**
 * All document kinds that DocsAccessor can store and retrieve.
 *
 * - `adr`                — Architecture Decision Records (docs/adr/*.md)
 * - `agent-output`       — Agent session markdown outputs (.cleo/agent-outputs/*.md)
 * - `transcript`         — Full agent conversation transcripts (llmtxt.db)
 * - `attachment`         — Task attachments (manifest.db blob store)
 * - `session-receipt`    — llmtxt session receipts (llmtxt.db sessions table)
 * - `knowledge-graph-node` — Nodes from llmtxt/graph KnowledgeGraph (llmtxt.db)
 */
export type DocKind =
  | 'adr'
  | 'agent-output'
  | 'transcript'
  | 'attachment'
  | 'session-receipt'
  | 'knowledge-graph-node';

// ---------------------------------------------------------------------------
// Core document record
// ---------------------------------------------------------------------------

/**
 * A stored document record returned by getDoc / listDocs.
 */
export interface DocRecord {
  /** Content-addressed identifier (SHA-256 hex for blob-backed; UUID for DB-backed). */
  readonly id: string;
  /** Document kind. */
  readonly kind: DocKind;
  /** Raw content of the document (UTF-8 text or base64 for binary). */
  readonly content: string;
  /** Human-readable title or filename. */
  readonly title: string | null;
  /** ISO 8601 creation timestamp. */
  readonly createdAt: string;
  /** Linked task IDs (e.g. the task this agent-output was produced for). */
  readonly linkedTaskIds: string[];
  /** Arbitrary metadata blob (kind-specific). */
  readonly meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Method parameter types
// ---------------------------------------------------------------------------

/**
 * Parameters for {@link DocsAccessor.storeDoc}.
 */
export interface StoreDocParams {
  /** Document kind determining which backing store is used. */
  kind: DocKind;
  /** Raw document content (UTF-8). */
  content: string;
  /** Human-readable title or filename. */
  title?: string;
  /** Task IDs to link to this document. */
  linkedTaskIds?: string[];
  /** Arbitrary metadata to attach (kind-specific). */
  meta?: Record<string, unknown>;
}

/**
 * Result from {@link DocsAccessor.storeDoc}.
 */
export interface StoreDocResult {
  /** Assigned document ID (SHA-256 for blob-backed, UUID for DB-backed). */
  readonly id: string;
  /** The backing store that received the write. */
  readonly backend: 'llmtxt.db' | 'manifest.db';
}

/**
 * Filters for {@link DocsAccessor.listDocs}.
 */
export interface ListDocsFilters {
  /** Restrict to one document kind. */
  kind?: DocKind;
  /** Restrict to documents linked to this task ID. */
  linkedTaskId?: string;
  /** Maximum number of results. Default: 100. */
  limit?: number;
  /** Offset for pagination. */
  offset?: number;
  /** Order by. Default: 'createdAt'. */
  orderBy?: 'createdAt' | 'title';
}

/**
 * A search hit from {@link DocsAccessor.searchDocs}.
 */
export interface DocSearchHit {
  /** The matching document record. */
  readonly doc: DocRecord;
  /** Similarity score (0–1, higher is more relevant). */
  readonly score: number;
}

/**
 * Export format for {@link DocsAccessor.exportDoc}.
 */
export type DocExportFormat = 'markdown' | 'json' | 'plain';

// ---------------------------------------------------------------------------
// DocsAccessor interface
// ---------------------------------------------------------------------------

/**
 * DocsAccessor — unified interface for all CLEO document operations.
 *
 * Backed by llmtxt.db (sessions + receipts) and manifest.db (blob attachments).
 * Both backing stores are opaque to consumers — all access goes through this
 * interface.
 *
 * DB write ownership (ADR-068):
 *   - `session-receipt`, `transcript`, `knowledge-graph-node` → llmtxt.db
 *   - `adr`, `agent-output`, `attachment` → manifest.db (blob store)
 *
 * @see ADR-068 — DB Charter per-DB write ownership table
 * @see ADR-069 — Coordination Layers: DocsAccessor is a Storage Layer contract
 */
export interface DocsAccessor {
  /**
   * Store a document, routing to the correct backing store by kind.
   *
   * @param params - Document content, kind, and metadata.
   * @returns The assigned ID and backend that received the write.
   */
  storeDoc(params: StoreDocParams): Promise<StoreDocResult>;

  /**
   * Retrieve a document by ID or content hash.
   *
   * @param idOrHash - Document ID (UUID or SHA-256 hex).
   * @returns The document record, or null if not found.
   */
  getDoc(idOrHash: string): Promise<DocRecord | null>;

  /**
   * List documents matching filters with pagination support.
   *
   * @param filters - Optional filter bag.
   * @returns Array of matching document records.
   */
  listDocs(filters?: ListDocsFilters): Promise<DocRecord[]>;

  /**
   * Search documents by semantic similarity via llmtxt/similarity.
   *
   * Queries the llmtxt.db embeddings index. Only documents with embeddings
   * are returned (agent-outputs, ADRs, transcripts ingested via storeDoc).
   *
   * @param query - Natural language query string.
   * @param limit - Maximum hits to return. Default: 10.
   * @returns Ranked search results with similarity scores.
   */
  searchDocs(query: string, limit?: number): Promise<DocSearchHit[]>;

  /**
   * Export a document in the requested format.
   *
   * @param id - Document ID.
   * @param format - Output format. Default: 'markdown'.
   * @returns Formatted document content string, or null if not found.
   */
  exportDoc(id: string, format?: DocExportFormat): Promise<string | null>;

  /**
   * Release any resources held by this accessor (close DB connections).
   */
  close(): Promise<void>;
}
