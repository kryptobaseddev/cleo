/**
 * Tests for checksum-based backup verification.
 *
 * @task T4728
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeChecksum, verifyBackup, compareChecksums } from '../checksum.js';

describe('computeChecksum', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-checksum-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computes consistent SHA-256 checksums for identical content', async () => {
    const filePath = join(tempDir, 'test.txt');
    const content = 'Hello, World!';
    await writeFile(filePath, content);

    const checksum1 = await computeChecksum(filePath);
    const checksum2 = await computeChecksum(filePath);

    expect(checksum1).toBe(checksum2);
    expect(checksum1).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex format
  });

  it('produces different checksums for different content', async () => {
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    await writeFile(file1, 'content-a');
    await writeFile(file2, 'content-b');

    const checksum1 = await computeChecksum(file1);
    const checksum2 = await computeChecksum(file2);

    expect(checksum1).not.toBe(checksum2);
  });

  it('detects single byte changes', async () => {
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    await writeFile(file1, 'abcdefghij');
    await writeFile(file2, 'bbcdefghij'); // Single char change

    const checksum1 = await computeChecksum(file1);
    const checksum2 = await computeChecksum(file2);

    expect(checksum1).not.toBe(checksum2);
  });

  it('computes checksum for binary files', async () => {
    const filePath = join(tempDir, 'binary.bin');
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    await writeFile(filePath, buffer);

    const checksum = await computeChecksum(filePath);

    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('throws for nonexistent files', async () => {
    const nonexistent = join(tempDir, 'does-not-exist.txt');

    await expect(computeChecksum(nonexistent)).rejects.toThrow();
  });
});

describe('verifyBackup', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-verify-test-'));
    cleoDir = join(tempDir, '.cleo');
    // Set CLEO_DIR so sqlite module creates DB in our temp dir
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    // Close any open DB connections
    try {
      const { closeDb } = await import('../../../store/sqlite.js');
      closeDb();
    } catch {
      // Ignore if module not loaded
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('verifies identical files as valid', async () => {
    const sourcePath = join(cleoDir, 'tasks.db');
    const backupPath = join(tempDir, 'backup.db');

    // Create a real SQLite database using the sqlite module
    // node:sqlite uses WAL and writes directly to disk; no saveToFile needed
    const { getDb, closeDb: close } = await import('../../../store/sqlite.js');
    close(); // Reset singleton
    await getDb();
    // SQLite has already written to disk via WAL; copy the file directly

    // Copy the database to backup location
    const dbContent = await readFile(sourcePath);
    await writeFile(backupPath, dbContent);

    const result = await verifyBackup(sourcePath, backupPath);

    expect(result.valid).toBe(true);
    expect(result.sourceChecksum).toBe(result.backupChecksum);
    expect(result.error).toBeUndefined();
  });

  it('detects corrupted backup (different content)', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'backup.db');

    await writeFile(sourcePath, 'source content');
    await writeFile(backupPath, 'corrupted content');

    const result = await verifyBackup(sourcePath, backupPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
    expect(result.sourceChecksum).not.toBe(result.backupChecksum);
  });

  it('detects single byte corruption', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'backup.db');

    const content = Buffer.from('SQLite format 3\x00' + 'A'.repeat(500));
    await writeFile(sourcePath, content);

    // Corrupt a single byte in the middle
    const corruptedContent = Buffer.from(content);
    corruptedContent[250] = corruptedContent[250]! ^ 0xff;
    await writeFile(backupPath, corruptedContent);

    const result = await verifyBackup(sourcePath, backupPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
  });

  it('detects same size but different content', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'backup.db');

    // Same length, different content (would pass old size check but fail checksum)
    await writeFile(sourcePath, 'AAAAAAAAAAAAAAAA');
    await writeFile(backupPath, 'BBBBBBBBBBBBBBBB');

    const result = await verifyBackup(sourcePath, backupPath);

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Checksum mismatch');
  });

  it('rejects invalid SQLite files', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'backup.db');

    // Valid SQLite header but corrupted content
    const content = Buffer.from('SQLite format 3\x00' + 'X'.repeat(100));
    await writeFile(sourcePath, content);
    await writeFile(backupPath, content);

    const result = await verifyBackup(sourcePath, backupPath);

    // Should fail SQLite validation even if checksums match
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not a valid SQLite database');
  });

  it('returns both checksums in error case', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'backup.db');

    await writeFile(sourcePath, 'content-a');
    await writeFile(backupPath, 'content-b');

    const result = await verifyBackup(sourcePath, backupPath);

    expect(result.valid).toBe(false);
    expect(result.sourceChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.backupChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceChecksum).not.toBe(result.backupChecksum);
    expect(result.error).toContain(result.sourceChecksum);
    expect(result.error).toContain(result.backupChecksum);
  });

  it('throws for nonexistent source file', async () => {
    const sourcePath = join(tempDir, 'nonexistent.db');
    const backupPath = join(tempDir, 'backup.db');
    await writeFile(backupPath, 'content');

    await expect(verifyBackup(sourcePath, backupPath)).rejects.toThrow();
  });

  it('throws for nonexistent backup file', async () => {
    const sourcePath = join(tempDir, 'source.db');
    const backupPath = join(tempDir, 'nonexistent.db');
    await writeFile(sourcePath, 'content');

    await expect(verifyBackup(sourcePath, backupPath)).rejects.toThrow();
  });
});

describe('compareChecksums', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-compare-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns true for identical files', async () => {
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    await writeFile(file1, 'identical content');
    await writeFile(file2, 'identical content');

    const result = await compareChecksums(file1, file2);

    expect(result).toBe(true);
  });

  it('returns false for different files', async () => {
    const file1 = join(tempDir, 'file1.txt');
    const file2 = join(tempDir, 'file2.txt');
    await writeFile(file1, 'content-a');
    await writeFile(file2, 'content-b');

    const result = await compareChecksums(file1, file2);

    expect(result).toBe(false);
  });

  it('returns true for same file compared to itself', async () => {
    const file1 = join(tempDir, 'file1.txt');
    await writeFile(file1, 'some content');

    const result = await compareChecksums(file1, file1);

    expect(result).toBe(true);
  });

  it('throws for nonexistent files', async () => {
    const file1 = join(tempDir, 'exists.txt');
    const file2 = join(tempDir, 'does-not-exist.txt');
    await writeFile(file1, 'content');

    await expect(compareChecksums(file1, file2)).rejects.toThrow();
  });
});
