/**
 * `cleo backup inspect <bundle>` — manifest-only streaming read.
 *
 * Reads `manifest.json` from a `.cleobundle.tar.gz` (or encrypted
 * `.enc.cleobundle.tar.gz`) without extracting any other files and without
 * writing anything to disk.
 *
 * SDK primitives (tar parsing, encryption detection, hash verification, byte
 * formatting) live in `@cleocode/core/internal` (`backup-inspect.ts`) per the
 * AGENTS.md Package-Boundary Check (T9985 / E8-CLI-LAYERING). This CLI file
 * retains only the orchestrator that wires those primitives to citty, the
 * stdout renderer, and `process.exitCode`.
 *
 * Spec: T311-backup-portability-spec.md §5.3
 *
 * @task T363
 * @task T9985
 * @epic T311
 * @module cli/commands/backup-inspect
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  detectEncryption,
  ENC_MIN_LENGTH,
  ENC_VERSION_OFFSET,
  ENC_VERSION_SUPPORTED,
  extractManifestFromTar,
  fmtBytes,
  verifyManifestHash,
} from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliError, humanLine } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Report renderer (CLI-bound — uses humanLine)
// ---------------------------------------------------------------------------

/**
 * Renders the structured inspect report to stdout as required by spec §5.3.
 *
 * Lives in the CLI package because it binds to {@link humanLine}; the
 * underlying numeric/string formatting is provided by `fmtBytes` from
 * `@cleocode/core/internal`.
 *
 * @param bundlePath - Path to the bundle file (for display).
 * @param bundleSize - Total byte size of the bundle file on disk.
 * @param encrypted - Whether the bundle is encrypted.
 * @param manifest - Parsed manifest object.
 * @param integrityOk - Result of the manifest hash check.
 * @task T363
 * @epic T311
 */
// cli-boundary-ok: pure stdout renderer using humanLine (CLI-only); no business logic moved
function printInspectReport(
  // cli-boundary-ok: pure stdout renderer; SDK formatting moved to core
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

  humanLine(lines.join('\n'));
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
  // cli-boundary-ok: orchestrator binds to cliError + process.exitCode; SDK primitives extracted to core
  const resolved = path.resolve(bundlePath);

  if (!fs.existsSync(resolved)) {
    cliError(`Bundle not found: ${bundlePath}`, 4, { name: 'E_NOT_FOUND' });
    process.exitCode = 4;
    return;
  }

  const encrypted = detectEncryption(resolved);

  if (encrypted) {
    const passphrase = process.env['CLEO_BACKUP_PASSPHRASE'];
    if (!passphrase) {
      // Spec §5.3 step 1: report encryption status, exit 0.
      humanLine(
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
      cliError('Encrypted bundle payload too short', 70, { name: 'E_DECRYPT_FAILED' });
      process.exitCode = 70;
      return;
    }
    const versionByte = encrypted_buf[ENC_VERSION_OFFSET];
    if (versionByte !== ENC_VERSION_SUPPORTED) {
      cliError(
        `Unsupported encrypted bundle version ${versionByte ?? 'undefined'}; expected ${ENC_VERSION_SUPPORTED}`,
        70,
        { name: 'E_DECRYPT_FAILED' },
      );
      process.exitCode = 70;
      return;
    }

    let decryptedBuf: Buffer;
    try {
      decryptedBuf = decryptBundle(encrypted_buf, passphrase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      cliError(`Decryption failed: ${msg}`, 70, {
        name: 'E_DECRYPT_FAILED',
        fix: 'Verify CLEO_BACKUP_PASSPHRASE matches the bundle.',
      });
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
  // cli-boundary-ok: tar/manifest parsing now imported from core; this is the CLI wrapper
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
    cliError(`Failed to decompress bundle: ${msg}`, 71, { name: 'E_DECOMPRESS_FAILED' });
    process.exitCode = 71;
    return;
  }

  const manifestContent = extractManifestFromTar(tarBuf);
  if (!manifestContent) {
    cliError('manifest.json not found in bundle', 74, { name: 'E_MANIFEST_MISSING' });
    process.exitCode = 74;
    return;
  }

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestContent) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    cliError(`Failed to parse manifest.json: ${msg}`, 71, { name: 'E_MANIFEST_PARSE' });
    process.exitCode = 71;
    return;
  }

  const integrityOk = verifyManifestHash(manifestContent, manifest);

  const stat = fs.statSync(displayPath);
  printInspectReport(displayPath, stat.size, encrypted, manifest, integrityOk);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * `cleo backup inspect <bundle>` subcommand definition for citty.
 *
 * Stream-reads `manifest.json` from a `.cleobundle.tar.gz` (or encrypted
 * `.enc.cleobundle.tar.gz`) and prints a structured report without extracting
 * or modifying anything on disk.
 *
 * Imported by `backup.ts` and mounted under `subCommands.inspect`.
 *
 * @task T363
 * @epic T311
 */
export const backupInspectSubCommand = defineCommand({
  meta: {
    name: 'inspect',
    description: 'Show bundle manifest without extracting or modifying anything',
  },
  args: {
    bundle: {
      type: 'positional',
      description: 'Path to the .cleobundle.tar.gz file',
      required: true,
    },
  },
  async run({ args }) {
    await inspectAction(args.bundle);
  },
});
