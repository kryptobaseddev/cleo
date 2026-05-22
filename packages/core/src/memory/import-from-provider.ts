/**
 * Provider-agnostic memory import — business logic extracted from `cleo memory import`.
 *
 * Reads `*.md` files from a provider memory directory, parses YAML frontmatter,
 * deduplicates by content hash, and dispatches observations into `brain.db` via
 * the CLEO dispatch layer. The CLI handler calls {@link importMemoryFiles}.
 *
 * @module memory/import-from-provider
 * @epic T9833
 * @task T10062
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for {@link importMemoryFiles}. */
export interface ImportMemoryFilesOptions {
  /**
   * Source directory containing `*.md` memory files.
   * Defaults to `~/.claude/projects/-mnt-projects-cleocode/memory`.
   */
  sourceDir?: string;
  /** When true, log what would be imported without writing to `brain.db`. */
  dryRun?: boolean;
  /** Project root used to locate the dedup state file. */
  projectRoot: string;
  /** CLEO directory name inside the project root (default: `.cleo`). */
  cleoDirName?: string;
  /** File name for the import-hash dedup state (default: `migrate-memory-hashes.json`). */
  hasheFileName?: string;
  /**
   * Dispatch function — matches the `dispatchFromCli` signature from the CLI
   * adapter. Injected here to keep the core module decoupled from CLI internals.
   */
  dispatch: (
    gateway: 'mutate' | 'query',
    domain: string,
    operation: string,
    params: Record<string, unknown>,
    output: { command: string; operation: string },
  ) => Promise<void>;
}

/** Per-entry import record. */
export interface ImportedEntry {
  file: string;
  type: string;
  title: string;
}

/** Per-entry skip record. */
export interface SkippedEntry {
  file: string;
  reason: string;
}

/** Per-entry error record. */
export interface ErrorEntry {
  file: string;
  error: string;
}

/** Summary returned by {@link importMemoryFiles}. */
export interface ImportMemoryResult {
  total: number;
  imported: number;
  skipped: number;
  errors: number;
  dryRun: boolean;
  importedEntries: ImportedEntry[];
  skippedEntries: SkippedEntry[];
  errorEntries: ErrorEntry[];
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Supports simple `key: value` pairs only (no nested YAML).
 *
 * @param raw - Raw file content
 * @returns Extracted frontmatter fields and body text
 */
export function parseMemoryFileFrontmatter(raw: string): {
  name?: string;
  description?: string;
  type?: string;
  body: string;
} {
  const lines = raw.split('\n');
  if (!lines[0]?.trim().startsWith('---')) {
    return { body: raw.trim() };
  }

  const endIdx = lines.slice(1).findIndex((l) => /^---\s*$/.test(l));
  if (endIdx === -1) {
    return { body: raw.trim() };
  }

  const fmLines = lines.slice(1, endIdx + 1);
  const body = lines
    .slice(endIdx + 2)
    .join('\n')
    .trim();

  const fm: Record<string, string> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) fm[key] = value;
  }

  return {
    name: fm['name'],
    description: fm['description'],
    type: fm['type'],
    body,
  };
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Compute a 16-char hex content fingerprint for deduplication.
 *
 * @param title - Entry title
 * @param body - Entry body text
 * @returns 16-char hex prefix of SHA-256 hash
 */
export function memoryContentHash(title: string, body: string): string {
  return createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Hash state persistence
// ---------------------------------------------------------------------------

/** Load the set of already-imported content hashes from the dedup state file. */
function loadImportHashes(stateFile: string): Set<string> {
  try {
    if (!existsSync(stateFile)) return new Set();
    const raw = readFileSync(stateFile, 'utf-8');
    const parsed = JSON.parse(raw) as { hashes: string[] };
    return new Set(parsed.hashes);
  } catch {
    return new Set();
  }
}

/** Persist the updated set of imported hashes to the dedup state file. */
function saveImportHashes(stateFile: string, hashes: Set<string>): void {
  const dir = stateFile.slice(0, stateFile.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ hashes: [...hashes] }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import `*.md` memory files from a provider directory into `brain.db`.
 *
 * Skips `MEMORY.md`, empty files, and previously imported entries (by content
 * hash). Routes `feedback` type entries to `memory.learning.store`; all other
 * types go to `memory.observe`.
 *
 * @param opts - Import options
 * @returns Summary of the import operation
 * @throws {Error} When the source directory does not exist
 */
export async function importMemoryFiles(
  opts: ImportMemoryFilesOptions,
): Promise<ImportMemoryResult> {
  const {
    dryRun = false,
    projectRoot,
    cleoDirName = '.cleo',
    hasheFileName = 'migrate-memory-hashes.json',
    dispatch,
  } = opts;

  const sourceDir =
    opts.sourceDir ?? join(homedir(), '.claude', 'projects', '-mnt-projects-cleocode', 'memory');

  if (!existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }

  const stateFile = join(projectRoot, cleoDirName, hasheFileName);
  const files = readdirSync(sourceDir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((f) => join(sourceDir, f));

  const importedHashes = dryRun ? new Set<string>() : loadImportHashes(stateFile);
  const stats = { total: files.length, imported: 0, skipped: 0, errors: 0 };
  const importedEntries: ImportedEntry[] = [];
  const skippedEntries: SkippedEntry[] = [];
  const errorEntries: ErrorEntry[] = [];

  for (const filePath of files) {
    const fileName = filePath.split('/').pop() ?? filePath;
    try {
      const raw = readFileSync(filePath, 'utf-8');
      if (!raw.trim()) {
        stats.skipped++;
        skippedEntries.push({ file: fileName, reason: 'empty file' });
        continue;
      }

      const { name, description, type, body } = parseMemoryFileFrontmatter(raw);
      const title = name ?? fileName.replace(/\.md$/, '').replace(/-/g, ' ');
      const bodyParts = [description, body].filter(Boolean);
      const fullText = bodyParts.join('\n\n').trim();

      if (!fullText) {
        stats.skipped++;
        skippedEntries.push({ file: fileName, reason: 'empty body' });
        continue;
      }

      const hash = memoryContentHash(title, fullText);

      if (!dryRun && importedHashes.has(hash)) {
        stats.skipped++;
        skippedEntries.push({ file: fileName, reason: `already imported (hash: ${hash})` });
        continue;
      }

      const entryType = type ?? 'project';

      if (!dryRun) {
        if (entryType === 'feedback') {
          await dispatch(
            'mutate',
            'memory',
            'learning.store',
            {
              insight: `[MIGRATED] ${title}: ${fullText}`,
              source: 'manual',
              confidence: 0.8,
              actionable: false,
            },
            { command: 'memory', operation: 'memory.learning.store' },
          );
        } else {
          const observeType =
            entryType === 'project'
              ? 'feature'
              : entryType === 'reference'
                ? 'discovery'
                : entryType === 'user'
                  ? 'change'
                  : 'discovery';

          await dispatch(
            'mutate',
            'memory',
            'observe',
            {
              text: `[MIGRATED] ${title}: ${fullText}`,
              title: `[MIGRATED] ${title}`,
              type: observeType,
              sourceType: 'manual',
            },
            { command: 'memory', operation: 'memory.observe' },
          );
        }
        importedHashes.add(hash);
      }

      stats.imported++;
      importedEntries.push({ file: fileName, type: entryType, title });
    } catch (err) {
      stats.errors++;
      const message = err instanceof Error ? err.message : String(err);
      errorEntries.push({ file: fileName, error: message });
    }
  }

  if (!dryRun) {
    saveImportHashes(stateFile, importedHashes);
  }

  return {
    ...stats,
    dryRun,
    importedEntries,
    skippedEntries,
    errorEntries,
  };
}
