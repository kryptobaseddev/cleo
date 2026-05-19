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

import { createHash, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { KnowledgeGraph, MessageInput } from 'llmtxt/graph';
import type { ReconstructionResult, VersionDiffSummary, VersionEntry } from 'llmtxt/sdk';
import type { SimilarityRankResult } from 'llmtxt/similarity';
import { getProjectRoot } from '../paths.js';
import { blobList, blobRead } from '../store/blob-ops.js';

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
 * List all SHA-256 content-address versions of attachments for an owner.
 *
 * Reads the blob manifest for `ownerId` and returns all entries, optionally
 * filtered by filename. Each entry carries its content-address SHA-256 so
 * callers can reconstruct history from the store.
 *
 * @param opts - Required `ownerId`, optional `name` filter and `projectRoot`.
 * @returns Version list with SHA-256 content addresses.
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
  const allBlobs = await blobList(opts.ownerId, root).catch(() => []);

  const filtered = opts.name ? allBlobs.filter((b) => b.name === opts.name) : allBlobs;

  const versions: DocsVersionEntry[] = filtered.map((b) => ({
    attachmentId: b.sha256,
    name: b.name,
    sha256: b.sha256,
    sizeBytes: b.sizeBytes,
    mimeType: b.mimeType,
  }));

  return {
    ownerId: opts.ownerId,
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

/**
 * Atomically publish an attachment from the docs SSoT to a git-tracked path.
 *
 * Reads the named blob from the store and writes it to `toPath` using a
 * tmp-then-rename atomic pattern with `fsync` before close. When `attachmentId`
 * is omitted the last blob in the manifest is used.
 *
 * Path-escape guard: when `toPath` is relative it is joined under
 * `projectRoot`; absolute paths must still resolve within `projectRoot`
 * unless the caller passes `allowOutsideRoot: true`. This prevents an
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

  if (blobs.length === 0) {
    throw new Error(`publishDocs: no attachments found for owner "${opts.ownerId}"`);
  }

  // Select target blob by sha256 or name match; default to last entry
  const target = opts.attachmentId
    ? blobs.find((b) => b.sha256 === opts.attachmentId || b.name === opts.attachmentId)
    : blobs[blobs.length - 1];

  if (!target) {
    throw new Error(
      `publishDocs: attachment "${opts.attachmentId}" not found for owner "${opts.ownerId}"`,
    );
  }

  const bytes = await blobRead(opts.ownerId, target.name, root);
  if (!bytes) {
    throw new Error(
      `publishDocs: could not read blob "${target.name}" for owner "${opts.ownerId}"`,
    );
  }

  // Resolve to absolute, then enforce project-root containment unless opted out.
  const publishedPath = isAbsolute(opts.toPath)
    ? resolvePath(opts.toPath)
    : resolvePath(root, opts.toPath);

  if (!opts.allowOutsideRoot) {
    const rel = relative(root, publishedPath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `publishDocs: refusing to write outside projectRoot "${root}" (resolved to "${publishedPath}"). Pass allowOutsideRoot:true to override.`,
      );
    }
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
  const relativePath = relative(root, publishedPath);

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
