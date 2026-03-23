/**
 * Backup and restore core module.
 * @task T4783
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

export interface BackupResult {
  backupId: string;
  path: string;
  timestamp: string;
  type: string;
  files: string[];
}

export interface RestoreResult {
  restored: boolean;
  backupId: string;
  timestamp: string;
  filesRestored: string[];
}

/** Create a backup of CLEO data files. */
export function createBackup(
  projectRoot: string,
  opts?: { type?: string; note?: string },
): BackupResult {
  const cleoDir = join(projectRoot, '.cleo');
  const btype = opts?.type || 'snapshot';
  const timestamp = new Date().toISOString();
  const backupId = `${btype}-${timestamp.replace(/[:.]/g, '-')}`;
  const backupDir = join(cleoDir, 'backups', btype);

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const filesToBackup = ['tasks.db', 'brain.db', 'config.json', 'project-info.json'];
  const backedUp: string[] = [];

  for (const file of filesToBackup) {
    const src = join(cleoDir, file);
    if (existsSync(src)) {
      const dest = join(backupDir, `${file}.${backupId}`);
      try {
        const content = readFileSync(src);
        writeFileSync(dest, content);
        backedUp.push(file);
      } catch {
        // skip files that fail to copy
      }
    }
  }

  // Write metadata
  const metaPath = join(backupDir, `${backupId}.meta.json`);
  try {
    writeFileSync(
      metaPath,
      JSON.stringify(
        {
          backupId,
          type: btype,
          timestamp,
          note: opts?.note,
          files: backedUp,
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {
    // non-fatal
  }

  return { backupId, path: backupDir, timestamp, type: btype, files: backedUp };
}

/** A single backup entry returned by listSystemBackups. */
export interface BackupEntry {
  backupId: string;
  type: string;
  timestamp: string;
  note?: string;
  files: string[];
}

/**
 * List all available system backups (snapshot, safety, migration types).
 * Reads `.meta.json` sidecar files written by createBackup.
 * This is a pure read operation — it does not modify any files.
 * @task T4783
 */
export function listSystemBackups(projectRoot: string): BackupEntry[] {
  const cleoDir = join(projectRoot, '.cleo');
  const backupTypes = ['snapshot', 'safety', 'migration'];
  const entries: BackupEntry[] = [];

  for (const btype of backupTypes) {
    const backupDir = join(cleoDir, 'backups', btype);
    if (!existsSync(backupDir)) continue;
    try {
      const files = readdirSync(backupDir).filter((f) => f.endsWith('.meta.json'));
      for (const metaFile of files) {
        try {
          const raw = readFileSync(join(backupDir, metaFile), 'utf-8');
          const meta = JSON.parse(raw) as Partial<BackupEntry>;
          if (meta.backupId && meta.timestamp) {
            entries.push({
              backupId: meta.backupId,
              type: meta.type ?? btype,
              timestamp: meta.timestamp,
              note: meta.note,
              files: meta.files ?? [],
            });
          }
        } catch {
          // skip malformed meta files
        }
      }
    } catch {
      // skip unreadable backup directories
    }
  }

  // Sort newest first
  return entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** Restore from a backup. */
export function restoreBackup(
  projectRoot: string,
  params: { backupId: string; force?: boolean },
): RestoreResult {
  if (!params.backupId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'backupId is required');
  }

  const cleoDir = join(projectRoot, '.cleo');
  const backupTypes = ['snapshot', 'safety', 'migration'];
  let metaPath: string | null = null;
  let backupDir: string | null = null;

  for (const btype of backupTypes) {
    const candidateMeta = join(cleoDir, 'backups', btype, `${params.backupId}.meta.json`);
    if (existsSync(candidateMeta)) {
      metaPath = candidateMeta;
      backupDir = join(cleoDir, 'backups', btype);
      break;
    }
  }

  if (!metaPath || !backupDir) {
    throw new CleoError(ExitCode.NOT_FOUND, `Backup not found: ${params.backupId}`);
  }

  let meta: { files: string[]; timestamp: string };
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {
    throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read backup metadata');
  }

  const restored: string[] = [];
  for (const file of meta.files ?? []) {
    const backupFile = join(backupDir, `${file}.${params.backupId}`);
    if (existsSync(backupFile)) {
      try {
        const content = readFileSync(backupFile);
        writeFileSync(join(cleoDir, file), content);
        restored.push(file);
      } catch {
        // skip files that fail to restore
      }
    }
  }

  return {
    restored: restored.length > 0,
    backupId: params.backupId,
    timestamp: meta.timestamp ?? new Date().toISOString(),
    filesRestored: restored,
  };
}
