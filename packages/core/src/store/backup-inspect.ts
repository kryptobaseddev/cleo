/**
 * Backup bundle inspect primitives (SDK).
 *
 * Pure manifest-parsing helpers extracted from
 * `packages/cleo/src/cli/commands/backup-inspect.ts` per the AGENTS.md
 * Package-Boundary Check (T9985 / E8-CLI-LAYERING). These functions never
 * touch process state, citty, or any CLI renderer — they read raw buffers
 * and return values, so they are unit-testable without spinning up the CLI.
 *
 * The CLI command file retains the orchestrator (`inspectAction`,
 * `inspectTarball`, `printInspectReport`) because those bind to
 * {@link cliError}, {@link humanLine}, and `process.exitCode`.
 *
 * Spec: T311-backup-portability-spec.md §5.3.
 *
 * @task T9985
 * @epic T9985 (E8-CLI-LAYERING)
 * @saga T9977 (SG-WORKTRUNK-OWN)
 * @see packages/cleo/src/cli/commands/backup-inspect.ts — CLI orchestrator
 */

import crypto from 'node:crypto';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Magic string that identifies a CLEO encrypted bundle (ASCII "CLEOENC1"). */
export const CLEO_ENC_MAGIC = 'CLEOENC1';

/** Byte offset of the format-version byte in the encrypted header. */
export const ENC_VERSION_OFFSET = 8;

/** Supported encrypted-bundle format version. */
export const ENC_VERSION_SUPPORTED = 0x01;

/** Total fixed overhead of the encrypted bundle header (76 bytes) + auth tag (16 bytes). */
export const ENC_MIN_LENGTH = 8 + 1 + 7 + 32 + 12 + 16;

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
 * @public
 */
export function extractManifestFromTar(tarBuf: Buffer): string | null {
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
 * @public
 */
export function verifyManifestHash(raw: string, manifest: Record<string, unknown>): boolean {
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
 * @public
 */
export function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
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
 * @public
 */
export function detectEncryption(filePath: string): boolean {
  const header = Buffer.alloc(8);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, header, 0, 8, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header.toString('utf8') === CLEO_ENC_MAGIC;
}
