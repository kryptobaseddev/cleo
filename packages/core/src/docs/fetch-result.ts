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
 * - **`path` resolves against the doc's actual backing store**:
 *   `manifest-db` → `.cleo/blobs/blobs/<sha256>`; anything else → the legacy
 *   content-addressed attachment path (with the MIME-correct extension).
 * - **mime/type come from the record**, never literals.
 *
 * @task T13352 (Epic T13340 / Saga T13339)
 * @see ResolvedDoc — packages/core/src/docs/docs-read-model.ts
 * @see readDoc — sibling read API with the same utf-8-vs-base64 body rule
 */

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import type { DocsFetchResult, DocsType } from '@cleocode/contracts/operations/docs.js';
import { resolveCleoDir } from '../paths.js';
import { blobFilePath } from '../store/blob-keep.js';
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
 * Resolve the on-disk storage path for a doc against its ACTUAL backing
 * store. `manifest-db` docs live in the blob store
 * (`.cleo/blobs/blobs/<sha256>`); everything else lives in the legacy
 * content-addressed attachment tree. Returns undefined for docs without a
 * content hash.
 *
 * @param doc - The resolved doc record.
 * @param cleoDir - The project's `.cleo` directory.
 * @returns Absolute storage path, or undefined.
 * @task T13352
 */
export function docsStoragePath(doc: ResolvedDoc, cleoDir: string): string | undefined {
  if (!doc.sha256) return undefined;
  if (doc.source === 'manifest-db') {
    return join(cleoDir, 'blobs', 'blobs', doc.sha256);
  }
  return blobFilePath(cleoDir, doc.sha256, doc.mimeType ?? 'text/markdown');
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
export function buildDocsFetchResult(opts: {
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
}): DocsFetchResult {
  const { doc, content, projectRoot, attachmentBackend } = opts;
  const cleoDir = resolveCleoDir(projectRoot);
  const contentBytes = Buffer.from(content, 'utf-8');
  const inline = contentBytes.length <= MAX_INLINE_BYTES;
  const text = isTextMime(doc.mimeType);

  const contentField = inline && text ? content : undefined;
  const bytesBase64 = inline && !text ? contentBytes.toString('base64') : undefined;

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
    },
    path: docsStoragePath(doc, cleoDir),
    sizeBytes: contentBytes.length,
    ...(contentField !== undefined ? { content: contentField } : {}),
    ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
    inlined: contentField !== undefined || bytesBase64 !== undefined,
    ...(attachmentBackend !== undefined
      ? { attachmentBackend: attachmentBackend as DocsFetchResult['attachmentBackend'] }
      : {}),
  };
}
