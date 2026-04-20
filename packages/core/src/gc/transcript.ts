/**
 * Transcript Scanner — Inventory and age-classification of Claude session transcripts.
 *
 * Implements the hot/warm/cold three-tier model from memory-architecture-spec.md §6:
 * - HOT  (0–24h):  Full JSONL retained; agents can re-read
 * - WARM (1–7d):   Pending extraction; scheduled at session end
 * - COLD (>7d):    brain.db entries only; raw JSONL deleted (tombstone in brain_obs)
 *
 * Storage layout scanned (§6.2):
 * ```
 * ~/.claude/projects/
 *   <project-slug>/
 *     <session-uuid>.jsonl              ← root-level main session transcript
 *     <session-uuid>/                   ← session UUID directory
 *       subagents/
 *         agent-<agentId>.jsonl         ← subagent transcript
 *         agent-<agentId>.meta.json
 *       tool-results/
 *         <toolUseId>.json
 * ```
 *
 * @see docs/specs/memory-architecture-spec.md §6.1–6.2
 * @task T728
 * @epic T726
 */

import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPathBytes, idempotentRm } from './runner.js';

// ---------------------------------------------------------------------------
// Tier boundaries (in milliseconds)
// ---------------------------------------------------------------------------

/** HOT tier: sessions less than 24 hours old. */
const HOT_MAX_MS = 24 * 60 * 60 * 1000;

/** WARM tier: sessions 24h–7d old. */
const WARM_MAX_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Hot/warm/cold lifecycle tier for a transcript session. */
export type TranscriptTier = 'hot' | 'warm' | 'cold';

/**
 * Metadata for a single session transcript discovered on disk.
 */
export interface SessionInfo {
  /** Absolute path to the root session JSONL file. */
  jsonlPath: string;
  /** Project slug (directory name under `~/.claude/projects/`). */
  projectSlug: string;
  /** Session UUID extracted from the JSONL filename. */
  sessionId: string;
  /** Last modified time of the JSONL file (ms since epoch). */
  mtimeMs: number;
  /** Age of the session in milliseconds. */
  ageMs: number;
  /** Lifecycle tier. */
  tier: TranscriptTier;
  /** Size in bytes of the root JSONL file. */
  bytes: number;
  /**
   * Absolute path to the session UUID directory (if it exists).
   * Contains `subagents/` and `tool-results/` subdirs.
   */
  sessionDir: string | null;
  /** Size in bytes of the session UUID directory (including subagents). */
  sessionDirBytes: number;
}

/**
 * Aggregate scan result: session inventory with tier-based grouping.
 */
export interface TranscriptScanResult {
  /** Total number of sessions found. */
  totalSessions: number;
  /** HOT tier sessions (< 24h). */
  hot: SessionInfo[];
  /** WARM tier sessions (24h–7d). */
  warm: SessionInfo[];
  /** Total size of all discovered transcripts in bytes. */
  totalBytes: number;
  /** Absolute path to `~/.claude/projects/`. */
  projectsDir: string;
}

/**
 * Result of a transcript prune operation.
 */
export interface TranscriptPruneResult {
  /** Number of sessions pruned. */
  pruned: number;
  /** Bytes freed. */
  bytesFreed: number;
  /** Paths that were deleted (or would be deleted in dry-run). */
  deletedPaths: string[];
  /** Whether this was a dry-run (no filesystem mutations). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a session age into a transcript tier.
 *
 * @param ageMs - Session age in milliseconds
 * @returns Lifecycle tier
 */
export function classifyTranscriptTier(ageMs: number): TranscriptTier {
  if (ageMs < HOT_MAX_MS) return 'hot';
  if (ageMs < WARM_MAX_MS) return 'warm';
  return 'cold';
}

/**
 * Parse a session UUID from a JSONL filename.
 *
 * Expected format: `<uuid>.jsonl` where uuid matches the standard
 * UUID v4 pattern (8-4-4-4-12 hex digits).
 *
 * @param filename - JSONL filename (basename only)
 * @returns Session UUID string, or the filename stem if not UUID format
 */
function parseSessionId(filename: string): string {
  return filename.replace(/\.jsonl$/, '');
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Scan `~/.claude/projects/` and return a structured inventory of all
 * session transcripts, classified by hot/warm/cold tier.
 *
 * Does not modify any files. Safe to call at any time.
 *
 * @param projectsDir - Override the default `~/.claude/projects/` path (for testing)
 * @returns Transcript scan result with tier-classified session list
 */
export async function scanTranscripts(projectsDir?: string): Promise<TranscriptScanResult> {
  const resolvedProjectsDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  const now = Date.now();

  const hot: SessionInfo[] = [];
  const warm: SessionInfo[] = [];
  let totalBytes = 0;

  // List project slugs
  let slugs: string[];
  try {
    const entries = await readdir(resolvedProjectsDir, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // Directory doesn't exist yet — return empty result
    return { totalSessions: 0, hot, warm, totalBytes, projectsDir: resolvedProjectsDir };
  }

  for (const slug of slugs) {
    const slugDir = join(resolvedProjectsDir, slug);

    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const jsonlPath = join(slugDir, entry.name);
      const sessionId = parseSessionId(entry.name);

      let fileInfo: import('fs').Stats;
      try {
        fileInfo = await stat(jsonlPath);
      } catch {
        continue; // File disappeared between readdir and stat
      }

      const mtimeMs = fileInfo.mtimeMs;
      const ageMs = now - mtimeMs;
      const tier = classifyTranscriptTier(ageMs);
      const bytes = fileInfo.size;

      // Check for associated session UUID directory
      const candidateSessionDir = join(slugDir, sessionId);
      let sessionDir: string | null = null;
      let sessionDirBytes = 0;
      try {
        const dirInfo = await lstat(candidateSessionDir);
        if (dirInfo.isDirectory()) {
          sessionDir = candidateSessionDir;
          sessionDirBytes = await getPathBytes(candidateSessionDir);
        }
      } catch {
        // Session dir doesn't exist — single-file session
      }

      const info: SessionInfo = {
        jsonlPath,
        projectSlug: slug,
        sessionId,
        mtimeMs,
        ageMs,
        tier,
        bytes,
        sessionDir,
        sessionDirBytes,
      };

      totalBytes += bytes + sessionDirBytes;

      if (tier === 'hot') {
        hot.push(info);
      } else if (tier === 'warm') {
        warm.push(info);
      }
      // COLD sessions have already had their JSONL deleted (tombstone only in brain.db)
      // so they won't appear in the filesystem scan
    }
  }

  const totalSessions = hot.length + warm.length;
  return { totalSessions, hot, warm, totalBytes, projectsDir: resolvedProjectsDir };
}

/**
 * Prune session transcripts older than `olderThanMs` milliseconds.
 *
 * Dry-run by default: pass `confirm: true` to perform actual deletion.
 *
 * Circuit breakers (from memory-architecture-spec.md §6.4):
 * - If `ANTHROPIC_API_KEY` is absent, only delete sessions older than 30d
 *   (raw preservation fallback — skip extraction).
 *
 * @param opts - Prune options
 * @param opts.olderThanMs - Delete sessions older than this many milliseconds
 * @param opts.confirm - If true, perform actual deletion; dry-run if false
 * @param opts.projectsDir - Override `~/.claude/projects/` (for testing)
 * @returns Prune result with count, bytes freed, and deleted paths
 */
export async function pruneTranscripts(opts: {
  olderThanMs: number;
  confirm: boolean;
  projectsDir?: string;
}): Promise<TranscriptPruneResult> {
  const { olderThanMs, confirm, projectsDir } = opts;
  const dryRun = !confirm;

  // Circuit breaker: no API key → be conservative (only prune >30d)
  const hasApiKey = Boolean(process.env['ANTHROPIC_API_KEY']);
  const effectiveMaxAgeMs = hasApiKey
    ? olderThanMs
    : Math.max(olderThanMs, 30 * 24 * 60 * 60 * 1000);

  const now = Date.now();
  const deletedPaths: string[] = [];
  let bytesFreed = 0;
  let pruned = 0;

  const resolvedProjectsDir = projectsDir ?? join(homedir(), '.claude', 'projects');

  let slugs: string[];
  try {
    const entries = await readdir(resolvedProjectsDir, { withFileTypes: true });
    slugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { pruned: 0, bytesFreed: 0, deletedPaths: [], dryRun };
  }

  for (const slug of slugs) {
    const slugDir = join(resolvedProjectsDir, slug);

    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;

      const jsonlPath = join(slugDir, entry.name);

      let fileInfo: import('fs').Stats;
      try {
        fileInfo = await stat(jsonlPath);
      } catch {
        continue;
      }

      const ageMs = now - fileInfo.mtimeMs;
      if (ageMs <= effectiveMaxAgeMs) continue;

      const sessionId = parseSessionId(entry.name);
      const sessionDir = join(slugDir, sessionId);

      // Measure bytes before deletion
      const jsonlBytes = fileInfo.size;
      let sessionDirBytes = 0;
      try {
        const dirInfo = await lstat(sessionDir);
        if (dirInfo.isDirectory()) {
          sessionDirBytes = await getPathBytes(sessionDir);
        }
      } catch {
        // No session dir
      }

      if (dryRun) {
        deletedPaths.push(jsonlPath);
        if (sessionDirBytes > 0) deletedPaths.push(sessionDir);
        bytesFreed += jsonlBytes + sessionDirBytes;
        pruned++;
        continue;
      }

      // Actual deletion
      try {
        await idempotentRm(jsonlPath);
        deletedPaths.push(jsonlPath);
        bytesFreed += jsonlBytes;
        pruned++;
      } catch {
        // Deletion failure: skip this file
        continue;
      }

      // Delete associated session directory if it exists
      try {
        const dirInfo = await lstat(sessionDir);
        if (dirInfo.isDirectory()) {
          await idempotentRm(sessionDir);
          deletedPaths.push(sessionDir);
          bytesFreed += sessionDirBytes;
        }
      } catch {
        // No session dir or already deleted
      }
    }
  }

  return { pruned, bytesFreed, deletedPaths, dryRun };
}

/**
 * Parse a human-readable duration string into milliseconds.
 *
 * Supported formats: `7d`, `24h`, `30m`, `1d`, `14d`, `168h`, etc.
 * Used by `cleo transcript prune --older-than <duration>`.
 *
 * @param duration - Duration string (e.g. `"7d"`, `"24h"`, `"30m"`)
 * @returns Duration in milliseconds
 * @throws Error if the format is not recognized
 */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+(\.\d+)?)(d|h|m|s)$/.exec(duration.trim());
  if (!match?.[1] || !match[3]) {
    throw new Error(`Invalid duration format: "${duration}". Use format like 7d, 24h, 30m, 60s.`);
  }
  const value = parseFloat(match[1]);
  const unit = match[3];
  const multipliers: Record<string, number> = {
    d: 24 * 60 * 60 * 1000,
    h: 60 * 60 * 1000,
    m: 60 * 1000,
    s: 1000,
  };
  return value * (multipliers[unit] ?? 1000);
}
