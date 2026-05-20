/**
 * scanner — recursive `.md` walker for `cleo docs import`.
 *
 * Walks a directory tree from a single root, returning one entry per
 * markdown file discovered. Each entry carries the absolute path, the
 * project-relative source-dir prefix used by the type classifier, and a
 * SHA-256 of the file's content so the dedup gate can decide whether
 * the bytes are already in the docs SSoT.
 *
 * Excludes well-known transient/build directories by default
 * (`node_modules`, `.git`, `dist`, `coverage`, `build`).
 *
 * @epic T9628 (Saga T9625)
 * @task T9710 (ST-MIG-1a)
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Document import classification used by the type classifier.
 *
 * CLI-level concept distinct from {@link DocKind} — `research`, `note`,
 * and `spec` ride in `meta.importType` while the blob backend stores
 * them as `agent-output`. `adr` maps 1:1 to the existing DocKind.
 */
export type DocImportType = 'research' | 'adr' | 'note' | 'spec';

/** A single markdown file discovered during scanning. */
export interface ScannedFile {
  /** Absolute filesystem path of the markdown file. */
  readonly absPath: string;
  /** Path relative to the scan root (e.g. `.cleo/research/foo.md`). */
  readonly relPath: string;
  /** SHA-256 of the file bytes, hex encoded. */
  readonly contentSha: string;
  /** Classified import type per the source-dir rules table. */
  readonly suggestedType: DocImportType;
  /** Raw file content (UTF-8). Cached to avoid re-reading during import. */
  readonly content: string;
}

/** Options for {@link scanDirectory}. */
export interface ScanOptions {
  /** Absolute filesystem path to scan recursively. */
  readonly root: string;
  /**
   * Directory names to skip during the walk. Default:
   * `node_modules`, `.git`, `dist`, `coverage`, `build`.
   */
  readonly excludeDirs?: ReadonlySet<string>;
  /**
   * Override for the default type classifier. When provided this overrides
   * the source-dir rules table for the given `relPath`.
   */
  readonly classify?: (relPath: string) => DocImportType;
}

/**
 * Default directory names skipped by the scanner.
 */
export const DEFAULT_EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'build',
  '_archived',
]);

/**
 * Default type classifier — see ADR-073 / T9639 spec for the rules table:
 *
 * ```
 * .cleo/adrs/         → adr
 * .cleo/research/     → research
 * .cleo/agent-outputs → note
 * docs/specs/         → spec
 * docs/               → spec (catch-all)
 * *                   → note (default)
 * ```
 *
 * @param relPath - Path relative to the scan root.
 * @returns Classified import type.
 */
export function classifyByRelPath(relPath: string): DocImportType {
  // Normalise to forward slashes so Windows callers behave consistently.
  const path = relPath.split('\\').join('/');
  if (path.startsWith('.cleo/adrs/')) return 'adr';
  if (path.startsWith('.cleo/research/')) return 'research';
  if (path.startsWith('.cleo/agent-outputs/')) return 'note';
  if (path.startsWith('docs/specs/')) return 'spec';
  if (path.startsWith('docs/')) return 'spec';
  return 'note';
}

/**
 * Recursively walk `root` and return every `.md` file with its sha + type.
 *
 * Symbolic links are skipped (we only follow regular files and directories)
 * to avoid pathological cycles. Files that fail to read are silently
 * skipped — callers can detect this via the `errorCount` they maintain
 * around the scan.
 *
 * @param options - Scan options including the root directory.
 * @returns One {@link ScannedFile} per discovered `.md` file.
 */
export async function scanDirectory(options: ScanOptions): Promise<ScannedFile[]> {
  const excludeDirs = options.excludeDirs ?? DEFAULT_EXCLUDE_DIRS;
  const classify = options.classify ?? classifyByRelPath;
  const results: ScannedFile[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excludeDirs.has(entry.name)) continue;
        await walk(abs);
        continue;
      }
      // Treat symlinks-to-files conservatively: only follow regular files we can stat.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith('.md')) continue;
      if (entry.isSymbolicLink()) {
        try {
          const st = await stat(abs);
          if (!st.isFile()) continue;
        } catch {
          continue;
        }
      }

      let content: string;
      try {
        content = await readFile(abs, 'utf-8');
      } catch {
        continue;
      }
      const relPath = relative(options.root, abs).split('\\').join('/');
      const contentSha = createHash('sha256').update(content).digest('hex');
      results.push({
        absPath: abs,
        relPath,
        contentSha,
        suggestedType: classify(relPath),
        content,
      });
    }
  }

  await walk(options.root);
  // Deterministic order — useful for the counter-integrity audit.
  return results.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
