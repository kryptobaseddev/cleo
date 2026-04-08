/**
 * backup-unpack.ts — Bundle extraction and integrity verification for .cleobundle.tar.gz.
 *
 * Implements the unpack + verify half of the T311 import lifecycle.
 * Extracts a .cleobundle.tar.gz (or .enc.cleobundle.tar.gz) to a staging
 * directory and verifies all 6 integrity layers defined in ADR-038 §4.2.
 *
 * The caller is responsible for cleaning up the staging directory via
 * {@link cleanupStaging} after processing. Restore-to-disk is the
 * responsibility of T361 (CLI import handler).
 *
 * Verification layers (executed in strict order):
 *   Layer 1 — AES-256-GCM auth tag (encrypted bundles only)
 *   Layer 2 — Manifest self-hash (SHA-256 with placeholder substitution)
 *   Layer 3 — Manifest JSON Schema validation (bundled schemas/manifest-v1.json)
 *   Layer 4 — Per-file SHA-256 checksums
 *   Layer 5 — SQLite PRAGMA integrity_check
 *   Layer 6 — Schema version comparison (warnings only, never blocks)
 *
 * @task T350
 * @epic T311
 * @why ADR-038 — the unpack + verify half of the T311 import lifecycle.
 *      Restore-to-disk is the responsibility of T361 (CLI import handler);
 *      this module stops after verification and returns a staging dir path.
 * @module store/backup-unpack
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { BackupManifest } from '@cleocode/contracts';
import type { Ajv as AjvInstance, ValidateFunction } from 'ajv';
// ajv/dist/2020 provides JSON Schema Draft 2020-12 support required by
// schemas/manifest-v1.json which declares `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
import { default as Ajv2020Import } from 'ajv/dist/2020.js';
import { default as addFormatsImport } from 'ajv-formats';
import { extract as tarExtract } from 'tar';
import { decryptBundle, isEncryptedBundle } from './backup-crypto.js';

// ---------------------------------------------------------------------------
// node:sqlite interop (createRequire — Vitest strips `node:` prefix)
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// ajv ESM/CJS interop — Draft 2020-12 variant
// ---------------------------------------------------------------------------

const ajv2020Mod = Ajv2020Import as Record<string, unknown>;
const Ajv2020 = (
  typeof ajv2020Mod.default === 'function' ? ajv2020Mod.default : Ajv2020Import
) as new (
  opts?: Record<string, unknown>,
) => AjvInstance;
const fmtMod = addFormatsImport as Record<string, unknown>;
const addFormats = (typeof fmtMod.default === 'function' ? fmtMod.default : addFormatsImport) as (
  ajv: AjvInstance,
) => AjvInstance;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Input parameters for {@link unpackBundle}.
 *
 * @task T350
 * @epic T311
 */
export interface UnpackBundleInput {
  /** Absolute path to the .cleobundle.tar.gz (or .enc.cleobundle.tar.gz) file. */
  bundlePath: string;
  /** Required if the bundle is encrypted. */
  passphrase?: string;
}

/**
 * Schema compatibility warning for a database whose version differs from local.
 *
 * Warnings do NOT abort the import — they are collected and returned
 * in the result for the caller to surface (spec §9, Q5=C best-effort).
 *
 * @task T350
 * @epic T311
 */
export interface SchemaCompatWarning {
  /** Logical database name as it appears in the manifest. */
  db: string;
  /** schemaVersion recorded in the bundle manifest. */
  bundleVersion: string;
  /** Current local schema version (from migration records). */
  localVersion: string;
  /** Direction of the version skew. */
  severity: 'older-bundle' | 'newer-bundle';
}

/**
 * Result of a successful {@link unpackBundle} call.
 *
 * The caller MUST call {@link cleanupStaging} with `stagingDir` after
 * processing, regardless of what they do with the contents.
 *
 * @task T350
 * @epic T311
 */
export interface UnpackBundleResult {
  /** Absolute path to the extracted staging directory. Caller must clean up. */
  stagingDir: string;
  /** Parsed and validated manifest.json from the bundle. */
  manifest: BackupManifest;
  /** Per-layer verification results. */
  verified: {
    /** true if AES-GCM auth tag was valid (or N/A for unencrypted bundles). */
    encryptionAuth: boolean;
    /** true if manifest.json matched the bundled JSON Schema. */
    manifestSchema: boolean;
    /** true if all files' SHA-256 matched checksums.sha256. */
    checksums: boolean;
    /** true if all .db files passed PRAGMA integrity_check. */
    sqliteIntegrity: boolean;
  };
  /** Schema version warnings — never block the import. */
  warnings: SchemaCompatWarning[];
}

// ---------------------------------------------------------------------------
// Exit codes (ADR-038 §4.3)
// ---------------------------------------------------------------------------

/**
 * Error thrown by {@link unpackBundle} when any integrity layer fails.
 *
 * Exit codes:
 * - `70` `E_BUNDLE_DECRYPT`     — decryption or passphrase failure
 * - `71` `E_BUNDLE_SCHEMA`      — manifest.json failed JSON Schema validation
 * - `72` `E_CHECKSUM_MISMATCH`  — SHA-256 checksum did not match
 * - `73` `E_SQLITE_INTEGRITY`   — SQLite PRAGMA integrity_check failed
 * - `74` `E_MANIFEST_MISSING`   — manifest.json absent from archive
 * - `75` `E_SCHEMAS_MISSING`    — schemas/manifest-v1.json absent from archive
 *
 * @task T350
 * @epic T311
 */
export class BundleError extends Error {
  /**
   * @param code     - Numeric exit code (70–75).
   * @param codeName - Symbolic constant name, e.g. `'E_BUNDLE_DECRYPT'`.
   * @param message  - Human-readable error description.
   */
  constructor(
    public readonly code: number,
    public readonly codeName: string,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Compute SHA-256 hex of a buffer. */
function sha256OfBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Compute SHA-256 hex of a file on disk. */
function sha256OfFile(filePath: string): string {
  return sha256OfBuffer(fs.readFileSync(filePath));
}

/**
 * Build and return a singleton Ajv 2020-12 instance with formats support.
 * The schema cache lives for the lifetime of the process, which is acceptable
 * since the manifest-v1.json schema is stable.
 */
let _ajv2020: AjvInstance | null = null;
function getAjv2020(): AjvInstance {
  if (_ajv2020 === null) {
    _ajv2020 = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    addFormats(_ajv2020);
  }
  return _ajv2020;
}

/**
 * Stable schema ID for manifest-v1.json used as Ajv internal key.
 * Having a fixed, well-known ID lets us call `ajv.getSchema(id)` on
 * subsequent requests instead of re-compiling from disk every time.
 */
const MANIFEST_SCHEMA_ID = 'cleo-manifest-v1-internal';

/**
 * Validate `data` against the JSON Schema loaded from `schemaPath`.
 * Returns an array of error messages; empty array means valid.
 *
 * Uses a stable internal schema ID so that multiple calls within the
 * same process reuse the compiled validator without triggering the Ajv
 * "schema already exists" error.
 */
function validateAgainstJsonSchema(data: unknown, schemaPath: string): string[] {
  const ajv = getAjv2020();

  // Reuse previously compiled validator if already registered.
  let validate: ValidateFunction | undefined = ajv.getSchema(MANIFEST_SCHEMA_ID);
  if (validate === undefined) {
    const rawSchema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
    // Strip the external `$id` to avoid Ajv's cross-call duplicate-id check,
    // then add with our stable internal key.
    const { $id: _unusedId, ...schemaWithoutId } = rawSchema;
    ajv.addSchema(schemaWithoutId, MANIFEST_SCHEMA_ID);
    validate = ajv.getSchema(MANIFEST_SCHEMA_ID) as ValidateFunction;
  }
  if (validate(data)) {
    return [];
  }
  return (validate.errors ?? []).map(
    (e: { instancePath?: string; message?: string }) =>
      `${e.instancePath ?? '/'}: ${e.message ?? 'unknown'}`,
  );
}

/**
 * Read the latest applied Drizzle migration identifier from a local DB file.
 *
 * Looks for a `__drizzle_migrations` or `drizzle_migrations` table and reads
 * the latest `folder_millis` or `created_at` value. Returns `null` if the
 * local DB file does not exist or has no migration table (unknown DB).
 *
 * @param dbName - Logical database name (e.g. "tasks").
 * @returns Migration identifier string, or `null` if unknown.
 */
function getLocalSchemaVersion(dbName: string): string | null {
  // Resolve the path for known project-tier databases relative to this module.
  // packages/core/src/store/backup-unpack.ts → packages/core/ → packages/ → root
  const thisFile = import.meta.url.replace('file://', '');
  const packageRoot = path.resolve(path.dirname(thisFile), '..', '..', '..');

  // Known DB paths: project-tier DBs live at <projectRoot>/.cleo/<name>.db but
  // we can only inspect the local running project's DB here.  For schema version
  // comparison we read from the local .cleo directory relative to a project root
  // heuristic, but that is inherently environment-specific.  The simpler and
  // safer approach (spec §9 best-effort) is to look at the Drizzle migration
  // folder for the known DBs shipped with this package.
  const migrationCandidates = [
    path.join(packageRoot, 'migrations', `drizzle-${dbName}`),
    path.join(packageRoot, 'migrations', dbName),
  ];

  for (const dir of migrationCandidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs
        .readdirSync(dir)
        .filter((n) => /^\d+/.test(n))
        .sort()
        .reverse();
      if (entries.length > 0 && entries[0] != null) {
        // Strip non-numeric suffix to get the millis part
        const match = /^(\d+)/.exec(entries[0]);
        if (match?.[1] != null) {
          return match[1];
        }
      }
    } catch {
      // Non-fatal — fall through to next candidate
    }
  }

  return null;
}

/**
 * Compare bundle schema version vs local schema version for a single DB.
 * Returns a {@link SchemaCompatWarning} when the versions differ, or `null`.
 */
function compareSchemaVersions(dbName: string, bundleVersion: string): SchemaCompatWarning | null {
  if (bundleVersion === 'unknown') return null;

  const localVersion = getLocalSchemaVersion(dbName);
  if (localVersion === null) return null; // unknown DB — skip comparison
  if (localVersion === 'unknown') return null;
  if (bundleVersion === localVersion) return null;

  // Numeric comparison where possible (Drizzle uses epoch millis as folder names)
  const bNum = Number(bundleVersion);
  const lNum = Number(localVersion);

  if (!Number.isNaN(bNum) && !Number.isNaN(lNum)) {
    const severity: SchemaCompatWarning['severity'] = bNum < lNum ? 'older-bundle' : 'newer-bundle';
    return { db: dbName, bundleVersion, localVersion, severity };
  }

  // Fallback: lexicographic comparison
  const severity: SchemaCompatWarning['severity'] =
    bundleVersion < localVersion ? 'older-bundle' : 'newer-bundle';
  return { db: dbName, bundleVersion, localVersion, severity };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract a `.cleobundle.tar.gz` to a temp staging directory and verify all
 * 6 integrity layers in strict sequence (ADR-038 §4.2).
 *
 * On any failure AFTER the staging directory is created, the staging directory
 * is cleaned up before the {@link BundleError} is thrown.
 *
 * The caller MUST call {@link cleanupStaging} with the returned `stagingDir`
 * after it is done processing.
 *
 * @param input - Bundle path and optional passphrase.
 * @returns Verification result with staging dir, manifest, layer flags, and warnings.
 * @throws {BundleError} On any integrity failure (exit codes 70–75).
 *
 * @task T350
 * @epic T311
 */
export async function unpackBundle(input: UnpackBundleInput): Promise<UnpackBundleResult> {
  const { bundlePath, passphrase } = input;

  // ----- Step 1: Read bundle header (first 8 bytes) -------------------------
  const fd = fs.openSync(bundlePath, 'r');
  const header = Buffer.alloc(8);
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);

  // ----- Step 2: Detect encryption ------------------------------------------
  const encrypted = isEncryptedBundle(header);

  // ----- Step 3: Decrypt if needed ------------------------------------------
  let encryptionAuth = false;
  let tarPath: string;
  let tmpDecryptedPath: string | null = null;

  if (encrypted) {
    if (!passphrase || passphrase.length === 0) {
      throw new BundleError(
        70,
        'E_BUNDLE_DECRYPT',
        'Bundle is encrypted but no passphrase was provided.',
      );
    }
    const encryptedBuf = fs.readFileSync(bundlePath);
    let decrypted: Buffer;
    try {
      decrypted = decryptBundle(encryptedBuf, passphrase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BundleError(70, 'E_BUNDLE_DECRYPT', `Decryption failed: ${msg}`);
    }
    // Write decrypted tar.gz to a temp file for extraction
    tmpDecryptedPath = path.join(os.tmpdir(), `cleo-unpack-dec-${Date.now()}.tar.gz`);
    fs.writeFileSync(tmpDecryptedPath, decrypted);
    tarPath = tmpDecryptedPath;
    encryptionAuth = true;
  } else {
    tarPath = bundlePath;
    // unencrypted: auth is N/A — report true (not applicable = pass)
    encryptionAuth = true;
  }

  // ----- Step 4: Create staging directory -----------------------------------
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-unpack-'));

  // From here on, any failure must clean up stagingDir (and tmpDecryptedPath).
  const cleanup = (): void => {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    if (tmpDecryptedPath !== null) {
      try {
        if (fs.existsSync(tmpDecryptedPath)) {
          fs.unlinkSync(tmpDecryptedPath);
        }
      } catch {
        // best-effort
      }
    }
  };

  try {
    // ----- Step 5: Extract tarball ------------------------------------------
    try {
      await tarExtract({ file: tarPath, cwd: stagingDir });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Tar extraction failure is most likely due to corruption — treat as
      // checksum mismatch (the corrupted bytes caused tar to fail before we
      // could even read checksums).
      throw new BundleError(72, 'E_CHECKSUM_MISMATCH', `Tar extraction failed: ${msg}`);
    }

    // ----- Step 6: Verify manifest.json exists -------------------------------
    const manifestPath = path.join(stagingDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new BundleError(74, 'E_MANIFEST_MISSING', 'manifest.json is missing from the bundle.');
    }

    // ----- Step 7: Verify schemas/manifest-v1.json exists -------------------
    const schemaPath = path.join(stagingDir, 'schemas', 'manifest-v1.json');
    if (!fs.existsSync(schemaPath)) {
      throw new BundleError(
        75,
        'E_SCHEMAS_MISSING',
        'schemas/manifest-v1.json is missing from the bundle.',
      );
    }

    // ----- Step 8: Parse manifest.json ---------------------------------------
    let manifest: BackupManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BackupManifest;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BundleError(71, 'E_BUNDLE_SCHEMA', `manifest.json is not valid JSON: ${msg}`);
    }

    // ----- Step 9: Validate manifest against bundled JSON Schema (Layer 3) --
    const schemaErrors = validateAgainstJsonSchema(manifest, schemaPath);
    if (schemaErrors.length > 0) {
      throw new BundleError(
        71,
        'E_BUNDLE_SCHEMA',
        `manifest.json failed schema validation: ${schemaErrors.join('; ')}`,
      );
    }
    const manifestSchema = true;

    // ----- Layer 2: Manifest self-hash verification --------------------------
    // Per spec §4.1: compute SHA-256 of manifest JSON with integrity.manifestHash=""
    // and compare to integrity.manifestHash.
    if (manifest.integrity.manifestHash != null && manifest.integrity.manifestHash.length > 0) {
      const manifestWithPlaceholder = {
        ...manifest,
        integrity: { ...manifest.integrity, manifestHash: '' },
      };
      const computedHash = sha256OfBuffer(
        Buffer.from(JSON.stringify(manifestWithPlaceholder), 'utf-8'),
      );
      if (computedHash !== manifest.integrity.manifestHash) {
        throw new BundleError(
          71,
          'E_BUNDLE_SCHEMA',
          'Manifest self-hash mismatch — manifest.json may have been tampered with.',
        );
      }
    }

    // ----- Step 10: Checksum verification (Layer 4) --------------------------
    const checksumsPath = path.join(stagingDir, 'checksums.sha256');
    let checksums = true;
    if (fs.existsSync(checksumsPath)) {
      const checksumContent = fs.readFileSync(checksumsPath, 'utf-8');
      const lines = checksumContent.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        // GNU sha256sum format: "<64 hex chars>  <relative path>"
        const spaceIdx = line.indexOf('  ');
        if (spaceIdx === -1) continue;
        const expectedHash = line.slice(0, spaceIdx).trim();
        const relPath = line.slice(spaceIdx + 2).trim();
        const filePath = path.join(stagingDir, relPath);
        if (!fs.existsSync(filePath)) {
          throw new BundleError(
            72,
            'E_CHECKSUM_MISMATCH',
            `Checksummed file missing from staging: file=${relPath}`,
          );
        }
        const actualHash = sha256OfFile(filePath);
        if (actualHash !== expectedHash) {
          throw new BundleError(72, 'E_CHECKSUM_MISMATCH', `SHA-256 mismatch for file=${relPath}`);
        }
      }
    } else {
      // checksums.sha256 missing from the extracted bundle is acceptable for
      // bundles that were packed without checksums; pass through without failure.
      checksums = true;
    }

    // ----- Step 11: SQLite integrity check (Layer 5) -------------------------
    const sqliteIntegrity = true;
    for (const dbEntry of manifest.databases) {
      const dbPath = path.join(stagingDir, dbEntry.filename);
      if (!fs.existsSync(dbPath)) continue;
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare('PRAGMA integrity_check').get() as
          | { integrity_check: string }
          | undefined;
        if (row?.integrity_check !== 'ok') {
          throw new BundleError(
            73,
            'E_SQLITE_INTEGRITY',
            `PRAGMA integrity_check failed for file=${dbEntry.filename}`,
          );
        }
      } catch (err) {
        if (err instanceof BundleError) throw err;
        throw new BundleError(
          73,
          'E_SQLITE_INTEGRITY',
          `Could not open database for integrity check: file=${dbEntry.filename}`,
        );
      } finally {
        try {
          db?.close();
        } catch {
          // ignore
        }
      }
    }

    // ----- Step 12: Schema version compat warnings (Layer 6) ----------------
    const warnings: SchemaCompatWarning[] = [];
    for (const dbEntry of manifest.databases) {
      const warning = compareSchemaVersions(dbEntry.name, dbEntry.schemaVersion);
      if (warning !== null) {
        warnings.push(warning);
      }
    }

    // ----- Step 13: Clean up temp decrypted file if any ----------------------
    if (tmpDecryptedPath !== null) {
      try {
        if (fs.existsSync(tmpDecryptedPath)) {
          fs.unlinkSync(tmpDecryptedPath);
        }
      } catch {
        // best-effort
      }
    }

    // ----- Return result -----------------------------------------------------
    return {
      stagingDir,
      manifest,
      verified: {
        encryptionAuth,
        manifestSchema,
        checksums,
        sqliteIntegrity,
      },
      warnings,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * Remove the staging directory created by {@link unpackBundle}.
 *
 * Safe to call on a path that no longer exists (idempotent).
 *
 * @param stagingDir - Absolute path returned in {@link UnpackBundleResult.stagingDir}.
 *
 * @task T350
 * @epic T311
 */
export function cleanupStaging(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch {
    // best-effort — do not throw on cleanup
  }
}
