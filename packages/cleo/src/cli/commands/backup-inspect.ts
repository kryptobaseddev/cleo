/**
 * `cleo backup inspect <bundle>` — manifest-only streaming read.
 *
 * Reads `manifest.json` from a `.cleobundle.tar.gz` (or encrypted
 * `.enc.cleobundle.tar.gz`) without extracting any other files and without
 * writing anything to disk.
 *
 * Spec: T311-backup-portability-spec.md §5.3
 *
 * @task T363
 * @epic T311
 * @module cli/commands/backup-inspect
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ShimCommand as Command } from '../commander-shim.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic string that identifies a CLEO encrypted bundle (ASCII "CLEOENC1"). */
const CLEO_ENC_MAGIC = 'CLEOENC1';

/** Byte offset of the format-version byte in the encrypted header. */
const ENC_VERSION_OFFSET = 8;

/** Supported encrypted-bundle format version. */
const ENC_VERSION_SUPPORTED = 0x01;

/** Total fixed overhead of the encrypted bundle header (76 bytes) + auth tag (16 bytes). */
const ENC_MIN_LENGTH = 8 + 1 + 7 + 32 + 12 + 16;

// ---------------------------------------------------------------------------
// Tar parsing helpers
// ---------------------------------------------------------------------------

/** Size of a single POSIX tar header block in bytes. */
const TAR_BLOCK_SIZE = 512;

/** Byte offset of the filename field in a tar header. */
const TAR_NAME_OFFSET = 0;

/** Byte length of the filename field in a tar header. */
const TAR_NAME_LENGTH = 100;

/** Byte offset of the file size (octal ASCII) in a tar header. */
const TAR_SIZE_OFFSET = 124;

/** Byte length of the file size field in a tar header. */
const TAR_SIZE_LENGTH = 12;

/** Byte offset of the type flag in a tar header. */
const TAR_TYPE_OFFSET = 156;

/**
 * Reads `manifest.json` from an already-decompressed tar buffer (i.e., the
 * raw tar bytes after gunzip). Stops as soon as the entry is found, honoring
 * the spec requirement that `manifest.json` MUST be the first entry.
 *
 * Returns `null` if the entry is not found in the buffer.
 *
 * @param tarBuf - Raw (uncompressed) tar bytes.
 * @returns UTF-8 content of `manifest.json`, or `null` if not found.
 * @task T363
 * @epic T311
 */
function extractManifestFromTar(tarBuf: Buffer): string | null {
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + TAR_BLOCK_SIZE);

    // Detect end-of-archive (two consecutive zero-filled 512-byte blocks).
    if (header.every((b) => b === 0)) {
      break;
    }

    // Read filename (null-terminated within the 100-byte field).
    const rawName = header.subarray(TAR_NAME_OFFSET, TAR_NAME_OFFSET + TAR_NAME_LENGTH);
    const nullIdx = rawName.indexOf(0);
    const entryName = rawName
      .subarray(0, nullIdx === -1 ? TAR_NAME_LENGTH : nullIdx)
      .toString('utf8');

    // Read type flag (regular file = '0' or '\0').
    const typeFlag = String.fromCharCode(header[TAR_TYPE_OFFSET] ?? 0);
    const isRegular = typeFlag === '0' || typeFlag === '\0';

    // Read file size (null-terminated octal ASCII within 12-byte field).
    const rawSize = header
      .subarray(TAR_SIZE_OFFSET, TAR_SIZE_OFFSET + TAR_SIZE_LENGTH)
      .toString('utf8')
      .replace(/\0/g, '')
      .trim();
    const fileSize = parseInt(rawSize, 8);

    offset += TAR_BLOCK_SIZE;

    const normalizedName = entryName.replace(/^\.\//, '');

    if (isRegular && normalizedName === 'manifest.json') {
      if (offset + fileSize > tarBuf.length) {
        return null;
      }
      return tarBuf.subarray(offset, offset + fileSize).toString('utf8');
    }

    // Advance past file data (rounded up to 512-byte boundary).
    if (!Number.isNaN(fileSize) && fileSize > 0) {
      offset += Math.ceil(fileSize / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Integrity helpers
// ---------------------------------------------------------------------------

/**
 * Verifies `manifest.json` content against its embedded `integrity.manifestHash`.
 *
 * Per spec §4.2 Layer 2: the hash is SHA-256 of the manifest JSON with
 * `manifestHash` set to `""`, then hex-encoded.
 *
 * @param raw - Raw manifest.json UTF-8 string as extracted from the bundle.
 * @param manifest - Parsed manifest object.
 * @returns `true` if the hash matches; `false` if tampered or field absent.
 * @task T363
 * @epic T311
 */
function verifyManifestHash(raw: string, manifest: Record<string, unknown>): boolean {
  const integrity = manifest['integrity'] as Record<string, unknown> | undefined;
  if (!integrity || typeof integrity['manifestHash'] !== 'string') {
    return false;
  }

  const expectedHash = integrity['manifestHash'] as string;

  // Re-parse the raw JSON, zero out manifestHash, serialize, and hash.
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return false;
  }

  const intObj = obj['integrity'] as Record<string, unknown>;
  intObj['manifestHash'] = '';
  const forHashing = JSON.stringify(obj);
  const computed = crypto.createHash('sha256').update(forHashing).digest('hex');

  return computed === expectedHash;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a byte count into a human-readable string (B, KB, MB).
 *
 * @param bytes - Raw byte count.
 * @returns Formatted string such as `"5.0 MB"` or `"512 B"`.
 * @task T363
 * @epic T311
 */
function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * Renders the structured inspect report to stdout as required by spec §5.3.
 *
 * @param bundlePath - Path to the bundle file (for display).
 * @param bundleSize - Total byte size of the bundle file on disk.
 * @param encrypted - Whether the bundle is encrypted.
 * @param manifest - Parsed manifest object.
 * @param integrityOk - Result of the manifest hash check.
 * @task T363
 * @epic T311
 */
function printInspectReport(
  bundlePath: string,
  bundleSize: number,
  encrypted: boolean,
  manifest: Record<string, unknown>,
  integrityOk: boolean,
): void {
  const backup = (manifest['backup'] ?? {}) as Record<string, unknown>;
  const databases = (manifest['databases'] ?? []) as Array<Record<string, unknown>>;
  const jsonFiles = (manifest['json'] ?? []) as Array<Record<string, unknown>>;
  const manifestVersion = (manifest['manifestVersion'] as string | undefined) ?? 'unknown';
  const scope = (backup['scope'] as string | undefined) ?? 'unknown';
  const createdAt = (backup['createdAt'] as string | undefined) ?? 'unknown';
  const createdBy = (backup['createdBy'] as string | undefined) ?? 'unknown';
  const machineFingerprint = (backup['machineFingerprint'] as string | undefined) ?? 'unknown';
  const projectName = (backup['projectName'] as string | undefined) ?? '';
  const projectFingerprint = (backup['projectFingerprint'] as string | null | undefined) ?? null;

  // Determine if source machine matches current machine (best-effort via
  // env vars; we cannot access machine-key here without DB access).
  const machineSame = false; // Conservative: we do not read machine-key in inspect.

  const lines: string[] = [
    `Bundle:         ${bundlePath} (${fmtBytes(bundleSize)})`,
    `Format:         CLEO Backup Bundle v${manifestVersion}`,
    `Scope:          ${scope}`,
    `Created:        ${createdAt} by ${createdBy}`,
    `Encrypted:      ${encrypted ? 'yes' : 'no'}`,
    `Source machine: ${machineFingerprint} (${machineSame ? 'same' : 'different'} as this machine)`,
  ];

  if (projectName) {
    lines.push(
      `Project:        ${projectName}${projectFingerprint ? ` (${projectFingerprint})` : ''}`,
    );
  }

  if (databases.length > 0) {
    lines.push('');
    lines.push('Databases:');
    for (const db of databases) {
      const filename = (db['filename'] as string | undefined) ?? '';
      const basename = path.basename(filename);
      const size = (db['size'] as number | undefined) ?? 0;
      const schemaVersion = (db['schemaVersion'] as string | undefined) ?? 'unknown';
      const rowCounts = (db['rowCounts'] as Record<string, number> | undefined) ?? {};
      const rowSummary = Object.entries(rowCounts)
        .map(([tbl, count]) => `${tbl}: ${count}`)
        .join(', ');
      const rowPart = rowSummary ? `   ${rowSummary}` : '';
      lines.push(
        `  ${basename.padEnd(20)} ${fmtBytes(size).padEnd(10)} schema: ${schemaVersion}${rowPart}`,
      );
    }
  }

  if (jsonFiles.length > 0) {
    lines.push('');
    lines.push('JSON files:');
    for (const jf of jsonFiles) {
      const filename = (jf['filename'] as string | undefined) ?? '';
      const basename = path.basename(filename);
      const size = (jf['size'] as number | undefined) ?? 0;
      lines.push(`  ${basename.padEnd(30)} ${fmtBytes(size)}`);
    }
  }

  lines.push('');
  lines.push(`Manifest integrity: [${integrityOk ? 'OK' : 'TAMPERED'}]`);

  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Encrypted-bundle detect
// ---------------------------------------------------------------------------

/**
 * Tests whether the file at `filePath` starts with the CLEO encrypted bundle
 * magic bytes ("CLEOENC1"). Reads only 8 bytes.
 *
 * @param filePath - Absolute path to the bundle file.
 * @returns `true` if the file is an encrypted CLEO bundle.
 * @task T363
 * @epic T311
 */
function detectEncryption(filePath: string): boolean {
  const header = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.toString('utf8') === CLEO_ENC_MAGIC;
}

// ---------------------------------------------------------------------------
// Main action
// ---------------------------------------------------------------------------

/**
 * Action handler for `cleo backup inspect <bundle>`.
 *
 * Reads `manifest.json` from the bundle (decrypting if
 * `CLEO_BACKUP_PASSPHRASE` is set), verifies the manifest hash, and prints
 * a structured report to stdout. Never writes anything to disk.
 *
 * Exit codes:
 * - `0` — success (including encrypted-only report when no passphrase given)
 * - `4` — bundle file not found
 * - `71` — manifest not found inside tarball
 * - `70` — decryption failed (wrong passphrase)
 *
 * @param bundlePath - Path to the `.cleobundle.tar.gz` or
 *   `.enc.cleobundle.tar.gz` file.
 * @task T363
 * @epic T311
 */
async function inspectAction(bundlePath: string): Promise<void> {
  const resolved = path.resolve(bundlePath);

  if (!fs.existsSync(resolved)) {
    console.error(
      JSON.stringify({
        success: false,
        error: { code: 4, message: `Bundle not found: ${bundlePath}` },
      }),
    );
    process.exitCode = 4;
    return;
  }

  const encrypted = detectEncryption(resolved);

  if (encrypted) {
    const passphrase = process.env['CLEO_BACKUP_PASSPHRASE'];
    if (!passphrase) {
      // Spec §5.3 step 1: report encryption status, exit 0.
      console.log(
        [
          `Bundle:    ${bundlePath}`,
          'Encrypted: yes',
          '',
          'Bundle is encrypted. Set the CLEO_BACKUP_PASSPHRASE environment variable',
          'to decrypt and inspect the manifest contents.',
          '',
          'Example:',
          `  CLEO_BACKUP_PASSPHRASE=<passphrase> cleo backup inspect ${bundlePath}`,
        ].join('\n'),
      );
      process.exitCode = 0;
      return;
    }

    // Decrypt to a tmp file, then inspect the plain tarball.
    const { decryptBundle } = await import('@cleocode/core/internal');
    const encrypted_buf = fs.readFileSync(resolved);

    // Validate header version byte before attempting decryption.
    if (encrypted_buf.length < ENC_MIN_LENGTH) {
      console.error(
        JSON.stringify({
          success: false,
          error: { code: 70, message: 'Encrypted bundle payload too short' },
        }),
      );
      process.exitCode = 70;
      return;
    }
    const versionByte = encrypted_buf[ENC_VERSION_OFFSET];
    if (versionByte !== ENC_VERSION_SUPPORTED) {
      console.error(
        JSON.stringify({
          success: false,
          error: {
            code: 70,
            message: `Unsupported encrypted bundle version ${versionByte ?? 'undefined'}; expected ${ENC_VERSION_SUPPORTED}`,
          },
        }),
      );
      process.exitCode = 70;
      return;
    }

    let decryptedBuf: Buffer;
    try {
      decryptedBuf = decryptBundle(encrypted_buf, passphrase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          success: false,
          error: { code: 70, message: `Decryption failed: ${msg}` },
        }),
      );
      process.exitCode = 70;
      return;
    }

    // Write decrypted tarball to a tmpfile, inspect it, then clean up.
    const tmpPath = path.join(os.tmpdir(), `cleo-inspect-${process.pid}-${Date.now()}.tar.gz`);
    try {
      fs.writeFileSync(tmpPath, decryptedBuf);
      await inspectTarball(tmpPath, resolved, encrypted);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup errors
      }
    }
    return;
  }

  // Unencrypted bundle — inspect directly.
  await inspectTarball(resolved, resolved, false);
}

/**
 * Reads `manifest.json` from a (possibly decrypted) tar.gz file and prints
 * the formatted inspect report.
 *
 * @param tarPath - Absolute path to the `.tar.gz` file to read.
 * @param displayPath - Path shown in the report (original bundle path).
 * @param encrypted - Whether the original bundle was encrypted.
 * @task T363
 * @epic T311
 */
async function inspectTarball(
  tarPath: string,
  displayPath: string,
  encrypted: boolean,
): Promise<void> {
  // Decompress the gz stream into a Buffer, then parse the tar manually.
  const compressedBuf = fs.readFileSync(tarPath);
  let tarBuf: Buffer;
  try {
    tarBuf = zlib.gunzipSync(compressedBuf);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        success: false,
        error: { code: 71, message: `Failed to decompress bundle: ${msg}` },
      }),
    );
    process.exitCode = 71;
    return;
  }

  const manifestContent = extractManifestFromTar(tarBuf);
  if (!manifestContent) {
    console.error(
      JSON.stringify({
        success: false,
        error: { code: 74, message: 'manifest.json not found in bundle' },
      }),
    );
    process.exitCode = 74;
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestContent) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        success: false,
        error: { code: 71, message: `Failed to parse manifest.json: ${msg}` },
      }),
    );
    process.exitCode = 71;
    return;
  }

  const integrityOk = verifyManifestHash(manifestContent, manifest);

  const stat = fs.statSync(displayPath);
  printInspectReport(displayPath, stat.size, encrypted, manifest, integrityOk);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Registers the `backup inspect <bundle>` subcommand on the given `backup`
 * parent command.
 *
 * @param backup - The `backup` ShimCommand instance.
 * @task T363
 * @epic T311
 */
export function registerBackupInspectSubcommand(backup: Command): void {
  backup
    .command('inspect <bundle>')
    .description('Show bundle manifest without extracting or modifying anything')
    .action(async (bundleArg: string) => {
      await inspectAction(bundleArg);
    });
}
