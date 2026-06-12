/**
 * Bounded file-content loader for the fix-gen stage (T11988).
 *
 * The self-improvement fix-gen stage builds a prompt for the LLM
 * ({@link "./fix-gen.js".buildFixGenPrompt}). Without file context the model
 * can only see the regression diff entries (e.g.
 * `op tasks.show (#0) at data/task/status: actual="pending" expected="active"`)
 * and rationally responds `NO_PATCH` because it cannot locate the responsible code.
 *
 * This module resolves the relevant source files for each regressing op-coordinate
 * via the static map ({@link "./op-source-map.js"}) and reads their content with a
 * **hard context budget** so the prompt stays bounded regardless of file size.
 *
 * ## Budget model
 *
 * Two independent byte-level caps:
 *
 *   - `perFileBudget` (default {@link DEFAULT_PER_FILE_BUDGET}): the maximum bytes
 *     read from any single file. Files larger than this are truncated at a
 *     newline boundary and a `<… TRUNCATED …>` marker is appended.
 *   - `totalBudget` (default {@link DEFAULT_TOTAL_BUDGET}): the maximum total bytes
 *     across ALL included files. Files are added in order (handler files first, then
 *     core files); once the total would be exceeded the remaining files are
 *     summarised as a path-only `<file listed but not loaded — budget exhausted>` stub.
 *
 * The caller embeds the resolved {@link LoadedFileContext} into the prompt. The LLM
 * prompt builder ({@link "./fix-gen.js".buildFixGenPrompt}) inserts the file blocks
 * between the regression description and the "produce the diff" instruction, giving
 * the model concrete code to work from.
 *
 * Import-time side-effect-free: no logger init, no native handles.
 *
 * @module @cleocode/core/selfimprove/fix-gen-context
 * @epic T11889
 * @task T11988
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectOpSourceFiles } from './op-source-map.js';

// ── Budget constants ────────────────────────────────────────────────────────

/**
 * Per-file byte cap (default): any single file is truncated to at most 24 KB
 * before being included in the prompt. Chosen to comfortably fit a large-ish
 * handler or core module without overwhelming the model context.
 */
export const DEFAULT_PER_FILE_BUDGET = 24_576; // 24 KB

/**
 * Total byte cap (default): the combined content of all included files must not
 * exceed 65 KB. Keeps the combined code context section to a model-digestible
 * slice of the context window even when multiple files are included.
 */
export const DEFAULT_TOTAL_BUDGET = 65_536; // 64 KB

// ── Types ────────────────────────────────────────────────────────────────────

/** Options for {@link loadFileContext}. */
export interface LoadFileContextOptions {
  /**
   * Absolute project root. Source files are resolved relative to this path.
   * Must be set to the actual repo root for the paths from the op-source-map
   * to resolve correctly.
   */
  readonly projectRoot: string;
  /**
   * The op-coordinates whose source files should be loaded (e.g. `['tasks.show']`).
   * Resolved via {@link collectOpSourceFiles}.
   */
  readonly opCoords: readonly string[];
  /**
   * Per-file byte budget (defaults to {@link DEFAULT_PER_FILE_BUDGET}).
   * Files exceeding this are truncated with a `<… TRUNCATED …>` marker.
   */
  readonly perFileBudget?: number;
  /**
   * Total byte budget for all files combined
   * (defaults to {@link DEFAULT_TOTAL_BUDGET}).
   * Files whose content would push the total over budget are listed but not
   * loaded (their path is emitted as a stub).
   */
  readonly totalBudget?: number;
}

/** A single file included in the context (content loaded or stubbed). */
export interface FileContextEntry {
  /** Repo-relative path (as returned by the op-source-map). */
  readonly repoRelativePath: string;
  /**
   * File content (possibly truncated if `truncated` is `true`). `null` when the
   * file was skipped due to the total budget being exhausted or a read error.
   */
  readonly content: string | null;
  /**
   * `true` when the file was truncated at the per-file budget; the loaded
   * `content` ends with a `<… TRUNCATED …>` marker.
   */
  readonly truncated: boolean;
  /**
   * `true` when the total budget was exhausted before this file was loaded. The
   * file appears in the context list but its `content` is `null`.
   */
  readonly budgetExhausted: boolean;
  /**
   * `true` when the file could not be read (missing, permission error, etc.).
   * The file appears in the context list with `content: null`.
   */
  readonly readError: boolean;
}

/** Resolved file context for a set of op-coordinates. */
export interface LoadedFileContext {
  /** The resolved file entries (handler files first, then core files). */
  readonly entries: readonly FileContextEntry[];
  /** Total bytes of loaded content (across all non-skipped entries). */
  readonly totalBytes: number;
  /** Number of files that were truncated due to the per-file budget. */
  readonly truncatedCount: number;
  /** Number of files that were skipped due to the total budget. */
  readonly budgetSkippedCount: number;
  /** Number of files that could not be read. */
  readonly errorCount: number;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Truncate `content` to at most `maxBytes` bytes, cutting at a newline boundary
 * wherever possible, and appending a marker.
 *
 * Operates on raw bytes via `Buffer` so multi-byte characters don't produce
 * partial surrogate pairs in the truncated output.
 *
 * @param content - The full file content string.
 * @param maxBytes - The per-file byte cap.
 * @returns `{ text, truncated }` — the (possibly shortened) string and a flag.
 * @internal
 */
export function truncateToByteLimit(
  content: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: content, truncated: false };
  }
  // Cut at a newline boundary within the budget to avoid broken lines.
  let cutAt = maxBytes;
  while (cutAt > 0 && buf[cutAt] !== 0x0a /* '\n' */) {
    cutAt--;
  }
  if (cutAt === 0) cutAt = maxBytes; // no newline found — hard cut
  const truncated = buf.slice(0, cutAt).toString('utf8');
  return { text: `${truncated}\n<… TRUNCATED at ${maxBytes} bytes …>`, truncated: true };
}

/**
 * Load bounded file content for the op-coordinates in a fix-gen request.
 *
 * Resolves the handler + core files for each `opCoord` via
 * {@link collectOpSourceFiles}, reads them against `projectRoot`, applies the
 * per-file and total byte budgets, and returns a structured
 * {@link LoadedFileContext} describing every entry (loaded, truncated, skipped, or
 * errored). NEVER throws — read errors produce `{ content: null, readError: true }`.
 *
 * @param opts - See {@link LoadFileContextOptions}.
 * @returns The resolved {@link LoadedFileContext}.
 *
 * @example
 * ```ts
 * const ctx = loadFileContext({
 *   projectRoot: '/repo',
 *   opCoords: ['tasks.show'],
 * });
 * // ctx.entries[0].repoRelativePath  === 'packages/cleo/src/dispatch/domains/tasks.ts'
 * // ctx.entries[1].repoRelativePath  === 'packages/core/src/tasks/show.ts'
 * // ctx.totalBytes                   <= DEFAULT_TOTAL_BUDGET
 * ```
 */
export function loadFileContext(opts: LoadFileContextOptions): LoadedFileContext {
  const perFileBudget = opts.perFileBudget ?? DEFAULT_PER_FILE_BUDGET;
  const totalBudget = opts.totalBudget ?? DEFAULT_TOTAL_BUDGET;

  // Resolve the unique set of source files for all op-coords.
  const { handlerFiles, coreFiles } = collectOpSourceFiles(opts.opCoords);
  // Handler files first (they contain the dispatch glue the model needs to locate
  // where to apply the fix); core modules follow (they contain the business logic).
  const allRelPaths = [...handlerFiles, ...coreFiles];

  const entries: FileContextEntry[] = [];
  let totalBytes = 0;
  let truncatedCount = 0;
  let budgetSkippedCount = 0;
  let errorCount = 0;

  for (const relPath of allRelPaths) {
    const absPath = join(opts.projectRoot, relPath);

    // Total budget exhausted — list the file but do not load it.
    if (totalBytes >= totalBudget) {
      entries.push({
        repoRelativePath: relPath,
        content: null,
        truncated: false,
        budgetExhausted: true,
        readError: false,
      });
      budgetSkippedCount++;
      continue;
    }

    // Read the file, gracefully handling any IO error.
    let raw: string;
    try {
      raw = readFileSync(absPath, 'utf8');
    } catch {
      entries.push({
        repoRelativePath: relPath,
        content: null,
        truncated: false,
        budgetExhausted: false,
        readError: true,
      });
      errorCount++;
      continue;
    }

    // Apply per-file budget.
    const { text, truncated } = truncateToByteLimit(raw, perFileBudget);
    const textBytes = Buffer.byteLength(text, 'utf8');

    // If adding this file would bust the total budget, use a shorter slice that
    // fits, then mark the file as budget-exhausted.
    const remaining = totalBudget - totalBytes;
    if (textBytes > remaining) {
      const { text: fitted, truncated: fTrunc } = truncateToByteLimit(raw, remaining);
      const fittedBytes = Buffer.byteLength(fitted, 'utf8');
      entries.push({
        repoRelativePath: relPath,
        content: fittedBytes > 0 ? fitted : null,
        truncated: fTrunc || truncated,
        budgetExhausted: true,
        readError: false,
      });
      totalBytes += fittedBytes;
      truncatedCount += fTrunc || truncated ? 1 : 0;
      budgetSkippedCount++;
      continue;
    }

    entries.push({
      repoRelativePath: relPath,
      content: text,
      truncated,
      budgetExhausted: false,
      readError: false,
    });
    totalBytes += textBytes;
    if (truncated) truncatedCount++;
  }

  return { entries, totalBytes, truncatedCount, budgetSkippedCount, errorCount };
}

/**
 * Render a {@link LoadedFileContext} as the file-context section of a fix-gen
 * prompt.
 *
 * Produces a human-readable block listing each file with its content (or a stub
 * explaining why the content was omitted). Suitable for direct embedding in the
 * LLM user-turn after the regression description.
 *
 * @param ctx - The loaded file context.
 * @returns A string ready for embedding in the prompt (empty string when no files).
 *
 * @example
 * ```ts
 * const section = renderFileContextSection(ctx);
 * // --- packages/core/src/tasks/show.ts ---
 * // <content or stub>
 * ```
 */
export function renderFileContextSection(ctx: LoadedFileContext): string {
  if (ctx.entries.length === 0) return '';

  const lines: string[] = ['Relevant source files (bounded — apply the diff against these):'];
  for (const entry of ctx.entries) {
    lines.push('');
    lines.push(`--- ${entry.repoRelativePath} ---`);
    if (entry.readError) {
      lines.push('<file not readable — patch by path only>');
    } else if (entry.budgetExhausted && entry.content === null) {
      lines.push('<file listed but not loaded — context budget exhausted>');
    } else if (entry.content !== null) {
      lines.push(entry.content);
    }
  }
  return lines.join('\n');
}
