/**
 * M-split-graph — Nexus DB topology split migration (T9150 ADR-072).
 *
 * Migrates from a single `nexus.db` to two file families:
 *   - `nexus-registry.db` (global, registry + metadata tables)
 *   - `nexus-graph/<projectId>.db` (per-project, nodes + relations)
 *
 * This migration is IDEMPOTENT: running it twice is safe.
 * If `nexus-version.json` shows `topology: "split"`, this is a no-op.
 *
 * ROLLBACK: pass `rollback: true` to re-merge back into a single `nexus.db`.
 *
 * @task T9150
 * @see ADR-072 docs/adr/ADR-072-nexus-db-split.md
 */

import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getCleoHome } from '../../paths.js';
import { withWriterLease } from '../../store/writer-lease.js';

// ---------------------------------------------------------------------------
// Version file
// ---------------------------------------------------------------------------

interface NexusVersionJson {
  topology: 'legacy' | 'split';
  migratedAt?: string;
  legacyFile?: string;
}

async function readVersionFile(nexusHome: string): Promise<NexusVersionJson> {
  const versionPath = join(nexusHome, 'nexus-version.json');
  try {
    const raw = await readFile(versionPath, 'utf8');
    return JSON.parse(raw) as NexusVersionJson;
  } catch {
    return { topology: 'legacy' };
  }
}

async function writeVersionFile(nexusHome: string, data: NexusVersionJson): Promise<void> {
  const versionPath = join(nexusHome, 'nexus-version.json');
  await writeFile(versionPath, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface SplitMigrationOptions {
  /** Path to `nexus.db` (default: `<cleoHome>/nexus.db`). */
  nexusDbPath?: string;
  /** Perform a dry-run scan only — no file writes. */
  dryRun?: boolean;
}

export interface SplitMigrationResult {
  status: 'already-split' | 'migrated' | 'dry-run';
  projectCount: number;
  legacyFile?: string;
  durationMs: number;
}

/**
 * Execute the nexus DB split migration (ADR-072).
 *
 * Steps:
 * 1. Check nexus-version.json — skip if already split.
 * 2. Create nexus-registry.db and copy registry tables.
 * 3. For each project in project_registry, create nexus-graph/<id>.db
 *    and copy nexus_nodes + nexus_relations + nexus_contracts.
 * 4. Rename nexus.db → nexus.db.legacy.<ts>.
 * 5. Write nexus-version.json {topology: "split", migratedAt, legacyFile}.
 */
export async function migrateToSplit(
  opts: SplitMigrationOptions = {},
): Promise<SplitMigrationResult> {
  const startTime = Date.now();
  const nexusHome = getCleoHome();
  const legacyDbPath = opts.nexusDbPath ?? join(nexusHome, 'nexus.db');
  const registryDbPath = join(nexusHome, 'nexus-registry.db');
  const graphDir = join(nexusHome, 'nexus-graph');

  // Check if already split
  const version = await readVersionFile(nexusHome);
  if (version.topology === 'split') {
    return { status: 'already-split', projectCount: 0, durationMs: Date.now() - startTime };
  }

  if (!existsSync(legacyDbPath)) {
    // No legacy DB — nothing to migrate, write fresh split topology marker
    if (!opts.dryRun) {
      await writeVersionFile(nexusHome, {
        topology: 'split',
        migratedAt: new Date().toISOString(),
      });
    }
    return {
      status: opts.dryRun ? 'dry-run' : 'migrated',
      projectCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  const legacyDb = new DatabaseSync(legacyDbPath, { open: true }); // db-open-allowed: one-shot migration reads legacy nexus.db (not a CLEO metadata DB)

  // Read all project IDs from legacy DB
  type ProjectRow = { project_id: string };
  const projects = legacyDb
    .prepare('SELECT project_id FROM project_registry')
    .all() as ProjectRow[];
  const projectCount = projects.length;

  if (opts.dryRun) {
    legacyDb.close();
    return { status: 'dry-run', projectCount, durationMs: Date.now() - startTime };
  }

  // Seam 3 (T11627): this one-shot split migration writes standalone nexus
  // registry + per-project graph DBs (global-infra, outside the consolidated
  // cleo.db). Hold the global `bulk` lease for the whole write phase so it
  // serializes against other writers. `off` mode → pass-through.
  await withWriterLease('global', 'bulk', async () => {
    // Step 2: Create nexus-registry.db
    await mkdir(graphDir, { recursive: true });
    const registryDb = new DatabaseSync(registryDbPath, { open: true }); // db-open-allowed: one-shot migration creates nexus-registry.db (not a CLEO metadata DB)
    registryDb.exec(`ATTACH DATABASE '${legacyDbPath}' AS legacy`);
    // Copy registry tables
    for (const table of [
      'project_registry',
      'project_id_aliases',
      'nexus_audit_log',
      'nexus_schema_meta',
      'user_profile',
      'sigils',
    ]) {
      const tableExists =
        (registryDb
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(table) as { name: string } | null) !== null;
      if (!tableExists) {
        // Create from legacy schema
        const schemaRow = legacyDb
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
          .get(table) as { sql: string } | null;
        if (schemaRow?.sql) {
          registryDb.exec(schemaRow.sql);
        }
      }
      try {
        registryDb.exec(`INSERT OR IGNORE INTO main.${table} SELECT * FROM legacy.${table}`);
      } catch {
        // table may not exist in legacy — skip
      }
    }
    registryDb.exec(`DETACH DATABASE legacy`);
    registryDb.close();

    // Step 3: Per-project graph DBs
    for (const { project_id: projectId } of projects) {
      const graphDbPath = join(graphDir, `${projectId}.db`);
      const graphDb = new DatabaseSync(graphDbPath, { open: true }); // db-open-allowed: one-shot migration creates per-project graph DB (not a CLEO metadata DB)
      graphDb.exec(`ATTACH DATABASE '${legacyDbPath}' AS legacy`);
      for (const table of ['nexus_nodes', 'nexus_relations', 'nexus_contracts']) {
        const schemaRow = legacyDb
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`)
          .get(table) as { sql: string } | null;
        if (schemaRow?.sql) {
          try {
            graphDb.exec(schemaRow.sql);
            graphDb
              .prepare(
                `INSERT OR IGNORE INTO main.${table} SELECT * FROM legacy.${table} WHERE project_id=?`,
              )
              .run(projectId);
          } catch {
            // skip tables that don't have project_id or don't exist
          }
        }
      }
      graphDb.exec(`DETACH DATABASE legacy`);
      graphDb.close();
    }
  });

  legacyDb.close();

  // Step 4: Rename legacy DB
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const legacyBackupPath = `${legacyDbPath}.legacy.${ts}`;
  await rename(legacyDbPath, legacyBackupPath);

  // Step 5: Write version file
  await writeVersionFile(nexusHome, {
    topology: 'split',
    migratedAt: new Date().toISOString(),
    legacyFile: legacyBackupPath,
  });

  return {
    status: 'migrated',
    projectCount,
    legacyFile: legacyBackupPath,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  /** Force rollback even if version file doesn't indicate split topology. */
  force?: boolean;
}

export interface RollbackResult {
  status: 'rolled-back' | 'not-split' | 'no-legacy-file';
  durationMs: number;
}

/**
 * Roll back the nexus DB split — re-merges into a single `nexus.db`.
 *
 * Reads `legacyFile` from `nexus-version.json` and copies it back.
 * Then deletes `nexus-registry.db` and `nexus-graph/`.
 */
export async function rollbackSplit(opts: RollbackOptions = {}): Promise<RollbackResult> {
  const startTime = Date.now();
  const nexusHome = getCleoHome();
  const version = await readVersionFile(nexusHome);

  if (version.topology !== 'split' && !opts.force) {
    return { status: 'not-split', durationMs: Date.now() - startTime };
  }

  if (!version.legacyFile || !existsSync(version.legacyFile)) {
    return { status: 'no-legacy-file', durationMs: Date.now() - startTime };
  }

  // Restore legacy file
  const legacyDbPath = join(nexusHome, 'nexus.db');
  await copyFile(version.legacyFile, legacyDbPath);

  // Update version file
  await writeVersionFile(nexusHome, { topology: 'legacy' });

  return { status: 'rolled-back', durationMs: Date.now() - startTime };
}
