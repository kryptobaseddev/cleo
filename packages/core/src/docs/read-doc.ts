/**
 * `docs.read` core-SDK implementation — render a single CLEO doc (body + full
 * provenance frontmatter) directly from `cleo.db`, the SOLE doc authority
 * (saga T11778).
 *
 * This is the live read API the Obsidian plugin (T11827) and `cleo docs view`
 * call. It is NOT a static export: every call reads the current DB state. The
 * body is surfaced as UTF-8 text when decodable, else base64 (T11825 AC2), so
 * binary blobs (images/PDFs) render without a second round-trip.
 *
 * Frontmatter is read straight from the `attachments` provenance columns
 * (`slug`, `doc_version`, `owner_version`, `supersedes`, `superseded_by`,
 * `topics`, `related_tasks`) — the same columns `docs_wikilinks` derives from —
 * so the response is self-describing for an external consumer.
 *
 * @task T11825 (Epic T11781 / Saga T11778)
 * @adr ADR-078 — Docs SSoT as provenance graph
 * @see DocReadResponse — packages/contracts/src/docs/read.ts
 * @see createDocsReadModel — body fetch + base64 plumbing reuse
 */

import { Buffer } from 'node:buffer';
import type { DocBody, DocFrontmatter, DocReadResponse } from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';

/**
 * Options for {@link readDoc}.
 *
 * @task T11825
 */
export interface ReadDocOptions {
  /** Project root for DB resolution. Defaults to {@link getProjectRoot}(). */
  readonly projectRoot?: string;
}

/**
 * Error raised when {@link readDoc}'s slug cannot be resolved to a doc.
 *
 * @task T11825
 */
export class DocNotFoundError extends Error {
  constructor(slug: string) {
    super(`Doc not found: no attachment carries slug '${slug}'`);
    this.name = 'DocNotFoundError';
  }
}

/** Narrow attachment-row shape read for the frontmatter. */
interface FrontmatterRow {
  id: string;
  sha256: string;
  slug: string | null;
  type: string | null;
  summary: string | null;
  lifecycleStatus: string;
  supersedes: string | null;
  supersededBy: string | null;
  topics: string | null;
  relatedTasks: string | null;
  ownerVersion: string | null;
  docVersion: number;
  createdAt: string;
}

/**
 * Read a single doc by slug, returning its body + full provenance frontmatter.
 *
 * Resolves the supersedes / superseded-by FK targets to their slugs (the
 * external-consumer-friendly addressing) and decodes the body to UTF-8 when
 * possible, falling back to base64 for binary content.
 *
 * @example
 * ```ts
 * const doc = await readDoc('adr-078-docs-provenance');
 * console.log(doc.frontmatter.docVersion, doc.frontmatter.topics);
 * if (doc.body.encoding === 'utf-8') console.log(doc.body.text);
 * ```
 *
 * @param slug - The exact doc slug (case-sensitive).
 * @param opts - Optional project-root override.
 * @returns The typed {@link DocReadResponse}.
 * @throws {DocNotFoundError} when no attachment carries the slug.
 * @task T11825
 */
export async function readDoc(slug: string, opts: ReadDocOptions = {}): Promise<DocReadResponse> {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  // T14288: slug (live or an alias) → the doc's identity → its head; the
  // metadata comes from the identity (the registry row for a legacy doc).
  const { resolveDocRef, supersessionSlugs } = await import('./slug-rename.js');
  const ref = await resolveDocRef(projectRoot, slug);
  if (!ref) throw new DocNotFoundError(slug);
  const frontmatterRow: FrontmatterRow = {
    id: ref.ownRow.id,
    sha256: ref.sha256,
    slug: ref.slug,
    type: ref.meta.docType,
    summary: ref.meta.summary,
    lifecycleStatus: ref.meta.lifecycleStatus ?? ref.ownRow.lifecycleStatus,
    supersedes: null,
    supersededBy: null,
    topics: ref.meta.topics,
    relatedTasks: ref.meta.relatedTasks,
    ownerVersion: ref.meta.ownerVersion,
    docVersion: ref.ownRow.docVersion,
    createdAt: ref.ownRow.createdAt,
  };
  const { supersedes: supersedesSlug, supersededBy: supersededBySlug } = await supersessionSlugs(
    projectRoot,
    ref,
  );

  // Fetch the RAW body bytes (not a decoded string) so binary blobs survive the
  // base64 path with full fidelity — `TextDecoder` would lossily replace
  // invalid sequences with U+FFFD.
  const { bytes, mimeType } = await fetchRawBody(frontmatterRow.sha256, projectRoot);

  const frontmatter: DocFrontmatter = {
    slug: frontmatterRow.slug ?? slug,
    kind: frontmatterRow.type,
    title: frontmatterRow.slug ?? slug,
    summary: frontmatterRow.summary,
    lifecycleStatus: frontmatterRow.lifecycleStatus,
    docVersion: frontmatterRow.docVersion,
    ownerVersion: frontmatterRow.ownerVersion,
    supersedes: supersedesSlug,
    supersededBy: supersededBySlug,
    topics: parseStringArray(frontmatterRow.topics),
    relatedTasks: parseStringArray(frontmatterRow.relatedTasks),
    sha256: frontmatterRow.sha256,
    createdAt: frontmatterRow.createdAt,
  };

  const body = encodeBody(bytes, mimeType);
  return { frontmatter, body };
}

/**
 * Read the raw body bytes for a doc by content hash via the content-addressed
 * attachment store. Returns an empty buffer when the metadata row exists but
 * the blob was purged from disk.
 *
 * @internal
 */
async function fetchRawBody(
  sha256: string,
  projectRoot: string,
): Promise<{ bytes: Buffer; mimeType: string | null }> {
  const store = createAttachmentStore();
  try {
    const result = await store.get(sha256, projectRoot);
    if (result) {
      const mime = (result.metadata.attachment as { mime?: unknown }).mime;
      return { bytes: result.bytes, mimeType: typeof mime === 'string' ? mime : null };
    }
  } catch {
    // Attachment store unavailable or blob purged — fall through to empty body.
  }
  return { bytes: Buffer.alloc(0), mimeType: null };
}

/**
 * Encode a doc body from its raw bytes. UTF-8-decodable content (the common
 * markdown case) is surfaced as `text`; binary content (images/PDFs/files) is
 * surfaced as `base64` so an external consumer can render it (T11825 AC2).
 *
 * UTF-8 validity is detected by a lossless decode→re-encode round-trip: invalid
 * sequences decode to U+FFFD and fail to re-encode to the original bytes.
 *
 * @internal
 */
function encodeBody(bytes: Buffer, mimeType: string | null): DocBody {
  const text = bytes.toString('utf-8');
  const isUtf8 = Buffer.from(text, 'utf-8').equals(bytes);
  if (isUtf8) {
    return { encoding: 'utf-8', text, sizeBytes: bytes.length, mimeType };
  }
  return {
    encoding: 'base64',
    base64: bytes.toString('base64'),
    sizeBytes: bytes.length,
    mimeType,
  };
}

/**
 * Parse a JSON-array-of-strings column, tolerating null / malformed values.
 *
 * @internal
 */
function parseStringArray(raw: string | null): readonly string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}
