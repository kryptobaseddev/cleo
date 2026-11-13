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
 *   `Desktop` and a `Documents` link that resolves to `~/Desktop` /
 *   `~/Documents`. A plain directory there is retained cloud data, not proof.
 * - Home-folder roots on every platform: `~/Dropbox`, `~/OneDrive*`,
 *   `~/Google Drive`, `~/iCloudDrive`, and the `OneDrive*` environment
 *   variables Windows sets.
 *
 * @task T14549
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path, { join, resolve } from 'node:path';
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

/** A `node:path` flavour (`path.posix` or `path.win32`). */
export type PathApi = typeof path.posix;

/**
 * Whether `child` is `parent` or beneath it, compared path segment by path
 * segment. On Windows the comparison folds case, and a different drive or
 * share never matches (`D:\app` is not inside `C:\Users\me\Dropbox`).
 *
 * @param parent - Candidate ancestor directory.
 * @param child - Path to test.
 * @param api - Path flavour. @defaultValue the platform's `node:path`
 * @returns `true` when `child` equals or descends from `parent`.
 * @task T14549
 */
export function isPathWithin(parent: string, child: string, api: PathApi = path): boolean {
  const windows = api.sep === '\\';
  const segments = (p: string): string[] => {
    const resolved = api.resolve(p);
    return (windows ? resolved.toLowerCase() : resolved).split(api.sep).filter((s) => s !== '');
  };
  const ps = segments(parent);
  const cs = segments(child);
  return ps.length <= cs.length && ps.every((seg, i) => seg === cs[i]);
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

/** Candidate synced roots, plus the signals that could not be read. */
interface CandidateScan {
  /** Synced roots, most specific first. */
  candidates: CloudSyncedFolder[];
  /** Signal paths an error (EACCES, EPERM, ...) kept from being read. */
  unreadable: string[];
}

/** Error code of a failed filesystem call, for the unreadable list. */
function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : 'error';
}

/** Candidate synced roots. Never throws: an unreadable signal is recorded, not fatal. */
function candidateRoots(home: string, env: NodeJS.ProcessEnv): CandidateScan {
  const candidates: CloudSyncedFolder[] = [];
  const unreadable: string[] = [];
  const iCloudDocs = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  // iCloud Desktop & Documents: while the feature is on, iCloud Drive holds a
  // LINK named Desktop/Documents that resolves to the home folder. Only that
  // proves the local folder is the synced one; a plain directory there is
  // cloud data kept after the feature was turned off (Apple support 109344),
  // next to a fresh, unsynced local folder.
  for (const name of ['Desktop', 'Documents']) {
    const entry = join(iCloudDocs, name);
    try {
      const stat = lstatSync(entry, { throwIfNoEntry: false });
      const local = join(home, name);
      if (stat?.isSymbolicLink() && real(entry) === real(local)) {
        candidates.push({ provider: 'iCloud Drive (Desktop & Documents)', syncRoot: local });
      }
    } catch (err) {
      unreadable.push(`${entry} (${errorCode(err)})`);
    }
  }
  const cloudStorage = join(home, 'Library', 'CloudStorage');
  try {
    if (existsSync(cloudStorage)) {
      for (const entry of readdirSync(cloudStorage)) {
        candidates.push({
          provider: cloudStorageProvider(entry),
          syncRoot: join(cloudStorage, entry),
        });
      }
    }
  } catch (err) {
    unreadable.push(`${cloudStorage} (${errorCode(err)})`);
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
  } catch (err) {
    unreadable.push(`${home} (${errorCode(err)})`);
  }
  candidates.push(
    { provider: 'Dropbox', syncRoot: join(home, 'Dropbox') },
    { provider: 'Google Drive', syncRoot: join(home, 'Google Drive') },
    { provider: 'iCloud Drive', syncRoot: join(home, 'iCloudDrive') },
  );
  return { candidates, unreadable };
}

/** Result of {@link scanCloudSyncedFolder}. */
export interface CloudSyncScan {
  /** The synced folder holding the project, or `null` when no signal matched. */
  found: CloudSyncedFolder | null;
  /** Signals that could not be read; a `null` `found` is then not proof of absence. */
  unreadable: string[];
}

/**
 * Scan the local cloud-sync signals for `projectRoot`. Never throws.
 *
 * @param projectRoot - Project root to test.
 * @param opts - Injected home and environment.
 * @returns The match (if any) and every signal that could not be read.
 * @task T14549
 */
export function scanCloudSyncedFolder(
  projectRoot: string,
  opts: CloudSyncDetectOptions = {},
): CloudSyncScan {
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  const root = real(projectRoot);
  const { candidates, unreadable } = candidateRoots(home, env);
  for (const candidate of candidates) {
    for (const syncRoot of new Set([real(candidate.syncRoot), resolve(candidate.syncRoot)])) {
      if (isPathWithin(syncRoot, root)) {
        return { found: { provider: candidate.provider, syncRoot }, unreadable };
      }
    }
  }
  return { found: null, unreadable };
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
  return scanCloudSyncedFolder(projectRoot, opts).found;
}

/**
 * Doctor check: warn (never block) when the project root is inside a
 * cloud-synced folder, where SQLite WAL files corrupt (T14549 AC5).
 *
 * @param projectRoot - Project root.
 * @param opts - Injected home and environment (tests).
 * @returns `warning` naming the service and folder, `info` when a signal could
 *   not be read and nothing matched, else `passed`.
 * @task T14549
 */
export function checkCloudSyncedProject(
  projectRoot: string,
  opts: CloudSyncDetectOptions = {},
): CheckResult {
  const { found, unreadable } = scanCloudSyncedFolder(projectRoot, opts);
  if (!found && unreadable.length > 0) {
    // Advisory: an unreadable signal never aborts doctor or --fix.
    return {
      id: 'cloud_synced_project',
      category: 'configuration',
      status: 'info',
      message:
        'Cloud-sync check incomplete: could not read ' +
        `${unreadable.join(', ')}; the project may still be inside a synced folder`,
      details: { incomplete: true, unreadable },
      fix: null,
    };
  }
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
    details: { provider: found.provider, syncRoot: found.syncRoot, unreadable },
    fix: `Move the project to a folder ${found.provider} does not sync (for example ~/projects), then run it from there`,
  };
}
