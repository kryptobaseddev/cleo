/**
 * DocsReadModel — unified read-side query surface for the CLEO docs system.
 *
 * Abstracts the scattered document surfaces (tasks.db attachments,
 * manifest.db blobs, and the docs-publications.json ledger) behind one
 * coherent read API. Agents and CLI command handlers query through this
 * model instead of navigating the individual stores directly.
 *
 * Lookup axes:
 *   - slug          → resolve by stable human-readable slug (from attachments.slug)
 *   - owner         → resolve all docs owned by a task/session/observation
 *   - attachmentId  → resolve by attachment UUID or SHA-256 content address
 *   - blobName      → resolve by blob name within an owner's manifest
 *   - latest        → resolve the latest version for a given slug
 *
 * The read model also surfaces publication status and drift classification
 * from the docs-publications.json ledger, which is the canonical record of
 * which blobs have been published to git-tracked paths and whether those
 * published files are in-sync with the backing blob store.
 *
 * @task T11049 (T10516-C2)
 * @epic T10519 (T10516-C)
 * @saga T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 * @see packages/core/src/store/attachment-store.ts (tasks.db attachments)
 * @see packages/core/src/store/blob-ops.ts (manifest.db blobs via llmtxt)
 * @see packages/core/src/docs/docs-ops.ts (publications ledger + status)
 */
import { createHash } from 'node:crypto';
import type { AttachmentMetadata, DocKind } from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import type { BlobListEntry } from '../store/blob-ops.js';
import { blobList, blobRead } from '../store/blob-ops.js';
import type { AttachmentLifecycleStatus } from '../store/schema/attachments.js';

// ---------------------------------------------------------------------------
// Re-use the publications types from docs-ops via dynamic import to avoid
// a circular dependency (docs-read-model → docs-ops → docs-read-model).
// ---------------------------------------------------------------------------

interface DocsPublicationRecord {
  readonly ownerId: string;
  readonly blobName: string;
  readonly publishedPath: string;
  readonly lastBlobSha: string;
  readonly publishedAt: string;
}

interface DocsPublicationsLedger {
  readonly version: 1;
  readonly entries: readonly DocsPublicationRecord[];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A fully-resolved document record surfaced by the read model.
 *
 * Unifies fields from tasks.db attachments, manifest.db blobs, and the
 * publications ledger into a single envelope. Content is NOT populated by
 * default — callers that need the raw text must call {@link DocsReadModel.fetchContent}
 * separately. This keeps list/status operations fast by avoiding unnecessary blob reads.
 */
export interface ResolvedDoc {
  /** Attachment UUID (tasks.db) or SHA-256 hex (blob store). Always set. */
  readonly id: string;
  /** SHA-256 content hash. The canonical content address. */
  readonly sha256: string;
  /** Document taxonomy kind (e.g. 'adr', 'spec', 'research'). Null for raw blobs. */
  readonly kind: DocKind | null;
  /** Display title. Falls back to slug, then blob name. */
  readonly title: string | null;
  /** Stable human-readable slug from attachments.slug. Null for slug-less blobs. */
  readonly slug: string | null;
  /** Owner entity ID (task/session/observation ID). */
  readonly ownerId: string;
  /** Owner entity type. */
  readonly ownerType: string;
  /** Attachment or blob name (e.g. "spec.md"). */
  readonly blobName: string;
  /** Byte size of the stored content. */
  readonly sizeBytes: number;
  /**
   * Number of owners referencing this doc, sourced from `attachments.ref_count`
   * in tasks.db. Zero for manifest-only blobs (which have no ref-count concept)
   * and for freshly-added docs not yet attached to an owner. Surfacing the real
   * value keeps `docs list` consistent with the `docs add` response (T11572).
   */
  readonly refCount: number;
  /** IANA MIME type, when known. */
  readonly mimeType: string | null;
  /** Human-readable summary from attachments.summary. */
  readonly summary: string | null;
  /** Lifecycle status: 'active', 'archived', 'draft', etc. */
  readonly lifecycleStatus: string;
  /** ISO 8601 creation timestamp from the primary store. */
  readonly createdAt: string;
  /** Project-root-relative published file path, or null if unpublished. */
  readonly publishedPath: string | null;
  /** ISO 8601 timestamp of latest publish, or null if unpublished. */
  readonly publishedAt: string | null;
  /** SHA of the blob at the time of publish, or null if unpublished. */
  readonly lastPublishedBlobSha: string | null;
  /** Drift classification between published file and backing blob. */
  readonly publicationDrift: 'in-sync' | 'modified' | 'deleted' | 'unpublished';
  /** Which backing store this doc was resolved from. */
  readonly source: 'tasks-db' | 'manifest-db' | 'merged';
}

/**
 * Filters for {@link DocsReadModel.listProjectDocs}.
 */
export interface ListProjectDocsOpts {
  /** Restrict to a single document kind. */
  kind?: string;
  /** Maximum number of results. Default: 200. */
  limit?: number;
  /** Whether to only return docs with a slug. Default: false. */
  sluggedOnly?: boolean;
  /** Whether to include unpublished docs. Default: true. */
  includeUnpublished?: boolean;
}

/**
 * Options for constructing a {@link DocsReadModel}.
 */
export interface DocsReadModelOptions {
  /**
   * Absolute path to the CLEO project root (the directory containing `.cleo/`).
   * Defaults to {@link getProjectRoot}() when omitted.
   */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// DocsReadModel implementation
// ---------------------------------------------------------------------------

/**
 * Unified read-side query model for the CLEO docs system.
 *
 * Hides the three-backend reality (tasks.db attachments, manifest.db blobs,
 * docs-publications.json ledger) behind a single typed query surface.
 * CLI command handlers should depend on this class rather than calling
 * `AttachmentStore`, `blobList`, or `readPublicationsLedger` directly.
 *
 * Construction is cheap — the underlying stores are opened lazily on
 * first use and closed via {@link close}.
 *
 * @example
 * ```ts
 * const model = createDocsReadModel({ projectRoot: '/path/to/project' });
 *
 * // Resolve the latest version of an ADR by slug
 * const doc = await model.resolveBySlug('adr-068-db-charter');
 *
 * // List all docs owned by a task
 * const docs = await model.resolveByOwner('T11049');
 *
 * // Check publication status
 * const pubs = await model.listProjectDocs({ sluggedOnly: true });
 * ```
 */
export class DocsReadModel {
  private readonly projectRoot: string;
  private publicationCache: Promise<DocsPublicationRecord[]> | null = null;

  constructor(options: DocsReadModelOptions = {}) {
    this.projectRoot = options.projectRoot ?? getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // Core resolution methods
  // -----------------------------------------------------------------------

  /**
   * Resolve a single document by its stable slug.
   *
   * Queries the tasks.db attachments table for a row whose `slug` column
   * matches. When found, enriches the result with blob-store metadata and
   * publication status.
   *
   * @param slug - The exact slug to look up (case-sensitive).
   * @returns A resolved doc, or `null` if no attachment carries this slug.
   */
  async resolveBySlug(slug: string): Promise<ResolvedDoc | null> {
    const store = createAttachmentStore();
    const row = await store.findBySlug(slug, this.projectRoot);
    if (!row) return null;

    return this.enrichFromTasksDb(row.metadata, {
      slug: row.slug,
      type: row.type,
      summary: row.summary,
      lifecycleStatus: row.lifecycleStatus,
    });
  }

  /**
   * Resolve all documents owned by a given entity.
   *
   * Merges results from both tasks.db (via `listByOwner`) and manifest.db
   * (via `blobList`). Tasks.db attachments take precedence when both stores
   * have entries for the same owner + blob name combination.
   *
   * @param ownerId - Task, session, or observation ID (e.g. "T11049").
   * @param opts.ownerType - Owner type. Defaults to 'task'.
   * @param opts.kind - Optional kind filter.
   * @returns Array of resolved docs (may be empty).
   */
  async resolveByOwner(
    ownerId: string,
    opts?: { ownerType?: string; kind?: string },
  ): Promise<ResolvedDoc[]> {
    const ownerType = opts?.ownerType ?? 'task';
    const kindFilter = opts?.kind ?? null;

    const [attachmentDocs, blobDocs] = await Promise.all([
      this.resolveFromTasksDbByOwner(ownerId, ownerType),
      this.resolveFromManifestByOwner(ownerId),
    ]);

    // Merge by blob name: tasks.db wins, manifest entries only added when
    // there is no tasks.db entry with the same blobName.
    const merged = new Map<string, ResolvedDoc>();
    for (const doc of attachmentDocs) merged.set(doc.blobName, doc);
    for (const doc of blobDocs) {
      if (!merged.has(doc.blobName)) merged.set(doc.blobName, doc);
    }

    let results = Array.from(merged.values());
    if (kindFilter) results = results.filter((d) => d.kind === kindFilter);
    return results;
  }

  /**
   * Resolve a single document by attachment ID or SHA-256 content hash.
   *
   * Searches both tasks.db (by UUID attachment ID) and the blob store
   * (by SHA-256 content address). Tasks.db is tried first.
   *
   * @param id - Attachment UUID or 64-char hex SHA-256.
   * @returns A resolved doc, or `null` if no match is found.
   */
  async resolveByAttachmentId(id: string): Promise<ResolvedDoc | null> {
    // Try tasks.db first (attachment UUIDs look like `att_<...>` or UUID)
    const store = createAttachmentStore();
    const meta = await store.getMetadata(id, this.projectRoot);
    if (meta) {
      // Fetch extras (slug, type) from the row
      const extras = await store.getExtras(id, this.projectRoot);
      return this.enrichFromTasksDb(meta, {
        slug: extras?.slug ?? null,
        type: extras?.type ?? null,
        summary: null,
        lifecycleStatus: 'active',
      });
    }

    // Fall back to blob-store lookup by SHA-256
    return this.resolveFromBlobStoreBySha(id);
  }

  /**
   * Resolve a document by blob name within an owner's scope.
   *
   * Typical use: looking up the latest version of a published doc where
   * you know the owner and the blob name but not the slug.
   *
   * @param ownerId - Owner entity ID.
   * @param blobName - The blob/attachment name.
   * @returns A resolved doc, or `null` if not found.
   */
  async resolveByBlobName(ownerId: string, blobName: string): Promise<ResolvedDoc | null> {
    // Try the blob store first (manifest.db, fast path)
    const bytes = await blobRead(ownerId, blobName, this.projectRoot);
    if (bytes) {
      const blobs = await blobList(ownerId, this.projectRoot).catch(() => []);
      const match = blobs.find((b) => b.name === blobName);
      if (match) {
        return this.buildFromBlobEntry(ownerId, match);
      }
    }

    // Fall back to tasks.db — list by owner and filter by name
    const ownerDocs = await this.resolveByOwner(ownerId);
    const match = ownerDocs.find((d) => d.blobName === blobName);
    return match ?? null;
  }

  /**
   * Resolve the latest version of a document by slug.
   *
   * Alias for {@link resolveBySlug} with version semantic baked into the
   * name so callers (status/fetch/publish/list commands) know this is the
   * canonical "latest" resolution path.
   *
   * @param slug - Stable slug.
   * @returns The latest resolved doc, or `null`.
   */
  async resolveLatest(slug: string): Promise<ResolvedDoc | null> {
    return this.resolveBySlug(slug);
  }

  // -----------------------------------------------------------------------
  // List operations
  // -----------------------------------------------------------------------

  /**
   * List all documents in the project, merged from all backing stores.
   *
   * Deduplicates by SHA-256 content hash + slug, preferring tasks.db entries
   * over raw blob store entries when both exist for the same slug.
   *
   * @param opts - Optional filters and pagination.
   * @returns Array of resolved docs sorted by creation date (newest first).
   */
  async listProjectDocs(opts?: ListProjectDocsOpts): Promise<ResolvedDoc[]> {
    const limit = opts?.limit ?? 200;
    const kindFilter = opts?.kind ?? null;

    const [attachmentDocs, blobDocs, publications] = await Promise.all([
      this.resolveAllFromTasksDb(),
      this.resolveAllFromManifest(),
      this.loadPublications(),
    ]);

    // Dedupe: key by slug when available, otherwise by (ownerId, blobName) pair.
    const merged = new Map<string, ResolvedDoc>();

    for (const doc of attachmentDocs) {
      const key = doc.slug ?? `${doc.ownerId}:${doc.blobName}`;
      merged.set(key, doc);
    }

    for (const doc of blobDocs) {
      const key = `${doc.ownerId}:${doc.blobName}`;
      if (!merged.has(key)) {
        merged.set(key, doc);
      }
    }

    // Annotate with publication status
    for (const [, doc] of merged) {
      const pub = publications.find(
        (p) => p.ownerId === doc.ownerId && p.blobName === doc.blobName,
      );
      if (pub) {
        (doc as MutableResolvedDoc).publishedPath = pub.publishedPath;
        (doc as MutableResolvedDoc).publishedAt = pub.publishedAt;
        (doc as MutableResolvedDoc).lastPublishedBlobSha = pub.lastBlobSha;
        (doc as MutableResolvedDoc).publicationDrift =
          pub.lastBlobSha === doc.sha256 ? 'in-sync' : 'modified';
      }
    }

    let results = Array.from(merged.values());
    if (kindFilter) results = results.filter((d) => d.kind === kindFilter);
    if (opts?.sluggedOnly) results = results.filter((d) => d.slug !== null);
    if (opts?.includeUnpublished === false) {
      results = results.filter((d) => d.publishedPath !== null);
    }

    // Sort by createdAt descending
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return results.slice(0, limit);
  }

  // -----------------------------------------------------------------------
  // Content fetching
  // -----------------------------------------------------------------------

  /**
   * Fetch the raw content bytes for a resolved document.
   *
   * The read model's resolution methods do NOT load content by default
   * (keeps list/status operations fast). Call this when you need the
   * actual text/bytes.
   *
   * @param doc - A resolved doc (from any resolution method).
   * @returns The raw content as a UTF-8 string, or `null` if the blob
   *          cannot be read.
   */
  async fetchContent(doc: ResolvedDoc): Promise<string | null> {
    // Try blob store first
    const bytes = await blobRead(doc.ownerId, doc.blobName, this.projectRoot);
    if (bytes) return new TextDecoder().decode(bytes);

    // Fall back to attachment store
    const store = createAttachmentStore();
    try {
      const result = await store.get(doc.sha256, this.projectRoot);
      if (result) return result.bytes.toString('utf-8');
    } catch {
      // Attachment store unavailable or blob purged
    }

    return null;
  }

  /**
   * Fetch content for multiple docs in parallel.
   *
   * @param docs - Resolved docs array.
   * @returns Map of doc id → content string. Docs whose content could
   *          not be fetched are omitted.
   */
  async fetchContentBatch(docs: ResolvedDoc[]): Promise<Map<string, string>> {
    const results = await Promise.all(
      docs.map(async (d) => {
        const content = await this.fetchContent(d);
        return { id: d.id, content };
      }),
    );
    const map = new Map<string, string>();
    for (const { id, content } of results) {
      if (content !== null) map.set(id, content);
    }
    return map;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /**
   * Release any cached resources. The read model is stateless aside from
   * the publication cache; calling this is optional but recommended for
   * long-running processes to free memory.
   */
  close(): void {
    this.publicationCache = null;
  }

  // -----------------------------------------------------------------------
  // Publication status
  // -----------------------------------------------------------------------

  /**
   * Check publication status for all published docs.
   *
   * Compares the blob SHA in the store against the file SHA on disk
   * for every entry in the docs-publications ledger.
   * Returns the same shape as `statusDocs()` for backward compatibility.
   */
  async status(projectRootOverride?: string): Promise<{
    readonly items: readonly {
      readonly ownerId: string;
      readonly blobName: string;
      readonly publishedPath: string;
      readonly blobSha: string;
      readonly fileSha: string | null;
      readonly drift: 'in-sync' | 'added' | 'modified' | 'deleted';
    }[];
    readonly allInSync: boolean;
  }> {
    const root = projectRootOverride ?? this.projectRoot;
    const publications = await this.loadPublications();
    if (publications.length === 0) {
      return { items: [], allInSync: true };
    }

    const { readFile, stat } = await import('node:fs/promises');
    const { resolve: resolvePathFn, isAbsolute: isAbs } = await import('node:path');

    // Build blob sha cache from the manifest
    const ownerCache = new Map<string, Map<string, string>>();
    async function getBlobSha(
      ownerId: string,
      blobName: string,
      ledgerSha: string,
    ): Promise<string> {
      let perOwner = ownerCache.get(ownerId);
      if (!perOwner) {
        perOwner = new Map();
        const rows = await blobList(ownerId, root).catch(() => []);
        for (const row of rows) perOwner.set(row.name, row.sha256);
        ownerCache.set(ownerId, perOwner);
      }
      return perOwner.get(blobName) ?? ledgerSha;
    }

    const items: {
      ownerId: string;
      blobName: string;
      publishedPath: string;
      blobSha: string;
      fileSha: string | null;
      drift: 'in-sync' | 'added' | 'modified' | 'deleted';
    }[] = [];

    for (const row of publications) {
      const filePath = isAbs(row.publishedPath)
        ? row.publishedPath
        : resolvePathFn(root, row.publishedPath);

      const blobSha = await getBlobSha(row.ownerId, row.blobName, row.lastBlobSha);

      let fileSha: string | null = null;
      let exists = false;
      try {
        await stat(filePath);
        exists = true;
      } catch {
        /* missing */
      }

      let drift: 'in-sync' | 'added' | 'modified' | 'deleted';
      if (exists) {
        try {
          const data = await readFile(filePath);
          fileSha = createHash('sha256').update(data).digest('hex');
          drift = fileSha === blobSha ? 'in-sync' : 'modified';
        } catch {
          drift = 'deleted';
        }
      } else {
        drift = 'deleted';
      }

      items.push({
        ownerId: row.ownerId,
        blobName: row.blobName,
        publishedPath: row.publishedPath,
        blobSha,
        fileSha,
        drift,
      });
    }

    return {
      items,
      allInSync: items.every((i) => i.drift === 'in-sync'),
    };
  }

  // -----------------------------------------------------------------------
  // Private: resolution helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve docs from tasks.db attachments for a given owner.
   */
  private async resolveFromTasksDbByOwner(
    ownerId: string,
    ownerType: string,
  ): Promise<ResolvedDoc[]> {
    const store = createAttachmentStore();
    const metas = await store.listByOwner(ownerType, ownerId, this.projectRoot);

    // For each attachment, also fetch extras (slug/type) from the attachments row.
    const results: ResolvedDoc[] = [];
    for (const meta of metas) {
      const extras = await store.getExtras(meta.id, this.projectRoot);
      const doc = await this.enrichFromTasksDb(meta, {
        slug: extras?.slug ?? null,
        type: extras?.type ?? null,
        summary: null,
        lifecycleStatus: 'active',
      });
      results.push(doc);
    }
    return results;
  }

  /**
   * Resolve ALL docs from tasks.db.
   */
  private async resolveAllFromTasksDb(): Promise<ResolvedDoc[]> {
    const store = createAttachmentStore();
    const rows = await store.listAllInProject(this.projectRoot);
    return rows.map((row) => {
      const name = extractBlobName(row.metadata);
      const size = extractBlobSize(row.metadata);
      const mime = extractBlobMime(row.metadata);
      return {
        id: row.metadata.id,
        sha256: row.metadata.sha256,
        kind: (row.type as DocKind) ?? null,
        title: row.slug ?? name ?? null,
        slug: row.slug,
        ownerId: row.ownerId,
        ownerType: row.ownerType,
        blobName: name ?? row.slug ?? row.metadata.id,
        sizeBytes: size,
        refCount: row.metadata.refCount,
        mimeType: mime,
        summary: row.summary,
        lifecycleStatus: row.lifecycleStatus,
        createdAt: row.metadata.createdAt,
        publishedPath: null,
        publishedAt: null,
        lastPublishedBlobSha: null,
        publicationDrift: 'unpublished' as const,
        source: 'tasks-db' as const,
      };
    });
  }

  /**
   * Resolve docs from manifest.db blobs for a given owner.
   */
  private async resolveFromManifestByOwner(ownerId: string): Promise<ResolvedDoc[]> {
    const blobs = await blobList(ownerId, this.projectRoot).catch(() => []);
    return blobs.map((b) => this.buildResolvedDocFromBlob(ownerId, b));
  }

  /**
   * Resolve ALL docs from manifest.db across all known owners.
   *
   * Since manifest.db does not support "list all owners" natively, this
   * is best-effort — it queries all owner IDs we know about from tasks.db
   * and the publications ledger.
   */
  private async resolveAllFromManifest(): Promise<ResolvedDoc[]> {
    // Discover owner IDs from tasks.db attachment refs
    const store = createAttachmentStore();
    const allRows = await store.listAllInProject(this.projectRoot);
    const ownerIds = new Set(allRows.map((r) => r.ownerId));

    // Also include owner IDs from the publications ledger
    const pubs = await this.loadPublications();
    for (const p of pubs) ownerIds.add(p.ownerId);

    const results: ResolvedDoc[] = [];
    for (const ownerId of ownerIds) {
      const blobs = await blobList(ownerId, this.projectRoot).catch(() => []);
      for (const b of blobs) {
        results.push(this.buildResolvedDocFromBlob(ownerId, b));
      }
    }
    return results;
  }

  /**
   * Resolve a doc from the blob store by SHA-256 content hash.
   *
   * This requires scanning owners since manifest.db indexes by (owner, name).
   * For large projects this is expensive — prefer attachment-ID lookup.
   */
  private async resolveFromBlobStoreBySha(sha256: string): Promise<ResolvedDoc | null> {
    // Discover known owners
    const store = createAttachmentStore();
    const allRows = await store.listAllInProject(this.projectRoot);
    const ownerIds = new Set(allRows.map((r) => r.ownerId));

    const pubs = await this.loadPublications();
    for (const p of pubs) ownerIds.add(p.ownerId);

    for (const ownerId of ownerIds) {
      const blobs = await blobList(ownerId, this.projectRoot).catch(() => []);
      const match = blobs.find((b) => b.sha256 === sha256);
      if (match) return this.buildResolvedDocFromBlob(ownerId, match);
    }

    return null;
  }

  /**
   * Build a ResolvedDoc from a manifest.db blob entry.
   */
  private buildResolvedDocFromBlob(ownerId: string, entry: BlobListEntry): ResolvedDoc {
    // Derive kind from known taxonomy types
    const kind = inferDocKind(entry.name);
    return {
      id: entry.sha256,
      sha256: entry.sha256,
      kind,
      title: entry.name,
      slug: kind ? entry.name.replace(/\.md$/, '') : null,
      ownerId,
      ownerType: detectOwnerType(ownerId),
      blobName: entry.name,
      sizeBytes: entry.sizeBytes,
      // manifest.db blobs are the content SSoT, not the ref-counted attachment
      // store — there is no per-owner ref_count to surface here.
      refCount: 0,
      mimeType: entry.mimeType ?? null,
      summary: null,
      lifecycleStatus: 'active',
      createdAt: new Date(0).toISOString(), // manifest.db does not track creation time
      publishedPath: null,
      publishedAt: null,
      lastPublishedBlobSha: null,
      publicationDrift: 'unpublished',
      source: 'manifest-db',
    };
  }

  /**
   * Build a ResolvedDoc from a blob entry.
   */
  private buildFromBlobEntry(ownerId: string, entry: BlobListEntry): ResolvedDoc {
    return this.buildResolvedDocFromBlob(ownerId, entry);
  }

  /**
   * Enrich a tasks.db attachment with blob-store and publication context.
   */
  private async enrichFromTasksDb(
    meta: AttachmentMetadata,
    extras: {
      slug: string | null;
      type: string | null;
      summary: string | null;
      lifecycleStatus: AttachmentLifecycleStatus | string | null;
    },
  ): Promise<ResolvedDoc> {
    const blobName = extractBlobName(meta);
    const size = extractBlobSize(meta);
    const mime = extractBlobMime(meta);
    const ownerId = inferOwnerIdFromMeta(meta);

    // Check publication status
    const publications = await this.loadPublications();
    const pub = publications.find(
      (p) => p.ownerId === ownerId && p.blobName === (blobName ?? extras.slug ?? ''),
    );

    let publicationDrift: ResolvedDoc['publicationDrift'] = 'unpublished';
    if (pub) {
      publicationDrift = pub.lastBlobSha === meta.sha256 ? 'in-sync' : 'modified';
    }

    return {
      id: meta.id,
      sha256: meta.sha256,
      kind: (extras.type as DocKind) ?? null,
      title: extras.slug ?? blobName ?? null,
      slug: extras.slug,
      ownerId,
      ownerType: detectOwnerType(ownerId),
      blobName: blobName ?? extras.slug ?? meta.id,
      sizeBytes: size,
      refCount: meta.refCount,
      mimeType: mime,
      summary: extras.summary,
      lifecycleStatus: extras.lifecycleStatus ?? 'active',
      createdAt: meta.createdAt,
      publishedPath: pub?.publishedPath ?? null,
      publishedAt: pub?.publishedAt ?? null,
      lastPublishedBlobSha: pub?.lastBlobSha ?? null,
      publicationDrift,
      source: 'tasks-db',
    };
  }

  /**
   * Load publications from the JSON ledger, cached in memory.
   */
  private async loadPublications(): Promise<DocsPublicationRecord[]> {
    if (this.publicationCache) return this.publicationCache;

    this.publicationCache = (async () => {
      const { join } = await import('node:path');
      const { readFile } = await import('node:fs/promises');
      const ledgerPath = join(this.projectRoot, '.cleo', 'docs-publications.json');
      try {
        const raw = await readFile(ledgerPath, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<DocsPublicationsLedger>;
        if (!parsed || !Array.isArray(parsed.entries)) return [];
        return parsed.entries.filter(
          (e): e is DocsPublicationRecord =>
            !!e &&
            typeof e.ownerId === 'string' &&
            typeof e.blobName === 'string' &&
            typeof e.publishedPath === 'string' &&
            typeof e.lastBlobSha === 'string' &&
            typeof e.publishedAt === 'string',
        );
      } catch {
        return [];
      }
    })();

    return this.publicationCache;
  }
}

// ---------------------------------------------------------------------------
// Internal mutable shape (used during enrichment)
// ---------------------------------------------------------------------------

interface MutableResolvedDoc {
  publishedPath?: string | null;
  publishedAt?: string | null;
  lastPublishedBlobSha?: string | null;
  publicationDrift?: ResolvedDoc['publicationDrift'];
}

// ---------------------------------------------------------------------------
// Attachment helper functions
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable blob/attachment name from an AttachmentMetadata record.
 *
 * Handles all Attachment variant kinds:
 *   - `blob`        → `attachment.storageKey` (last segment); falls back to
 *                     legacy `name`/`blobId` fields when `storageKey` is absent
 *                     (T11262 — historic rows written before the contract was
 *                     enforced at the writer chokepoint).
 *   - `local-file`  → `path.basename(attachment.path)` (defensive against
 *                     missing `path`)
 *   - `url`         → the last path segment of the URL
 *   - `llms-txt`    → `"llms-txt"` (flat content, no file)
 *   - `llmtxt-doc`  → `"llmtxt-doc"` (pointer into llmtxt backend)
 *
 * Never throws on malformed input — always falls through to `null`.
 *
 * @task T11262
 */
function extractBlobName(meta: AttachmentMetadata): string | null {
  const att = meta.attachment;
  // Legacy/malformed shape fallback (T11262). Some historic blob rows pre-date
  // the writer-chokepoint enforcement and carry `name`/`blobId` instead of
  // `storageKey`. Reading must NEVER throw on those rows — list/fetch must
  // remain functional even when a single project row is poisoned.
  const legacyName = (att as { name?: unknown }).name;
  switch (att.kind) {
    case 'blob': {
      const sk = (att as { storageKey?: unknown }).storageKey;
      if (typeof sk === 'string' && sk.length > 0) {
        return sk.split('/').pop() ?? null;
      }
      if (typeof legacyName === 'string' && legacyName.length > 0) {
        return legacyName;
      }
      return null;
    }
    case 'local-file': {
      const p = (att as { path?: unknown }).path;
      if (typeof p === 'string' && p.length > 0) {
        return p.split('/').pop() ?? null;
      }
      return null;
    }
    case 'url':
      try {
        const urlPath = new URL(att.url).pathname;
        return urlPath.split('/').pop() || null;
      } catch {
        return null;
      }
    case 'llms-txt':
      return 'llms-txt';
    case 'llmtxt-doc':
      return 'llmtxt-doc';
    default:
      return null;
  }
}

/**
 * Extract the byte size from an AttachmentMetadata record.
 *
 * Returns 0 for variants that do not carry a size field (url without cache,
 * llmtxt-doc).
 */
function extractBlobSize(meta: AttachmentMetadata): number {
  const att = meta.attachment;
  switch (att.kind) {
    case 'blob':
    case 'local-file':
      return att.size;
    case 'url':
      return att.cachedSha256 ? 0 : 0; // size not tracked for URLs
    default:
      return 0;
  }
}

/**
 * Extract the MIME type from an AttachmentMetadata record.
 */
function extractBlobMime(meta: AttachmentMetadata): string | null {
  const att = meta.attachment;
  switch (att.kind) {
    case 'blob':
      return att.mime ?? null;
    case 'local-file':
      return att.mime ?? null;
    case 'url':
      return att.mime ?? null;
    case 'llms-txt':
      return 'text/plain';
    default:
      return null;
  }
}

/**
 * Infer the likely owner ID for an attachment.
 *
 * Attachments are typically bound to tasks. This performs a best-effort
 * extraction from the attachment metadata. For attachments without clear
 * ownership, returns `'__docs__'` (the sentinel used by DocsAccessorImpl).
 */
function inferOwnerIdFromMeta(meta: AttachmentMetadata): string {
  const name = extractBlobName(meta);
  if (name) {
    const taskMatch = name.match(/T(\d+)/i);
    if (taskMatch) return `T${taskMatch[1]}`;
  }
  return '__docs__';
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Detect the owner type from an ID prefix.
 *
 * - T###       → 'task'
 * - ses_*      → 'session'
 * - O-*        → 'observation'
 * - (default)  → 'task'
 */
function detectOwnerType(id: string): string {
  if (/^T\d+$/i.test(id)) return 'task';
  if (id.startsWith('ses_')) return 'session';
  if (id.startsWith('O-')) return 'observation';
  return 'task';
}

/**
 * Infer the document kind from a blob/attachment filename.
 *
 * Recognises common naming conventions:
 *   - `adr-*`    → 'adr'
 *   - `*.spec.*` → 'spec'
 *   - `research*` → 'research'
 *   - `handoff*` → 'handoff'
 *   - `note*`    → 'note'
 */
function inferDocKind(name: string): DocKind | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('adr-') || lower.includes('/adr/')) return 'adr';
  if (lower.includes('.spec.') || lower.startsWith('spec-')) return 'spec' as DocKind;
  if (lower.startsWith('research')) return 'research' as DocKind;
  if (lower.startsWith('handoff')) return 'handoff' as DocKind;
  if (lower.startsWith('note-') || lower === 'notes.md') return 'note' as DocKind;
  return null;
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a DocsReadModel for the given project root.
 *
 * CLI command handlers should call this factory instead of constructing
 * `DocsReadModel` directly (follows ADR-069 Coordination Layers boundary).
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @returns A fully initialized DocsReadModel.
 */
export function createDocsReadModel(projectRoot?: string): DocsReadModel {
  return new DocsReadModel({ projectRoot });
}
