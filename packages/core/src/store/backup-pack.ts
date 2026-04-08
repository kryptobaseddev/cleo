/**
 * backup-pack.ts — Bundle creation for .cleobundle.tar.gz portability.
 *
 * Implements the pack side of the T311 export/import lifecycle. Packs
 * project and/or global CLEO databases plus JSON config files into a
 * .cleobundle.tar.gz archive with a manifest, JSON Schema, per-file
 * SHA-256 checksums, and optional AES-256-GCM encryption.
 *
 * Archive layout (§2 of T311 spec):
 *   manifest.json               — FIRST entry (streaming inspect)
 *   schemas/manifest-v1.json    — bundled JSON Schema
 *   databases/                  — VACUUM INTO snapshots of in-scope DBs
 *   json/                       — config.json, project-info.json, project-context.json
 *   global/                     — global-salt (scope global|all)
 *   checksums.sha256             — GNU sha256sum format, covers all except manifest.json
 *
 * @task T347
 * @epic T311
 * @why ADR-038 — portable cross-machine backup. Packs project + global DBs
 *      into a .cleobundle.tar.gz with manifest, checksums, and optional encryption.
 * @what Implements the pack side of the export/import lifecycle.
 * @module store/backup-pack
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { BackupManifest, BackupScope } from '@cleocode/contracts';
import { create as tarCreate } from 'tar';
import { getCleoHome, getProjectRoot } from '../paths.js';
import { encryptBundle } from './backup-crypto.js';
import { getConduitDbPath } from './conduit-sqlite.js';
import { getGlobalSaltPath } from './global-salt.js';
import { getNexusDbPath } from './nexus-sqlite.js';
import { getGlobalSignaldockDbPath } from './signaldock-sqlite.js';
import { assertT310Ready } from './t310-readiness.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input parameters for {@link packBundle}.
 *
 * @task T347
 * @epic T311
 */
export interface PackBundleInput {
  /** Export scope — determines which tiers and files are included. */
  scope: BackupScope;
  /** Absolute path to the project root. Required for 'project' and 'all' scopes. */
  projectRoot?: string;
  /** Target bundle path, e.g. /tmp/myproject-20260408.cleobundle.tar.gz */
  outputPath: string;
  /** Enable AES-256-GCM encryption. Requires passphrase. */
  encrypt?: boolean;
  /** Required when encrypt=true. */
  passphrase?: string;
  /** Optional label written into manifest.backup.projectName. */
  projectName?: string;
}

/**
 * Result of a successful {@link packBundle} call.
 *
 * @task T347
 * @epic T311
 */
export interface PackBundleResult {
  /** Absolute path to the written bundle file. */
  bundlePath: string;
  /** Byte size of the final bundle file on disk. */
  size: number;
  /** Fully-populated manifest that was written into the bundle. */
  manifest: BackupManifest;
  /** Number of data files staged (excludes manifest.json, checksums.sha256, and schema). */
  fileCount: number;
}

// ---------------------------------------------------------------------------
// Path to the bundled JSON Schema (shipped with @cleocode/contracts)
// ---------------------------------------------------------------------------

/** Resolves the schemas directory inside @cleocode/contracts (compile-time helper). */
function resolveContractsSchemasDir(): string {
  // Walk up from this file to find packages/contracts/schemas/manifest-v1.json.
  // In the installed package the file lives at contracts/schemas/manifest-v1.json.
  // In the monorepo it lives at packages/contracts/schemas/manifest-v1.json.
  const candidates = [
    // Monorepo: packages/core/src/store → packages/core/src → packages/core → packages → root
    path.resolve(
      path.dirname(import.meta.url.replace('file://', '')),
      '..',
      '..',
      '..',
      '..',
      'contracts',
      'schemas',
    ),
    // Installed: node_modules/@cleocode/contracts/schemas
    path.resolve(
      path.dirname(import.meta.url.replace('file://', '')),
      '..',
      '..',
      '..',
      '..',
      'node_modules',
      '@cleocode',
      'contracts',
      'schemas',
    ),
    // Fallback: dist sibling
    path.resolve(
      path.dirname(import.meta.url.replace('file://', '')),
      '..',
      '..',
      'node_modules',
      '@cleocode',
      'contracts',
      'schemas',
    ),
  ];
  for (const candidate of candidates) {
    const schemaFile = path.join(candidate, 'manifest-v1.json');
    if (fs.existsSync(schemaFile)) {
      return candidate;
    }
  }
  throw new Error(
    'backup-pack: cannot locate schemas/manifest-v1.json in @cleocode/contracts. ' +
      'Ensure the package is built and installed.',
  );
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of a file on disk.
 *
 * @param filePath - Absolute path to the file to hash.
 * @returns 64-character lowercase hex string.
 */
function sha256OfFile(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/**
 * Compute SHA-256 of a buffer.
 *
 * @param buf - Buffer to hash.
 * @returns 64-character lowercase hex string.
 */
function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Compute the machine fingerprint: SHA-256 of the machine-key file at
 * `getCleoHome()/machine-key`. If the file does not exist, returns a
 * zero-padded sentinel (64 zeros) without throwing.
 *
 * @returns 64-character lowercase hex string.
 */
function sha256OfMachineKey(): string {
  const keyPath = path.join(getCleoHome(), 'machine-key');
  if (!fs.existsSync(keyPath)) {
    return '0'.repeat(64);
  }
  return sha256OfFile(keyPath);
}

/**
 * Read the CalVer version from the @cleocode/cleo package or the monorepo root.
 *
 * @returns Version string, e.g. "2026.4.13". Falls back to "unknown".
 */
function readLocalCleoVersion(): string {
  // Try resolving @cleocode/cleo package.json from this file
  const candidates = [
    path.resolve(
      path.dirname(import.meta.url.replace('file://', '')),
      '..',
      '..',
      '..',
      '..',
      'cleo',
      'package.json',
    ),
    path.resolve(
      path.dirname(import.meta.url.replace('file://', '')),
      '..',
      '..',
      '..',
      '..',
      '..',
      'package.json',
    ),
    path.resolve(path.dirname(import.meta.url.replace('file://', '')), '..', '..', 'package.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as { version?: string };
        if (typeof pkg.version === 'string' && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // continue to next candidate
      }
    }
  }
  return 'unknown';
}

/**
 * Enumerate all tables in a SQLite database and return per-table row counts.
 *
 * Opens the DB read-only. If the file is corrupt or the DB cannot be opened,
 * returns an empty record (does not throw).
 *
 * @param dbPath - Absolute path to a SQLite database file.
 * @returns Map of table name → row count.
 */
function rowCountsForDb(dbPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // Enumerate user tables
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    for (const row of rows) {
      const result = db.prepare(`SELECT COUNT(*) AS cnt FROM "${row.name}"`).get() as
        | { cnt: number }
        | undefined;
      counts[row.name] = result?.cnt ?? 0;
    }
  } catch {
    // Non-throwing: return what we have
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
  return counts;
}

/**
 * Read the most recently applied Drizzle migration identifier from a DB.
 *
 * Looks for a `__drizzle_migrations` table (Drizzle v1 beta naming convention)
 * or the older `drizzle_migrations` table, reads the latest `folder_millis`
 * value (or `created_at` for older schemas). Returns "unknown" if not found.
 *
 * @param dbPath - Absolute path to a SQLite database file.
 * @returns Migration identifier string or "unknown".
 */
function schemaVersionForDb(dbPath: string): string {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    // Check which migration table exists
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%drizzle%'")
      .all() as Array<{ name: string }>;

    if (tables.length === 0) return 'unknown';

    const tableName = tables[0]!.name;

    // Try folder_millis column first (Drizzle v1 convention)
    try {
      const row = db
        .prepare(`SELECT folder_millis FROM "${tableName}" ORDER BY folder_millis DESC LIMIT 1`)
        .get() as { folder_millis: number } | undefined;
      if (row?.folder_millis != null) {
        return String(row.folder_millis);
      }
    } catch {
      // column not present
    }

    // Fallback: created_at column
    try {
      const row = db
        .prepare(`SELECT created_at FROM "${tableName}" ORDER BY created_at DESC LIMIT 1`)
        .get() as { created_at: string | number } | undefined;
      if (row?.created_at != null) {
        return String(row.created_at);
      }
    } catch {
      // column not present
    }

    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Snapshot a SQLite database using `VACUUM INTO '<dest>'`.
 *
 * Opens the source DB, runs a WAL checkpoint, then VACUUM INTO to produce a
 * clean snapshot at destPath. Skips silently if the source does not exist.
 *
 * @param srcPath  - Absolute path to the source DB file.
 * @param destPath - Absolute path for the snapshot output.
 * @returns True if snapshot was created; false if source did not exist.
 */
function vacuumIntoStaging(srcPath: string, destPath: string): boolean {
  if (!fs.existsSync(srcPath)) {
    return false;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(srcPath);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
    return true;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pack a CLEO backup bundle.
 *
 * Creates a `.cleobundle.tar.gz` (or `.enc.cleobundle.tar.gz`) containing
 * VACUUM INTO snapshots of all in-scope databases, JSON config files,
 * the global-salt (for global/all scopes), a manifest.json, a bundled JSON
 * Schema, and a GNU-format checksums.sha256 file.
 *
 * The manifest.json is always written as the first tar entry to enable
 * efficient streaming inspection without reading the full archive (ADR-038 §1).
 *
 * @param input - Pack options (scope, paths, encryption).
 * @returns Result containing bundle path, size, manifest, and file count.
 * @throws {Error} If encrypt=true but no passphrase is provided.
 * @throws {T310MigrationRequiredError} If the project is on the pre-T310 topology.
 *
 * @task T347
 * @epic T311
 *
 * @example
 * ```typescript
 * const result = await packBundle({
 *   scope: 'project',
 *   projectRoot: '/my/project',
 *   outputPath: '/tmp/my-project-20260408.cleobundle.tar.gz',
 * });
 * console.log(result.bundlePath, result.size);
 * ```
 */
export async function packBundle(input: PackBundleInput): Promise<PackBundleResult> {
  // ----- 1. Validate input ------------------------------------------------
  if (input.encrypt === true && !input.passphrase) {
    throw new Error('packBundle: passphrase is required when encrypt=true');
  }

  const includesProject = input.scope === 'project' || input.scope === 'all';
  const includesGlobal = input.scope === 'global' || input.scope === 'all';

  if (includesProject && !input.projectRoot) {
    throw new Error(`packBundle: projectRoot is required for scope "${input.scope}"`);
  }

  const resolvedProjectRoot = includesProject ? (input.projectRoot ?? getProjectRoot()) : '';

  // ----- 2. T310 readiness check (project/all) ----------------------------
  if (includesProject) {
    assertT310Ready(resolvedProjectRoot);
  }

  // ----- 3. Create temp staging directory ---------------------------------
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-pack-'));

  try {
    // Subdirectories
    fs.mkdirSync(path.join(stagingDir, 'databases'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'json'), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, 'schemas'), { recursive: true });
    if (includesGlobal) {
      fs.mkdirSync(path.join(stagingDir, 'global'), { recursive: true });
    }

    // ----- 4a. Copy JSON Schema from @cleocode/contracts ----------------
    const contractsSchemasDir = resolveContractsSchemasDir();
    fs.copyFileSync(
      path.join(contractsSchemasDir, 'manifest-v1.json'),
      path.join(stagingDir, 'schemas', 'manifest-v1.json'),
    );

    // ----- 4b. Stage databases ------------------------------------------
    const stagedDbs: Array<{
      name: 'tasks' | 'brain' | 'conduit' | 'nexus' | 'signaldock';
      srcPath: string;
      stagedPath: string;
    }> = [];

    if (includesProject) {
      const cleoDir = path.join(resolvedProjectRoot, '.cleo');
      for (const name of ['tasks', 'brain'] as const) {
        const srcPath = path.join(cleoDir, `${name}.db`);
        const stagedPath = path.join(stagingDir, 'databases', `${name}.db`);
        const snapped = vacuumIntoStaging(srcPath, stagedPath);
        if (snapped) {
          stagedDbs.push({ name, srcPath, stagedPath });
        } else {
          process.stderr.write(
            `[backup-pack] WARNING: ${name}.db not found at ${srcPath}, skipping.\n`,
          );
        }
      }
      // conduit.db
      const conduitSrc = getConduitDbPath(resolvedProjectRoot);
      const conduitDest = path.join(stagingDir, 'databases', 'conduit.db');
      const conduitSnapped = vacuumIntoStaging(conduitSrc, conduitDest);
      if (conduitSnapped) {
        stagedDbs.push({ name: 'conduit', srcPath: conduitSrc, stagedPath: conduitDest });
      } else {
        process.stderr.write(
          `[backup-pack] WARNING: conduit.db not found at ${conduitSrc}, skipping.\n`,
        );
      }
    }

    if (includesGlobal) {
      // nexus.db
      const nexusSrc = getNexusDbPath();
      const nexusDest = path.join(stagingDir, 'databases', 'nexus.db');
      const nexusSnapped = vacuumIntoStaging(nexusSrc, nexusDest);
      if (nexusSnapped) {
        stagedDbs.push({ name: 'nexus', srcPath: nexusSrc, stagedPath: nexusDest });
      } else {
        process.stderr.write(
          `[backup-pack] WARNING: nexus.db not found at ${nexusSrc}, skipping.\n`,
        );
      }

      // signaldock.db
      const sdSrc = getGlobalSignaldockDbPath();
      const sdDest = path.join(stagingDir, 'databases', 'signaldock.db');
      const sdSnapped = vacuumIntoStaging(sdSrc, sdDest);
      if (sdSnapped) {
        stagedDbs.push({ name: 'signaldock', srcPath: sdSrc, stagedPath: sdDest });
      } else {
        process.stderr.write(
          `[backup-pack] WARNING: signaldock.db not found at ${sdSrc}, skipping.\n`,
        );
      }
    }

    // ----- 4c. Stage JSON files ------------------------------------------
    const stagedJson: Array<{
      filename: 'json/config.json' | 'json/project-info.json' | 'json/project-context.json';
      stagedPath: string;
    }> = [];

    if (includesProject) {
      const cleoDir = path.join(resolvedProjectRoot, '.cleo');
      const jsonFiles = [
        { name: 'config.json', filename: 'json/config.json' as const },
        { name: 'project-info.json', filename: 'json/project-info.json' as const },
        { name: 'project-context.json', filename: 'json/project-context.json' as const },
      ];
      for (const jf of jsonFiles) {
        const srcPath = path.join(cleoDir, jf.name);
        if (!fs.existsSync(srcPath)) {
          process.stderr.write(
            `[backup-pack] WARNING: ${jf.name} not found at ${srcPath}, skipping.\n`,
          );
          continue;
        }
        const destPath = path.join(stagingDir, 'json', jf.name);
        fs.copyFileSync(srcPath, destPath);
        stagedJson.push({ filename: jf.filename, stagedPath: destPath });
      }
    }

    // ----- 4d. Stage global-salt -----------------------------------------
    let globalSaltStaged = false;
    if (includesGlobal) {
      const saltSrc = getGlobalSaltPath();
      if (fs.existsSync(saltSrc)) {
        process.stderr.write(
          '[backup-pack] WARNING: global-salt is included in this bundle. ' +
            'Importing this bundle will overwrite the global-salt on the target machine, ' +
            'invalidating all agent API keys. Agents will require re-authentication.\n',
        );
        fs.copyFileSync(saltSrc, path.join(stagingDir, 'global', 'global-salt'));
        globalSaltStaged = true;
      } else {
        process.stderr.write(
          `[backup-pack] WARNING: global-salt not found at ${saltSrc}, skipping.\n`,
        );
      }
    }

    // ----- 5. Compute SHA-256 checksums for all staged files (excl manifest.json) ---
    // Collect all relative paths under staging (excl manifest.json itself)
    const checksumLines: string[] = [];

    // schemas/manifest-v1.json
    const schemaRelPath = 'schemas/manifest-v1.json';
    const schemaHash = sha256OfFile(path.join(stagingDir, 'schemas', 'manifest-v1.json'));
    checksumLines.push(`${schemaHash}  ${schemaRelPath}`);

    // databases
    for (const db of stagedDbs) {
      const relPath = `databases/${db.name}.db`;
      const hash = sha256OfFile(db.stagedPath);
      checksumLines.push(`${hash}  ${relPath}`);
    }

    // json files
    for (const jf of stagedJson) {
      const hash = sha256OfFile(jf.stagedPath);
      checksumLines.push(`${hash}  ${jf.filename}`);
    }

    // global-salt
    if (globalSaltStaged) {
      const saltHash = sha256OfFile(path.join(stagingDir, 'global', 'global-salt'));
      checksumLines.push(`${saltHash}  global/global-salt`);
    }

    // Write checksums.sha256
    const checksumContent = checksumLines.join('\n') + '\n';
    fs.writeFileSync(path.join(stagingDir, 'checksums.sha256'), checksumContent, 'utf-8');

    // ----- 6. Compute project fingerprint -----------------------------------
    const cleoVersion = readLocalCleoVersion();
    let projectFingerprint: string | undefined;
    if (includesProject) {
      const piPath = path.join(resolvedProjectRoot, '.cleo', 'project-info.json');
      if (fs.existsSync(piPath)) {
        projectFingerprint = sha256OfFile(piPath);
      }
    }

    // ----- 7. Build manifest databases entries ------------------------------
    const databaseEntries: BackupManifest['databases'] = stagedDbs.map((db) => {
      const stat = fs.statSync(db.stagedPath);
      return {
        name: db.name,
        filename: `databases/${db.name}.db`,
        size: stat.size,
        sha256: sha256OfFile(db.stagedPath),
        schemaVersion: schemaVersionForDb(db.stagedPath),
        rowCounts: rowCountsForDb(db.stagedPath),
      };
    });

    // ----- 8. Build manifest json entries -----------------------------------
    const jsonEntries: BackupManifest['json'] = stagedJson.map((jf) => {
      const stat = fs.statSync(jf.stagedPath);
      return {
        filename: jf.filename,
        size: stat.size,
        sha256: sha256OfFile(jf.stagedPath),
      };
    });

    // ----- 9. Build manifest globalFiles entries ----------------------------
    let globalFiles: BackupManifest['globalFiles'];
    if (includesGlobal && globalSaltStaged) {
      const saltStaged = path.join(stagingDir, 'global', 'global-salt');
      const stat = fs.statSync(saltStaged);
      globalFiles = [
        {
          filename: 'global/global-salt',
          size: stat.size,
          sha256: sha256OfFile(saltStaged),
        },
      ];
    }

    // ----- 10. Compute manifestHash (with placeholder empty string) ---------
    // Per spec §4.1 and §5.1 step 11: compute SHA-256 of manifest JSON
    // with integrity.manifestHash set to "". Then set it.
    const manifestWithPlaceholder: BackupManifest = {
      $schema: './schemas/manifest-v1.json',
      manifestVersion: '1.0.0',
      backup: {
        createdAt: new Date().toISOString(),
        createdBy: `cleo v${cleoVersion}`,
        scope: input.scope,
        ...(input.projectName != null ? { projectName: input.projectName } : {}),
        ...(projectFingerprint != null ? { projectFingerprint } : {}),
        machineFingerprint: sha256OfMachineKey(),
        cleoVersion,
        encrypted: input.encrypt === true,
      },
      databases: databaseEntries,
      json: jsonEntries,
      ...(globalFiles != null ? { globalFiles } : {}),
      integrity: {
        algorithm: 'sha256',
        checksumsFile: 'checksums.sha256',
        manifestHash: '',
      },
    };

    const manifestJsonForHash = JSON.stringify(manifestWithPlaceholder);
    const manifestHash = sha256OfBuffer(Buffer.from(manifestJsonForHash, 'utf-8'));

    // Final manifest with real hash
    const manifest: BackupManifest = {
      ...manifestWithPlaceholder,
      integrity: {
        algorithm: 'sha256',
        checksumsFile: 'checksums.sha256',
        manifestHash,
      },
    };

    // Write manifest.json to staging
    const manifestContent = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(path.join(stagingDir, 'manifest.json'), manifestContent, 'utf-8');

    // ----- 11. Create tarball with manifest.json as FIRST entry -----------
    // Spec §2 rule 1: manifest.json MUST be written as the first tar entry.
    // We achieve this by listing manifest.json first in the file list.

    // Collect all relative paths to include, in the required order
    const tarFiles: string[] = [];

    // 1st: manifest.json
    tarFiles.push('manifest.json');

    // 2nd: schemas/
    tarFiles.push('schemas/manifest-v1.json');

    // 3rd: databases/
    for (const db of stagedDbs) {
      tarFiles.push(`databases/${db.name}.db`);
    }

    // 4th: json/
    for (const jf of stagedJson) {
      tarFiles.push(jf.filename);
    }

    // 5th: global/
    if (globalSaltStaged) {
      tarFiles.push('global/global-salt');
    }

    // 6th: checksums.sha256
    tarFiles.push('checksums.sha256');

    const tmpTarPath = `${stagingDir}.tar.gz`;
    await tarCreate(
      {
        gzip: true,
        file: tmpTarPath,
        cwd: stagingDir,
      },
      tarFiles,
    );

    // ----- 12. Optionally encrypt -----------------------------------------
    if (input.encrypt === true && input.passphrase) {
      const tarBuffer = fs.readFileSync(tmpTarPath);
      const encrypted = encryptBundle(tarBuffer, input.passphrase);
      fs.writeFileSync(input.outputPath, encrypted);
      try {
        fs.unlinkSync(tmpTarPath);
      } catch {
        // best-effort cleanup
      }
    } else {
      fs.renameSync(tmpTarPath, input.outputPath);
    }

    // ----- 13. Compute final bundle size and file count -------------------
    const bundleStat = fs.statSync(input.outputPath);
    const fileCount = stagedDbs.length + stagedJson.length + (globalSaltStaged ? 1 : 0);

    return {
      bundlePath: input.outputPath,
      size: bundleStat.size,
      manifest,
      fileCount,
    };
  } finally {
    // ----- Cleanup staging dir (always, even on error) -------------------
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    // Also clean up the tmp tar file if still present (e.g. error before rename)
    try {
      const tmpTarPath = `${stagingDir}.tar.gz`;
      if (fs.existsSync(tmpTarPath)) {
        fs.unlinkSync(tmpTarPath);
      }
    } catch {
      // best-effort
    }
  }
}
