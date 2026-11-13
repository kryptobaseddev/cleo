/**
 * Cloud-synced project folders (T14549).
 *
 * SQLite WAL databases corrupt under file-sync services: the service uploads
 * and restores `cleo.db`, `cleo.db-wal` and `cleo.db-shm` independently and
 * out of order. This module detects a project root inside such a folder from
 * local filesystem signals only (no network, no service APIs) so `cleo doctor`
 * can warn. It never blocks.
 *
 * Signals:
 * - macOS File Provider roots: `~/Library/CloudStorage/<Provider>-<account>`
 *   (Dropbox, OneDrive, Google Drive, Box) and iCloud Drive
 *   (`~/Library/Mobile Documents`).
 * - macOS iCloud "Desktop & Documents": when on, iCloud Drive holds a
 *   `Desktop` and a `Documents` entry (a link to `~/Desktop` / `~/Documents`).
 * - Home-folder roots on every platform: `~/Dropbox`, `~/OneDrive*`,
 *   `~/Google Drive`, `~/iCloudDrive`, and the `OneDrive*` environment
 *   variables Windows sets.
 *
 * @task T14549
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { CheckResult } from '@cleocode/contracts/scaffold-diagnostics';

/** A detected cloud-synced folder containing the project. */
export interface CloudSyncedFolder {
  /** Service name, e.g. `iCloud Drive (Desktop & Documents)`, `Dropbox`. */
  provider: string;
  /** The synced folder root the project sits under. */
  syncRoot: string;
}

/** Inputs for {@link detectCloudSyncedFolder}; tests inject a fake home and env. */
export interface CloudSyncDetectOptions {
  /** Home directory. @defaultValue `os.homedir()` */
  home?: string;
  /** Environment to read `OneDrive*` variables from. @defaultValue `process.env` */
  env?: NodeJS.ProcessEnv;
}

/** Real path when it exists, else the resolved path. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `child` is `parent` or beneath it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep));
}

/** Readable service name for a `~/Library/CloudStorage` entry. */
function cloudStorageProvider(entry: string): string {
  const lower = entry.toLowerCase();
  if (lower.startsWith('googledrive')) return 'Google Drive';
  if (lower.startsWith('onedrive')) return 'OneDrive';
  if (lower.startsWith('dropbox')) return 'Dropbox';
  if (lower.startsWith('box')) return 'Box';
  if (lower.startsWith('icloud')) return 'iCloud Drive';
  return entry.split('-')[0] || entry;
}

/** Candidate synced roots, most specific first. */
function candidateRoots(home: string, env: NodeJS.ProcessEnv): CloudSyncedFolder[] {
  const candidates: CloudSyncedFolder[] = [];
  const iCloudDocs = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  // iCloud Desktop & Documents: the entries exist in iCloud Drive only while
  // the feature is on. A link points at the real folder; a directory (older
  // macOS) means the home folder of that name is the synced one.
  for (const name of ['Desktop', 'Documents']) {
    const entry = join(iCloudDocs, name);
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat) continue;
    candidates.push({
      provider: 'iCloud Drive (Desktop & Documents)',
      syncRoot: stat.isSymbolicLink() ? real(entry) : join(home, name),
    });
  }
  const cloudStorage = join(home, 'Library', 'CloudStorage');
  if (existsSync(cloudStorage)) {
    try {
      for (const entry of readdirSync(cloudStorage)) {
        candidates.push({
          provider: cloudStorageProvider(entry),
          syncRoot: join(cloudStorage, entry),
        });
      }
    } catch {
      // Unreadable: no File Provider signal.
    }
  }
  candidates.push({
    provider: 'iCloud Drive',
    syncRoot: join(home, 'Library', 'Mobile Documents'),
  });
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const value = env[key];
    if (value) candidates.push({ provider: 'OneDrive', syncRoot: value });
  }
  try {
    for (const entry of readdirSync(home)) {
      if (/^onedrive\b/i.test(entry))
        candidates.push({ provider: 'OneDrive', syncRoot: join(home, entry) });
    }
  } catch {
    // Unreadable home: the fixed names below still apply.
  }
  candidates.push(
    { provider: 'Dropbox', syncRoot: join(home, 'Dropbox') },
    { provider: 'Google Drive', syncRoot: join(home, 'Google Drive') },
    { provider: 'iCloud Drive', syncRoot: join(home, 'iCloudDrive') },
  );
  return candidates;
}

/**
 * The cloud-synced folder `projectRoot` sits in, from local signals only.
 *
 * @param projectRoot - Project root to test.
 * @param opts - Injected home and environment.
 * @returns The provider and synced root, or `null` when none applies.
 * @task T14549
 */
export function detectCloudSyncedFolder(
  projectRoot: string,
  opts: CloudSyncDetectOptions = {},
): CloudSyncedFolder | null {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const root = real(projectRoot);
  for (const candidate of candidateRoots(home, env)) {
    for (const syncRoot of new Set([real(candidate.syncRoot), resolve(candidate.syncRoot)])) {
      if (within(syncRoot, root)) return { provider: candidate.provider, syncRoot };
    }
  }
  return null;
}

/**
 * Doctor check: warn (never block) when the project root is inside a
 * cloud-synced folder, where SQLite WAL files corrupt (T14549 AC5).
 *
 * @param projectRoot - Project root.
 * @param opts - Injected home and environment (tests).
 * @returns `warning` naming the service and folder, else `passed`.
 * @task T14549
 */
export function checkCloudSyncedProject(
  projectRoot: string,
  opts: CloudSyncDetectOptions = {},
): CheckResult {
  const found = detectCloudSyncedFolder(projectRoot, opts);
  if (!found) {
    return {
      id: 'cloud_synced_project',
      category: 'configuration',
      status: 'passed',
      message: 'Project is not inside a known cloud-synced folder',
      details: {},
      fix: null,
    };
  }
  return {
    id: 'cloud_synced_project',
    category: 'configuration',
    status: 'warning',
    message:
      `Project ${projectRoot} is inside a ${found.provider} synced folder (${found.syncRoot}). ` +
      'SQLite WAL files (.cleo/cleo.db, -wal, -shm) corrupt under file sync: the service ' +
      'uploads and restores them separately. Move the project out of the synced folder',
    details: { provider: found.provider, syncRoot: found.syncRoot },
    fix: `Move the project to a folder ${found.provider} does not sync (for example ~/projects), then run it from there`,
  };
}
