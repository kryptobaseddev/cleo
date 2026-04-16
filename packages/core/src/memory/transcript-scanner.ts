/**
 * Transcript scanner — locates Claude session JSONL files and lists
 * sessions pending extraction.
 *
 * Claude stores session files at:
 *   `~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl`
 *
 * The encoded path is the project absolute path with `/` → `-`.
 *
 * Functions:
 *   - `findSessionTranscriptPath` — locate a specific session's JSONL
 *   - `scanPendingTranscripts`    — list sessions queued for extraction
 *   - `listAllTranscripts`        — enumerate all root-level session JSONLs
 *
 * @task T732
 * @epic T726
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A located Claude session JSONL file. */
export interface TranscriptEntry {
  /** Absolute path to the JSONL file. */
  path: string;
  /** Session UUID (filename without `.jsonl`). */
  sessionId: string;
  /** Encoded project directory name (e.g. `-mnt-projects-cleocode`). */
  projectDir: string;
  /** Size of the file in bytes. */
  sizeBytes: number;
  /** Last-modified time as ISO string. */
  modifiedAt: string;
}

/** A pending extraction record read from brain_observations. */
export interface PendingExtractionRecord {
  /** CLEO session ID. */
  sessionId: string;
  /** Recorded file path (may no longer exist if already processed). */
  filePath: string;
  /** When the record was created. */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Locate the JSONL file for a specific Claude session ID.
 *
 * Searches across all project directories under `~/.claude/projects/` for a
 * file named `<sessionId>.jsonl`. Returns the absolute path or `null` if not
 * found.
 *
 * This is a best-effort search — if the session is a subagent transcript in a
 * subdirectory, it is excluded (we only process root-level sessions).
 *
 * @param sessionId - The session UUID (e.g. `77edaed6-13e5-4af1-9311-ea94eae114f9`)
 * @returns Absolute path to the JSONL, or null.
 */
export async function findSessionTranscriptPath(sessionId: string): Promise<string | null> {
  const claudeProjectsRoot = join(homedir(), '.claude', 'projects');

  try {
    const projectDirs = await readdir(claudeProjectsRoot, { withFileTypes: true });
    for (const entry of projectDirs) {
      if (!entry.isDirectory()) continue;
      const candidate = join(claudeProjectsRoot, entry.name, `${sessionId}.jsonl`);
      try {
        await stat(candidate);
        return candidate; // found
      } catch {
        // not in this project dir
      }
    }
  } catch {
    // ~/.claude/projects doesn't exist or is inaccessible
  }

  return null;
}

/**
 * Read pending extraction records from brain_observations.
 *
 * Returns sessions that have been queued (tombstone `transcript_pending_extraction:*`)
 * but not yet fully processed (no `transcript-extracted:*` tombstone).
 *
 * @param projectRoot - CLEO project root for brain.db access.
 * @returns Array of pending records.
 */
export async function scanPendingTranscripts(
  projectRoot: string,
): Promise<PendingExtractionRecord[]> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/brain-sqlite.js');
    await getBrainDb(projectRoot);
    const db = getBrainNativeDb();
    if (!db) return [];

    // Find all pending records that don't yet have a corresponding extracted tombstone
    const rows = db
      .prepare(
        `SELECT
           source_session_id AS sessionId,
           text,
           created_at AS createdAt
         FROM brain_observations
         WHERE title LIKE 'transcript_pending_extraction:%'
           AND source_session_id NOT IN (
             SELECT source_session_id
             FROM brain_observations
             WHERE title LIKE 'transcript-extracted:%'
           )
         ORDER BY created_at DESC`,
      )
      .all() as Array<{
      sessionId: string;
      text: string;
      createdAt: string;
    }>;

    return rows.map((row) => {
      // Extract file path from the observation text
      const fileMatch = /File: ([^\s]+\.jsonl)/.exec(row.text);
      return {
        sessionId: row.sessionId,
        filePath: fileMatch ? fileMatch[1] : '',
        createdAt: row.createdAt,
      };
    });
  } catch {
    return [];
  }
}

/**
 * List all root-level Claude session JSONL files across all project directories.
 *
 * This is the discovery function for the migration command (T733). Returns
 * only root-level sessions (not subagent transcripts in subdirectories) sorted
 * by last-modified time, oldest first (migration processes oldest first).
 *
 * @param options - Optional filters.
 * @returns Array of transcript entries.
 */
export async function listAllTranscripts(options?: {
  /** Only return files older than this many hours. Default: 0 (all). */
  olderThanHours?: number;
  /** Only return files from this project directory encoding (e.g. `-mnt-projects-cleocode`). */
  projectFilter?: string;
  /** Maximum number of entries to return. */
  limit?: number;
}): Promise<TranscriptEntry[]> {
  const claudeProjectsRoot = join(homedir(), '.claude', 'projects');
  const entries: TranscriptEntry[] = [];

  const cutoffMs = options?.olderThanHours ? Date.now() - options.olderThanHours * 3600 * 1000 : 0;

  try {
    const projectDirs = await readdir(claudeProjectsRoot, { withFileTypes: true });

    for (const dirEntry of projectDirs) {
      if (!dirEntry.isDirectory()) continue;
      if (options?.projectFilter && dirEntry.name !== options.projectFilter) continue;

      const projectDir = join(claudeProjectsRoot, dirEntry.name);

      try {
        const files = await readdir(projectDir, { withFileTypes: true });
        for (const fileEntry of files) {
          // Root-level JSONL only (skip subdirectories like `subagents/`)
          if (!fileEntry.isFile() || !fileEntry.name.endsWith('.jsonl')) continue;

          const filePath = join(projectDir, fileEntry.name);
          try {
            const fileStat = await stat(filePath);
            if (cutoffMs > 0 && fileStat.mtimeMs > cutoffMs) continue;

            entries.push({
              path: filePath,
              sessionId: fileEntry.name.replace(/\.jsonl$/, ''),
              projectDir: dirEntry.name,
              sizeBytes: fileStat.size,
              modifiedAt: fileStat.mtime.toISOString(),
            });
          } catch {
            // Skip files we can't stat
          }
        }
      } catch {
        // Skip project dirs we can't read
      }
    }
  } catch {
    return [];
  }

  // Sort by modified time, oldest first
  entries.sort((a, b) => new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime());

  if (options?.limit) {
    return entries.slice(0, options.limit);
  }

  return entries;
}
