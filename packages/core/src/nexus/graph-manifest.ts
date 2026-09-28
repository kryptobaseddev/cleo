/**
 * Compact per-generation bookkeeping for cheap freshness checks (T12316).
 *
 * The published `graph_assessment` carries every retained reference with its
 * full evidence — 472 MB of JSON on this repository — so it cannot be read on
 * the query path. The file manifest records only what a freshness check needs
 * (path, size, mtime, content hash per indexed file), and the run summary
 * records what the last analysis cost, so a refresh can be estimated before it
 * is started. Both live in `_nexus_meta` next to the generation they describe.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12316
 * @module nexus/graph-manifest
 */

import { isAbsolute } from 'node:path';
import type { GraphIndexAssessment, GraphIndexRunSummary } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';
import { ASSESSMENT_KEY } from './assessment-store.js';
import { canonicalProjectRoot, fromStoredPath, isWithin, toStoredPath } from './stored-roots.js';

/** `_nexus_meta` key of the compact file manifest. */
const MANIFEST_KEY = 'graph_file_manifest';
/** `_nexus_meta` key of the last analysis run summary. */
const RUN_SUMMARY_KEY = 'graph_run_summary';

/** One indexed file: `[path, size, mtimeMs, contentHash]`. */
export type GraphManifestEntry = [path: string, size: number, mtimeMs: number, hash: string];

/** Compact description of the files a published generation was built from. */
export interface GraphFileManifest {
  /** Generation the manifest describes. */
  generation: string | null;
  /**
   * Absolute source root the paths are relative to. In memory it is absolute;
   * in `_nexus_meta` it is stored relative to the project root (T12474).
   */
  sourceRoot: string;
  /** Explicitly included nested repositories, needed to walk the same tree. */
  includedRepositories: string[];
  /** When the generation was assessed. */
  assessedAt: string;
  /** Every indexed file with a content hash. */
  files: GraphManifestEntry[];
}

/** Cost record of the last analysis that published a generation. */
export interface GraphRunCost {
  /** Mode, counts and per-phase milliseconds of that run. */
  summary: GraphIndexRunSummary;
  /** End-to-end milliseconds, including provenance and publication. */
  durationMs: number;
  /** When the run finished. */
  recordedAt: string;
}

const manifestSchema = z.object({
  generation: z.string().nullable(),
  sourceRoot: z.string(),
  includedRepositories: z.array(z.string()),
  assessedAt: z.string(),
  files: z.array(z.tuple([z.string(), z.number(), z.number(), z.string()])),
});

const runCostSchema = z.object({
  summary: z.object({
    mode: z.enum(['incremental', 'full', 'unchanged']),
    reason: z.string(),
    changedFiles: z.number(),
    addedFiles: z.number(),
    deletedFiles: z.number(),
    parsedFiles: z.number(),
    reusedFiles: z.number(),
    resolvedFiles: z.number(),
    phaseMs: z.record(z.string(), z.number()),
  }),
  durationMs: z.number(),
  recordedAt: z.string(),
});

/** Files with an observed size, mtime and hash, as recorded by an index scan. */
interface ObservedFile {
  path: string;
  size?: number;
  mtimeMs?: number;
  contentHash?: string;
}

/**
 * Build the manifest for a generation from its observed files.
 * @param assessment - Assessment of the generation (source root, scope, timestamp).
 * @param files - Files whose size, mtime and hash were observed; others are omitted.
 * @returns The compact manifest.
 */
export function buildFileManifest(
  assessment: Pick<
    GraphIndexAssessment,
    'generation' | 'sourceRoot' | 'includedRepositories' | 'assessedAt'
  >,
  files: readonly ObservedFile[],
): GraphFileManifest {
  const entries: GraphManifestEntry[] = [];
  for (const file of files) {
    if (file.contentHash && file.size !== undefined && file.mtimeMs !== undefined)
      entries.push([file.path, file.size, file.mtimeMs, file.contentHash]);
  }
  return {
    generation: assessment.generation ?? null,
    sourceRoot: assessment.sourceRoot,
    includedRepositories: [...(assessment.includedRepositories ?? [])],
    assessedAt: assessment.assessedAt,
    files: entries,
  };
}

/**
 * Write the manifest; call inside the transaction that publishes its generation.
 *
 * The source root is stored relative to `projectRoot` (T12474), so the record
 * stays valid after the project moves.
 *
 * @param tx - Open transaction on the project graph database.
 * @param manifest - Manifest of the generation being committed.
 * @param projectRoot - Canonical project root; when omitted the root is stored as given.
 */
export function writeFileManifest(
  tx: NodeSQLiteDatabase,
  manifest: GraphFileManifest,
  projectRoot?: string,
): void {
  const stored: GraphFileManifest = projectRoot
    ? { ...manifest, sourceRoot: toStoredPath(projectRoot, manifest.sourceRoot) }
    : manifest;
  tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${MANIFEST_KEY}, ${JSON.stringify(stored)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
}

/**
 * Remove the manifest; call when a generation is published without one, so a
 * stale manifest can never describe a different generation.
 * @param tx - Open transaction on the project graph database.
 */
export function clearFileManifest(tx: NodeSQLiteDatabase): void {
  tx.run(sql`DELETE FROM main._nexus_meta WHERE key = ${MANIFEST_KEY}`);
}

/**
 * Project root a legacy absolute record was written under, read from the
 * assessment published in the same transaction. Only consulted for a legacy
 * manifest, and only the one JSON field is extracted.
 */
function legacyProjectRoot(db: NodeSQLiteDatabase): string | undefined {
  const value = db.values(
    sql`SELECT json_extract(value, '$.sourceRoots.projectRoot') FROM main._nexus_meta WHERE key = ${ASSESSMENT_KEY}`,
  )[0]?.[0];
  return typeof value === 'string' && isAbsolute(value) ? value : undefined;
}

/**
 * Read the manifest of the committed generation, its source root resolved
 * against the live project root.
 *
 * A manifest written before T12474 holds the absolute root of the machine that
 * analyzed it; when that root lies inside the project root recorded with the
 * same generation, it is rebased onto the live root, so a moved project walks
 * its own tree instead of a path that no longer exists.
 *
 * @param db - Project graph database.
 * @param projectRoot - Live project root the database was opened for.
 * @returns The manifest, or `null` when the generation predates manifests.
 * @throws When a stored manifest is malformed.
 */
export function readFileManifest(
  db: NodeSQLiteDatabase,
  projectRoot: string,
): GraphFileManifest | null {
  const value = db.values(
    sql`SELECT value FROM main._nexus_meta WHERE key = ${MANIFEST_KEY}`,
  )[0]?.[0];
  if (typeof value !== 'string') return null;
  const stored = manifestSchema.parse(JSON.parse(value));
  const base = canonicalProjectRoot(projectRoot);
  if (!isAbsolute(stored.sourceRoot))
    return { ...stored, sourceRoot: fromStoredPath(base, stored.sourceRoot) };
  const legacyRoot = legacyProjectRoot(db);
  if (!legacyRoot || !isWithin(legacyRoot, stored.sourceRoot)) return stored;
  return { ...stored, sourceRoot: fromStoredPath(base, stored.sourceRoot, legacyRoot) };
}

/**
 * Record what the last publishing analysis cost; advisory, used for estimates.
 * @param db - Project graph database.
 * @param cost - Summary and duration of the run.
 */
export function writeRunCost(db: NodeSQLiteDatabase, cost: GraphRunCost): void {
  db.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${RUN_SUMMARY_KEY}, ${JSON.stringify(cost)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
}

/**
 * Read the last recorded run cost.
 * @param db - Project graph database.
 * @returns The cost, or `null` when none (or an unreadable one) is recorded.
 */
export function readRunCost(db: NodeSQLiteDatabase): GraphRunCost | null {
  const value = db.values(
    sql`SELECT value FROM main._nexus_meta WHERE key = ${RUN_SUMMARY_KEY}`,
  )[0]?.[0];
  if (typeof value !== 'string') return null;
  const parsed = runCostSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : null;
}
