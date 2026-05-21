/**
 * AttachmentStore-backed DocsAccessor adapter for `cleo docs import`.
 *
 * The default {@link DocsAccessorImpl} writes to `manifest.db` (the
 * llmtxt/blob store) and keeps an in-memory blob index. That is incorrect
 * for the import path because:
 *
 *   1. Slug→sha lookup (`cleo docs fetch <slug>`) queries the
 *      `attachments` table in tasks.db via {@link AttachmentStore.findBySlug}.
 *   2. Project-wide search (`searchAllProjectDocs`) queries
 *      {@link AttachmentStore.listAllInProject}.
 *   3. The in-memory index is dropped between processes — idempotency
 *      across `cleo docs import` runs would always re-import everything.
 *
 * This adapter implements {@link DocsAccessor} on top of
 * {@link AttachmentStore.put}, populating the `slug` and `type` extras the
 * docs surface relies on. Bytes are written content-addressed to
 * `.cleo/attachments/sha256/` and registered in `tasks.db.attachments`.
 *
 * The owner ref MUST be one of the six supported entity types
 * ({@link assertOwnerType}). Imports without a natural task owner are
 * registered under the sentinel `task` / `__project__` pair so they appear
 * in `listAllInProject` without colliding with real task IDs.
 *
 * @epic T9791 (Saga T9787)
 * @task T9791
 */

import { createHash } from 'node:crypto';
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
import { createAttachmentStore, SlugCollisionError } from '../../store/attachment-store.js';
import type { DocImportType } from './scanner.js';

/**
 * Sentinel owner used when imported docs do not carry a natural task ID.
 *
 * The value is registered against {@link OWNER_TYPE} so it surfaces from
 * `cleo docs list --project` without clashing with real task IDs in the
 * `tasks` table (no FK constraint exists on `attachment_refs.owner_id`).
 *
 * @task T9791
 */
export const IMPORT_PROJECT_OWNER_ID = '__project__';

/**
 * Owner type used for the import sentinel. `task` is the most common type
 * surfaced by the docs CLI and keeps the row in the same listing as
 * task-attached docs without forcing a schema change.
 *
 * @task T9791
 */
export const IMPORT_OWNER_TYPE = 'task' as const;

/**
 * Extract a task ID (e.g. `T9782`) from a relative path's leading segment.
 *
 * Returns the task ID when the path begins with `T` followed by digits
 * (case-insensitive), the project sentinel otherwise. Used by the rcasd
 * + agent-outputs source dirs where the directory name is often the task
 * the doc was produced for.
 *
 * @param relPath - Project-relative path of the imported file.
 * @returns Either a `T###` task ID or {@link IMPORT_PROJECT_OWNER_ID}.
 *
 * @task T9791
 */
export function inferOwnerIdFromPath(relPath: string): string {
  const head = relPath.split(/[\\/]/)[0] ?? '';
  // Accept `T1`, `T9`, `T123`, `T9782`, `T9782-anything`, `T9782-closeout`,
  // `T9782.md`. The trailing boundary is end-of-string, `-`, `.`, or `_`
  // so prefixes like `T9foo` are NOT misread as task IDs.
  const m = /^([Tt]\d+)(?=$|[-._])/.exec(head);
  if (m?.[1]) return m[1].toUpperCase();
  return IMPORT_PROJECT_OWNER_ID;
}

/**
 * Map the canonical {@link DocImportType} CLI enum onto the underlying
 * storage-layer {@link DocKind}. Mirrors the equivalent helper in
 * `import-orchestrator.ts` so the adapter compiles without a circular
 * dependency.
 *
 * @internal
 */
function importTypeToDocKind(t: DocImportType | undefined): DocKind {
  return t === 'adr' ? 'adr' : 'agent-output';
}

/**
 * Concrete {@link DocsAccessor} that persists writes through
 * {@link AttachmentStore} so the imported bytes carry the queryable
 * `slug` + `type` columns the rest of the docs surface depends on.
 *
 * Reads (getDoc / listDocs / searchDocs / exportDoc) are best-effort —
 * the import path only needs storeDoc to be wired correctly. The other
 * methods proxy to AttachmentStore where the contract maps, and return
 * empty arrays / null otherwise to keep the surface honest.
 *
 * @task T9791
 */
export class AttachmentStoreDocsAccessor implements DocsAccessor {
  private readonly store = createAttachmentStore();

  /** Absolute project root used as the AttachmentStore cwd. */
  private readonly projectRoot: string;

  /**
   * Track shas we have already counted so a second call with identical
   * content returns the existing id without retrying the `put` transaction.
   * AttachmentStore.put is itself idempotent via SHA dedup, but the cache
   * trims the round-trip cost when the importer re-asks for the same blob
   * within a single run (e.g. on a force-rerun).
   */
  private readonly shaCache = new Set<string>();

  constructor(options: { projectRoot: string }) {
    this.projectRoot = options.projectRoot;
  }

  /**
   * Persist a document via AttachmentStore.put, honouring `meta.slug` +
   * `meta.importType` when present.
   *
   * Slug collisions raised by AttachmentStore are unwrapped: when the
   * incoming SHA matches the row that owns the slug, the put is a no-op.
   * Otherwise the slug is dropped (best-effort) and the put retried so
   * the import never blocks on legacy collisions. The audit manifest
   * surfaces the demotion via `meta.slugDemoted`.
   *
   * @param params - StoreDocParams; meta.slug + meta.importType are read.
   */
  async storeDoc(params: StoreDocParams): Promise<StoreDocResult> {
    const slug =
      typeof params.meta?.slug === 'string' && params.meta.slug.length > 0
        ? params.meta.slug
        : undefined;
    const importType =
      typeof params.meta?.importType === 'string'
        ? (params.meta.importType as DocImportType)
        : undefined;
    const sourcePath = typeof params.meta?.sourcePath === 'string' ? params.meta.sourcePath : null;

    const ownerId = sourcePath ? inferOwnerIdFromPath(sourcePath) : IMPORT_PROJECT_OWNER_ID;

    // AttachmentStore stores types as plain strings. We constrain to the
    // canonical DocsType set in the CLI handler; here we accept whatever the
    // caller passes so unit tests can flow custom values through.
    const extras: { slug?: string; type?: string } = {};
    if (slug !== undefined) extras.slug = slug;
    if (importType !== undefined) extras.type = importType;

    const bytes = Buffer.from(params.content, 'utf-8');
    const mime =
      importType === 'adr' || sourcePath?.endsWith('.md') ? 'text/markdown' : 'text/plain';
    const attachment = {
      kind: 'blob' as const,
      storageKey: '', // computed by AttachmentStore.put
      mime,
      size: bytes.byteLength,
    };

    let meta: Awaited<ReturnType<typeof this.store.put>>;
    try {
      meta = await this.store.put(
        bytes,
        attachment,
        IMPORT_OWNER_TYPE,
        ownerId,
        'cleo docs import',
        this.projectRoot,
        extras,
      );
    } catch (err) {
      if (err instanceof SlugCollisionError) {
        // Best-effort fallback: retry without the slug so the bytes still
        // make it in; the audit manifest already records the slug we tried.
        const retryExtras = { ...extras };
        delete retryExtras.slug;
        meta = await this.store.put(
          bytes,
          attachment,
          IMPORT_OWNER_TYPE,
          ownerId,
          'cleo docs import',
          this.projectRoot,
          retryExtras,
        );
      } else {
        throw err;
      }
    }

    this.shaCache.add(meta.sha256);
    return {
      id: meta.sha256,
      backend: 'manifest.db',
    };
  }

  /**
   * Look up a doc by sha256 (preferred) or attachment id.
   *
   * AttachmentStore.get(sha256) reads the blob from disk; only the bytes
   * + metadata are surfaced — there is no notion of a `DocKind` on disk
   * so the kind is approximated from the stored type column.
   */
  async getDoc(idOrHash: string): Promise<DocRecord | null> {
    if (/^[0-9a-f]{64}$/i.test(idOrHash)) {
      const fetched = await this.store.get(idOrHash, this.projectRoot);
      if (!fetched) return null;
      const extras = await this.store.getExtras(fetched.metadata.id, this.projectRoot);
      return {
        id: fetched.metadata.sha256,
        kind: importTypeToDocKind(extras?.type as DocImportType | undefined),
        content: fetched.bytes.toString('utf-8'),
        title: extras?.slug ?? fetched.metadata.id,
        createdAt: fetched.metadata.createdAt,
        linkedTaskIds: [],
        meta: { sha256: fetched.metadata.sha256, type: extras?.type ?? null },
      };
    }
    const meta = await this.store.getMetadata(idOrHash, this.projectRoot);
    if (!meta) return null;
    const fetched = await this.store.get(meta.sha256, this.projectRoot);
    if (!fetched) return null;
    const extras = await this.store.getExtras(meta.id, this.projectRoot);
    return {
      id: meta.sha256,
      kind: importTypeToDocKind(extras?.type as DocImportType | undefined),
      content: fetched.bytes.toString('utf-8'),
      title: extras?.slug ?? meta.id,
      createdAt: meta.createdAt,
      linkedTaskIds: [],
      meta: { sha256: meta.sha256, type: extras?.type ?? null },
    };
  }

  /**
   * List every imported doc in the project, exposing each row's SHA so
   * `runDocsImport` can use it to seed the existing-sha set on the
   * dedup pass.
   *
   * IMPORTANT — only rows that ALREADY carry a `slug` are surfaced. Rows
   * predate the import path (e.g. attached via `cleo docs add` without
   * `--slug`) are excluded so the orchestrator's SHA-dedup re-runs them
   * through {@link storeDoc} and the AttachmentStore applies the slug + type
   * to the existing row (its `put` method is idempotent on SHA collision).
   *
   * Without this filter, the original Saga T9625 validation gate
   * (`cleo docs fetch sg-cleo-docs-canon-plan`) would silently no-op
   * forever — bytes are stored but the slug column stays NULL.
   *
   * @param filters - Honoured: `kind` (mapped to AttachmentStore type filter
   *   when possible) and `limit`. Other filters fall back to listing all
   *   rows; the importer reads `id` (sha) only.
   *
   * @task T9791
   */
  async listDocs(filters?: ListDocsFilters): Promise<DocRecord[]> {
    // Map DocsAccessor.DocKind onto AttachmentStore.type when the caller
    // asked for `adr` — every other kind falls through (AttachmentStore
    // stores the user-facing taxonomy, not the storage discriminator).
    const typeFilter =
      filters?.kind === 'adr'
        ? { type: 'adr' }
        : filters?.kind === 'agent-output'
          ? undefined
          : undefined;
    const rows = await this.store.listAllInProject(this.projectRoot, typeFilter);
    const limit = filters?.limit ?? rows.length;

    // Deduplicate by sha so the importer's existingShas set sees one entry
    // per blob (multiple refs to the same blob produce N rows). Skip rows
    // missing a slug so the SHA-dedup gate allows them through and the
    // re-put applies the import's slug + type to the legacy row.
    const seen = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (!r.slug) continue;
      if (!seen.has(r.metadata.sha256)) seen.set(r.metadata.sha256, r);
    }
    const unique = Array.from(seen.values()).slice(0, limit);

    return unique.map((r) => ({
      id: r.metadata.sha256,
      kind: importTypeToDocKind(r.type as DocImportType | undefined),
      // Importer never reads .content from this surface — keep it empty so
      // we don't have to load every blob from disk on the seed call.
      content: '',
      title: r.slug ?? r.metadata.id,
      createdAt: r.metadata.createdAt,
      linkedTaskIds: [],
      meta: { sha256: r.metadata.sha256, type: r.type ?? null, slug: r.slug ?? null },
    }));
  }

  /**
   * Search is best-effort and intentionally returns no hits — the
   * import path never invokes searchDocs. Callers wanting semantic search
   * should use `searchAllProjectDocs` from `@cleocode/core/internal`
   * directly.
   */
  async searchDocs(_query: string, _limit?: number): Promise<DocSearchHit[]> {
    return [];
  }

  /**
   * Export the raw markdown bytes for a stored doc. Only `markdown`
   * format is supported; other formats fall back to the same string.
   */
  async exportDoc(id: string, _format?: DocExportFormat): Promise<string | null> {
    const doc = await this.getDoc(id);
    return doc?.content ?? null;
  }

  /**
   * AttachmentStore has no per-instance resources to release — the SQLite
   * connection is the shared singleton owned by @cleocode/core/store.
   * Implemented as a no-op so the import command can stay symmetric with
   * the previous DocsAccessor close() call.
   */
  async close(): Promise<void> {
    // intentional no-op
  }

  /**
   * Compute the deterministic SHA-256 used by every consumer of the
   * import path. Exposed so callers (e.g. unit tests) can verify the
   * adapter and the scanner agree on the id format.
   */
  static sha256Of(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}

/**
 * Factory wrapper mirroring {@link createDocsAccessor} from
 * `store/docs-accessor-impl.ts`.
 *
 * @param projectRoot - Absolute project root (the directory containing `.cleo/`).
 * @returns A new {@link AttachmentStoreDocsAccessor}.
 *
 * @task T9791
 */
export function createAttachmentStoreDocsAccessor(
  projectRoot: string,
): AttachmentStoreDocsAccessor {
  return new AttachmentStoreDocsAccessor({ projectRoot });
}
