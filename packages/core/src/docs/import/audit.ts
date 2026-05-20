/**
 * audit — manifest writer for `cleo docs import`.
 *
 * Every import run emits a structured manifest describing what would have
 * happened (`--dry-run`) or what actually did (`docs-import-<ts>.json`).
 * The manifest is the audit trail callers verify against in the
 * counter-integrity check (T9709).
 *
 * Manifest is written atomically (tmp + rename) so a crash mid-write
 * never leaves a partial file under the canonical path.
 *
 * @epic T9628 (Saga T9625)
 * @task T9713 (ST-MIG-1d)
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DocImportType } from './scanner.js';

/** Per-file outcome recorded in the audit manifest. */
export type ImportAction = 'created' | 'noop' | 'error';

/** One row in the manifest's `entries` array. */
export interface ImportManifestEntry {
  /** Path relative to the scan root. */
  readonly file: string;
  /** Slug assigned to this file (absent on dry-run + error). */
  readonly slug?: string;
  /** Classified import type. */
  readonly type: DocImportType;
  /** Action taken or proposed (dry-run). */
  readonly action: ImportAction;
  /** SHA-256 of the file content. */
  readonly sha: string;
  /** ISO-8601 timestamp the row was recorded. */
  readonly ts: string;
  /** Human-readable error message when action === 'error'. */
  readonly error?: string;
  /** DocsAccessor backend that received the write (omitted on noop / error / dry-run). */
  readonly backend?: 'manifest.db' | 'llmtxt.db';
  /** Document ID returned by DocsAccessor (omitted on noop / error / dry-run). */
  readonly docId?: string;
}

/** Counters maintained across the import run. */
export interface ImportCounters {
  /** Files discovered by the scanner. */
  scanCount: number;
  /** Files successfully imported (new blob versions). */
  importCount: number;
  /** Files skipped because the SHA was already present. */
  noopCount: number;
  /** Files that failed (read error, store error, classification error). */
  errorCount: number;
}

/** Full audit manifest written to disk. */
export interface ImportManifest {
  /** ISO-8601 timestamp the run started. */
  readonly startedAt: string;
  /** ISO-8601 timestamp the run completed. */
  readonly completedAt: string;
  /** Absolute root passed to the scanner. */
  readonly root: string;
  /** True when the run was `--dry-run`. */
  readonly dryRun: boolean;
  /** Counters at run completion. */
  readonly counters: ImportCounters;
  /** Per-file outcomes. */
  readonly entries: ImportManifestEntry[];
}

/** Options for {@link writeAuditManifest}. */
export interface WriteManifestOptions {
  /** Absolute path the manifest should be written to. */
  readonly path: string;
  /** The manifest payload to serialise. */
  readonly manifest: ImportManifest;
}

/**
 * Atomically write the manifest to `path` (tmp + rename).
 *
 * The parent directory is created if it does not yet exist. JSON is
 * pretty-printed with 2-space indent for human review of the audit log.
 *
 * @param options - Path + manifest payload.
 */
export async function writeAuditManifest(options: WriteManifestOptions): Promise<void> {
  await mkdir(dirname(options.path), { recursive: true });
  const tmp = `${options.path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(options.manifest, null, 2), 'utf-8');
  await rename(tmp, options.path);
}

/**
 * Build the canonical manifest filename: `docs-import-YYYYMMDDTHHmmss.json`.
 *
 * @param dir - Directory the manifest should land in.
 * @param now - Override the timestamp (mostly for tests).
 * @returns The absolute manifest path.
 */
export function defaultManifestPath(dir: string, now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[:-]/g, '').replace(/\..*$/, '');
  return join(dir, `docs-import-${iso}.json`);
}

/** Initial zeroed counters. */
export function createCounters(): ImportCounters {
  return { scanCount: 0, importCount: 0, noopCount: 0, errorCount: 0 };
}
