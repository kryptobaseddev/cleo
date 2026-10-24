/**
 * Walk-free code-index health (T14021): where the index stands against the
 * base branch and HEAD, which indexed files are gone from disk, the stale
 * policy, and the read-only per-project probe `cleo doctor --all-projects`
 * runs. Kept apart from `freshness.ts` so the doctor probe does not pull the
 * analysis pipeline (and its write path) into the health check.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module nexus/index-health
 * @task T14021
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphIndexFreshness } from '@cleocode/contracts';
import { getConfigValue } from '../config/registry.js';
import type { getNexusDb } from '../store/nexus-sqlite.js';
import { readFileManifest, readIndexedRevision } from './graph-manifest.js';

/** Milliseconds per day, for {@link GraphIndexFreshness.ageDays}. */
const DAY_MS = 86_400_000;

/**
 * Where the index stands against the base branch (T14007): the indexed
 * revision, the base ref and its commit, the commits the index has not seen,
 * and its age. Measured against the base ref, never the working tree or HEAD,
 * so a checkout on an old branch cannot make a stale index look fresh.
 *
 * @param db - Project graph database.
 * @param sourceRoot - Repository the index describes.
 * @param lastIndexedAt - Assessment time of the published generation.
 * @returns The revision fields of {@link GraphIndexFreshness}.
 */
export async function measureAgainstBase(
  db: Awaited<ReturnType<typeof getNexusDb>>,
  sourceRoot: string,
  lastIndexedAt: string | null,
): Promise<
  Pick<
    GraphIndexFreshness,
    | 'indexedRevision'
    | 'baseRef'
    | 'baseRevision'
    | 'commitsBehind'
    | 'commitsBehindHead'
    | 'changedFilesSinceIndex'
    | 'ageDays'
  >
> {
  const { changedFilesSince, commitsBetween, resolveBaseRef, revParse } = await import(
    '../git/base-ref.js'
  );
  const indexedRevision = readIndexedRevision(db);
  const baseRef = resolveBaseRef(sourceRoot);
  const baseRevision = baseRef ? revParse(sourceRoot, baseRef) : null;
  const commitsBehind =
    indexedRevision && baseRevision
      ? commitsBetween(sourceRoot, indexedRevision, baseRevision)
      : null;
  // T14008: what is checked out is what a query is about; the base distance is report-only.
  const commitsBehindHead = indexedRevision
    ? commitsBetween(sourceRoot, indexedRevision, 'HEAD')
    : null;
  // T14014: a cheap, walk-free count for reporting; the walk stays authoritative.
  const changedFilesSinceIndex = indexedRevision
    ? changedFilesSince(sourceRoot, indexedRevision)
    : null;
  const indexedMs = lastIndexedAt ? Date.parse(lastIndexedAt) : Number.NaN;
  const ageDays = Number.isFinite(indexedMs)
    ? Math.max(0, Math.floor((Date.now() - indexedMs) / DAY_MS))
    : null;
  return {
    indexedRevision,
    baseRef,
    baseRevision,
    commitsBehind,
    commitsBehindHead,
    changedFilesSinceIndex,
    ageDays,
  };
}

/**
 * Indexed paths that no longer exist under `sourceRoot`, sorted (T14021). One
 * `existsSync` per path: no walk and no hashing.
 *
 * @param sourceRoot - Repository the index describes.
 * @param paths - Indexed POSIX paths relative to `sourceRoot`.
 * @returns The absent paths.
 */
export function missingIndexedPaths(sourceRoot: string, paths: Iterable<string>): string[] {
  const missing: string[] = [];
  for (const path of paths) if (!existsSync(join(sourceRoot, path))) missing.push(path);
  return missing.sort();
}

/** One project's code-index health, as `cleo doctor --all-projects` reports it (T14021). */
export interface NexusIndexHealth {
  /** A published generation with a file manifest exists. */
  indexed: boolean;
  /** When the index was built. */
  lastIndexedAt: string | null;
  /** Whole days since it was built. */
  ageDays: number | null;
  /** Revision it indexed. */
  indexedRevision: string | null;
  /** Commits on the base branch it has not seen (reported only). */
  commitsBehind: number | null;
  /** Commits on the checked-out HEAD it has not seen; judged against the policy. */
  commitsBehindHead: number | null;
  /** Indexed files no longer on disk. */
  missingFileCount: number;
  /** A bounded sample of them. */
  missingPaths: string[];
  /** Too far behind HEAD for `nexus.freshness.maxCommitsBehind`, or holding missing files. */
  stale: boolean;
  /** Why the index is stale or could not be read; absent when fresh. */
  reason?: string;
}

/**
 * Probe a project's code index without a walk and without opening its store
 * through the migrating chokepoint (T14021): a read-only snapshot of the
 * project's `cleo.db`, the recorded manifest and revision, `git rev-list`
 * counts, and one `existsSync` per indexed file. A project that was never
 * indexed is not stale.
 *
 * @param projectRoot - Project whose index is probed.
 * @param dbPath - The project's `cleo.db`.
 * @param options - `sampleLimit` for missing paths.
 * @returns The index health; never throws.
 * @example
 * ```ts
 * const health = await probeNexusIndexHealth('/repo', '/repo/.cleo/cleo.db');
 * if (health.stale) console.log(health.reason);
 * ```
 */
export async function probeNexusIndexHealth(
  projectRoot: string,
  dbPath: string,
  options: { sampleLimit?: number } = {},
): Promise<NexusIndexHealth> {
  const health: NexusIndexHealth = {
    indexed: false,
    lastIndexedAt: null,
    ageDays: null,
    indexedRevision: null,
    commitsBehind: null,
    commitsBehindHead: null,
    missingFileCount: 0,
    missingPaths: [],
    stale: false,
  };
  if (!existsSync(dbPath)) return health;
  const { openCleoDbSnapshot } = await import('../store/open-cleo-db.js');
  const { drizzle } = await import('drizzle-orm/node-sqlite');
  let snap: ReturnType<typeof openCleoDbSnapshot> | undefined;
  try {
    snap = openCleoDbSnapshot(dbPath, { readOnly: true, applyPragmas: false });
    const hasMeta = snap.db
      .prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = '_nexus_meta'")
      .get();
    if (!hasMeta) return health;
    const db = drizzle({ client: snap.db });
    const manifest = readFileManifest(db, projectRoot);
    if (!manifest) return health;
    const base = await measureAgainstBase(db, manifest.sourceRoot, manifest.assessedAt);
    const missing = missingIndexedPaths(
      manifest.sourceRoot,
      manifest.files.map(([path]) => path),
    );
    const { maxCommitsBehind } = await readNexusStalePolicy(projectRoot);
    const behind = (base.commitsBehindHead ?? 0) > maxCommitsBehind;
    const reasons = [
      ...(behind
        ? [`${base.commitsBehindHead} commit(s) behind HEAD (max ${maxCommitsBehind})`]
        : []),
      ...(missing.length > 0 ? [`${missing.length} indexed file(s) no longer on disk`] : []),
    ];
    return {
      indexed: true,
      lastIndexedAt: manifest.assessedAt,
      ageDays: base.ageDays ?? null,
      indexedRevision: base.indexedRevision ?? null,
      commitsBehind: base.commitsBehind ?? null,
      commitsBehindHead: base.commitsBehindHead ?? null,
      missingFileCount: missing.length,
      missingPaths: missing.slice(0, options.sampleLimit ?? 10),
      stale: reasons.length > 0,
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    };
  } catch (error) {
    return {
      ...health,
      reason: `the index could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    snap?.close();
  }
}

/** Default for `nexus.freshness.maxCommitsBehind` (T14008, lead decision 2026-10-24). */
export const DEFAULT_MAX_COMMITS_BEHIND = 50;

/** Env var that accepts a stale answer for any graph query (T14008). */
export const NEXUS_ALLOW_STALE_ENV = 'CLEO_NEXUS_ALLOW_STALE';

/** When a graph answer from a stale index is refused (T14008). */
export interface NexusStalePolicy {
  /** Most commits the index may trail the base branch. */
  maxCommitsBehind: number;
  /** The caller accepted a stale answer (`--allow-stale` or {@link NEXUS_ALLOW_STALE_ENV}). */
  allowStale: boolean;
}

/**
 * Read the stale-answer policy: `nexus.freshness.maxCommitsBehind` (default
 * {@link DEFAULT_MAX_COMMITS_BEHIND}) and the caller's opt-out.
 *
 * @param projectRoot - Project whose merged config is read.
 * @param options - `allowStale` from the caller's flag.
 * @returns The effective policy.
 * @example
 * ```ts
 * const policy = await readNexusStalePolicy(root, { allowStale: args['allow-stale'] });
 * ```
 */
export async function readNexusStalePolicy(
  projectRoot: string,
  options: { allowStale?: boolean } = {},
): Promise<NexusStalePolicy> {
  let raw: unknown;
  try {
    raw = await getConfigValue('nexus.freshness.maxCommitsBehind', { projectRoot });
  } catch {
    raw = undefined;
  }
  const configured = Number(raw);
  return {
    maxCommitsBehind:
      raw !== undefined && raw !== null && Number.isInteger(configured) && configured >= 0
        ? configured
        : DEFAULT_MAX_COMMITS_BEHIND,
    allowStale:
      options.allowStale === true || envSwitch(process.env[NEXUS_ALLOW_STALE_ENV]) === true,
  };
}

/**
 * Read an on/off env value (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`).
 *
 * @param value - Raw env value.
 * @returns The switch, or `undefined` when unrecognised.
 */
export function envSwitch(value: unknown): boolean | undefined {
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return undefined;
}
