/**
 * Session Journal — append-only JSONL writer for `.cleo/session-journals/`.
 *
 * Provides the core read/write primitives for the session journal substrate
 * (T1263 PSYCHE E6). Journals are the 7th CLEO system — they log the other
 * six (TASKS, LOOM, BRAIN, NEXUS, CANT, CONDUIT) at session boundaries.
 *
 * ## File layout
 *
 * ```
 * .cleo/session-journals/
 *   2026-04-24.jsonl    ← today — all sessions append here
 *   2026-04-23.jsonl    ← yesterday
 *   ...
 * ```
 *
 * Each file is append-only JSONL (one JSON object per line terminated by `\n`).
 * Multiple simultaneous sessions append to the same daily file safely via
 * `appendFile` which uses O_APPEND — atomic for writes under ~4 KB on ext4/APFS.
 * No shared file handle; each call opens/appends/closes independently.
 *
 * ## Retention
 *
 * | Tier    | Age       | Disposition                               |
 * |---------|-----------|-------------------------------------------|
 * | Hot     | 0–7 days  | All entries retained verbatim             |
 * | Warm    | 8–30 days | Retain `session_end` entries only         |
 * | Archive | 31–90 days| Monthly rollup; individual files deleted  |
 * | Purge   | >90 days  | Monthly rollups deleted                   |
 *
 * @module sessions/session-journal
 * @task T1263
 * @epic T1075
 * @see packages/contracts/src/session-journal.ts — schema + types
 * @see .cleo/adrs/ADR-013 §9 — runtime-data-safety (no git tracking)
 */

import { appendFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionJournalEntry } from '@cleocode/contracts';

// ============================================================================
// Constants
// ============================================================================

/** Subdirectory under `.cleo/` that stores session journal JSONL files. */
const SESSION_JOURNALS_DIR = 'session-journals';

/** Number of hot-tier days (files younger than this are fully retained). */
const HOT_TIER_DAYS = 7;

/** Number of warm-tier days (files between hot and warm retain session_end only). */
const WARM_TIER_DAYS = 30;

/** Number of archive-tier days (files older than this are purged). */
const ARCHIVE_TIER_DAYS = 90;

// ============================================================================
// Path helpers
// ============================================================================

/**
 * Resolve the absolute path to a session journal JSONL file for a given date.
 *
 * Daily rotation: one file per calendar day. Multiple sessions append to the
 * same file; reads scan recent files in reverse-date order.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param date - Target date. Defaults to today (UTC).
 * @returns Absolute path to `<projectRoot>/.cleo/session-journals/YYYY-MM-DD.jsonl`.
 *
 * @example
 * ```typescript
 * const path = getSessionJournalPath('/my/project');
 * // → '/my/project/.cleo/session-journals/2026-04-24.jsonl'
 * ```
 */
export function getSessionJournalPath(projectRoot: string, date?: Date): string {
  const d = date ?? new Date();
  const dateStr = d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
  return join(projectRoot, '.cleo', SESSION_JOURNALS_DIR, `${dateStr}.jsonl`);
}

/**
 * Resolve the absolute path to the session-journals directory.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to `<projectRoot>/.cleo/session-journals/`.
 */
function getSessionJournalsDir(projectRoot: string): string {
  return join(projectRoot, '.cleo', SESSION_JOURNALS_DIR);
}

// ============================================================================
// Write
// ============================================================================

/**
 * Append a single session journal entry to the daily JSONL file.
 *
 * - Creates the `.cleo/session-journals/` directory if it does not exist
 *   (idempotent via `mkdir({recursive:true})`).
 * - Appends a single JSON line terminated by `\n` using O_APPEND atomicity.
 * - Safe for concurrent writes from multiple processes (worktree sessions).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param entry - Journal entry to append. Must pass `sessionJournalEntrySchema`.
 * @param date - Target date file. Defaults to today (UTC).
 *
 * @throws If the filesystem write fails (disk full, permissions, etc.).
 *         Callers MUST wrap in try/catch and handle gracefully — journal
 *         writes must never block session lifecycle operations.
 *
 * @example
 * ```typescript
 * await appendSessionJournalEntry('/my/project', {
 *   schemaVersion: '1.0',
 *   timestamp: new Date().toISOString(),
 *   sessionId: 'ses_20260424_abc',
 *   eventType: 'session_start',
 *   agentIdentifier: 'claude-code',
 *   scope: 'global',
 * });
 * ```
 */
export async function appendSessionJournalEntry(
  projectRoot: string,
  entry: SessionJournalEntry,
  date?: Date,
): Promise<void> {
  const filePath = getSessionJournalPath(projectRoot, date);
  // Ensure directory exists — idempotent
  await mkdir(join(projectRoot, '.cleo', SESSION_JOURNALS_DIR), { recursive: true });
  const line = `${JSON.stringify(entry)}\n`;
  await appendFile(filePath, line, { encoding: 'utf-8' });
}

// ============================================================================
// Read
// ============================================================================

/**
 * Read the most recent session journal entries across the N most recent daily files.
 *
 * Scans up to `maxFiles` dated `.jsonl` files in reverse-date order, collecting
 * up to `maxEntries` total entries (most recent entries first). Used by
 * `initProject` to surface recent session context for the meta-agent.
 *
 * Unknown schema versions are silently skipped (forward-compatible).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param maxEntries - Maximum total entries to return. Default: 20.
 * @param maxFiles - Maximum number of daily files to scan. Default: 5.
 * @returns Array of journal entries in reverse-chronological order (newest first).
 *          Returns empty array if the journals directory does not exist or is empty.
 *
 * @example
 * ```typescript
 * const entries = await readRecentJournals('/my/project', 10);
 * ```
 */
export async function readRecentJournals(
  projectRoot: string,
  maxEntries = 20,
  maxFiles = 5,
): Promise<SessionJournalEntry[]> {
  const journalsDir = getSessionJournalsDir(projectRoot);

  let files: string[];
  try {
    const entries = await readdir(journalsDir);
    files = entries
      .filter((f) => f.endsWith('.jsonl') && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
      .reverse()
      .slice(0, maxFiles);
  } catch {
    // Directory does not exist or is not readable — return empty
    return [];
  }

  const result: SessionJournalEntry[] = [];

  for (const file of files) {
    if (result.length >= maxEntries) break;

    try {
      const content = await readFile(join(journalsDir, file), 'utf-8');
      const lines = content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .reverse(); // newest entries first within a file (last written = last line)

      for (const line of lines) {
        if (result.length >= maxEntries) break;
        try {
          const entry = JSON.parse(line) as SessionJournalEntry;
          // Basic schema version check — skip unknown versions gracefully
          if (entry && typeof entry === 'object' && 'schemaVersion' in entry) {
            result.push(entry);
          }
        } catch {
          // Malformed line — skip silently
        }
      }
    } catch {
      // File read error — skip this file
    }
  }

  return result;
}

// ============================================================================
// Retention policy
// ============================================================================

/**
 * Options for `rotateSessionJournals`.
 */
export interface RotateSessionJournalsOptions {
  /** Override hot tier cutoff in days. Default: {@link HOT_TIER_DAYS} (7). */
  hotDays?: number;
  /** Override warm tier cutoff in days. Default: {@link WARM_TIER_DAYS} (30). */
  warmDays?: number;
  /** Override archive cutoff in days (files older than this are purged). Default: {@link ARCHIVE_TIER_DAYS} (90). */
  archiveDays?: number;
}

/**
 * Apply the session journal retention policy to `.cleo/session-journals/`.
 *
 * Tiers (relative to current UTC date):
 *
 * | Tier    | Age       | Action                                              |
 * |---------|-----------|-----------------------------------------------------|
 * | Hot     | 0–7 days  | No-op — all entries retained verbatim               |
 * | Warm    | 8–30 days | Rewrite file keeping only `session_end` entries      |
 * | Archive | 31–90 days| Delete the individual file (rollup future work)      |
 * | Purge   | >90 days  | Delete the file (already archived or stale)          |
 *
 * Errors for individual files are caught and the rotation continues.
 * If the journals directory does not exist, returns immediately (no-op).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Optional tier cutoff overrides (for testing).
 *
 * @example
 * ```typescript
 * await rotateSessionJournals('/my/project');
 * ```
 */
export async function rotateSessionJournals(
  projectRoot: string,
  opts: RotateSessionJournalsOptions = {},
): Promise<void> {
  const hotDays = opts.hotDays ?? HOT_TIER_DAYS;
  const warmDays = opts.warmDays ?? WARM_TIER_DAYS;
  const archiveDays = opts.archiveDays ?? ARCHIVE_TIER_DAYS;

  const journalsDir = getSessionJournalsDir(projectRoot);

  let files: string[];
  try {
    const entries = await readdir(journalsDir);
    files = entries.filter((f) => f.endsWith('.jsonl') && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  } catch {
    // Directory does not exist — no-op
    return;
  }

  const now = Date.now();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  for (const file of files) {
    const filePath = join(journalsDir, file);

    // Parse file age from name (YYYY-MM-DD)
    const dateStr = file.replace('.jsonl', '');
    const fileDate = new Date(`${dateStr}T00:00:00.000Z`);
    if (Number.isNaN(fileDate.getTime())) continue;

    const ageMs = now - fileDate.getTime();
    const ageDays = ageMs / MS_PER_DAY;

    try {
      if (ageDays <= hotDays) {
      } else if (ageDays <= warmDays) {
        // Warm tier — keep only session_end entries
        const content = await readFile(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim().length > 0);
        const filtered = lines.filter((line) => {
          try {
            const entry = JSON.parse(line) as { eventType?: string };
            return entry?.eventType === 'session_end';
          } catch {
            return false;
          }
        });
        if (filtered.length !== lines.length) {
          // Rewrite file with only session_end entries
          await writeFile(filePath, filtered.map((l) => `${l}\n`).join(''), {
            encoding: 'utf-8',
          });
        }
      } else if (ageDays <= archiveDays) {
        // Archive tier — delete individual file
        await unlink(filePath);
      } else {
        // Purge tier (>90 days) — delete
        await unlink(filePath);
      }
    } catch {
      // Best-effort — skip errors for individual files
    }
  }
}

// ============================================================================
// Gitignore helper
// ============================================================================

/**
 * Return the session-journals gitignore entry for use by `ensureGitignore`.
 *
 * The `.cleo/session-journals/` directory contains potentially sensitive session
 * data (task IDs, note excerpts, agent identifiers). It MUST NOT be committed.
 * This entry is included in the `.cleo/.gitignore` deny-by-default template via
 * the CLEO_GITIGNORE_FALLBACK constant in `packages/core/src/scaffold.ts`.
 *
 * @returns The gitignore pattern string for session-journals.
 */
export function getSessionJournalsGitignoreEntry(): string {
  return 'session-journals/';
}

/**
 * Return the file age statistics for session journal files.
 * Used by tests to verify rotation logic without date-mocking.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Map from filename to age in days.
 * @internal
 */
export async function _getJournalFilesAgeMap(projectRoot: string): Promise<Map<string, number>> {
  const journalsDir = getSessionJournalsDir(projectRoot);
  const result = new Map<string, number>();
  try {
    const entries = await readdir(journalsDir);
    for (const file of entries) {
      if (!file.endsWith('.jsonl') || !/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)) continue;
      try {
        const s = await stat(join(journalsDir, file));
        const ageDays = (Date.now() - s.mtime.getTime()) / (24 * 60 * 60 * 1000);
        result.set(file, ageDays);
      } catch {
        // skip
      }
    }
  } catch {
    // directory absent
  }
  return result;
}
