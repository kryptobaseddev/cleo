/**
 * Docs ops — thin typed wrappers over llmtxt primitives.
 *
 * Each function dynamically imports from the relevant llmtxt subpath so that
 * `llmtxt` can remain an optional peer dependency (following the T1041 pattern).
 * When a primitive is unavailable the function throws a typed
 * `LLMTXT_PRIMITIVE_UNAVAILABLE` error rather than a bare module-not-found.
 *
 * Supported llmtxt subpaths used here:
 *   - `llmtxt/similarity`  — `rankBySimilarity`
 *   - `llmtxt/sdk`         — `squashPatches`, `diffVersions`, `reconstructVersion`
 *   - `llmtxt/graph`       — `buildGraph`
 *
 * @epic T1041 (llmtxt v2026.4.12 adoption)
 * @see packages/cleo/src/cli/commands/docs.ts (CLI surface)
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import type { LocalFileAttachment } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { computeProjectHash, resolveWorktreeRootForHash } from '@cleocode/paths';
import type { KnowledgeGraph, MessageInput } from 'llmtxt/graph';
import type { ReconstructionResult, VersionDiffSummary, VersionEntry } from 'llmtxt/sdk';
import type { SimilarityRankResult } from 'llmtxt/similarity';
import { CleoError } from '../errors.js';
import { discoveryEnv } from '../git/work-tree.js';
import { getProjectRoot } from '../paths.js';
import { createAttachmentStore } from '../store/attachment-store.js';
import { blobList, blobRead, blobReadBySha } from '../store/blob-ops.js';
import { canonicalizePath } from '../tools/fs.js';
import { readDocsPublications, upsertDocsPublication } from './publications-store.js';

// ─── Error helpers ────────────────────────────────────────────────────────────

/** Minimum llmtxt version that ships the required primitives. */
const REQUIRED_LLMTXT_VERSION = '2026.4.12';

/**
 * Throw a structured error when an llmtxt primitive cannot be imported.
 *
 * @param primitive - The import specifier that failed (e.g. `"llmtxt/similarity"`).
 * @param cause     - The original module-not-found error.
 * @throws Always throws `LLMTXT_PRIMITIVE_UNAVAILABLE` with a human-readable message.
 *
 * @internal
 */
function throwUnavailable(primitive: string, cause: unknown): never {
  const msg =
    `LLMTXT_PRIMITIVE_UNAVAILABLE: cannot import "${primitive}". ` +
    `Requires llmtxt >= ${REQUIRED_LLMTXT_VERSION}. ` +
    `Install with: pnpm add llmtxt@${REQUIRED_LLMTXT_VERSION}`;
  const err = new Error(msg);
  err.cause = cause;
  (err as Error & { code: string }).code = 'LLMTXT_PRIMITIVE_UNAVAILABLE';
  throw err;
}

// ─── Public result types ──────────────────────────────────────────────────────

/**
 * A single ranked search result from {@link searchDocs}.
 */
export interface DocsSearchHit {
  /** Attachment or candidate text identifier. */
  readonly id: string;
  /** Human-readable name (attachment filename or description). */
  readonly name: string;
  /** Normalised similarity score in [0, 1]. */
  readonly score: number;
  /** Owner entity ID that holds this attachment. */
  readonly ownerId?: string;
}

/**
 * Result returned by {@link searchDocs}.
 */
export interface DocsSearchResult {
  /** The original query string. */
  readonly query: string;
  /** Ranked hits, highest score first. */
  readonly hits: DocsSearchHit[];
}

/**
 * Result returned by {@link mergeDocs}.
 */
export interface DocsMergeResult {
  /** The merged patch text content. */
  readonly merged: string;
  /** Strategy that was applied. */
  readonly strategy: 'three-way' | 'cherry-pick' | 'multi-diff';
  /** Whether conflicts were detected during merge. */
  readonly hasConflicts: boolean;
}

/**
 * A node in the document relationship graph.
 */
export interface DocsGraphNode {
  /** Node identifier. */
  readonly id: string;
  /** Display label. */
  readonly label: string;
  /** Node type from the graph primitive. */
  readonly kind: string;
  /** Weight from the graph primitive. */
  readonly weight: number;
}

/**
 * An edge in the document relationship graph.
 */
export interface DocsGraphEdge {
  /** Source node ID. */
  readonly source: string;
  /** Target node ID. */
  readonly target: string;
  /** Edge type from the graph primitive. */
  readonly relation: string;
  /** Edge weight from the graph primitive. */
  readonly weight: number;
}

/**
 * Result returned by {@link buildDocsGraph}.
 */
export interface DocsGraphResult {
  /** Graph nodes. */
  readonly nodes: DocsGraphNode[];
  /** Graph edges. */
  readonly edges: DocsGraphEdge[];
  /** Raw KnowledgeGraph primitive output for serialisation. */
  readonly raw: KnowledgeGraph;
}

/**
 * A single ranked attachment from {@link rankDocs}.
 */
export interface DocsRankHit {
  /** Attachment SHA-256 content address. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /** Normalised relevance score. */
  readonly score: number;
}

/**
 * Result returned by {@link rankDocs}.
 */
export interface DocsRankResult {
  /** Owner entity that was ranked. */
  readonly ownerId: string;
  /** Ranked attachments, best first. */
  readonly hits: DocsRankHit[];
}

/**
 * A single version entry from {@link listDocVersions}.
 */
export interface DocsVersionEntry {
  /** Attachment ID (sha256 content address). */
  readonly attachmentId: string;
  /** File name as stored. */
  readonly name: string;
  /** Lowercase hex SHA-256 digest. */
  readonly sha256: string;
  /** Byte size. */
  readonly sizeBytes: number;
  /** IANA MIME type, when known. */
  readonly mimeType?: string;
  /** CLEO release version that wrote this version (T11181). */
  readonly ownerVersion?: string;
  /** Sequential doc version counter (T11181). */
  readonly docVersion?: number;
}

/**
 * Result returned by {@link listDocVersions}.
 */
export interface DocsVersionsResult {
  /** Owner entity queried. */
  readonly ownerId: string;
  /** Optional filename filter that was applied. */
  readonly nameFilter?: string;
  /** Version entries. */
  readonly versions: DocsVersionEntry[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search attachments by semantic similarity using `llmtxt/similarity.rankBySimilarity`.
 *
 * Loads all blob attachments for `ownerId` and ranks them against `query`.
 * Returns up to `limit` hits (default 10) in descending score order.
 *
 * @param query - Free-text search query.
 * @param opts  - Optional owner scope and pagination.
 * @returns Ranked search hits from highest to lowest similarity score.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/similarity` is not installed.
 *
 * @example
 * ```ts
 * const result = await searchDocs('authentication flow', { ownerId: 'T123', limit: 5 });
 * ```
 */
export async function searchDocs(
  query: string,
  opts?: { ownerId?: string; limit?: number; projectRoot?: string },
): Promise<DocsSearchResult> {
  let rankBySimilarity: (
    q: string,
    candidates: string[],
    options?: { method?: 'ngram' | 'shingle'; threshold?: number },
  ) => SimilarityRankResult[];

  try {
    const mod = await import('llmtxt/similarity');
    rankBySimilarity = mod.rankBySimilarity;
  } catch (cause) {
    throwUnavailable('llmtxt/similarity', cause);
  }

  const root = opts?.projectRoot ?? getProjectRoot();
  const limit = opts?.limit ?? 10;

  const blobs = opts?.ownerId ? await blobList(opts.ownerId, root).catch(() => []) : [];

  if (blobs.length === 0) {
    return { query, hits: [] };
  }

  const candidates = blobs.map((b) => b.name);
  const ranked = rankBySimilarity(query, candidates);

  const hits: DocsSearchHit[] = ranked.slice(0, limit).map((r) => {
    const blob = blobs[r.index];
    return {
      id: blob.sha256,
      name: blob.name,
      score: r.score,
      ownerId: opts?.ownerId,
    };
  });

  return { query, hits };
}

// ─── Project-wide doc search (T9647) ──────────────────────────────────────────

/**
 * A single ranked hit returned by {@link searchAllProjectDocs}.
 *
 * @task T9647
 */
export interface DocsProjectSearchHit {
  /** Attachment SHA-256 content address. */
  readonly id: string;
  /** Slug under which the doc is published, when present. */
  readonly slug: string | null;
  /** Taxonomy type (spec|adr|research|handoff|note|llm-readme), when present. */
  readonly type: string | null;
  /** Owner entity type that originally bound the attachment (e.g. `"task"`). */
  readonly ownerType: string;
  /** Owner entity ID that originally bound the attachment. */
  readonly ownerId: string;
  /** Filename / display name. */
  readonly name: string;
  /** Normalised similarity score in [0, 1]. */
  readonly score: number;
  /** Best-effort plaintext snippet centred on the first query-term match. */
  readonly snippet: string;
}

/**
 * Result returned by {@link searchAllProjectDocs}.
 *
 * @task T9647
 */
export interface DocsProjectSearchResult {
  /** The original query string. */
  readonly query: string;
  /** Total number of docs considered before ranking. */
  readonly totalDocs: number;
  /** Ranked hits, highest score first. */
  readonly hits: DocsProjectSearchHit[];
}

/** Maximum bytes to read per attachment when building the search corpus. */
const SEARCH_MAX_BYTES_PER_DOC = 64 * 1024;

/** Maximum characters in a snippet returned with a search hit. */
const SEARCH_SNIPPET_CHARS = 200;

/**
 * Internal: decide whether an attachment's content should be treated as text.
 * The viewer search only meaningfully ranks text-shaped attachments.
 *
 * @internal
 */
function isTextMime(mime: string | undefined | null): boolean {
  if (!mime) return false;
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/yaml' ||
    mime === 'application/x-yaml'
  );
}

/**
 * Internal: extract a snippet from `content` centred on the first occurrence
 * of any whitespace-separated query term. Falls back to the leading window of
 * the document when no term matches.
 *
 * @internal
 */
function buildSnippet(content: string, query: string, maxChars = SEARCH_SNIPPET_CHARS): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxChars) return flat;

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const lower = flat.toLowerCase();

  let firstHit = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (firstHit < 0 || idx < firstHit)) firstHit = idx;
  }

  if (firstHit < 0) return `${flat.slice(0, maxChars)}…`;

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, firstHit - half);
  const end = Math.min(flat.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < flat.length ? '…' : '';
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

/**
 * Rank every published doc in the project against `query` using
 * `llmtxt/similarity.rankBySimilarity` over their text content.
 *
 * Unlike {@link searchDocs}, which is scoped to a single owner and ranks by
 * blob name only, this function builds the full set of project docs (via
 * {@link AttachmentStore.listAllInProject}), reads the bytes for each text
 * attachment, ranks against the actual content, and returns hits with slug,
 * type, snippet and score.
 *
 * Non-text attachments (binary blobs, images) are skipped so their bytes do
 * not pollute the n-gram fingerprint.
 *
 * @param query - Free-text search query.
 * @param opts  - Optional `type` filter, `limit`, and `projectRoot` override.
 * @returns Ranked hits with snippet, highest score first.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/similarity` is not installed.
 *
 * @task T9647 — viewer + CLI project-wide search
 * @epic T9631
 *
 * @example
 * ```ts
 * const result = await searchAllProjectDocs('release pipeline', { limit: 5 });
 * // result.hits[0]: { slug, type, score, snippet, ... }
 * ```
 */
export async function searchAllProjectDocs(
  query: string,
  opts?: { type?: string; limit?: number; projectRoot?: string },
): Promise<DocsProjectSearchResult> {
  let rankBySimilarity: (
    q: string,
    candidates: string[],
    options?: { method?: 'ngram' | 'shingle'; threshold?: number },
  ) => SimilarityRankResult[];

  try {
    const mod = await import('llmtxt/similarity');
    rankBySimilarity = mod.rankBySimilarity;
  } catch (cause) {
    throwUnavailable('llmtxt/similarity', cause);
  }

  const root = opts?.projectRoot ?? getProjectRoot();
  const limit = opts?.limit ?? 10;
  const store = createAttachmentStore();

  const rows = await store.listAllInProject(root, opts?.type ? { type: opts.type } : undefined);

  // Dedupe by attachment id so a doc referenced by N owners is ranked once.
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!seen.has(r.metadata.id)) seen.set(r.metadata.id, r);
  }
  const deduped = Array.from(seen.values());

  if (deduped.length === 0 || query.trim().length === 0) {
    return { query, totalDocs: deduped.length, hits: [] };
  }

  // Build the corpus: read text bytes for each attachment, cap at
  // SEARCH_MAX_BYTES_PER_DOC to keep ranking deterministic on huge docs.
  type Candidate = {
    row: (typeof deduped)[number];
    content: string;
  };
  const candidates: Candidate[] = [];
  for (const row of deduped) {
    const mime =
      row.metadata.attachment.kind === 'blob'
        ? row.metadata.attachment.mime
        : row.metadata.attachment.kind === 'local-file'
          ? ((row.metadata.attachment as LocalFileAttachment).mime ?? 'text/plain')
          : null;
    if (!isTextMime(mime)) continue;
    try {
      const fetched = await store.get(row.metadata.sha256, root);
      if (!fetched) continue;
      const text = fetched.bytes.toString('utf8').slice(0, SEARCH_MAX_BYTES_PER_DOC);
      candidates.push({ row, content: text });
    } catch {
      // Skip unreadable blobs — they should not crash the whole search.
    }
  }

  if (candidates.length === 0) {
    return { query, totalDocs: deduped.length, hits: [] };
  }

  const ranked = rankBySimilarity(
    query,
    candidates.map((c) => c.content),
  );

  const hits: DocsProjectSearchHit[] = ranked.slice(0, limit).map((r) => {
    const c = candidates[r.index];
    return {
      id: c.row.metadata.id,
      slug: c.row.slug,
      type: c.row.type,
      ownerType: c.row.ownerType,
      ownerId: c.row.ownerId,
      name: c.row.slug ?? c.row.metadata.id,
      score: r.score,
      snippet: buildSnippet(c.content, query),
    };
  });

  return { query, totalDocs: deduped.length, hits };
}

// ─── Similarity ranking by seed slug (T10163) ────────────────────────────────

/**
 * A single ranked hit returned by {@link findSimilarDocs}.
 *
 * Shape pins the envelope contract documented in T10163 AC:
 * `{ slug, kind, score, summary, lifecycle_status }`. `kind` is the
 * taxonomy classification (DocKind name, e.g. `'adr'`, `'spec'`); the
 * underlying column on `attachments` is named `type` but the surfaced
 * field follows the canonical doc-kind terminology.
 *
 * @task T10163 (Epic T10157 / Saga T9855)
 */
export interface DocsFindSimilarHit {
  /** Attachment SHA-256 content address. */
  readonly id: string;
  /** Slug under which the doc is published. */
  readonly slug: string;
  /** Taxonomy classification (DocKind name) — null when the doc has none. */
  readonly kind: string | null;
  /** Normalised cosine similarity score in `[0, 1]`. */
  readonly score: number;
  /** Short human-readable summary from `attachments.summary`. */
  readonly summary: string | null;
  /** Lifecycle state from `attachments.lifecycle_status`. */
  readonly lifecycle_status: string;
}

/**
 * Result returned by {@link findSimilarDocs}.
 *
 * @task T10163 (Epic T10157 / Saga T9855)
 */
export interface DocsFindSimilarResult {
  /** The seed slug used as the similarity anchor. */
  readonly seedSlug: string;
  /** DocKind of the seed doc — null when the seed has none. */
  readonly seedKind: string | null;
  /** Total number of docs considered before threshold + limit filtering. */
  readonly totalCandidates: number;
  /** Ranked hits, highest score first, post-threshold + limit. */
  readonly hits: DocsFindSimilarHit[];
}

/**
 * Default minimum similarity score for {@link findSimilarDocs} results.
 * Matches the AC for T10163 and biases toward higher-signal matches.
 */
export const DEFAULT_FIND_SIMILAR_THRESHOLD = 0.5;

/**
 * Default maximum number of hits returned by {@link findSimilarDocs}.
 */
export const DEFAULT_FIND_SIMILAR_LIMIT = 10;

/**
 * Find docs similar to a given seed slug via
 * `llmtxt/similarity.rankBySimilarity` over their text content.
 *
 * Unlike {@link searchAllProjectDocs}, which takes a free-text query, this
 * function uses the **content of an existing published doc** as the
 * similarity anchor. Useful for agents asking "what's already been written
 * about X?" before drafting a new doc.
 *
 * Behaviour:
 *   - The seed doc itself is always excluded from the results.
 *   - By default, candidates are filtered to the same `kind` (DocKind /
 *     `attachments.type`) as the seed. Pass `allKinds: true` to disable
 *     this filter and rank cross-kind.
 *   - Hits below `threshold` (default {@link DEFAULT_FIND_SIMILAR_THRESHOLD})
 *     are dropped before slicing to `limit`
 *     (default {@link DEFAULT_FIND_SIMILAR_LIMIT}).
 *   - Non-text attachments (binary blobs, images) are skipped so their
 *     bytes do not pollute the n-gram fingerprint.
 *
 * @param slug - Slug of the seed doc to anchor similarity against.
 * @param opts - Optional filter + pagination overrides.
 * @returns Ranked hits with `{ slug, kind, score, summary, lifecycle_status }`.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/similarity` is not installed.
 * @throws `Error` with `code = 'E_DOCS_SLUG_NOT_FOUND'` when the seed slug
 *         does not resolve to a published doc.
 *
 * @task T10163 (Epic T10157 · Saga T9855 · E12.C6)
 *
 * @example
 * ```ts
 * const result = await findSimilarDocs('adr-073-above-epic-naming', { limit: 5 });
 * for (const hit of result.hits) {
 *   console.log(`${hit.score.toFixed(2)}  ${hit.slug}  (${hit.kind})`);
 * }
 * ```
 */
export async function findSimilarDocs(
  slug: string,
  opts?: {
    limit?: number;
    threshold?: number;
    allKinds?: boolean;
    projectRoot?: string;
  },
): Promise<DocsFindSimilarResult> {
  let rankBySimilarity: (
    q: string,
    candidates: string[],
    options?: { method?: 'ngram' | 'shingle'; threshold?: number },
  ) => SimilarityRankResult[];

  try {
    const mod = await import('llmtxt/similarity');
    rankBySimilarity = mod.rankBySimilarity;
  } catch (cause) {
    throwUnavailable('llmtxt/similarity', cause);
  }

  const root = opts?.projectRoot ?? getProjectRoot();
  const limit = opts?.limit ?? DEFAULT_FIND_SIMILAR_LIMIT;
  const threshold = opts?.threshold ?? DEFAULT_FIND_SIMILAR_THRESHOLD;
  const allKinds = opts?.allKinds ?? false;
  const store = createAttachmentStore();

  const seed = await store.findBySlug(slug, root);
  if (!seed) {
    const err = new Error(`E_DOCS_SLUG_NOT_FOUND: no doc with slug "${slug}"`);
    (err as Error & { code: string }).code = 'E_DOCS_SLUG_NOT_FOUND';
    throw err;
  }

  const seedFetched = await store.get(seed.metadata.sha256, root);
  if (!seedFetched) {
    const err = new Error(
      `E_DOCS_SEED_UNREADABLE: blob for slug "${slug}" (sha256=${seed.metadata.sha256}) ` +
        `is missing from the attachment store`,
    );
    (err as Error & { code: string }).code = 'E_DOCS_SEED_UNREADABLE';
    throw err;
  }
  const seedContent = seedFetched.bytes.toString('utf8').slice(0, SEARCH_MAX_BYTES_PER_DOC);

  const typeFilter = !allKinds && seed.type ? { type: seed.type } : undefined;
  const rows = await store.listAllInProject(root, typeFilter);

  // Dedupe by attachment id (one blob can be referenced by N owners) and
  // drop the seed itself so it cannot rank against itself.
  const seen = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.slug === slug) continue;
    if (r.metadata.id === seed.metadata.id) continue;
    if (!seen.has(r.metadata.id)) seen.set(r.metadata.id, r);
  }
  const deduped = Array.from(seen.values());

  if (deduped.length === 0) {
    return {
      seedSlug: slug,
      seedKind: seed.type,
      totalCandidates: 0,
      hits: [],
    };
  }

  type Candidate = {
    row: (typeof deduped)[number];
    content: string;
  };
  const candidates: Candidate[] = [];
  for (const row of deduped) {
    if (row.slug === null) continue;
    const mime =
      row.metadata.attachment.kind === 'blob'
        ? row.metadata.attachment.mime
        : row.metadata.attachment.kind === 'local-file'
          ? ((row.metadata.attachment as LocalFileAttachment).mime ?? 'text/plain')
          : null;
    if (!isTextMime(mime)) continue;
    try {
      const fetched = await store.get(row.metadata.sha256, root);
      if (!fetched) continue;
      const text = fetched.bytes.toString('utf8').slice(0, SEARCH_MAX_BYTES_PER_DOC);
      candidates.push({ row, content: text });
    } catch {
      // Skip unreadable blobs — they must not crash the whole search.
    }
  }

  if (candidates.length === 0) {
    return {
      seedSlug: slug,
      seedKind: seed.type,
      totalCandidates: deduped.length,
      hits: [],
    };
  }

  const ranked = rankBySimilarity(
    seedContent,
    candidates.map((c) => c.content),
  );

  const hits: DocsFindSimilarHit[] = [];
  for (const r of ranked) {
    if (hits.length >= limit) break;
    if (r.score < threshold) continue;
    const c = candidates[r.index];
    if (!c || c.row.slug === null) continue;
    hits.push({
      id: c.row.metadata.id,
      slug: c.row.slug,
      kind: c.row.type,
      score: r.score,
      summary: c.row.summary,
      lifecycle_status: c.row.lifecycleStatus,
    });
  }

  return {
    seedSlug: slug,
    seedKind: seed.type,
    totalCandidates: deduped.length,
    hits,
  };
}

/**
 * Merge two text contents using llmtxt/sdk version primitives.
 *
 * Strategies:
 * - `three-way` (default): squash both patches onto the base via `squashPatches`
 * - `cherry-pick`: apply the first patch onto the base via `reconstructVersion`
 * - `multi-diff`: compute a diff summary between two versions via `diffVersions`
 *
 * When the primitive throws (e.g. patch conflict), conflict markers are inserted
 * and `hasConflicts` is set to `true`.
 *
 * @param a    - First text content to use as patch text for version 1.
 * @param b    - Second text content to use as patch text for version 2.
 * @param opts - Strategy, optional base content, output path.
 * @returns Merge result with combined text and conflict indicator.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/sdk` is not installed.
 *
 * @example
 * ```ts
 * const result = await mergeDocs(contentA, contentB, { strategy: 'three-way', base: baseContent });
 * ```
 */
export async function mergeDocs(
  a: string,
  b: string,
  opts?: { strategy?: 'three-way' | 'cherry-pick' | 'multi-diff'; base?: string },
): Promise<DocsMergeResult> {
  let squashPatches: (
    base: string,
    patches: VersionEntry[],
  ) => { patchText: string; contentHash: string; tokenCount: number };
  let diffVersions: (
    base: string,
    patches: VersionEntry[],
    fromVersion: number,
    toVersion: number,
  ) => VersionDiffSummary;
  let reconstructVersion: (
    base: string,
    patches: VersionEntry[],
    targetVersion?: number,
  ) => ReconstructionResult;

  try {
    const mod = await import('llmtxt/sdk');
    squashPatches = mod.squashPatches;
    diffVersions = mod.diffVersions;
    reconstructVersion = mod.reconstructVersion;
  } catch (cause) {
    throwUnavailable('llmtxt/sdk', cause);
  }

  const strategy = opts?.strategy ?? 'three-way';
  const base = opts?.base ?? '';

  const now = Date.now();
  const patchA: VersionEntry = {
    versionNumber: 1,
    patchText: a,
    createdBy: 'cleo',
    changelog: 'version A',
    contentHash: '',
    createdAt: now,
  };
  const patchB: VersionEntry = {
    versionNumber: 2,
    patchText: b,
    createdBy: 'cleo',
    changelog: 'version B',
    contentHash: '',
    createdAt: now + 1,
  };

  let merged: string;
  let hasConflicts = false;

  if (strategy === 'three-way') {
    try {
      const result = squashPatches(base, [patchA, patchB]);
      merged = result.patchText;
    } catch {
      merged = `<<<<<<< A\n${a}\n=======\n${b}\n>>>>>>> B\n`;
      hasConflicts = true;
    }
  } else if (strategy === 'cherry-pick') {
    try {
      const result = reconstructVersion(base, [patchA], 1);
      merged = result.content;
    } catch {
      merged = `<<<<<<< A\n${a}\n=======\n${b}\n>>>>>>> B\n`;
      hasConflicts = true;
    }
  } else {
    // multi-diff
    try {
      const result = diffVersions(base, [patchA, patchB], 1, 2);
      merged = result.patchText;
    } catch {
      merged = `<<<<<<< A\n${a}\n=======\n${b}\n>>>>>>> B\n`;
      hasConflicts = true;
    }
  }

  return { merged, strategy, hasConflicts };
}

/**
 * Build a document relationship graph using `llmtxt/graph.buildGraph`.
 *
 * Loads blob attachments for the owner and synthesises `MessageInput` objects
 * from blob metadata so the primitive can extract nodes, edges, and topics.
 *
 * @param opts - Owner scope and project root.
 * @returns Graph nodes and edges suitable for dot/mermaid/json rendering.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/graph` is not installed.
 *
 * @example
 * ```ts
 * const graph = await buildDocsGraph({ ownerId: 'T123' });
 * ```
 */
export async function buildDocsGraph(opts: {
  ownerId?: string;
  projectRoot?: string;
}): Promise<DocsGraphResult> {
  let buildGraph: (messages: MessageInput[]) => KnowledgeGraph;

  try {
    const mod = await import('llmtxt/graph');
    buildGraph = mod.buildGraph;
  } catch (cause) {
    throwUnavailable('llmtxt/graph', cause);
  }

  const root = opts.projectRoot ?? getProjectRoot();
  const blobs = opts.ownerId ? await blobList(opts.ownerId, root).catch(() => []) : [];

  // Synthesise MessageInput objects from blob metadata
  const now = new Date().toISOString();
  const messages: MessageInput[] =
    blobs.length > 0
      ? blobs.map((b, i) => ({
          id: `blob-${i}`,
          fromAgentId: opts.ownerId ?? 'cleo',
          content: `${b.name} sha256:${b.sha256} size:${b.sizeBytes}${b.mimeType ? ` mime:${b.mimeType}` : ''}`,
          metadata: { tags: [b.mimeType ?? 'unknown'] },
          createdAt: now,
        }))
      : [
          {
            id: 'empty',
            fromAgentId: opts.ownerId ?? 'cleo',
            content: '(no attachments)',
            createdAt: now,
          },
        ];

  const raw = buildGraph(messages);

  const nodes: DocsGraphNode[] = raw.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    kind: n.type,
    weight: n.weight,
  }));

  const edges: DocsGraphEdge[] = raw.edges.map((e) => ({
    source: e.source,
    target: e.target,
    relation: e.type,
    weight: e.weight,
  }));

  return { nodes, edges, raw };
}

/**
 * Rank attachments for an owner by relevance using `llmtxt/similarity.rankBySimilarity`.
 *
 * When `query` is provided it is used directly; otherwise the owner ID is used
 * as the query anchor.
 *
 * @param opts - Required `ownerId`, optional `query` and `projectRoot`.
 * @returns Ranked attachment list, best first.
 *
 * @throws `LLMTXT_PRIMITIVE_UNAVAILABLE` when `llmtxt/similarity` is not installed.
 *
 * @example
 * ```ts
 * const result = await rankDocs({ ownerId: 'T123', query: 'architecture' });
 * ```
 */
export async function rankDocs(opts: {
  ownerId: string;
  query?: string;
  projectRoot?: string;
}): Promise<DocsRankResult> {
  let rankBySimilarity: (
    q: string,
    candidates: string[],
    options?: { method?: 'ngram' | 'shingle'; threshold?: number },
  ) => SimilarityRankResult[];

  try {
    const mod = await import('llmtxt/similarity');
    rankBySimilarity = mod.rankBySimilarity;
  } catch (cause) {
    throwUnavailable('llmtxt/similarity', cause);
  }

  const root = opts.projectRoot ?? getProjectRoot();
  const blobs = await blobList(opts.ownerId, root).catch(() => []);

  if (blobs.length === 0) {
    return { ownerId: opts.ownerId, hits: [] };
  }

  const query = opts.query ?? opts.ownerId;
  const candidates = blobs.map((b) => b.name);
  const ranked = rankBySimilarity(query, candidates);

  const hits: DocsRankHit[] = ranked.map((r) => {
    const blob = blobs[r.index];
    return { id: blob.sha256, name: blob.name, score: r.score };
  });

  return { ownerId: opts.ownerId, hits };
}

/**
 * Try the T13727 conduit-history listing for a doc-slug arg.
 *
 * Returns null (caller falls back to the manifest path) when the arg does
 * not resolve to a conduit doc, when the doc has no version rows yet, or
 * when the project store cannot be read — the command must never regress
 * because the store was unreachable.
 *
 * @internal
 */
async function listConduitDocVersions(
  root: string,
  slug: string,
  name: string | undefined,
): Promise<DocsVersionsResult | null> {
  try {
    const { findConduitAttachmentByUid, listConduitAttachmentVersions, resolveConduitDocUid } =
      await import('../store/conduit-doc-history.js');
    const docUid = await resolveConduitDocUid(root, slug);
    if (docUid === null) return null;
    const doc = await findConduitAttachmentByUid(root, docUid);
    const rows = await listConduitAttachmentVersions(root, docUid);
    if (rows.length === 0) return null;
    const entryName = doc?.slug ?? slug;
    if (name !== undefined && name !== entryName) {
      return { ownerId: slug, nameFilter: name, versions: [] };
    }
    // Order by the real timestamps: display ordinals can repeat across the
    // pre-/post-adoption seam (existing rows keep their minted local
    // ordinals), but every row carries an honest created_at.
    const ordered = [...rows].sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      return byTime !== 0 ? byTime : (b.uid ?? '').localeCompare(a.uid ?? '');
    });
    const versions: DocsVersionEntry[] = ordered.map((row) => ({
      attachmentId: row.contentHash,
      name: entryName,
      sha256: row.contentHash,
      sizeBytes: row.originalSize,
      docVersion: row.versionNumber,
    }));
    return { ownerId: slug, nameFilter: name, versions };
  } catch {
    return null;
  }
}

/**
 * List all SHA-256 content-address versions of attachments for an owner.
 *
 * Reads the blob manifest for `ownerId` and returns all entries, optionally
 * filtered by filename. Each entry carries its content-address SHA-256 so
 * callers can reconstruct history from the store.
 *
 * T13725 — `ownerId` may also be a doc slug. Resolution order: an owner id
 * (`T###`, `ses_*`, `O-*`) is listed verbatim, even when it has no blobs.
 * Any other arg is listed verbatim when it owns blobs; otherwise it is
 * resolved as a doc slug through the same {@link AttachmentStore.findBySlug}
 * surface `docs fetch` uses, and its owning task's blobs are listed
 * (sibling docs included; narrow with `name`). An
 * arg that is neither throws `E_NOT_FOUND`.
 *
 * T13727 — precedence: when the arg resolves as a doc slug that has been
 * adopted into the conduit family AND has at least one
 * `conduit_attachment_versions` row, the listing comes from the conduit
 * history ({@link listConduitAttachmentVersions}) keyed on the doc's
 * immutable uid — the canonical per-doc history — instead of the LWW blob
 * manifest. Entries carry the version's `content_hash` and
 * `version_number` (as `docVersion`) and are ordered newest `created_at`
 * first (real timestamps; display ordinals can repeat across the pre-/post-
 * adoption seam, so ordering leans on time, not the ordinal). A doc with no
 * conduit row, or none yet adopted, keeps the manifest listing as fallback
 * so the command never regresses.
 *
 * @param opts - Required `ownerId` (owner id or doc slug), optional `name`
 *   filter and `projectRoot`.
 * @returns Version list with SHA-256 content addresses.
 * @throws {CleoError} `E_NOT_FOUND` when the arg resolves to no owner and no doc.
 *
 * @example
 * ```ts
 * const result = await listDocVersions({ ownerId: 'T123', name: 'spec.md' });
 * ```
 */
export async function listDocVersions(opts: {
  ownerId: string;
  name?: string;
  projectRoot?: string;
}): Promise<DocsVersionsResult> {
  const root = opts.projectRoot ?? getProjectRoot();

  // T13727 — a doc slug with conduit history lists the canonical version
  // rows; any failure to reach the store degrades to the manifest path.
  if (!/^(T\d+$|ses_|O-)/.test(opts.ownerId)) {
    const conduit = await listConduitDocVersions(root, opts.ownerId, opts.name);
    if (conduit !== null) return conduit;
  }

  let allBlobs = await blobList(opts.ownerId, root).catch(() => []);
  let listedOwnerId = opts.ownerId;

  if (allBlobs.length === 0 && !/^(T\d+$|ses_|O-)/.test(opts.ownerId)) {
    const store = createAttachmentStore();
    const doc = await store.findBySlug(opts.ownerId, root).catch(() => null);
    if (doc === null) {
      // @sync-invariant none:input-shape an unknown --for arg is refused on a read-only query path before any write; nothing was written
      throw new CleoError(ExitCode.NOT_FOUND, `no doc or owner found for '${opts.ownerId}'`, {
        fix: 'Pass an owner id (T###, ses_*, O-*) or a doc slug from `cleo docs list`.',
      });
    }
    // shortcut: lists the owning task's blobs, siblings included; the store keeps no link from
    // a doc to its pre-update blobs (update re-homes the slug), so a per-doc filter would drop
    // history. Narrow with `name`, or filter per doc once updates record their predecessor.
    const refs = await store.listRefs(doc.metadata.id, root).catch(() => []);
    for (const ref of refs) {
      const rows = await blobList(ref.ownerId, root).catch(() => []);
      if (rows.length > 0) {
        allBlobs = rows;
        listedOwnerId = ref.ownerId;
        break;
      }
    }
  }

  const filtered = opts.name ? allBlobs.filter((b) => b.name === opts.name) : allBlobs;

  const versions: DocsVersionEntry[] = filtered.map((b) => ({
    attachmentId: b.sha256,
    name: b.name,
    sha256: b.sha256,
    sizeBytes: b.sizeBytes,
    mimeType: b.mimeType,
  }));

  return {
    ownerId: listedOwnerId,
    nameFilter: opts.name,
    versions,
  };
}

/**
 * Result returned by {@link publishDocs}.
 *
 * @epic T9626 (W0)
 * @task T9701 (ST-PUB-2a — atomic write-side + envelope SHA)
 */
export interface DocsPublishResult {
  /** Absolute path the bytes were written to. */
  readonly publishedPath: string;
  /** Project-root-relative form of `publishedPath`. Stable across machines. */
  readonly relativePath: string;
  /** Lowercase hex SHA-256 of the written bytes. */
  readonly sha256: string;
  /** Byte count actually written to disk. */
  readonly bytes: number;
  /** Content-addressed blob id (sha256) selected from the manifest. */
  readonly blobSha256: string;
  /** User-visible attachment name (e.g. `"spec.md"`) selected from the manifest. */
  readonly blobName: string;
  /** Owner entity ID whose blob was published. */
  readonly ownerId: string;
}

/** Return the validated real target; Git registration alone never authorizes arbitrary paths. */
async function validatedPublicationPath(root: string, destination: string): Promise<string | null> {
  const canonicalRoot = await canonicalizePath(root);
  const inside = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  };
  const canonicalDestination = await canonicalizePath(destination);
  if (
    (inside(resolvePath(root), destination) || inside(canonicalRoot, destination)) &&
    inside(canonicalRoot, canonicalDestination)
  )
    return canonicalDestination;
  const worktreeBase = resolveWorktreeRootForHash(computeProjectHash(canonicalRoot));
  const canonicalBase = await canonicalizePath(worktreeBase);
  const probe = (cwd: string, args: string[]): string =>
    execFileSync('git', args, {
      cwd,
      env: discoveryEnv(),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  try {
    // Cold path only: ordinary project publication never loads the worktree barrel.
    const { parseWorktreePorcelain } = await import('@cleocode/worktree');
    const common = await canonicalizePath(
      probe(canonicalRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const registered = parseWorktreePorcelain(
      probe(canonicalRoot, ['worktree', 'list', '--porcelain']), // raw-git-worktree-ok: T13376 read-only publication admission requires sanitized Git environment and bounded probe; canonical SDK parser validates the registry.
    );
    for (const entry of registered) {
      const taskId = basename(entry.path);
      if (!/^T\d+$/.test(taskId)) continue;
      const expected = join(canonicalBase, taskId);
      const checkout = await canonicalizePath(entry.path);
      if (
        checkout !== expected ||
        !(inside(checkout, destination) || inside(join(worktreeBase, taskId), destination)) ||
        !inside(checkout, canonicalDestination)
      )
        continue;
      const checkoutCommon = await canonicalizePath(
        probe(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      );
      if (checkoutCommon === common) return canonicalDestination;
    }
  } catch {
    // Missing/unreadable Git registration supplies no additional authority.
  }
  return null;
}

/**
 * Atomically publish an attachment from the docs SSoT to a git-tracked path.
 *
 * Reads the named blob from the store and writes it to `toPath` using a
 * tmp-then-rename atomic pattern with `fsync` before close. When `attachmentId`
 * is omitted the most recently uploaded blob (latest by `uploadedAt`) is used.
 *
 * Path-escape guard: when `toPath` is relative it is joined under
 * `projectRoot`; absolute paths must resolve within `projectRoot` or a
 * Git-registered canonical task worktree of the same repository. Symlink
 * escapes remain blocked, including for new destination files. Otherwise,
 * writes require an explicit override: the caller passes `allowOutsideRoot: true`. This prevents an
 * attacker-controlled blob name from being published to an arbitrary path
 * via traversal sequences.
 *
 * Idempotency: writing the same bytes twice produces the same file SHA and
 * leaves the destination byte-identical (tmp-then-rename overwrites in-place).
 *
 * @param opts - Required `ownerId` and `toPath`, optional `attachmentId`,
 *               `projectRoot`, and `allowOutsideRoot`.
 * @returns Published path, SHA-256 digest of written bytes, byte count,
 *          blob name + sha256, and the owner ID.
 *
 * @throws {Error} when no matching attachment is found for the owner.
 * @throws {Error} when the blob store cannot supply the bytes.
 * @throws {Error} when the resolved publish path escapes `projectRoot`
 *                 and `allowOutsideRoot` is not set.
 *
 * @epic T9626 (W0)
 * @task T9701 (ST-PUB-2a)
 *
 * @example
 * ```ts
 * const out = await publishDocs({ ownerId: 'T123', toPath: 'docs/spec.md' });
 * console.log(`Published ${out.bytes} bytes to ${out.publishedPath}`);
 * ```
 */
export async function publishDocs(opts: {
  ownerId: string;
  attachmentId?: string;
  toPath: string;
  projectRoot?: string;
  /** When true, allow writing to paths outside `projectRoot`. Default: `false`. */
  allowOutsideRoot?: boolean;
}): Promise<DocsPublishResult> {
  const root = opts.projectRoot ?? getProjectRoot();
  const blobs = await blobList(opts.ownerId, root).catch(() => []);

  // Select target blob. When attachmentId is provided, match by sha256, blob name,
  // or legacy attachment row ID. Otherwise, pick the most recently uploaded blob.
  let target = opts.attachmentId
    ? blobs.find((b) => b.sha256 === opts.attachmentId || b.name === opts.attachmentId)
    : blobs.length
      ? blobs.reduce((latest, b) => ((b.uploadedAt ?? 0) > (latest.uploadedAt ?? 0) ? b : latest))
      : undefined;

  let canonicalBytes: Uint8Array | undefined;
  if (!target) {
    // The manifest missed — fall back to the doc REGISTRY for target selection
    // (UUID / slug / default-latest resolution, still owner-scoped). Content
    // bytes are read from the blob store by content address (T13362) — the
    // legacy `.cleo/attachments/sha256/` tree has no read path here, so a doc
    // whose bytes were never mirrored/consolidated fails loudly instead of
    // silently publishing stale legacy bytes.
    const store = createAttachmentStore();
    const metadata = opts.attachmentId
      ? ((await store.getMetadata(opts.attachmentId, root).catch(() => null)) ??
        (await store.findBySlug(opts.attachmentId, root).catch(() => null))?.metadata)
      : (await store.listByOwner('task', opts.ownerId, root).catch(() => [])).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        )[0];
    if (metadata) {
      // Preserve UUID-to-registry-blob lookup, still scoped to this owner's manifest.
      target = blobs.find((entry) => entry.sha256 === metadata.sha256);
      if (!target) {
        const owners = await store.listRefs(metadata.id, root);
        const owner = owners.find((ref) => ref.ownerId === opts.ownerId);
        const owned = owner ? await store.listByOwner(owner.ownerType, opts.ownerId, root) : [];
        // @sync-invariant none:local-only publication reads are restricted to the requested attachment owner; no synced rows mutate.
        if (owned.some((attachment) => attachment.id === metadata.id)) {
          const content = await blobReadBySha(metadata.sha256, root);
          // @sync-invariant none:local-only blob content identity protects this local file publication, not synced rows.
          if (!content) throw new Error(`publishDocs: could not read attachment "${metadata.id}"`);
          canonicalBytes = content;
          const extras = await store.getExtras(metadata.id, root);
          target = {
            name:
              metadata.attachment.kind === 'blob' && metadata.attachment.storageKey
                ? basename(metadata.attachment.storageKey)
                : (extras?.slug ?? metadata.id),
            sha256: metadata.sha256,
            sizeBytes: content.byteLength,
            mimeType: metadata.attachment.kind === 'blob' ? metadata.attachment.mime : undefined,
            uploadedAt: Date.parse(metadata.createdAt),
          };
        }
      }
    }
  }

  if (!target) {
    if (!opts.attachmentId && !blobs.length)
      // @sync-invariant none:local-only absent readable owner content prevents local publication; no synced state is changed.
      throw new Error(`publishDocs: no attachments found for owner "${opts.ownerId}"`);
    throw new Error(
      `publishDocs: attachment "${opts.attachmentId}" not found for owner "${opts.ownerId}"`,
    );
  }

  const bytes = canonicalBytes ?? (await blobRead(opts.ownerId, target.name, root));
  if (!bytes) {
    throw new Error(
      `publishDocs: could not read blob "${target.name}" for owner "${opts.ownerId}"`,
    );
  }

  // Resolve to absolute, then enforce project-root containment unless opted out.
  let publishedPath = isAbsolute(opts.toPath)
    ? resolvePath(opts.toPath)
    : resolvePath(root, opts.toPath);
  let publicationOrigin = root;

  if (!opts.allowOutsideRoot) {
    // T13376: validate in the SDK so every caller shares the same boundary.
    // Both lexical and real filesystem containment are required; registered
    // canonical task worktrees extend the root without an outside-root bypass.
    const canonicalRoot = await canonicalizePath(root);
    const lexicalPath = isAbsolute(opts.toPath)
      ? resolvePath(opts.toPath)
      : resolvePath(canonicalRoot, opts.toPath);
    const validatedPath = await validatedPublicationPath(root, lexicalPath);
    if (!validatedPath) {
      throw new Error(
        `publishDocs: refusing to write outside projectRoot "${root}" (resolved to "${publishedPath}"). Pass allowOutsideRoot:true to override.`,
      );
    }
    publishedPath = validatedPath;
    publicationOrigin = canonicalRoot;
  }

  // Tmp name carries pid + random suffix so concurrent publishes never collide.
  const tmpPath = `${publishedPath}.cleo-publish-tmp.${process.pid}.${randomBytes(4).toString('hex')}`;

  await mkdir(dirname(publishedPath), { recursive: true });

  const { open, rename, unlink } = await import('node:fs/promises');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tmpPath, 'w', 0o644);
    await handle.writeFile(bytes);
    // Flush page cache + metadata so a crash between rename and reboot does
    // not surface a zero-byte file under the destination path.
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await rename(tmpPath, publishedPath);
  } catch (err) {
    // Cross-device rename is the most common cause; surface a clear error
    // rather than leaving a stray tmp file behind.
    await unlink(tmpPath).catch(() => {
      /* tmp already gone — nothing to clean. */
    });
    throw err;
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relativePath = relative(publicationOrigin, publishedPath);

  return {
    publishedPath,
    relativePath,
    sha256,
    bytes: bytes.byteLength,
    blobSha256: target.sha256,
    blobName: target.name,
    ownerId: opts.ownerId,
  };
}

// ─── docs-publications ledger (T9703 prep — used by status drift detector) ────

/**
 * On-disk record of one published doc. Persisted as a row of the
 * `docs_publications` table in the project `cleo.db` (T13362) — the
 * deprecated `.cleo/docs-publications.json` sidecar is read-only legacy,
 * seeded into the table on first access by the publications-store shim.
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c — drift detector)
 */
export interface DocsPublicationRecord {
  /** Owner entity ID whose blob was published (e.g. `"T123"`). */
  readonly ownerId: string;
  /** Attachment name as stored in the blob manifest. */
  readonly blobName: string;
  /** Project-root-relative path the bytes were written to. */
  readonly publishedPath: string;
  /** SHA-256 of the blob bytes at the time of publish. */
  readonly lastBlobSha: string;
  /** ISO-8601 timestamp of the latest publish event for this record. */
  readonly publishedAt: string;
}

/**
 * Load the docs-publications ledger.
 *
 * Reads the `docs_publications` store rows via the publications-store
 * accessor, which carries the one-time legacy-JSON seed shim (T13362). A
 * missing/empty ledger means "no publications recorded yet", never a hard
 * error.
 *
 * @internal
 */
export async function readPublicationsLedger(
  projectRoot: string,
): Promise<DocsPublicationRecord[]> {
  return readDocsPublications(projectRoot);
}

/**
 * Record a publish event in the docs-publications ledger.
 *
 * Upserts a `docs_publications` store row on `(ownerId, blobName,
 * publishedPath)`, refreshing `lastBlobSha` and `publishedAt` when the row
 * already exists so the ledger always reflects the latest known good
 * publication. New writes go to the store only — the deprecated JSON sidecar
 * is never updated (T13362).
 *
 * @param opts - Required record fields.
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 */
export async function recordPublication(opts: {
  ownerId: string;
  blobName: string;
  publishedPath: string;
  lastBlobSha: string;
  projectRoot?: string;
}): Promise<void> {
  const root = opts.projectRoot ?? getProjectRoot();
  await upsertDocsPublication(root, {
    ownerId: opts.ownerId,
    blobName: opts.blobName,
    publishedPath: opts.publishedPath,
    lastBlobSha: opts.lastBlobSha,
  });
}

/**
 * List all recorded publications in the ledger.
 *
 * Returns an empty array when no publications exist.
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 */
export async function listPublications(opts?: {
  projectRoot?: string;
}): Promise<DocsPublicationRecord[]> {
  const root = opts?.projectRoot ?? getProjectRoot();
  return readDocsPublications(root);
}

// ─── syncFromGit (T9702 — reverse-ingest) ─────────────────────────────────────

/**
 * Result returned by {@link syncFromGit}.
 *
 * @epic T9626 (W0)
 * @task T9702 (ST-PUB-2b — reverse-ingest)
 */
export interface DocsSyncFromGitResult {
  /** Owner entity ID the file was ingested under. */
  readonly ownerId: string;
  /** Attachment name as stored in the blob manifest. */
  readonly blobName: string;
  /** Project-root-relative source path. */
  readonly sourcePath: string;
  /** SHA-256 of the bytes that were ingested. */
  readonly newSha: string;
  /** SHA-256 of the previously-stored blob with the same name, when present. */
  readonly oldSha?: string;
  /** Byte count of the ingested file. */
  readonly bytes: number;
  /**
   * What happened during ingest:
   *   - `created` — first time this `(ownerId, name)` pair was seen.
   *   - `updated` — content differs from the latest stored blob.
   *   - `noop`    — content sha matches the latest stored blob; no new blob was written.
   */
  readonly action: 'created' | 'updated' | 'noop';
}

/**
 * Ingest a git-tracked file as a new blob version on the docs SSoT.
 *
 * Reads `fromPath`, computes its SHA-256, and:
 *   - Returns `{action: 'noop'}` when the latest stored blob for
 *     `(ownerId, blobName)` already matches the content sha (idempotency).
 *   - Otherwise attaches a new blob via `CleoBlobStore.attach` and returns
 *     `{action: 'created' | 'updated', newSha, oldSha?}`.
 *
 * The `blobName` defaults to `path.basename(fromPath)` unless explicitly
 * passed. Use `--name <slug>` from the CLI to override.
 *
 * @param opts - Required `ownerId` and `fromPath`, optional `blobName`,
 *               `contentType`, and `projectRoot`.
 * @returns Action taken + before/after SHAs.
 *
 * @throws {Error} when `fromPath` cannot be read.
 *
 * @epic T9626 (W0)
 * @task T9702 (ST-PUB-2b)
 *
 * @example
 * ```ts
 * const out = await syncFromGit({ ownerId: 'T123', fromPath: 'docs/spec.md' });
 * if (out.action === 'noop') console.log('already in sync');
 * ```
 */
export async function syncFromGit(opts: {
  ownerId: string;
  fromPath: string;
  blobName?: string;
  contentType?: string;
  projectRoot?: string;
}): Promise<DocsSyncFromGitResult> {
  const root = opts.projectRoot ?? getProjectRoot();

  const sourceAbs = isAbsolute(opts.fromPath)
    ? resolvePath(opts.fromPath)
    : resolvePath(root, opts.fromPath);
  const sourceRel = relative(root, sourceAbs);

  const { readFile } = await import('node:fs/promises');
  let bytes: Buffer;
  try {
    bytes = await readFile(sourceAbs);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    const err = new Error(`syncFromGit: cannot read "${sourceAbs}": ${msg}`);
    err.cause = cause;
    throw err;
  }

  const blobName = opts.blobName ?? sourceAbs.split(/[\\/]/).pop() ?? 'doc';
  const newSha = createHash('sha256').update(bytes).digest('hex');

  // Probe the existing manifest for a same-named blob.
  const existing = await blobList(opts.ownerId, root).catch(() => []);
  const latest = existing.find((b) => b.name === blobName);
  const oldSha = latest?.sha256;

  if (latest && latest.sha256 === newSha) {
    return {
      ownerId: opts.ownerId,
      blobName,
      sourcePath: sourceRel,
      newSha,
      oldSha,
      bytes: bytes.byteLength,
      action: 'noop',
    };
  }

  // Open the blob store and attach the new version. Same content under the
  // same name with a different sha overwrites the manifest row (LWW).
  const { CleoBlobStore } = await import('../store/llmtxt-blob-adapter.js');
  const store = new CleoBlobStore({ projectRoot: root });
  await store.open();
  try {
    await store.attach(
      opts.ownerId,
      blobName,
      new Uint8Array(bytes),
      opts.contentType ?? 'application/octet-stream',
    );
  } finally {
    await store.close();
  }

  return {
    ownerId: opts.ownerId,
    blobName,
    sourcePath: sourceRel,
    newSha,
    oldSha,
    bytes: bytes.byteLength,
    action: latest ? 'updated' : 'created',
  };
}

// ─── docs status (T9703 — drift detector) ─────────────────────────────────────

/**
 * Single drift item returned by {@link statusDocs}.
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 */
export interface DocsDriftItem {
  /** Owner entity ID the blob is attached to. */
  readonly ownerId: string;
  /** Attachment name in the blob manifest. */
  readonly blobName: string;
  /** Project-root-relative path the blob was published to. */
  readonly publishedPath: string;
  /** SHA-256 of the blob in the manifest (the docs SSoT). */
  readonly blobSha: string;
  /** SHA-256 of the file at `publishedPath`, or `null` when missing. */
  readonly fileSha: string | null;
  /**
   * Drift classification:
   *   - `in-sync`  — blobSha === fileSha
   *   - `added`    — file exists on disk but no row in the manifest (rare; never set today)
   *   - `modified` — blobSha !== fileSha and file is present
   *   - `deleted`  — file is missing from disk
   */
  readonly drift: 'in-sync' | 'added' | 'modified' | 'deleted';
}

/**
 * Result returned by {@link statusDocs}.
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 */
export interface DocsStatusResult {
  /** Each recorded publication, with drift classification. */
  readonly items: readonly DocsDriftItem[];
  /** True when every item is `in-sync`. */
  readonly allInSync: boolean;
}

/**
 * Read `.cleo/docs-publications.json` and classify drift for each entry.
 *
 * Drift cases covered:
 *   - blob present + file present + matching sha → `in-sync`
 *   - blob present + file present + sha mismatch → `modified`
 *   - blob present + file missing                → `deleted`
 *
 * The `added` classification is reserved for files-on-disk-without-a-manifest-row
 * and is not produced today — `status` operates strictly on the ledger.
 *
 * @param opts - Optional `projectRoot`.
 * @returns Items list + `allInSync` boolean. Suitable for CI exit-code gating
 *          (0 when `allInSync`, 2 otherwise).
 *
 * @epic T9626 (W0)
 * @task T9703 (ST-PUB-2c)
 *
 * @example
 * ```ts
 * const status = await statusDocs();
 * if (!status.allInSync) process.exit(2);
 * ```
 */
export async function statusDocs(opts?: { projectRoot?: string }): Promise<DocsStatusResult> {
  const root = opts?.projectRoot ?? getProjectRoot();
  const ledger = await readPublicationsLedger(root);
  if (ledger.length === 0) {
    return { items: [], allInSync: true };
  }

  const { readFile, stat } = await import('node:fs/promises');

  // Refresh blob shas from the manifest so the ledger drives WHICH paths to
  // check but the latest manifest drives the authoritative SSoT sha.
  const ownerCache = new Map<string, Map<string, string>>();
  async function getBlobSha(ownerId: string, blobName: string, ledgerSha: string): Promise<string> {
    let perOwner = ownerCache.get(ownerId);
    if (!perOwner) {
      perOwner = new Map();
      const rows = await blobList(ownerId, root).catch(() => []);
      for (const row of rows) perOwner.set(row.name, row.sha256);
      ownerCache.set(ownerId, perOwner);
    }
    return perOwner.get(blobName) ?? ledgerSha;
  }

  const items: DocsDriftItem[] = [];
  for (const row of ledger) {
    const filePath = isAbsolute(row.publishedPath)
      ? row.publishedPath
      : resolvePath(root, row.publishedPath);

    const blobSha = await getBlobSha(row.ownerId, row.blobName, row.lastBlobSha);

    let fileSha: string | null = null;
    let exists = false;
    try {
      await stat(filePath);
      exists = true;
    } catch {
      exists = false;
    }

    if (exists) {
      try {
        const data = await readFile(filePath);
        fileSha = createHash('sha256').update(data).digest('hex');
      } catch {
        fileSha = null;
      }
    }

    let drift: DocsDriftItem['drift'];
    if (!exists || fileSha === null) {
      drift = 'deleted';
    } else if (fileSha === blobSha) {
      drift = 'in-sync';
    } else {
      drift = 'modified';
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
