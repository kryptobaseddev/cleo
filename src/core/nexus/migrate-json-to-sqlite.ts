/**
 * Migrate legacy projects-registry.json to nexus.db (SQLite).
 *
 * Reads the JSON registry file, inserts each project into the
 * project_registry table via Drizzle, and renames the JSON file
 * to .migrated to prevent re-migration.
 *
 * @task T5366
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { projectRegistry } from '../../store/nexus-schema.js';
import { getNexusDb } from '../../store/nexus-sqlite.js';
import { getLogger } from '../logger.js';
import { getRegistryPath } from './registry.js';

/**
 * Migrate projects from legacy JSON registry to nexus.db.
 *
 * For each project entry in projects-registry.json:
 * - Reads target/.cleo/project-info.json for a stable UUID (projectId)
 * - Falls back to randomUUID() if project-info.json is absent
 * - Upserts into project_registry (on conflict by projectHash → update path/name/lastSeen)
 *
 * On success, renames the JSON file to .migrated.
 *
 * @returns Number of projects migrated.
 */
export async function migrateJsonToSqlite(): Promise<number> {
  const jsonPath = getRegistryPath();
  if (!existsSync(jsonPath)) return 0;

  const logger = getLogger('nexus');
  let raw: string;
  try {
    raw = readFileSync(jsonPath, 'utf-8');
  } catch {
    return 0;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn({ jsonPath }, 'Failed to parse legacy registry JSON — skipping migration');
    return 0;
  }

  // The JSON registry stores projects as a record keyed by hash
  const projectsRecord = data['projects'];
  if (!projectsRecord || typeof projectsRecord !== 'object') return 0;

  const entries = Object.values(projectsRecord) as Array<Record<string, unknown>>;
  if (entries.length === 0) return 0;

  const db = await getNexusDb();
  let migrated = 0;

  for (const entry of entries) {
    const projectPath = String(entry['path'] ?? '');
    const projectHash = String(entry['hash'] ?? entry['projectHash'] ?? '');
    const name = String(entry['name'] ?? projectPath.split('/').pop() ?? 'unknown');

    if (!projectPath || !projectHash) continue;

    // Try to read project-info.json for a stable UUID
    let projectId: string = randomUUID();
    try {
      const infoPath = join(projectPath, '.cleo', 'project-info.json');
      if (existsSync(infoPath)) {
        const info = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
        if (typeof info['projectId'] === 'string' && info['projectId']) {
          projectId = info['projectId'];
        }
      }
    } catch {
      // Use fallback UUID
    }

    const healthStatus = String(entry['healthStatus'] ?? 'unknown');
    const permissions = String(entry['permissions'] ?? 'read');
    const taskCount = typeof entry['taskCount'] === 'number' ? entry['taskCount'] : 0;
    const labels = Array.isArray(entry['labels']) ? entry['labels'] : [];

    await db
      .insert(projectRegistry)
      .values({
        projectId,
        projectHash,
        projectPath,
        name,
        healthStatus,
        permissions,
        taskCount,
        labelsJson: JSON.stringify(labels),
      })
      .onConflictDoUpdate({
        target: projectRegistry.projectHash,
        set: {
          projectPath: sql`excluded.project_path`,
          name: sql`excluded.name`,
          lastSeen: sql`(datetime('now'))`,
        },
      });
    migrated++;
  }

  // Rename JSON file to mark as migrated
  try {
    renameSync(jsonPath, jsonPath + '.migrated');
  } catch {
    logger.warn({ jsonPath }, 'Could not rename legacy registry file');
  }

  logger.info({ migrated }, `Migrated ${migrated} projects from JSON registry to nexus.db`);
  return migrated;
}
