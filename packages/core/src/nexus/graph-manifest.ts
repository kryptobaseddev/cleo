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

import type { GraphIndexAssessment, GraphIndexRunSummary } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';

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
  /** Canonical root the paths are relative to. */
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
 * @param tx - Open transaction on the project graph database.
 * @param manifest - Manifest of the generation being committed.
 */
export function writeFileManifest(tx: NodeSQLiteDatabase, manifest: GraphFileManifest): void {
  tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${MANIFEST_KEY}, ${JSON.stringify(manifest)})
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
 * Read the manifest of the committed generation.
 * @param db - Project graph database.
 * @returns The manifest, or `null` when the generation predates manifests.
 * @throws When a stored manifest is malformed.
 */
export function readFileManifest(db: NodeSQLiteDatabase): GraphFileManifest | null {
  const value = db.values(
    sql`SELECT value FROM main._nexus_meta WHERE key = ${MANIFEST_KEY}`,
  )[0]?.[0];
  if (typeof value !== 'string') return null;
  return manifestSchema.parse(JSON.parse(value));
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
