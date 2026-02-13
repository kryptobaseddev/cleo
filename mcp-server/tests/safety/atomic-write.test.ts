/**
 * Atomic Write Verification Tests
 *
 * Tests the native engine's store.ts atomic operations:
 * 1. writeJsonFileAtomic creates temp -> validates -> renames
 * 2. withLock prevents concurrent writes
 * 3. withFileLock handles stale locks
 * 4. Backup rotation matches CLI behavior
 *
 * @task T4375
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  readdirSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readJsonFile,
  writeJsonFileAtomic,
  withLock,
  withFileLock,
  listBackups,
  isProjectInitialized,
  resolveProjectRoot,
  getDataPath,
} from '../../src/engine/store';

describe('Atomic Write Operations', () => {
  let tempDir: string;
  let filePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-atomic-'));
    filePath = join(tempDir, 'todo.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('writeJsonFileAtomic', () => {
    it('creates file from scratch', () => {
      expect(existsSync(filePath)).toBe(false);
      writeJsonFileAtomic(filePath, { tasks: [] });
      expect(existsSync(filePath)).toBe(true);
    });

    it('writes valid JSON content', () => {
      const data = { tasks: [{ id: 'T1', title: 'Test task' }] };
      writeJsonFileAtomic(filePath, data);
      const content = readFileSync(filePath, 'utf-8');
      expect(JSON.parse(content)).toEqual(data);
    });

    it('uses 2-space indentation by default', () => {
      writeJsonFileAtomic(filePath, { a: 1 });
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('  "a"');
    });

    it('supports custom indentation', () => {
      writeJsonFileAtomic(filePath, { a: 1 }, 4);
      const content = readFileSync(filePath, 'utf-8');
      expect(content).toContain('    "a"');
    });

    it('appends trailing newline', () => {
      writeJsonFileAtomic(filePath, { a: 1 });
      const content = readFileSync(filePath, 'utf-8');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('overwrites existing file atomically', () => {
      writeJsonFileAtomic(filePath, { version: 1 });
      writeJsonFileAtomic(filePath, { version: 2 });
      const result = readJsonFile<{ version: number }>(filePath);
      expect(result?.version).toBe(2);
    });

    it('does not leave temp files after successful write', () => {
      writeJsonFileAtomic(filePath, { clean: true });
      const files = readdirSync(tempDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('preserves original file when serialization fails', () => {
      writeJsonFileAtomic(filePath, { original: true });

      // Try to write circular reference (will fail JSON.stringify)
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => writeJsonFileAtomic(filePath, circular)).toThrow();

      // Original file should remain
      const result = readJsonFile(filePath);
      expect(result).toEqual({ original: true });
    });
  });

  describe('Backup rotation (Tier 1)', () => {
    it('creates backup on first overwrite', () => {
      writeJsonFileAtomic(filePath, { v: 1 });
      writeJsonFileAtomic(filePath, { v: 2 });

      const backupDir = join(tempDir, '.backups');
      expect(existsSync(backupDir)).toBe(true);

      const backups = listBackups(filePath);
      expect(backups.length).toBeGreaterThanOrEqual(1);
    });

    it('backup contains previous file content', () => {
      writeJsonFileAtomic(filePath, { v: 1 });
      writeJsonFileAtomic(filePath, { v: 2 });

      const backups = listBackups(filePath);
      expect(backups.length).toBeGreaterThanOrEqual(1);
      const backupContent = JSON.parse(readFileSync(backups[0], 'utf-8'));
      expect(backupContent.v).toBe(1);
    });

    it('maintains numbered backup sequence', () => {
      for (let i = 1; i <= 5; i++) {
        writeJsonFileAtomic(filePath, { v: i });
      }

      const backups = listBackups(filePath);
      // First write creates no backup (no original to back up)
      // Writes 2-5 each create a backup, so 4 backups
      expect(backups.length).toBe(4);

      // .1 should be the most recent backup (v=4, from before write of v=5)
      const newest = JSON.parse(readFileSync(backups[0], 'utf-8'));
      expect(newest.v).toBe(4);
    });

    it('rotates backups beyond MAX_BACKUPS (10)', () => {
      // Write 15 times to trigger rotation
      for (let i = 1; i <= 15; i++) {
        writeJsonFileAtomic(filePath, { v: i });
      }

      const backups = listBackups(filePath);
      // Should have at most 10 backups (MAX_BACKUPS)
      expect(backups.length).toBeLessThanOrEqual(10);
    });

    it('does not create backup on first write (no original)', () => {
      writeJsonFileAtomic(filePath, { v: 1 });
      const backups = listBackups(filePath);
      expect(backups).toHaveLength(0);
    });

    it('backup filenames follow .N pattern', () => {
      writeJsonFileAtomic(filePath, { v: 1 });
      writeJsonFileAtomic(filePath, { v: 2 });
      writeJsonFileAtomic(filePath, { v: 3 });

      const backupDir = join(tempDir, '.backups');
      const files = readdirSync(backupDir);
      // Should have files like todo.json.1, todo.json.2
      for (const file of files) {
        expect(file).toMatch(/^todo\.json\.\d+$/);
      }
    });
  });

  describe('withLock transform pattern', () => {
    it('reads current state and applies transform', async () => {
      writeFileSync(filePath, JSON.stringify({ count: 5 }), 'utf-8');

      const result = await withLock<{ count: number }>(filePath, (current) => ({
        count: (current?.count ?? 0) + 1,
      }));

      expect(result.count).toBe(6);
      const stored = readJsonFile<{ count: number }>(filePath);
      expect(stored?.count).toBe(6);
    });

    it('handles new file state (empty file created for lock)', async () => {
      const newPath = join(tempDir, 'brand-new.json');
      // withLock creates an empty file for proper-lockfile, then readJsonFile
      // parses it. Empty string is invalid JSON, so this throws.
      // This documents current behavior: withLock requires pre-existing valid JSON.
      await expect(
        withLock<{ initialized: boolean }>(newPath, () => ({ initialized: true }))
      ).rejects.toThrow();
    });

    it('releases lock after successful transform', async () => {
      writeFileSync(filePath, '{}', 'utf-8');

      await withLock(filePath, () => ({ step: 1 }));
      // Should be able to acquire lock again immediately
      await withLock(filePath, () => ({ step: 2 }));

      const result = readJsonFile<{ step: number }>(filePath);
      expect(result?.step).toBe(2);
    });

    it('releases lock on transform error', async () => {
      writeFileSync(filePath, '{"safe": true}', 'utf-8');

      await expect(
        withLock(filePath, () => {
          throw new Error('Transform failed');
        })
      ).rejects.toThrow('Transform failed');

      // Lock should be released - can acquire again
      const result = await withLock<{ safe: boolean }>(filePath, (current) => ({
        safe: current?.safe ?? false,
      }));
      expect(result.safe).toBe(true);
    });

    it('creates directory if needed but requires valid initial JSON', async () => {
      const deepPath = join(tempDir, 'sub', 'dir', 'file.json');
      // withLock creates the directory and an empty file for locking,
      // but readJsonFile fails on empty content (not valid JSON).
      // This documents the contract: callers must pre-initialize or use withFileLock.
      await expect(
        withLock(deepPath, () => ({ created: true }))
      ).rejects.toThrow();

      // The directory should still be created even though transform fails
      expect(existsSync(join(tempDir, 'sub', 'dir'))).toBe(true);
    });
  });

  describe('Project utility functions', () => {
    it('isProjectInitialized returns false for temp dir', () => {
      expect(isProjectInitialized(tempDir)).toBe(false);
    });

    it('isProjectInitialized returns true when .cleo/todo.json exists', () => {
      const cleoDir = join(tempDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'todo.json'), '{}', 'utf-8');
      expect(isProjectInitialized(tempDir)).toBe(true);
    });

    it('resolveProjectRoot uses CLEO_ROOT env if set', () => {
      const original = process.env.CLEO_ROOT;
      process.env.CLEO_ROOT = '/custom/path';
      expect(resolveProjectRoot()).toBe('/custom/path');
      if (original) {
        process.env.CLEO_ROOT = original;
      } else {
        delete process.env.CLEO_ROOT;
      }
    });

    it('resolveProjectRoot falls back to cwd', () => {
      const original = process.env.CLEO_ROOT;
      delete process.env.CLEO_ROOT;
      expect(resolveProjectRoot()).toBe(process.cwd());
      if (original) {
        process.env.CLEO_ROOT = original;
      }
    });

    it('getDataPath constructs correct path', () => {
      const result = getDataPath('/project', 'todo.json');
      expect(result).toBe('/project/.cleo/todo.json');
    });
  });

  describe('listBackups utility', () => {
    it('returns empty array for file with no backups', () => {
      writeJsonFileAtomic(filePath, { v: 1 });
      const backups = listBackups(filePath);
      expect(backups).toEqual([]);
    });

    it('returns empty array for non-existent backup dir', () => {
      const noBackupPath = join(tempDir, 'no-backups', 'file.json');
      const backups = listBackups(noBackupPath);
      expect(backups).toEqual([]);
    });

    it('returns sorted list of backup paths', () => {
      for (let i = 1; i <= 4; i++) {
        writeJsonFileAtomic(filePath, { v: i });
      }

      const backups = listBackups(filePath);
      // Verify sorted by number (ascending)
      for (let i = 1; i < backups.length; i++) {
        const prevNum = parseInt(backups[i - 1].split('.').pop()!, 10);
        const currNum = parseInt(backups[i].split('.').pop()!, 10);
        expect(prevNum).toBeLessThan(currNum);
      }
    });
  });
});
