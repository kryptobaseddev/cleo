/**
 * Unit tests for T363: cleo backup inspect subcommand.
 *
 * Builds real (but minimal) `.cleobundle.tar.gz` fixtures in a tmp directory
 * using Node.js built-in `zlib` and manual tar block construction.  No real
 * SQLite or CLEO project directories are touched.
 *
 * Test matrix:
 *   - Inspect on unencrypted bundle prints manifest contents.
 *   - Inspect on encrypted bundle without CLEO_BACKUP_PASSPHRASE prints the
 *     "encrypted" advisory and exits 0.
 *   - Inspect on encrypted bundle with CLEO_BACKUP_PASSPHRASE decrypts and
 *     reads the manifest.
 *   - Inspect on non-existent bundle sets exitCode=4.
 *   - Inspect never writes any file to the project or global tier.
 *
 * @task T363
 * @epic T311
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShimCommand as Command } from '../../commander-shim.js';
import { registerBackupCommand } from '../backup.js';

// ---------------------------------------------------------------------------
// Capture stdout/stderr written via console.log / console.error
// ---------------------------------------------------------------------------

let consoleOutput: string[] = [];
let consoleErrors: string[] = [];

beforeEach(() => {
  consoleOutput = [];
  consoleErrors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  delete process.env['CLEO_BACKUP_PASSPHRASE'];
});

// ---------------------------------------------------------------------------
// Tar / bundle construction helpers
// ---------------------------------------------------------------------------

const TAR_BLOCK = 512;

/**
 * Builds a single POSIX tar header block for a regular file entry.
 *
 * @param name - Entry name (e.g. `"manifest.json"`).
 * @param size - Byte size of the file content.
 * @returns 512-byte Buffer containing the tar header.
 */
function buildTarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  header.write(name.slice(0, 100), 0, 'utf8'); // name
  header.write('0000644\0', 100, 'utf8'); // mode
  header.write('0000000\0', 108, 'utf8'); // uid
  header.write('0000000\0', 116, 'utf8'); // gid
  const sizeOctal = size.toString(8).padStart(11, '0') + '\0';
  header.write(sizeOctal, 124, 'utf8'); // size
  header.write('00000000000\0', 136, 'utf8'); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder (spaces)
  header.write('0', 156, 'utf8'); // type flag: regular file
  header.write('ustar  \0', 257, 'utf8'); // magic

  // Compute and write checksum.
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    checksum += header[i] ?? 0;
  }
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');

  return header;
}

/**
 * Builds a minimal tar.gz buffer containing a single file (`manifest.json`).
 *
 * @param manifestObj - Object to serialize as `manifest.json`.
 * @returns Gzip-compressed tar buffer.
 */
function buildTarGz(manifestObj: Record<string, unknown>): Buffer {
  const content = Buffer.from(JSON.stringify(manifestObj), 'utf8');
  const header = buildTarHeader('manifest.json', content.length);

  // Pad content to a 512-byte boundary.
  const contentPadded = Buffer.alloc(Math.ceil(content.length / TAR_BLOCK) * TAR_BLOCK, 0);
  content.copy(contentPadded);

  // Two zero blocks mark end of archive.
  const eof = Buffer.alloc(TAR_BLOCK * 2, 0);

  const tar = Buffer.concat([header, contentPadded, eof]);
  return zlib.gzipSync(tar);
}

/**
 * Builds a minimal manifest object with a valid `integrity.manifestHash`.
 *
 * @param overrides - Optional fields to merge into the manifest.
 * @returns Manifest object with a correct `integrity.manifestHash`.
 */
function buildManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    $schema: './schemas/manifest-v1.json',
    manifestVersion: '1.0.0',
    backup: {
      createdAt: '2026-04-13T09:14:55Z',
      createdBy: 'cleo v2026.4.13',
      scope: 'project',
      projectName: 'cleotest',
      projectFingerprint: 'a'.repeat(64),
      machineFingerprint: 'b'.repeat(64),
      cleoVersion: '2026.4.13',
      encrypted: false,
    },
    databases: [
      {
        name: 'tasks',
        filename: 'databases/tasks.db',
        size: 5242880,
        sha256: '1'.repeat(64),
        schemaVersion: '20260327000000',
        rowCounts: { tasks: 312, sessions: 14 },
      },
    ],
    json: [
      {
        filename: 'json/config.json',
        size: 2048,
        sha256: '2'.repeat(64),
      },
    ],
    globalFiles: [],
    integrity: {
      algorithm: 'sha256',
      checksumsFile: 'checksums.sha256',
      manifestHash: '',
    },
    ...overrides,
  };

  // Compute and inject the real manifestHash.
  const forHashing = JSON.stringify(base);
  const hash = crypto.createHash('sha256').update(forHashing).digest('hex');
  (base['integrity'] as Record<string, unknown>)['manifestHash'] = hash;

  return base;
}

/**
 * Writes a minimal unencrypted bundle to a tmp file and returns its path.
 *
 * @param tmpDir - Directory for the file.
 * @param overrides - Optional manifest field overrides.
 * @returns Absolute path to the created `.cleobundle.tar.gz` file.
 */
function writeBundleFile(tmpDir: string, overrides: Record<string, unknown> = {}): string {
  const manifest = buildManifest(overrides);
  const buf = buildTarGz(manifest);
  const bundlePath = path.join(tmpDir, 'test.cleobundle.tar.gz');
  fs.writeFileSync(bundlePath, buf);
  return bundlePath;
}

// ---------------------------------------------------------------------------
// Action extractor helper
// ---------------------------------------------------------------------------

/**
 * Builds the ShimCommand tree for `backup` and returns the `inspect`
 * subcommand's action handler.
 *
 * @returns Action function `(bundlePath: string) => Promise<void>`.
 */
function getInspectAction(): (bundlePath: string) => Promise<void> {
  const program = new Command();
  registerBackupCommand(program);
  const backupCmd = program.commands.find((c) => c.name() === 'backup');
  if (!backupCmd) throw new Error('backup command not registered');
  const inspectCmd = backupCmd.commands.find((c) => c.name() === 'inspect');
  if (!inspectCmd?._action) throw new Error('backup inspect subcommand has no action registered');
  return inspectCmd._action as (bundlePath: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('T363 cleo backup inspect', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-inspect-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Non-existent bundle
  // -------------------------------------------------------------------------

  describe('non-existent bundle', () => {
    it('sets exitCode=4 and outputs an error when bundle does not exist', async () => {
      const action = getInspectAction();
      await action('/tmp/does-not-exist-cleo-T363.cleobundle.tar.gz');

      expect(process.exitCode).toBe(4);
      expect(consoleErrors.join('\n')).toContain('"code":4');
    });
  });

  // -------------------------------------------------------------------------
  // Unencrypted bundle
  // -------------------------------------------------------------------------

  describe('unencrypted bundle', () => {
    it('prints manifest contents including scope, databases, json files', async () => {
      const bundlePath = writeBundleFile(tmpDir);
      const action = getInspectAction();
      await action(bundlePath);

      const out = consoleOutput.join('\n');
      // Bundle header
      expect(out).toContain('Bundle:');
      expect(out).toContain('test.cleobundle.tar.gz');
      // Scope and creation info
      expect(out).toContain('project');
      expect(out).toContain('cleo v2026.4.13');
      // Databases section
      expect(out).toContain('tasks.db');
      expect(out).toContain('tasks: 312');
      // JSON files section
      expect(out).toContain('config.json');
      // Integrity
      expect(out).toContain('[OK]');
      // exitCode not set to an error value
      expect(process.exitCode).toBe(0);
    });

    it('reports [TAMPERED] when manifest hash does not match', async () => {
      const manifest = buildManifest();
      // Corrupt the manifestHash field after computing it.
      (manifest['integrity'] as Record<string, unknown>)['manifestHash'] =
        'dead' + 'beef'.repeat(15);
      const buf = buildTarGz(manifest);
      const bundlePath = path.join(tmpDir, 'tampered.cleobundle.tar.gz');
      fs.writeFileSync(bundlePath, buf);

      const action = getInspectAction();
      await action(bundlePath);

      const out = consoleOutput.join('\n');
      expect(out).toContain('[TAMPERED]');
      // Still exits 0 per spec §5.3 step 3
      expect(process.exitCode).toBe(0);
    });

    it('sets exitCode=74 when manifest.json is absent from the tarball', async () => {
      // Build a tar.gz with a different filename — not manifest.json.
      const content = Buffer.from('{"not":"manifest"}', 'utf8');
      const header = buildTarHeader('other-file.json', content.length);
      const contentPadded = Buffer.alloc(TAR_BLOCK, 0);
      content.copy(contentPadded);
      const eof = Buffer.alloc(TAR_BLOCK * 2, 0);
      const tar = Buffer.concat([header, contentPadded, eof]);
      const gz = zlib.gzipSync(tar);
      const bundlePath = path.join(tmpDir, 'nomanifest.cleobundle.tar.gz');
      fs.writeFileSync(bundlePath, gz);

      const action = getInspectAction();
      await action(bundlePath);

      expect(process.exitCode).toBe(74);
      expect(consoleErrors.join('\n')).toContain('manifest.json not found');
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted bundle — no passphrase
  // -------------------------------------------------------------------------

  describe('encrypted bundle without passphrase', () => {
    it('prints encryption advisory and exits 0 without reading manifest', async () => {
      // Build an encrypted bundle using encryptBundle from core.
      const { encryptBundle } = await import('@cleocode/core/internal');
      const manifest = buildManifest();
      const tarGzBuf = buildTarGz(manifest);
      const encBuf = encryptBundle(tarGzBuf, 'test-passphrase-T363');
      const bundlePath = path.join(tmpDir, 'test.enc.cleobundle.tar.gz');
      fs.writeFileSync(bundlePath, encBuf);

      delete process.env['CLEO_BACKUP_PASSPHRASE'];

      const action = getInspectAction();
      await action(bundlePath);

      const out = consoleOutput.join('\n');
      expect(out).toContain('encrypted');
      expect(out).toContain('CLEO_BACKUP_PASSPHRASE');
      // Must NOT reveal manifest contents
      expect(out).not.toContain('tasks.db');
      expect(process.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Encrypted bundle — with passphrase
  // -------------------------------------------------------------------------

  describe('encrypted bundle with CLEO_BACKUP_PASSPHRASE', () => {
    it('decrypts and prints manifest contents when passphrase is correct', async () => {
      const { encryptBundle } = await import('@cleocode/core/internal');
      const manifest = buildManifest();
      const tarGzBuf = buildTarGz(manifest);
      const encBuf = encryptBundle(tarGzBuf, 'my-secret-T363');
      const bundlePath = path.join(tmpDir, 'test.enc.cleobundle.tar.gz');
      fs.writeFileSync(bundlePath, encBuf);

      process.env['CLEO_BACKUP_PASSPHRASE'] = 'my-secret-T363';

      const action = getInspectAction();
      await action(bundlePath);

      const out = consoleOutput.join('\n');
      expect(out).toContain('tasks.db');
      expect(out).toContain('project');
      expect(out).toContain('[OK]');
      expect(process.exitCode).toBe(0);
    });

    it('sets exitCode=70 and prints error when passphrase is wrong', async () => {
      const { encryptBundle } = await import('@cleocode/core/internal');
      const manifest = buildManifest();
      const tarGzBuf = buildTarGz(manifest);
      const encBuf = encryptBundle(tarGzBuf, 'correct-passphrase');
      const bundlePath = path.join(tmpDir, 'test.enc.cleobundle.tar.gz');
      fs.writeFileSync(bundlePath, encBuf);

      process.env['CLEO_BACKUP_PASSPHRASE'] = 'wrong-passphrase';

      const action = getInspectAction();
      await action(bundlePath);

      expect(process.exitCode).toBe(70);
      expect(consoleErrors.join('\n')).toContain('"code":70');
    });
  });

  // -------------------------------------------------------------------------
  // No disk writes
  // -------------------------------------------------------------------------

  describe('zero disk writes', () => {
    it('does not create any new files in tmpDir during inspect', async () => {
      const bundlePath = writeBundleFile(tmpDir);
      const filesBefore = fs.readdirSync(tmpDir);

      const action = getInspectAction();
      await action(bundlePath);

      // The bundle file itself is present; no additional files should appear.
      const filesAfter = fs.readdirSync(tmpDir);
      expect(filesAfter).toEqual(filesBefore);
    });

    it('does not write any files to os.tmpdir() during unencrypted inspect', async () => {
      const bundlePath = writeBundleFile(tmpDir);
      const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cleo-inspect-'));

      const action = getInspectAction();
      await action(bundlePath);

      const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cleo-inspect-'));
      expect(tmpAfter.length).toBe(tmpBefore.length);
    });
  });
});
