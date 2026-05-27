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
 * .cleo/rcasd/        → research   (T9791 — added so rcasd dirs classify
 *                                   when the scan root is the project root)
 * docs/specs/         → spec
 * docs/               → spec (catch-all)
 * *                   → note (default)
 * ```
 *
 * NOTE: This function expects {@link relPath} to start with the source-dir
 * prefix (e.g. `.cleo/adrs/`). When the scanner is invoked with a scan root
 * INSIDE one of these source dirs (e.g. `scanRoot = .cleo/adrs/`), every
 * file's relPath will be missing that prefix and default to `note`. Callers
 * SHOULD pass a {@link makeClassifierForScanRoot} closure to recover the
 * correct classification in that scenario.
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
  if (path.startsWith('.cleo/rcasd/')) return 'research';
  if (path.startsWith('docs/specs/')) return 'spec';
  if (path.startsWith('docs/')) return 'spec';
  return 'note';
}

/**
 * Map a canonical source-dir name to its {@link DocImportType}.
 *
 * Source-dir aware classification: when `cleo docs import .cleo/adrs` is run,
 * the scanner sees relPaths like `ADR-001.md` (no `.cleo/adrs/` prefix) so
 * {@link classifyByRelPath} would fall through to `note`. This map records
 * the canonical mapping by source-dir name so the CLI can pre-resolve the
 * classification before scanning.
 *
 * Keys are project-relative POSIX paths without trailing slash.
 *
 * @task T9791
 */
export const SOURCE_DIR_TO_TYPE: ReadonlyMap<string, DocImportType> = new Map([
  ['.cleo/adrs', 'adr'],
  ['.cleo/research', 'research'],
  ['.cleo/rcasd', 'research'],
  ['.cleo/agent-outputs', 'note'],
  ['docs/specs', 'spec'],
  ['docs', 'spec'],
]);

/**
 * Detect the source-dir for an absolute or project-relative scan root and
 * build a classifier closure that returns the matching {@link DocImportType}
 * for every file it sees.
 *
 * When the scan root does not match any canonical source-dir the returned
 * closure falls back to {@link classifyByRelPath} so callers retain the
 * pre-T9791 behaviour.
 *
 * @param scanRoot   - Absolute (or project-relative) path passed to the scanner.
 * @param projectRoot - Absolute project root for resolving the project-relative
 *                      form of {@link scanRoot}.
 * @returns A classifier that resolves the type for any scanned file under
 *          {@link scanRoot}.
 *
 * @task T9791
 */
export function makeClassifierForScanRoot(
  scanRoot: string,
  projectRoot: string,
): (relPath: string) => DocImportType {
  const normalize = (p: string): string => p.split('\\').join('/').replace(/\/+$/, '');
  const scan = normalize(scanRoot);
  const project = normalize(projectRoot);

  // Resolve a canonical project-relative source-dir suffix from scanRoot.
  let candidate: string | null = null;
  if (scan.startsWith(project)) {
    candidate = scan.slice(project.length).replace(/^\/+/, '');
  } else if (!scan.includes('/') || !scan.startsWith('/')) {
    // Already project-relative (e.g. ".cleo/adrs").
    candidate = scan.replace(/^\.\//, '');
  }

  if (candidate && SOURCE_DIR_TO_TYPE.has(candidate)) {
    const t = SOURCE_DIR_TO_TYPE.get(candidate);
    if (t !== undefined) {
      return () => t;
    }
  }

  // Special-case docs/ — anything under it that is not docs/specs is still spec.
  if (candidate === 'docs') {
    return () => 'spec';
  }

  return classifyByRelPath;
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
