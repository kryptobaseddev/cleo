/**
 * Backup and restore core module.
 * @task T4783
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

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

  const filesToBackup = ['todo.json', 'todo-archive.json', 'sessions.json', 'config.json', 'todo-log.jsonl'];
  const backedUp: string[] = [];

  for (const file of filesToBackup) {
    const src = join(cleoDir, file);
    if (existsSync(src)) {
      const dest = join(backupDir, `${file}.${backupId}`);
      try {
        const content = readFileSync(src, 'utf-8');
        writeFileSync(dest, content, 'utf-8');
        backedUp.push(file);
      } catch {
        // skip files that fail to copy
      }
    }
  }

  // Write metadata
  const metaPath = join(backupDir, `${backupId}.meta.json`);
  try {
    writeFileSync(metaPath, JSON.stringify({
      backupId,
      type: btype,
      timestamp,
      note: opts?.note,
      files: backedUp,
    }, null, 2), 'utf-8');
  } catch {
    // non-fatal
  }

  return { backupId, path: backupDir, timestamp, type: btype, files: backedUp };
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
        const content = readFileSync(backupFile, 'utf-8');
        writeFileSync(join(cleoDir, file), content, 'utf-8');
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
