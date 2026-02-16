/**
 * Session migration - migrate existing projects to Epic-Bound Session system.
 *
 * Automatically migrates existing single-session projects to the new
 * multi-session architecture when any session command is run.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDir } from '../paths.js';
import { readJson, saveJson } from '../../store/json.js';
import type { SessionsFile } from '../../types/session.js';

/**
 * Check if migration is needed for Epic-Bound Sessions.
 * Returns true if migration is needed, false if already migrated.
 */
export async function needsSessionMigration(cwd?: string): Promise<boolean> {
  const cleoDir = getCleoDir(cwd);
  const sessionsFile = join(cleoDir, 'sessions.json');
  const configFile = join(cleoDir, 'config.json');

  // If sessions.json exists with valid structure, no migration needed
  if (existsSync(sessionsFile)) {
    try {
      const data = JSON.parse(readFileSync(sessionsFile, 'utf-8'));
      if (data.version) return false;
    } catch {
      // Invalid JSON, needs migration
    }
  }

  // Config has multiSession but no sessions.json => partial migration
  if (existsSync(configFile)) {
    try {
      const config = JSON.parse(readFileSync(configFile, 'utf-8'));
      if (config.multiSession?.enabled !== undefined) return true;
    } catch {
      // Invalid config
    }
  }

  return true;
}

/**
 * Migrate existing single-session to multi-session format.
 * Creates sessions.json with proper structure and enables multi-session in config.
 */
export async function migrateToEpicSessions(cwd?: string): Promise<{
  migrated: boolean;
  actions: string[];
}> {
  const cleoDir = getCleoDir(cwd);
  const sessionsPath = join(cleoDir, 'sessions.json');
  const configPath = join(cleoDir, 'config.json');
  const actions: string[] = [];

  // Create sessions.json if missing
  if (!existsSync(sessionsPath)) {
    const initialData: SessionsFile = {
      version: '1.0.0',
      sessions: [],
      _meta: {
        schemaVersion: '1.0.0',
        lastUpdated: new Date().toISOString(),
      },
    };

    await saveJson(sessionsPath, initialData);
    actions.push('Created sessions.json');
  } else {
    // Validate existing sessions.json
    const data = await readJson<SessionsFile>(sessionsPath);
    if (data && !data.version) {
      const migrated: SessionsFile = {
        version: '1.0.0',
        sessions: data.sessions ?? [],
        _meta: {
          schemaVersion: '1.0.0',
          lastUpdated: new Date().toISOString(),
        },
      };
      await saveJson(sessionsPath, migrated);
      actions.push('Migrated sessions.json to v1.0.0 format');
    }
  }

  // Enable multiSession in config
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (!config.multiSession) {
        config.multiSession = { enabled: true };
        await saveJson(configPath, config);
        actions.push('Enabled multiSession in config.json');
      }
    } catch {
      // Config issue, skip
    }
  }

  return { migrated: actions.length > 0, actions };
}

/**
 * Check migration status and return a summary.
 */
export async function getMigrationStatus(cwd?: string): Promise<{
  needsMigration: boolean;
  sessionsFileExists: boolean;
  multiSessionEnabled: boolean;
}> {
  const cleoDir = getCleoDir(cwd);
  const sessionsPath = join(cleoDir, 'sessions.json');
  const configPath = join(cleoDir, 'config.json');

  const sessionsFileExists = existsSync(sessionsPath);
  let multiSessionEnabled = false;

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      multiSessionEnabled = config.multiSession?.enabled === true;
    } catch { /* */ }
  }

  return {
    needsMigration: await needsSessionMigration(cwd),
    sessionsFileExists,
    multiSessionEnabled,
  };
}
