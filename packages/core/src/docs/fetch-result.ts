/**
 * Shared `docs.fetch` / `docs view --json` result builder — T13352.
 *
 * Previously both call sites hand-built the envelope: they re-encoded the
 * already-decoded UTF-8 body to base64, hard-coded `refCount: 0`, and
 * reported a storage path inside the legacy `.cleo/attachments` tree even
 * for docs whose bytes live in the blob manifest store (where the reported
 * path does not exist).
 *
 * This builder is the single source of truth for the fetch envelope:
 *
 * - **Text docs carry `content`** (decoded UTF-8) directly in the envelope —
 *   no base64 round-trip for the overwhelmingly common markdown case.
 *   Binary docs keep `bytesBase64` (≤ 1 MB inline cap).
 * - **`refCount` is the real value** from the read model
 *   (`attachments.ref_count`; 0 for manifest-only blobs).
 * - **`path` always resolves against the blob store**
 *   (`.cleo/blobs/blobs/<sha256>`) — the canonical byte location since the
 *   legacy `.cleo/attachments/sha256/` tree was retired as a read surface
 *   (T13362). `fetchContent` reads the same location, so the reported path
 *   always matches where the envelope's bytes came from.
 * - **mime/type come from the record**, never literals.
 * - **Recorded CRDT head conflicts surface** as `headConflict` (T13604): the
 *   fetched content is the winning projection; losing edits survive in the
 *   append-only version history. Absent on a clean head — the no-conflict
 *   envelope is unchanged.
 *
 * @task T13352 (envelope shape) · T13604 (head-conflict surfacing)
 * @see ResolvedDoc — packages/core/src/docs/docs-read-model.ts
 * @see readDoc — sibling read API with the same utf-8-vs-base64 body rule
 */

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type {
  DocsFetchResult,
  DocsHeadConflictEntry,
  DocsType,
} from '@cleocode/contracts/operations/docs.js';
import { resolveCleoDir } from '../paths.js';
import type { ResolvedDoc } from './docs-read-model.js';

/** Largest body inlined into the envelope (matches the historical cap). */
const MAX_INLINE_BYTES = 1024 * 1024;

/**
 * `application/*` MIME types that are UTF-8 text on the wire. Anything
 * `text/*` is text by definition; binary `application/*` types (pdf,
 * octet-stream, zip, wasm, …) are not listed here.
 */
const TEXT_APPLICATION_MIMES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
  'application/javascript',
  'application/typescript',
  'application/toml',
  'application/x-sh',
  'application/ld+json',
]);

/**
 * Whether a MIME type denotes UTF-8 text. An absent MIME defaults to text:
 * docs blobs are overwhelmingly markdown, and the read model has already
 * decoded the body to a string by the time this predicate runs.
 *
 * @param mime - IANA MIME type, or null when unknown.
 * @returns True when the body should be surfaced as decoded `content`.
 * @task T13352
 */
export function isTextMime(mime: string | null): boolean {
  if (!mime) return true;
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/octet-stream') return false;
  return base.startsWith('text/') || TEXT_APPLICATION_MIMES.has(base);
}

/**
 * Resolve the on-disk storage path for a doc.
 *
 * The blob store (`.cleo/blobs/blobs/<sha256>`) is the canonical byte
 * location for every doc — `DocsReadModel.fetchContent` reads bytes by
 * content address since the legacy `.cleo/attachments/sha256/` tree was
 * retired as a read surface (T13362), so the envelope reports that same
 * location regardless of which registry the doc's metadata resolved from.
 * Returns undefined for docs without a content hash.
 *
 * @param doc - The resolved doc record.
 * @param cleoDir - The project's `.cleo` directory.
 * @returns Absolute storage path, or undefined.
 * @task T13352
 */
export function docsStoragePath(doc: ResolvedDoc, cleoDir: string): string | undefined {
  if (!doc.sha256) return undefined;
  return join(cleoDir, 'blobs', 'blobs', doc.sha256);
}

/**
 * Build the canonical `docs.fetch` result from a resolved doc and its
 * decoded body. Used by both the dispatch `docs.fetch` handler and the
 * `docs view --json` renderer, so the envelope shape can never drift
 * between the two again.
 *
 * @param opts.doc - The resolved doc record (metadata source of truth).
 * @param opts.content - The decoded UTF-8 body from `fetchContent`.
 * @param opts.projectRoot - Project root (resolves `.cleo` for the path).
 * @param opts.attachmentBackend - Current backend, echoed into the envelope.
 * @returns The typed {@link DocsFetchResult}.
 * @task T13352
 */
export async function buildDocsFetchResult(opts: {
  doc: ResolvedDoc;
  content: string;
  projectRoot: string;
  /**
   * Current backend label, echoed into the envelope. Typed as `string`
   * because core-internal `AttachmentBackend` (`'llmtxt'`) and the contracts
   * `AttachmentBackend` (`'legacy' | 'llmstxt-v2'`) are two divergent types
   * (pre-existing debt) — the historical fetch handler passed the internal
   * value through with a cast, and this builder preserves that behaviour.
   */
  attachmentBackend?: string;
  /**
   * `D####` decisions linked to this doc (T13359) — looked up by the caller
   * (the dispatch handler owns the store access) and echoed here so the
   * `docs.fetch` envelope and `docs view --json` can never drift on the
   * field. Omitted when the doc has no live links.
   */
  linkedDecisions?: string[];
}): Promise<DocsFetchResult> {
  const { doc, content, projectRoot, attachmentBackend, linkedDecisions } = opts;
  const cleoDir = resolveCleoDir(projectRoot);
  const contentBytes = Buffer.from(content, 'utf-8');
  const inline = contentBytes.length <= MAX_INLINE_BYTES;
  const text = isTextMime(doc.mimeType);

  const contentField = inline && text ? content : undefined;
  const bytesBase64 = inline && !text ? contentBytes.toString('base64') : undefined;
  const headConflict = await readDocHeadConflict(projectRoot, doc.slug);
  // T13674: expose the conduit head version the fetched body was projected
  // from, so a writer can pass it back as docs.update baseVersionUid and a
  // stale base is merged/conflicted instead of silently overwriting a
  // concurrent edit. Absent for docs outside the conduit family.
  const headVersionUid = await readDocHeadVersionUid(projectRoot, doc.slug);

  return {
    metadata: {
      id: doc.id,
      sha256: doc.sha256,
      kind: 'blob',
      mime: doc.mimeType ?? 'text/plain',
      size: doc.sizeBytes,
      description: doc.summary ?? undefined,
      createdAt: doc.createdAt,
      refCount: doc.refCount,
      ...(doc.slug ? { slug: doc.slug } : {}),
      ...(doc.kind ? { type: doc.kind as DocsType } : {}),
      ...(doc.displayNumber !== null ? { displayNumber: doc.displayNumber } : {}),
      ...(doc.title ? { title: doc.title } : {}),
      ...(doc.blobName ? { blobName: doc.blobName } : {}),
      ...(headVersionUid !== undefined ? { headVersionUid } : {}),
    },
    path: docsStoragePath(doc, cleoDir),
    sizeBytes: contentBytes.length,
    ...(contentField !== undefined ? { content: contentField } : {}),
    ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
    inlined: contentField !== undefined || bytesBase64 !== undefined,
    ...(attachmentBackend !== undefined
      ? { attachmentBackend: attachmentBackend as DocsFetchResult['attachmentBackend'] }
      : {}),
    ...(headConflict !== undefined ? { headConflict } : {}),
    ...(linkedDecisions !== undefined && linkedDecisions.length > 0 ? { linkedDecisions } : {}),
  };
}

/**
 * Resolve the conduit head version uid for a slug (T13674) — the version the
 * fetched body was projected from. Returns undefined for slug-less docs,
 * docs outside the conduit family, and any store read failure (the base
 * parameter stays opt-in; a degraded store must not break fetch).
 *
 * @param projectRoot - Project root.
 * @param slug - The doc's slug (`ResolvedDoc.slug`), or null.
 * @returns The head version uid, or undefined when not applicable.
 */
async function readDocHeadVersionUid(
  projectRoot: string,
  slug: string | null,
): Promise<string | undefined> {
  if (slug === null) return undefined;
  try {
    const { dbExists } = await import('../store/sqlite.js');
    if (!dbExists(projectRoot)) return undefined;
    const { resolveConduitDocUid, getConduitDocHead } = await import(
      '../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(projectRoot, slug);
    if (docUid === null) return undefined;
    const head = await getConduitDocHead(projectRoot, docUid);
    return head?.headVersionUid ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Surface a doc's recorded CRDT head conflicts on the fetch envelope
 * (T13604): when the conduit's current-version projection carries recorded
 * conflicts, the fetched content is the winning projection and the losing
 * edits survive in the append-only version history. Absent for slug-less
 * docs, docs outside the conduit family, and docs with a clean head — the
 * no-conflict envelope is byte-identical to before.
 *
 * @param projectRoot - Project root.
 * @param slug - The doc's slug (`ResolvedDoc.slug`), or null.
 * @returns The head-conflict summary, or undefined when nothing to surface.
 */
async function readDocHeadConflict(
  projectRoot: string,
  slug: string | null,
): Promise<DocsFetchResult['headConflict']> {
  if (slug === null) return undefined;
  try {
    const { dbExists } = await import('../store/sqlite.js');
    if (!dbExists(projectRoot)) return undefined;
    const { resolveConduitDocUid, getConduitDocHead } = await import(
      '../store/conduit-doc-history.js'
    );
    const docUid = await resolveConduitDocUid(projectRoot, slug);
    if (docUid === null) return undefined;
    const head = await getConduitDocHead(projectRoot, docUid);
    if (!head || head.conflictCount === 0) return undefined;
    let lastConflict: DocsHeadConflictEntry | undefined;
    if (head.lastConflictJson) {
      try {
        lastConflict = JSON.parse(head.lastConflictJson) as DocsHeadConflictEntry;
      } catch {
        lastConflict = undefined;
      }
    }
    return {
      conflictCount: head.conflictCount,
      ...(lastConflict !== undefined ? { lastConflict } : {}),
    };
  } catch {
    return undefined;
  }
}
