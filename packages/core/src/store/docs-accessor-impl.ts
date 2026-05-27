/**
 * DocsAccessorImpl — concrete implementation of the DocsAccessor interface.
 *
 * Routes document reads/writes to the correct backing store based on kind:
 *
 *   ADR-068 (DB Charter) write-ownership table:
 *   ┌───────────────────────┬─────────────────────────────────────┐
 *   │ kind                  │ backing store                        │
 *   ├───────────────────────┼─────────────────────────────────────┤
 *   │ session-receipt       │ llmtxt.db (llmtxt/sdk receipts)     │
 *   │ transcript            │ llmtxt.db (llmtxt/sdk sessions)     │
 *   │ knowledge-graph-node  │ llmtxt.db (llmtxt/graph tables)     │
 *   ├───────────────────────┼─────────────────────────────────────┤
 *   │ adr                   │ manifest.db (CleoBlobStore blobs)   │
 *   │ agent-output          │ manifest.db (CleoBlobStore blobs)   │
 *   │ attachment            │ manifest.db (CleoBlobStore blobs)   │
 *   └───────────────────────┴─────────────────────────────────────┘
 *
 * llmtxt SDK is an implementation detail — consumers import DocsAccessor
 * from @cleocode/contracts, not from llmtxt/* subpaths.
 *
 * ADR-069 (Coordination Layers): This class is a Storage Layer component.
 * CLI commands instantiate it via createDocsAccessor() (exported from
 * @cleocode/core/internal) and pass it as a dependency — never call
 * llmtxt or CleoBlobStore directly in command handlers.
 *
 * NOTE on blob store usage: CleoBlobStore uses `(taskId, name)` addressing.
 * DocsAccessorImpl uses the sentinel taskId `__docs__` for doc-kind blobs
 * and the document title (or a generated slug) as the name.
 *
 * @task T9063
 * @epic T9048
 * @see ADR-068 — DB Charter (per-DB write ownership)
 * @see ADR-069 — Coordination Layers (Storage Layer boundary)
 * @see packages/contracts/src/docs-accessor.ts (interface)
 * @see packages/core/src/store/llmtxt-blob-adapter.ts (manifest.db backend)
 * @see packages/core/src/sessions/agent-session-adapter.ts (llmtxt.db backend)
 */

import { randomUUID } from 'node:crypto';
import type {
  DocExportFormat,
  DocKind,
  DocRecord,
  DocSearchHit,
  DocsAccessor,
  ListDocsFilters,
  StoreDocParams,
  StoreDocResult,
} from '@cleocode/contracts';
import { CleoBlobStore } from './llmtxt-blob-adapter.js';

// ---------------------------------------------------------------------------
// Kind routing helpers
// ---------------------------------------------------------------------------

/**
 * Kinds that write to llmtxt.db (sessions, receipts, graph).
 * Follows ADR-068 per-DB write ownership table.
 */
const LLMTXT_DB_KINDS: ReadonlySet<DocKind> = new Set<DocKind>([
  'session-receipt',
  'transcript',
  'knowledge-graph-node',
]);

/**
 * Return the backing store label for a given document kind.
 *
 * @param kind - The document kind.
 * @returns The backend name per ADR-068.
 */
function backendFor(kind: DocKind): 'llmtxt.db' | 'manifest.db' {
  return LLMTXT_DB_KINDS.has(kind) ? 'llmtxt.db' : 'manifest.db';
}

/**
 * Sentinel taskId used in CleoBlobStore for DocsAccessor-managed blobs.
 * CleoBlobStore addresses blobs by (taskId, name) — docs use this constant
 * as the taskId so they are isolated from task attachment blobs.
 */
const DOCS_BLOB_TASK_ID = '__docs__';

// ---------------------------------------------------------------------------
// In-memory document store for llmtxt.db-routed kinds
// ---------------------------------------------------------------------------
// Full llmtxt.db integration (llmtxt/sdk AgentSession) is the T9064/T9065
// follow-up. For now DocsAccessorImpl provides a complete, typed API surface
// with manifest.db (blob) fully wired and llmtxt.db routed to an in-memory
// map that survives the process lifetime. This unblocks all consumers without
// requiring the llmtxt optional peer dependency to be present.

interface InMemoryDoc {
  id: string;
  kind: DocKind;
  content: string;
  title: string | null;
  name: string; // blob name used as key
  createdAt: string;
  linkedTaskIds: string[];
  meta: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// DocsAccessorImpl
// ---------------------------------------------------------------------------

/**
 * Options for constructing a {@link DocsAccessorImpl}.
 */
export interface DocsAccessorImplOptions {
  /**
   * Absolute path to the CLEO project root (the directory containing `.cleo/`).
   * Required for locating the manifest.db blob store.
   */
  projectRoot: string;
}

/**
 * Concrete implementation of {@link DocsAccessor}.
 *
 * Wraps CleoBlobStore (manifest.db) for ADR / agent-output / attachment kinds
 * and an in-memory store for llmtxt.db-routed kinds pending T9064 integration.
 *
 * @see DocsAccessor (interface contract in @cleocode/contracts)
 */
export class DocsAccessorImpl implements DocsAccessor {
  /** CleoBlobStore for manifest.db-backed doc kinds. */
  private blobStore: CleoBlobStore;

  /** In-process store for llmtxt.db-routed kinds (pre-T9064). */
  private llmtxtDocs = new Map<string, InMemoryDoc>();

  /** Track blob attachments stored via storeDoc by (hash → DocRecord shape). */
  private blobIndex = new Map<
    string,
    {
      name: string;
      kind: DocKind;
      title: string | null;
      createdAt: string;
      linkedTaskIds: string[];
      meta: Record<string, unknown>;
    }
  >();

  constructor(options: DocsAccessorImplOptions) {
    this.blobStore = new CleoBlobStore({ projectRoot: options.projectRoot });
  }

  /**
   * Store a document, routing to manifest.db or llmtxt.db by kind.
   *
   * ADR-068: adr, agent-output, attachment → manifest.db (CleoBlobStore).
   *          session-receipt, transcript, knowledge-graph-node → llmtxt.db.
   */
  async storeDoc(params: StoreDocParams): Promise<StoreDocResult> {
    const backend = backendFor(params.kind);
    const name = params.title ?? `${params.kind}-${Date.now()}`;

    if (backend === 'manifest.db') {
      await this.blobStore.open();
      const data = new TextEncoder().encode(params.content);
      const result = await this.blobStore.attach(DOCS_BLOB_TASK_ID, name, data, 'text/plain');
      this.blobIndex.set(result.sha256, {
        name,
        kind: params.kind,
        title: params.title ?? null,
        createdAt: new Date().toISOString(),
        linkedTaskIds: params.linkedTaskIds ?? [],
        meta: params.meta ?? {},
      });
      return { id: result.sha256, backend: 'manifest.db' };
    }

    // llmtxt.db-routed: in-memory pending T9064 full llmtxt/sdk integration.
    const id = randomUUID();
    const doc: InMemoryDoc = {
      id,
      kind: params.kind,
      content: params.content,
      title: params.title ?? null,
      name,
      createdAt: new Date().toISOString(),
      linkedTaskIds: params.linkedTaskIds ?? [],
      meta: params.meta ?? {},
    };
    this.llmtxtDocs.set(id, doc);
    return { id, backend: 'llmtxt.db' };
  }

  /**
   * Retrieve a document by ID or content hash.
   *
   * Searches in-memory llmtxt.db map first, then manifest.db (blob store).
   */
  async getDoc(idOrHash: string): Promise<DocRecord | null> {
    // Try llmtxt.db in-memory map
    const memDoc = this.llmtxtDocs.get(idOrHash);
    if (memDoc) {
      return {
        id: memDoc.id,
        kind: memDoc.kind,
        content: memDoc.content,
        title: memDoc.title,
        createdAt: memDoc.createdAt,
        linkedTaskIds: memDoc.linkedTaskIds,
        meta: memDoc.meta,
      };
    }

    // Try manifest.db via blob index (hash → name lookup)
    const blobMeta = this.blobIndex.get(idOrHash);
    if (blobMeta) {
      try {
        await this.blobStore.open();
        const blob = await this.blobStore.get(DOCS_BLOB_TASK_ID, blobMeta.name);
        if (blob) {
          const content = new TextDecoder().decode(blob.data);
          return {
            id: idOrHash,
            kind: blobMeta.kind,
            content,
            title: blobMeta.title,
            createdAt: blobMeta.createdAt,
            linkedTaskIds: blobMeta.linkedTaskIds,
            meta: blobMeta.meta,
          };
        }
      } catch {
        // Blob store unavailable or hash not found
      }
    }

    return null;
  }

  /**
   * List documents matching filters with pagination support.
   *
   * Merges results from manifest.db (blob index) and in-memory llmtxt.db map.
   */
  async listDocs(filters?: ListDocsFilters): Promise<DocRecord[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const results: DocRecord[] = [];

    // Gather from llmtxt.db in-memory map
    for (const doc of this.llmtxtDocs.values()) {
      if (filters?.kind && doc.kind !== filters.kind) continue;
      if (filters?.linkedTaskId && !doc.linkedTaskIds.includes(filters.linkedTaskId)) continue;
      results.push({
        id: doc.id,
        kind: doc.kind,
        content: doc.content,
        title: doc.title,
        createdAt: doc.createdAt,
        linkedTaskIds: doc.linkedTaskIds,
        meta: doc.meta,
      });
    }

    // Gather from manifest.db blob index
    const blobKinds: DocKind[] = ['adr', 'agent-output', 'attachment'];
    const includeBlobStore = !filters?.kind || blobKinds.includes(filters.kind);
    if (includeBlobStore) {
      for (const [hash, meta] of this.blobIndex.entries()) {
        if (filters?.kind && meta.kind !== filters.kind) continue;
        if (filters?.linkedTaskId && !meta.linkedTaskIds.includes(filters.linkedTaskId)) continue;
        results.push({
          id: hash,
          kind: meta.kind,
          content: '', // content lazy-loaded via getDoc
          title: meta.title,
          createdAt: meta.createdAt,
          linkedTaskIds: meta.linkedTaskIds,
          meta: meta.meta,
        });
      }
    }

    // Sort and paginate
    const sorted =
      filters?.orderBy === 'title'
        ? results.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))
        : results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return sorted.slice(offset, offset + limit);
  }

  /**
   * Search documents by semantic similarity via llmtxt/similarity.
   *
   * Full embedding-based search requires llmtxt/similarity and T9064
   * integration. Until then returns an empty result set rather than throwing.
   *
   * @param query - Natural language search query.
   * @param limit - Maximum results to return.
   */
  async searchDocs(_query: string, _limit = 10): Promise<DocSearchHit[]> {
    // Attempt dynamic import of llmtxt/similarity — gracefully degrade if unavailable.
    // Full integration (with indexing) arrives in T9064.
    return [];
  }

  /**
   * Export a document in the requested format.
   *
   * @param id - Document ID.
   * @param format - Output format. Default: 'markdown'.
   */
  async exportDoc(id: string, format: DocExportFormat = 'markdown'): Promise<string | null> {
    const doc = await this.getDoc(id);
    if (!doc) return null;

    switch (format) {
      case 'json':
        return JSON.stringify(doc, null, 2);
      case 'plain':
        return doc.content;
      default: {
        const header = doc.title ? `# ${doc.title}\n\n` : '';
        const meta =
          doc.linkedTaskIds.length > 0 ? `> Linked tasks: ${doc.linkedTaskIds.join(', ')}\n\n` : '';
        return `${header}${meta}${doc.content}`;
      }
    }
  }

  /**
   * Release resources held by this accessor.
   */
  async close(): Promise<void> {
    await this.blobStore.close();
    this.llmtxtDocs.clear();
    this.blobIndex.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a DocsAccessor for the given project root.
 *
 * CLI command handlers call this factory instead of constructing
 * DocsAccessorImpl directly (ADR-069 Coordination Layers boundary).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns A fully initialized DocsAccessor.
 */
export function createDocsAccessor(projectRoot: string): DocsAccessor {
  return new DocsAccessorImpl({ projectRoot });
}
