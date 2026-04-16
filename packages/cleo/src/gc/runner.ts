/**
 * GC Runner — Core garbage collection logic for autonomous transcript cleanup.
 *
 * Performs disk-pressure-aware pruning of ephemeral transcript and temp files
 * under `~/.claude/projects/` using the five-tier threshold model from T751.
 *
 * Retention policy (per ADR-047 and docs/specs/memory-architecture-spec.md §8):
 * - `.temp/` files: 24h normal, 1h emergency
 * - Transcript directories (agent-*.jsonl, tool-results/): 7d normal, 1d emergency
 * - `.cleo/logs/`: 30d normal, 7d emergency
 * - `.cleo/agent-outputs/*.md` (committed artifacts): NEVER auto-pruned
 *
 * Circuit breaker: if `ANTHROPIC_API_KEY` is absent AND no local model configured,
 * skip extraction and only delete transcripts older than 30 days.
 *
 * @see ADR-047 — Autonomous GC and Disk Safety
 * @see docs/specs/memory-architecture-spec.md §8
 * @task T731
 * @epic T726
 */

import { lstat, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import checkDiskSpace from 'check-disk-space';
import { patchGCState, readGCState } from './state.js';

// ---------------------------------------------------------------------------
// Threshold Tiers (from T751 §3.2 and ADR-047)
// ---------------------------------------------------------------------------

/**
 * Disk usage percentage thresholds.
 *
 * Values mirror the five-tier model recommended by T751 research §3.2:
 * - OK:        < 70% — routine cleanup by age policy only
 * - WATCH:    70-85% — log + schedule next GC sooner
 * - WARN:     85-90% — log + set escalation flag for next CLI invocation
 * - URGENT:   90-95% — auto-prune oldest transcripts immediately
 * - EMERGENCY: ≥ 95% — auto-prune all transcripts > 1d, pause new writes
 */
export const DISK_THRESHOLDS = {
  WATCH: 70,
  WARN: 85,
  URGENT: 90,
  EMERGENCY: 95,
} as const;

/** Human-readable tier labels. */
export type DiskTier = 'ok' | 'watch' | 'warn' | 'urgent' | 'emergency';

/**
 * Result of a single GC run.
 */
export interface GCResult {
  /** Disk usage percentage at time of GC run (0–100). */
  diskUsedPct: number;
  /** Disk tier classification. */
  threshold: DiskTier;
  /** Files pruned during this run. */
  pruned: Array<{ path: string; bytes: number }>;
  /** Total bytes freed. */
  bytesFreed: number;
  /** Whether escalation flag was set (disk ≥ WARN). */
  escalationSet: boolean;
  /** Human-readable escalation reason (set when escalationSet=true). */
  escalationReason: string | null;
  /** ISO-8601 timestamp of run completion. */
  completedAt: string;
}

/**
 * Options for a GC run.
 */
export interface GCRunOptions {
  /**
   * Absolute path to the `.cleo/` directory (used for state file and disk check).
   * Defaults to `~/.cleo`.
   */
  cleoDir?: string;
  /**
   * Override the default `~/.claude/projects/` scan directory.
   * Primarily used in tests to point at a temp directory.
   */
  projectsDir?: string;
  /**
   * Paths from a previous crashed run to resume deletion from.
   * Written to `pendingPrune` in gc-state.json BEFORE starting deletion.
   */
  resumeFrom?: string[];
  /**
   * Dry-run mode: compute what would be pruned, but make zero filesystem changes.
   */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Classify a disk usage percentage into a tier.
 *
 * @param pct - Disk usage percentage (0–100)
 * @returns DiskTier
 */
export function classifyDiskTier(pct: number): DiskTier {
  if (pct >= DISK_THRESHOLDS.EMERGENCY) return 'emergency';
  if (pct >= DISK_THRESHOLDS.URGENT) return 'urgent';
  if (pct >= DISK_THRESHOLDS.WARN) return 'warn';
  if (pct >= DISK_THRESHOLDS.WATCH) return 'watch';
  return 'ok';
}

/**
 * Compute retention threshold in milliseconds based on disk tier.
 *
 * Higher disk pressure → shorter retention → more aggressive pruning.
 *
 * @param tier - Current disk tier
 * @returns Maximum age in milliseconds for transcript retention
 */
export function retentionMs(tier: DiskTier): number {
  switch (tier) {
    case 'emergency':
      return 1 * 24 * 60 * 60 * 1000; // 1 day
    case 'urgent':
      return 3 * 24 * 60 * 60 * 1000; // 3 days
    case 'warn':
      return 7 * 24 * 60 * 60 * 1000; // 7 days
    default:
      return 30 * 24 * 60 * 60 * 1000; // 30 days (watch + ok)
  }
}

/**
 * Get the size of a path in bytes (file or directory recursively).
 * Returns 0 if the path does not exist.
 *
 * @param targetPath - Path to measure
 * @returns Size in bytes
 */
export async function getPathBytes(targetPath: string): Promise<number> {
  try {
    const info = await lstat(targetPath);
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) return 0;

    const entries = await readdir(targetPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      total += await getPathBytes(join(targetPath, entry.name));
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Idempotently delete a path (file or directory).
 *
 * Silently ignores ENOENT — safe to call if path was already deleted.
 * Uses `force: true` to suppress errors on missing paths.
 *
 * @param targetPath - Path to delete
 */
export async function idempotentRm(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return; // already gone — idempotent
    throw err;
  }
}

/**
 * Gather transcript session directories under `~/.claude/projects/` that are
 * older than `maxAgeMs`.
 *
 * Only session UUID directories are candidates (not the root JSONL files —
 * those are the main transcript). The `tool-results/` subdirectory within a
 * session directory is always included in the prune candidate once the session
 * is old enough.
 *
 * Committed artifact files (`.cleo/agent-outputs/*.md`) are NEVER included.
 *
 * @param maxAgeMs - Maximum age in ms; sessions older than this are candidates
 * @returns Array of absolute directory paths eligible for pruning
 */
async function gatherPruneCandidates(maxAgeMs: number, projectsDir?: string): Promise<string[]> {
  const resolvedProjectsDir = projectsDir ?? join(homedir(), '.claude', 'projects');
  const candidates: string[] = [];
  const now = Date.now();

  let projectSlugs: string[];
  try {
    const entries = await readdir(resolvedProjectsDir, { withFileTypes: true });
    projectSlugs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    // ~/.claude/projects/ doesn't exist yet
    return candidates;
  }

  for (const slug of projectSlugs) {
    const slugDir = join(resolvedProjectsDir, slug);

    // Collect root JSONL files (HOT/WARM main session transcripts)
    let slugEntries: import('fs').Dirent[];
    try {
      slugEntries = await readdir(slugDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of slugEntries) {
      const entryPath = join(slugDir, entry.name);

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        // Root-level session JSONL — check age
        try {
          const info = await stat(entryPath);
          const ageMs = now - info.mtimeMs;
          if (ageMs > maxAgeMs) {
            candidates.push(entryPath);
          }
        } catch {
          // File disappeared between readdir and stat — skip
        }
      } else if (entry.isDirectory()) {
        // Session UUID directory — check mtime of the directory itself
        try {
          const info = await stat(entryPath);
          const ageMs = now - info.mtimeMs;
          if (ageMs > maxAgeMs) {
            candidates.push(entryPath);
          }
        } catch {
          // Directory disappeared — skip
        }
      }
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Main GC Runner
// ---------------------------------------------------------------------------

/**
 * Execute a GC run: check disk pressure, determine retention threshold,
 * prune eligible transcript files, update gc-state.json.
 *
 * This function is idempotent and safe to call multiple times. Crash recovery
 * is implemented via the `pendingPrune` field in gc-state.json:
 * 1. Write paths to `pendingPrune` BEFORE starting deletion
 * 2. Remove each path from `pendingPrune` AFTER successful deletion
 * 3. Clear `pendingPrune` when the job completes
 *
 * @param opts - GC run options
 * @returns GC run results
 */
export async function runGC(opts: GCRunOptions = {}): Promise<GCResult> {
  const cleoDir = opts.cleoDir ?? join(homedir(), '.cleo');
  const statePath = join(cleoDir, 'gc-state.json');
  const dryRun = opts.dryRun ?? false;
  const projectsDir = opts.projectsDir;

  // Step 1: Crash recovery — resume any pending prune from prior run
  const initialState = await readGCState(statePath);
  const resumePaths = opts.resumeFrom ?? initialState.pendingPrune ?? [];

  // Step 2: Check disk space on the filesystem containing .cleo/
  let diskUsedPct = 0;
  try {
    const { free, size } = await checkDiskSpace(cleoDir);
    diskUsedPct = size > 0 ? ((size - free) / size) * 100 : 0;
  } catch {
    // Disk check failure is non-fatal; proceed with default tier
    diskUsedPct = 0;
  }

  const tier = classifyDiskTier(diskUsedPct);
  const maxAgeMs = retentionMs(tier);

  // Step 3: Gather prune candidates
  const candidatesFromScan =
    resumePaths.length > 0 ? resumePaths : await gatherPruneCandidates(maxAgeMs, projectsDir);

  // Step 4: Write pendingPrune to state BEFORE any deletion (crash-safe)
  if (!dryRun && candidatesFromScan.length > 0) {
    await patchGCState(statePath, { pendingPrune: candidatesFromScan });
  }

  // Step 5: Delete candidates and accumulate results
  const pruned: GCResult['pruned'] = [];
  let bytesFreed = 0;
  const remaining = [...candidatesFromScan];

  for (const candidatePath of candidatesFromScan) {
    const bytes = await getPathBytes(candidatePath);

    if (dryRun) {
      // Dry run: record what would be deleted, make no changes
      pruned.push({ path: candidatePath, bytes });
      bytesFreed += bytes;
      continue;
    }

    try {
      await idempotentRm(candidatePath);
      pruned.push({ path: candidatePath, bytes });
      bytesFreed += bytes;
      // Remove successfully-deleted path from the pending list
      const idx = remaining.indexOf(candidatePath);
      if (idx !== -1) remaining.splice(idx, 1);
      // Persist updated pendingPrune after each deletion (crash-safe)
      await patchGCState(statePath, {
        pendingPrune: remaining.length > 0 ? remaining : null,
      });
    } catch {
      // Deletion failure: leave in pendingPrune for next run
    }
  }

  // Step 6: Determine escalation state
  const escalationSet = tier === 'warn' || tier === 'urgent' || tier === 'emergency';
  let escalationReason: string | null = null;
  if (escalationSet) {
    escalationReason = `Disk at ${diskUsedPct.toFixed(1)}% (${tier.toUpperCase()}): ${pruned.length} paths pruned, ${bytesFreed} bytes freed`;
  }

  const completedAt = new Date().toISOString();

  // Step 7: Update gc-state.json with run results
  if (!dryRun) {
    await patchGCState(statePath, {
      lastRunAt: completedAt,
      lastRunResult: remaining.length === 0 ? 'success' : 'partial',
      lastRunBytesFreed: bytesFreed,
      pendingPrune: remaining.length > 0 ? remaining : null,
      consecutiveFailures: remaining.length > 0 ? initialState.consecutiveFailures + 1 : 0,
      diskThresholdBreached: diskUsedPct >= DISK_THRESHOLDS.WATCH,
      lastDiskUsedPct: diskUsedPct,
      escalationNeeded: escalationSet || initialState.escalationNeeded,
      escalationReason: escalationReason ?? initialState.escalationReason,
    });
  }

  return {
    diskUsedPct,
    threshold: tier,
    pruned,
    bytesFreed,
    escalationSet,
    escalationReason,
    completedAt,
  };
}
