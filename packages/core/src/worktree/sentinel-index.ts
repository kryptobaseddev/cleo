/**
 * In-project sentinel index for worktrees not created via `cleo orchestrate spawn`
 * (T9804 — Claude Code Agent isolation:worktree bridge).
 *
 * The sentinel index lives at `<repo>/.cleo/worktrees.json` (council D009 hybrid
 * pattern). It tracks worktrees whose canonical path is outside the XDG layout
 * (i.e. not under `~/.local/share/cleo/worktrees/<projectHash>/`) — primarily:
 *
 *  - Claude Code Agent `isolation:worktree` worktrees (`.claude/worktrees/<id>/`)
 *  - Manually-created worktrees (`git worktree add` without CLEO CLI)
 *
 * The index is a flat JSON array of {@link SentinelWorktreeEntry} objects.
 * All mutations are atomic: read → mutate → writeFileSync. Concurrent writes
 * by parallel agents are unlikely enough that optimistic-lock semantics are
 * sufficient (the index is advisory — integrity does not depend on it).
 *
 * NOTE: This is a LOCAL, scoped-per-project implementation shipped with T9804
 * because T9802 (paths SSoT) is not yet merged. Once T9802 ships and exports
 * `resolveWorktreeIndexPath`, import that helper instead of the local
 * `resolveIndexPath` function here.
 *
 * @task T9804
 * @epic T9804
 * @saga T9800
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeSource } from '@cleocode/contracts';
import { getLogger } from '../logger.js';

const log = getLogger('worktree:sentinel-index');

/** Relative path within the project root for the sentinel index. */
export const WORKTREE_SENTINEL_INDEX_PATH = '.cleo/worktrees.json';

/**
 * Source classifier for a sentinel index entry.
 *
 * Aliased to {@link WorktreeSource} from `@cleocode/contracts` for type
 * consistency across the worktree subsystem. The `cleo-spawn` value is
 * excluded here because sentinel-index entries only ever represent worktrees
 * that were NOT created via `cleo orchestrate spawn`.
 *
 * NOTE: This type is a re-export alias for `WorktreeSource`. The name
 * `SentinelWorktreeSource` is retained for backward compatibility in
 * internal.ts exports.
 */
export type SentinelWorktreeSource = WorktreeSource;

/**
 * One entry in the `.cleo/worktrees.json` sentinel index.
 *
 * Each entry represents a worktree that is tracked by CLEO but was NOT created
 * via `cleo orchestrate spawn` / `cleo worktree create`. The sentinel index
 * bridges these external worktrees into the canonical SSoT so they surface in
 * `cleo worktree list` and inherit lifecycle hooks.
 *
 * @task T9804
 */
export interface SentinelWorktreeEntry {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch checked out in this worktree (e.g. `feat/T9804-...`). */
  branch: string;
  /**
   * Task ID associated with this worktree, when determinable.
   *
   * For Claude Code Agent worktrees this is extracted from the agent session
   * context; for `manual` entries it is null unless the caller supplies it.
   */
  taskId: string | null;
  /** Source that produced this worktree — see {@link SentinelWorktreeSource}. */
  source: SentinelWorktreeSource;
  /** ISO-8601 timestamp when this entry was added to the sentinel index. */
  adoptedAt: string;
  /** Agent or operator that registered this entry (env `CLEO_AGENT_ID` ?? `'cleo'`). */
  adoptedBy: string;
}

/**
 * Read the sentinel index from `<projectRoot>/.cleo/worktrees.json`.
 *
 * Returns an empty array when the file does not exist or contains malformed
 * JSON — callers must treat a missing index as an empty one.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param indexPathOverride - Optional override path (testing).
 * @returns Array of {@link SentinelWorktreeEntry} entries.
 */
export function readSentinelIndex(
  projectRoot: string,
  indexPathOverride?: string,
): SentinelWorktreeEntry[] {
  const filePath = indexPathOverride ?? join(projectRoot, WORKTREE_SENTINEL_INDEX_PATH);
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSentinelEntry);
  } catch {
    // File not found or malformed JSON — treat as empty.
    return [];
  }
}

/**
 * Write the sentinel index to `<projectRoot>/.cleo/worktrees.json`.
 *
 * The write is not atomic across processes (no lock file). For CLEO's usage
 * pattern (low-frequency, sequential adopt calls) this is sufficient.
 * Errors are swallowed and logged at warn level — the index is advisory.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param entries - Full replacement array of {@link SentinelWorktreeEntry} entries.
 * @param indexPathOverride - Optional override path (testing).
 */
export function writeSentinelIndex(
  projectRoot: string,
  entries: SentinelWorktreeEntry[],
  indexPathOverride?: string,
): void {
  const filePath = indexPathOverride ?? join(projectRoot, WORKTREE_SENTINEL_INDEX_PATH);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(entries, null, 2)}\n`, { encoding: 'utf-8' });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to write worktree sentinel index',
    );
  }
}

/**
 * Upsert an entry in the sentinel index.
 *
 * If an entry with the same `path` already exists it is replaced in-place.
 * Otherwise the entry is appended.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param entry - The entry to upsert.
 * @param indexPathOverride - Optional override path (testing).
 * @returns `true` if the entry was newly inserted, `false` if it replaced an existing one.
 */
export function upsertSentinelEntry(
  projectRoot: string,
  entry: SentinelWorktreeEntry,
  indexPathOverride?: string,
): boolean {
  const existing = readSentinelIndex(projectRoot, indexPathOverride);
  const idx = existing.findIndex((e) => e.path === entry.path);
  const isNew = idx === -1;
  if (isNew) {
    existing.push(entry);
  } else {
    existing[idx] = entry;
  }
  writeSentinelIndex(projectRoot, existing, indexPathOverride);
  return isNew;
}

/**
 * Resolve the absolute path for the sentinel index file.
 *
 * This is the local T9804 implementation. Replace with
 * `resolveWorktreeIndexPath` from `@cleocode/paths` once T9802 ships.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Absolute path to the sentinel index JSON file.
 */
export function resolveWorktreeIndexPath(projectRoot: string): string {
  return join(projectRoot, WORKTREE_SENTINEL_INDEX_PATH);
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

/**
 * Type guard — true iff `v` matches the shape of a {@link SentinelWorktreeEntry}.
 *
 * @internal
 */
function isSentinelEntry(v: unknown): v is SentinelWorktreeEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['path'] === 'string' &&
    typeof o['branch'] === 'string' &&
    (o['taskId'] === null || typeof o['taskId'] === 'string') &&
    typeof o['source'] === 'string' &&
    typeof o['adoptedAt'] === 'string' &&
    typeof o['adoptedBy'] === 'string'
  );
}
