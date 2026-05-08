/**
 * migrate-agent-outputs — ingest .cleo/agent-outputs/*.md into DocsAccessor.
 *
 * Migrates raw markdown agent-output files from the filesystem into the
 * DocsAccessor blob store (manifest.db via CleoBlobStore). Originals are
 * preserved at .cleo/agent-outputs/_archived/ as a rollback safety net
 * for one release.
 *
 * Migration model:
 *   - Each .md file in .cleo/agent-outputs/ (excluding _archived/) is read
 *     and stored via DocsAccessor.storeDoc(kind:'agent-output').
 *   - The original file is copied (NOT deleted) to .cleo/agent-outputs/_archived/
 *     preserving the full path structure.
 *   - A manifest JSON at .cleo/agent-outputs/_archived/migration-manifest.json
 *     records: source path, blob hash, migrated-at timestamp.
 *   - Files that are already in .cleo/agent-outputs/_archived/ are skipped.
 *
 * Usage:
 *   import { migrateAgentOutputs } from '@cleocode/core/internal';
 *   const result = await migrateAgentOutputs({ projectRoot: '/path/to/project' });
 *
 * @task T9064
 * @see packages/core/src/store/docs-accessor-impl.ts (DocsAccessorImpl)
 * @see packages/contracts/src/docs-accessor.ts (DocsAccessor interface)
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { DocsAccessor } from '@cleocode/contracts';
import { createDocsAccessor } from '../store/docs-accessor-impl.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result from a single file migration attempt. */
export interface MigratedFile {
  /** Original file path relative to agent-outputs directory. */
  sourcePath: string;
  /** Blob hash assigned by DocsAccessor (content-addressed). */
  blobHash: string;
  /** Whether this file was freshly migrated (vs already archived). */
  wasMigrated: boolean;
}

/** A file that failed to migrate. */
export interface FailedFile {
  /** Source file path. */
  sourcePath: string;
  /** Error message. */
  error: string;
}

/** Result from migrateAgentOutputs(). */
export interface AgentOutputMigrationResult {
  /** Files successfully migrated in this run. */
  migrated: MigratedFile[];
  /** Files already archived from a previous run (skipped). */
  skipped: string[];
  /** Files that failed to migrate. */
  failed: FailedFile[];
  /** Total files scanned. */
  totalScanned: number;
  /** Path to the migration manifest JSON. */
  manifestPath: string;
}

/** Entry in the migration manifest. */
export interface MigrationManifestEntry {
  /** Source path relative to agent-outputs/. */
  sourcePath: string;
  /** Content-addressed blob hash in manifest.db. */
  blobHash: string;
  /** ISO-8601 timestamp of migration. */
  migratedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Subdirectory where originals are archived. */
const ARCHIVED_DIR = '_archived';
/** Manifest file recording all migration entries. */
const MANIFEST_FILENAME = 'migration-manifest.json';

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Options for migrateAgentOutputs().
 */
export interface MigrateAgentOutputsOptions {
  /**
   * Absolute path to the CLEO project root (containing .cleo/).
   */
  projectRoot: string;
  /**
   * If true, do not actually write to DocsAccessor or copy files.
   * Print a dry-run report instead. Default: false.
   */
  dryRun?: boolean;
  /**
   * Injected DocsAccessor (for testing). If not provided, one is created.
   */
  accessor?: DocsAccessor;
}

/**
 * Migrate all .cleo/agent-outputs/*.md files into the DocsAccessor blob store.
 *
 * Originals are preserved at .cleo/agent-outputs/_archived/ as a rollback
 * safety net. A migration manifest is written at _archived/migration-manifest.json.
 *
 * @param options - Migration options.
 * @returns Summary of migration results.
 */
export async function migrateAgentOutputs(
  options: MigrateAgentOutputsOptions,
): Promise<AgentOutputMigrationResult> {
  const { projectRoot, dryRun = false } = options;
  const agentOutputsDir = join(projectRoot, '.cleo', 'agent-outputs');
  const archivedDir = join(agentOutputsDir, ARCHIVED_DIR);
  const manifestPath = join(archivedDir, MANIFEST_FILENAME);

  const accessor = options.accessor ?? createDocsAccessor(projectRoot);
  const ownedAccessor = !options.accessor;

  try {
    // Collect existing migration manifest (to detect already-migrated files)
    let existingManifest: MigrationManifestEntry[] = [];
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      existingManifest = JSON.parse(raw) as MigrationManifestEntry[];
    } catch {
      // No existing manifest — first run
    }
    const alreadyMigrated = new Set(existingManifest.map((e) => e.sourcePath));

    // Scan agent-outputs for markdown files
    let files: string[];
    try {
      const entries = await readdir(agentOutputsDir, { recursive: true });
      files = entries
        .filter((f) => typeof f === 'string' && f.endsWith('.md'))
        .filter((f) => !f.startsWith(ARCHIVED_DIR + '/') && f !== ARCHIVED_DIR)
        .map((f) => f as string);
    } catch {
      // Directory doesn't exist or is empty
      files = [];
    }

    const migrated: MigratedFile[] = [];
    const skipped: string[] = [];
    const failed: FailedFile[] = [];
    const newManifestEntries: MigrationManifestEntry[] = [...existingManifest];

    for (const relPath of files) {
      const sourcePath = relPath;
      const absPath = join(agentOutputsDir, relPath);
      const archivePath = join(archivedDir, relPath);
      const archiveDir = join(
        archivedDir,
        relPath.includes('/') ? relPath.split('/').slice(0, -1).join('/') : '',
      );

      // Skip already-migrated files
      if (alreadyMigrated.has(sourcePath)) {
        skipped.push(sourcePath);
        continue;
      }

      if (dryRun) {
        migrated.push({ sourcePath, blobHash: '<dry-run>', wasMigrated: true });
        continue;
      }

      try {
        // Read the source file
        const content = await readFile(absPath, 'utf-8');
        const title = basename(relPath, '.md');

        // Store in DocsAccessor
        const result = await accessor.storeDoc({
          kind: 'agent-output',
          content,
          title,
          meta: { sourcePath: relative(projectRoot, absPath) },
        });

        // Archive the original
        await mkdir(archiveDir, { recursive: true });
        await copyFile(absPath, archivePath);

        // Record in manifest
        const entry: MigrationManifestEntry = {
          sourcePath,
          blobHash: result.id,
          migratedAt: new Date().toISOString(),
        };
        newManifestEntries.push(entry);
        migrated.push({ sourcePath, blobHash: result.id, wasMigrated: true });
      } catch (err) {
        failed.push({
          sourcePath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Write updated manifest
    if (!dryRun && migrated.length > 0) {
      await mkdir(archivedDir, { recursive: true });
      await writeFile(manifestPath, JSON.stringify(newManifestEntries, null, 2), 'utf-8');
    }

    return {
      migrated,
      skipped,
      failed,
      totalScanned: files.length,
      manifestPath,
    };
  } finally {
    if (ownedAccessor) {
      await accessor.close();
    }
  }
}
