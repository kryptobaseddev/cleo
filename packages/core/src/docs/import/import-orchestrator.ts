/**
 * import-orchestrator — wire `scan → classify → slug → dedup → write → audit`
 * for `cleo docs import` (T9709 / T9639).
 *
 * Single entry point: {@link runDocsImport}. Composes the pure helpers from
 * sibling files in this directory and the {@link DocsAccessor} store
 * contract. Returns a counter-balanced result the CLI handler can
 * print verbatim or serialise into the LAFS envelope.
 *
 * Counter-integrity invariant (T9709 acceptance):
 *   `scanCount === importCount + noopCount + errorCount`
 *
 * On mismatch the function throws {@link CounterMismatchError} so the
 * CLI maps it to exit code 2 with `E_COUNTER_MISMATCH`.
 *
 * @epic T9628 (Saga T9625)
 * @task T9709 (ST-MIG-1e)
 */

import type { DocKind, DocsAccessor, StoreDocResult } from '@cleocode/contracts';
import {
  createCounters,
  defaultManifestPath,
  type ImportCounters,
  type ImportManifest,
  type ImportManifestEntry,
  writeAuditManifest,
} from './audit.js';
import { decideDedupAction } from './dedup.js';
import { type DocImportType, scanDirectory } from './scanner.js';
import { generateSlug, type SlugResult, stripMdExtension } from './slug.js';

/**
 * Map the CLI-level {@link DocImportType} onto the underlying
 * {@link DocKind} used by {@link DocsAccessor.storeDoc}.
 *
 * `adr` maps 1:1; everything else is stored as `agent-output` with the
 * actual import type retained in `meta.importType` so future schema work
 * (e.g. T9627's slug + type columns) can read the canonical classification
 * without re-scanning the source files.
 */
export function importTypeToDocKind(type: DocImportType): DocKind {
  return type === 'adr' ? 'adr' : 'agent-output';
}

/** Result returned by {@link runDocsImport}. */
export interface RunDocsImportResult {
  /** Counters at run completion. */
  readonly counters: ImportCounters;
  /** Per-file outcomes. */
  readonly entries: ImportManifestEntry[];
  /** Absolute path of the audit manifest written to disk (undefined on dry-run). */
  readonly manifestPath?: string;
  /** True when the run was `--dry-run`. */
  readonly dryRun: boolean;
}

/** Options for {@link runDocsImport}. */
export interface RunDocsImportOptions {
  /** Absolute directory to scan recursively. */
  readonly root: string;
  /** Plug-in store (injected by the CLI handler). */
  readonly accessor: DocsAccessor;
  /** True to skip all writes and print proposed actions only. */
  readonly dryRun?: boolean;
  /** True to bypass SHA dedup. */
  readonly force?: boolean;
  /** Override the manifest output path (default: `<root>/docs-import-<ts>.json`). */
  readonly manifestPath?: string;
  /** Override the audit manifest directory (default: `<root>`). */
  readonly auditDir?: string;
  /** Inject a clock for deterministic tests. */
  readonly now?: () => Date;
}

/** Thrown when the counter-integrity invariant fails (T9709 AC). */
export class CounterMismatchError extends Error {
  constructor(
    public readonly counters: ImportCounters,
    public readonly sum: number,
  ) {
    super(
      `counter mismatch: scanCount=${counters.scanCount} but importCount+noopCount+errorCount=${sum}`,
    );
    this.name = 'CounterMismatchError';
  }
}

/**
 * Run a full import pass on `root` using the provided {@link DocsAccessor}.
 *
 * @param options - Import options (root, accessor, flags).
 * @returns Per-file outcomes + counters + audit manifest path.
 */
export async function runDocsImport(options: RunDocsImportOptions): Promise<RunDocsImportResult> {
  const dryRun = options.dryRun === true;
  const force = options.force === true;
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const scanned = await scanDirectory({ root: options.root });
  const counters = createCounters();
  counters.scanCount = scanned.length;

  // Build the existing-sha set in one go. listDocs() returns 100 by default;
  // we ask for a generous cap so a typical project's docs SSoT fits in memory.
  // Larger sets are an explicit follow-up (paginate the listDocs call).
  const existingDocs = await options.accessor.listDocs({ limit: 10_000 });
  const existingShas = new Set<string>(existingDocs.map((d) => d.id));

  // Track slugs created in THIS run so collisions chain (-2, -3, ...) within
  // the run as well as against the existing store.
  const usedSlugs = new Set<string>();
  for (const doc of existingDocs) {
    if (doc.title) {
      const baseSlug = stripMdExtension(doc.title);
      usedSlugs.add(baseSlug.toLowerCase());
    }
  }

  const entries: ImportManifestEntry[] = [];

  for (const file of scanned) {
    const ts = now().toISOString();

    // 1. Slug — failure here is an error row, not a hard abort.
    let slugResult: SlugResult;
    try {
      slugResult = generateSlug({
        source: stripMdExtension(file.relPath.split('/').pop() ?? file.relPath),
        existing: usedSlugs,
      });
    } catch (err) {
      counters.errorCount++;
      entries.push({
        file: file.relPath,
        type: file.suggestedType,
        action: 'error',
        sha: file.contentSha,
        ts,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    usedSlugs.add(slugResult.slug);

    // 2. Dedup gate.
    const decision = decideDedupAction({
      contentSha: file.contentSha,
      existingShas,
      force,
    });
    if (decision.action === 'noop') {
      counters.noopCount++;
      entries.push({
        file: file.relPath,
        slug: slugResult.slug,
        type: file.suggestedType,
        action: 'noop',
        sha: file.contentSha,
        ts,
      });
      continue;
    }

    // 3. Write (skip during dry-run, but still count + emit entry).
    if (dryRun) {
      counters.importCount++;
      entries.push({
        file: file.relPath,
        slug: slugResult.slug,
        type: file.suggestedType,
        action: 'created',
        sha: file.contentSha,
        ts,
      });
      continue;
    }

    let stored: StoreDocResult;
    try {
      stored = await options.accessor.storeDoc({
        kind: importTypeToDocKind(file.suggestedType),
        content: file.content,
        title: slugResult.slug,
        meta: {
          importType: file.suggestedType,
          sourcePath: file.relPath,
          slug: slugResult.slug,
          slugCollision: slugResult.collision,
          ...(slugResult.suffix === undefined ? {} : { slugSuffix: slugResult.suffix }),
        },
      });
    } catch (err) {
      counters.errorCount++;
      entries.push({
        file: file.relPath,
        slug: slugResult.slug,
        type: file.suggestedType,
        action: 'error',
        sha: file.contentSha,
        ts,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    counters.importCount++;
    existingShas.add(file.contentSha);
    entries.push({
      file: file.relPath,
      slug: slugResult.slug,
      type: file.suggestedType,
      action: 'created',
      sha: file.contentSha,
      ts,
      backend: stored.backend,
      docId: stored.id,
    });
  }

  // T9709 — counter integrity check.
  const sum = counters.importCount + counters.noopCount + counters.errorCount;
  if (sum !== counters.scanCount) {
    throw new CounterMismatchError(counters, sum);
  }

  const completedAt = now().toISOString();
  const manifest: ImportManifest = {
    startedAt,
    completedAt,
    root: options.root,
    dryRun,
    counters,
    entries,
  };

  let manifestPath: string | undefined;
  if (!dryRun) {
    manifestPath =
      options.manifestPath ?? defaultManifestPath(options.auditDir ?? options.root, now());
    await writeAuditManifest({ path: manifestPath, manifest });
  }

  return {
    counters,
    entries,
    manifestPath,
    dryRun,
  };
}
