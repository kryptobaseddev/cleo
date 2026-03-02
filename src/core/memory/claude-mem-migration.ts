/**
 * Claude-mem to brain.db migration.
 * Imports observations from ~/.claude-mem/claude-mem.db into brain_observations.
 * Also creates brain_decisions from decision-typed observations and
 * brain_learnings from session_summaries with learned fields.
 *
 * @epic T5149
 * @task T5143
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import { ensureFts5Tables, rebuildFts5Index } from './brain-search.js';
import type { BRAIN_OBSERVATION_TYPES } from '../../store/brain-schema.js';

// Runtime-load node:sqlite via createRequire (same pattern as node-sqlite-adapter.ts)
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Result from a claude-mem migration run. */
export interface ClaudeMemMigrationResult {
  observationsImported: number;
  observationsSkipped: number;
  learningsImported: number;
  decisionsImported: number;
  errors: string[];
  dryRun: boolean;
}

/** Options for the claude-mem migration. */
export interface ClaudeMemMigrationOptions {
  /** Path to claude-mem.db. Default: ~/.claude-mem/claude-mem.db */
  sourcePath?: string;
  /** Project tag for imported entries. */
  project?: string;
  /** If true, count what would be imported without inserting. */
  dryRun?: boolean;
  /** Number of rows to insert per transaction batch. Default: 100. */
  batchSize?: number;
}

/** Row shape from claude-mem observations table. */
interface ClaudeMemObservation {
  id: number;
  type: string;
  title: string;
  subtitle: string | null;
  narrative: string | null;
  facts: string | null;
  concepts: string | null;
  project: string | null;
  files_read: string | null;
  files_modified: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** Row shape from claude-mem session_summaries table. */
interface ClaudeMemSessionSummary {
  id: number;
  session_id: string | null;
  summary: string | null;
  learned: string | null;
  created_at: string | null;
}

/** Valid observation types in the BRAIN schema. */
const VALID_OBSERVATION_TYPES = new Set<string>([
  'discovery', 'change', 'feature', 'bugfix', 'decision', 'refactor',
]);

/**
 * Map a claude-mem observation type to a valid BRAIN observation type.
 * Falls back to 'discovery' for unrecognized types.
 */
function mapObservationType(type: string): typeof BRAIN_OBSERVATION_TYPES[number] {
  if (VALID_OBSERVATION_TYPES.has(type)) {
    return type as typeof BRAIN_OBSERVATION_TYPES[number];
  }
  return 'discovery';
}

/**
 * Parse a learned field from claude-mem session_summaries.
 * The field may be a JSON array of strings or a plain string.
 */
function parseLearned(learned: string): string {
  try {
    const parsed = JSON.parse(learned);
    if (Array.isArray(parsed)) {
      return parsed.filter((s) => typeof s === 'string' && s.trim()).join('; ');
    }
    if (typeof parsed === 'string') {
      return parsed;
    }
    return String(parsed);
  } catch {
    // Not valid JSON — treat as plain string
    return learned;
  }
}

/**
 * Migrate observations from claude-mem's SQLite database into CLEO brain.db.
 *
 * Reads from ~/.claude-mem/claude-mem.db (or a custom path) and inserts into:
 * - brain_observations (all observations, prefixed CM-)
 * - brain_decisions (decision-typed observations, prefixed CMD-)
 * - brain_learnings (session summaries with learned field, prefixed CML-)
 *
 * Idempotent: skips rows whose ID already exists in brain.db.
 * After all inserts, rebuilds FTS5 indexes.
 *
 * @param projectRoot - The CLEO project root (for brain.db resolution)
 * @param options - Migration options
 */
export async function migrateClaudeMem(
  projectRoot: string,
  options: ClaudeMemMigrationOptions = {},
): Promise<ClaudeMemMigrationResult> {
  const sourcePath = options.sourcePath ?? join(homedir(), '.claude-mem', 'claude-mem.db');
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 100;

  const result: ClaudeMemMigrationResult = {
    observationsImported: 0,
    observationsSkipped: 0,
    learningsImported: 0,
    decisionsImported: 0,
    errors: [],
    dryRun,
  };

  // Validate source database exists
  if (!existsSync(sourcePath)) {
    throw new Error(
      `claude-mem database not found at: ${sourcePath}\n`
      + `Expected location: ~/.claude-mem/claude-mem.db\n`
      + `Use --source <path> to specify a custom location.`,
    );
  }

  // Open source DB read-only
  let sourceDb: DatabaseSync;
  try {
    sourceDb = new DatabaseSync(sourcePath, {
      readOnly: true,
    });
  } catch (err) {
    throw new Error(
      `Failed to open claude-mem database at ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    // Initialize brain.db (ensures tables exist via migrations)
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) {
      throw new Error('Failed to initialize brain.db — getBrainNativeDb() returned null');
    }

    // Ensure FTS5 tables exist for the rebuild at the end
    ensureFts5Tables(nativeDb);

    // --- Phase 1: Migrate observations ---
    const observations = sourceDb.prepare(
      'SELECT * FROM observations ORDER BY id',
    ).all() as unknown as ClaudeMemObservation[];

    // Process observations in batches
    for (let i = 0; i < observations.length; i += batchSize) {
      const batch = observations.slice(i, i + batchSize);

      if (!dryRun) {
        nativeDb.prepare('BEGIN IMMEDIATE').run();
      }

      try {
        for (const row of batch) {
          const obsId = `CM-${row.id}`;

          // Check if already imported (idempotent)
          const existing = nativeDb.prepare(
            'SELECT id FROM brain_observations WHERE id = ?',
          ).get(obsId) as Record<string, unknown> | undefined;

          if (existing) {
            result.observationsSkipped++;
            continue;
          }

          if (dryRun) {
            result.observationsImported++;
            // Also count decisions in dry run
            if (row.type === 'decision') {
              result.decisionsImported++;
            }
            continue;
          }

          const mappedType = mapObservationType(row.type);
          const projectTag = options.project ?? row.project ?? null;

          nativeDb.prepare(`
            INSERT INTO brain_observations (
              id, type, title, subtitle, narrative,
              facts_json, concepts_json, project,
              files_read_json, files_modified_json,
              source_type, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            obsId,
            mappedType,
            row.title,
            row.subtitle ?? null,
            row.narrative ?? null,
            row.facts ?? null,
            row.concepts ?? null,
            projectTag,
            row.files_read ?? null,
            row.files_modified ?? null,
            'claude-mem',
            row.created_at ?? null,
            row.updated_at ?? null,
          );
          result.observationsImported++;

          // For decision-typed observations, also create a brain_decisions entry
          if (row.type === 'decision') {
            const decId = `CMD-${row.id}`;
            const existingDec = nativeDb.prepare(
              'SELECT id FROM brain_decisions WHERE id = ?',
            ).get(decId) as Record<string, unknown> | undefined;

            if (!existingDec) {
              nativeDb.prepare(`
                INSERT INTO brain_decisions (
                  id, type, decision, rationale, confidence, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
              `).run(
                decId,
                'tactical',
                row.title,
                row.narrative ?? 'Imported from claude-mem',
                'medium',
                row.created_at ?? null,
              );
              result.decisionsImported++;
            }
          }
        }

        if (!dryRun) {
          nativeDb.prepare('COMMIT').run();
        }
      } catch (err) {
        if (!dryRun) {
          try {
            nativeDb.prepare('ROLLBACK').run();
          } catch {
            // Ignore rollback errors
          }
        }
        result.errors.push(
          `Batch starting at observation ${batch[0]?.id ?? '?'}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Phase 2: Migrate session_summaries (learned -> brain_learnings) ---
    let summaries: ClaudeMemSessionSummary[] = [];
    try {
      summaries = sourceDb.prepare(
        'SELECT * FROM session_summaries ORDER BY id',
      ).all() as unknown as ClaudeMemSessionSummary[];
    } catch {
      // session_summaries table may not exist in all claude-mem versions
      // This is not an error — just skip
    }

    for (let i = 0; i < summaries.length; i += batchSize) {
      const batch = summaries.slice(i, i + batchSize);

      if (!dryRun) {
        nativeDb.prepare('BEGIN IMMEDIATE').run();
      }

      try {
        for (const row of batch) {
          if (!row.learned || !row.learned.trim()) {
            continue;
          }

          const learnId = `CML-${row.id}`;

          // Check if already imported
          const existing = nativeDb.prepare(
            'SELECT id FROM brain_learnings WHERE id = ?',
          ).get(learnId) as Record<string, unknown> | undefined;

          if (existing) {
            // Don't count as skipped — these are separate from observations
            continue;
          }

          const insight = parseLearned(row.learned);
          if (!insight.trim()) {
            continue;
          }

          if (dryRun) {
            result.learningsImported++;
            continue;
          }

          const source = row.session_id
            ? `claude-mem session ${row.session_id}`
            : 'claude-mem session';

          nativeDb.prepare(`
            INSERT INTO brain_learnings (
              id, insight, source, confidence, actionable, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            learnId,
            insight,
            source,
            0.5,
            0,  // false
            row.created_at ?? null,
          );
          result.learningsImported++;
        }

        if (!dryRun) {
          nativeDb.prepare('COMMIT').run();
        }
      } catch (err) {
        if (!dryRun) {
          try {
            nativeDb.prepare('ROLLBACK').run();
          } catch {
            // Ignore rollback errors
          }
        }
        result.errors.push(
          `Session summary batch starting at ${batch[0]?.id ?? '?'}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // --- Phase 3: Rebuild FTS5 indexes ---
    if (!dryRun && (result.observationsImported > 0 || result.learningsImported > 0 || result.decisionsImported > 0)) {
      try {
        rebuildFts5Index(nativeDb);
      } catch (err) {
        result.errors.push(
          `FTS5 rebuild warning: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } finally {
    // Close source DB (read-only, safe to close)
    try {
      sourceDb.close();
    } catch {
      // Ignore close errors
    }
  }

  return result;
}
