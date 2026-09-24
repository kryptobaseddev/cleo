/**
 * Device-local project path map (`nexus_project_paths`).
 *
 * The registry row is keyed by the immutable `project_id` (ADR-094), so its
 * `project_path` names one checkout — the one encountered most recently. The
 * path map records EVERY checkout of a project on this device, keyed by path,
 * so two checkouts of one project coexist instead of fighting over one row.
 *
 * Every writer that records a checkout in the registry records it here in the
 * same transaction: encounter registration, `nexusRegister`, `nexusReconcile`
 * and `nexusMoveProject`. Rows whose directory is gone are pruned when their
 * project is next recorded, so a move leaves one checkout, not two.
 *
 * @task T12354
 */

import { existsSync } from 'node:fs';
import type { NexusProjectCheckout } from '@cleocode/contracts';
import { and, desc, eq, ne } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { projectPaths } from '../store/schema/nexus-schema.js';

/** A registry handle or an open transaction on one. */
export type PathMapWriter = Pick<NodeSQLiteDatabase, 'select' | 'insert' | 'delete'>;

/** One checkout to record. */
export interface ProjectCheckoutRecord {
  /** Immutable project id. */
  projectId: string;
  /** Absolute checkout root. */
  projectPath: string;
  /** Path fingerprint of the checkout. */
  projectHash: string;
  /** ISO 8601 timestamp of the encounter. */
  now: string;
}

/**
 * Record a checkout in the path map and prune this project's vanished paths.
 *
 * A path belongs to exactly one project, so recording it re-points a row that
 * previously named another project. Runs synchronously so it composes with the
 * registry writers' immediate transactions.
 *
 * @param db - Registry handle or transaction.
 * @param record - The checkout encountered.
 * @returns Number of vanished checkouts pruned for this project.
 */
export function recordProjectCheckout(db: PathMapWriter, record: ProjectCheckoutRecord): number {
  db.insert(projectPaths)
    .values({
      projectPath: record.projectPath,
      projectId: record.projectId,
      projectHash: record.projectHash,
      firstSeen: record.now,
      lastSeen: record.now,
    })
    .onConflictDoUpdate({
      target: projectPaths.projectPath,
      set: { projectId: record.projectId, projectHash: record.projectHash, lastSeen: record.now },
    })
    .run();

  const siblings = db
    .select({ projectPath: projectPaths.projectPath })
    .from(projectPaths)
    .where(
      and(
        eq(projectPaths.projectId, record.projectId),
        ne(projectPaths.projectPath, record.projectPath),
      ),
    )
    .all();
  let pruned = 0;
  for (const sibling of siblings) {
    if (existsSync(sibling.projectPath)) continue;
    db.delete(projectPaths).where(eq(projectPaths.projectPath, sibling.projectPath)).run();
    pruned++;
  }
  return pruned;
}

/**
 * List every recorded checkout of a project on this device, newest first.
 *
 * @param projectId - Immutable project id.
 * @returns Checkouts with an `exists` flag; a vanished one stays listed until
 *   the project is next recorded.
 * @example
 * ```ts
 * const checkouts = await listProjectCheckouts(projectId);
 * ```
 */
export async function listProjectCheckouts(projectId: string): Promise<NexusProjectCheckout[]> {
  const { getNexusRegistryDb } = await import('../store/nexus-sqlite.js');
  const { getCleoHome } = await import('../paths.js');
  const db = await getNexusRegistryDb(getCleoHome());
  return db
    .select()
    .from(projectPaths)
    .where(eq(projectPaths.projectId, projectId))
    .orderBy(desc(projectPaths.lastSeen))
    .all()
    .map((row) => ({
      projectPath: row.projectPath,
      projectHash: row.projectHash,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      exists: existsSync(row.projectPath),
    }));
}
