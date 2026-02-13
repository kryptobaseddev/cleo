/**
 * Mixed-Writer Safety Tests
 *
 * Validates that native engine and CLI can safely coexist writing to
 * the same data files. Tests concurrent access patterns, lock contention,
 * and data integrity under concurrent writes.
 *
 * @task T4375
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readJsonFile,
  writeJsonFileAtomic,
  withLock,
  withFileLock,
  withMultiLock,
  listBackups,
} from '../../src/engine/store';

describe('Mixed-Writer Safety', () => {
  let tempDir: string;
  let todoPath: string;
  let archivePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-safety-'));
    todoPath = join(tempDir, 'todo.json');
    archivePath = join(tempDir, 'todo-archive.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Sequential writes', () => {
    it('native write followed by read returns correct data', () => {
      const data = { tasks: [{ id: 'T1', title: 'Test' }] };
      writeJsonFileAtomic(todoPath, data);
      const result = readJsonFile<typeof data>(todoPath);
      expect(result).toEqual(data);
    });

    it('multiple sequential writes maintain data integrity', () => {
      for (let i = 0; i < 10; i++) {
        const data = { tasks: [{ id: `T${i}`, title: `Task ${i}`, iteration: i }] };
        writeJsonFileAtomic(todoPath, data);
      }
      const result = readJsonFile<{ tasks: Array<{ iteration: number }> }>(todoPath);
      expect(result?.tasks[0].iteration).toBe(9);
    });

    it('write to non-existent directory path fails gracefully', () => {
      const badPath = join(tempDir, 'nonexistent', 'subdir', 'file.json');
      expect(() => writeJsonFileAtomic(badPath, { test: true })).toThrow();
    });
  });

  describe('Concurrent locked writes (native + native)', () => {
    it('two concurrent withLock calls do not corrupt data', async () => {
      // Initialize file
      writeFileSync(todoPath, JSON.stringify({ counter: 0 }), 'utf-8');

      // Run two concurrent lock-based increments
      const increment = () =>
        withLock<{ counter: number }>(todoPath, (current) => ({
          counter: (current?.counter ?? 0) + 1,
        }));

      const [result1, result2] = await Promise.all([increment(), increment()]);

      // Both should succeed, final value should be 2
      const final = readJsonFile<{ counter: number }>(todoPath);
      expect(final?.counter).toBe(2);
    });

    it('five concurrent withLock calls maintain consistency', async () => {
      writeFileSync(todoPath, JSON.stringify({ counter: 0 }), 'utf-8');

      const increment = () =>
        withLock<{ counter: number }>(todoPath, (current) => ({
          counter: (current?.counter ?? 0) + 1,
        }));

      await Promise.all([
        increment(),
        increment(),
        increment(),
        increment(),
        increment(),
      ]);

      const final = readJsonFile<{ counter: number }>(todoPath);
      expect(final?.counter).toBe(5);
    });

    it('concurrent writes to different files do not interfere', async () => {
      writeFileSync(todoPath, JSON.stringify({ type: 'todo', count: 0 }), 'utf-8');
      writeFileSync(archivePath, JSON.stringify({ type: 'archive', count: 0 }), 'utf-8');

      const incrementTodo = () =>
        withLock<{ type: string; count: number }>(todoPath, (current) => ({
          type: 'todo',
          count: (current?.count ?? 0) + 1,
        }));

      const incrementArchive = () =>
        withLock<{ type: string; count: number }>(archivePath, (current) => ({
          type: 'archive',
          count: (current?.count ?? 0) + 1,
        }));

      await Promise.all([
        incrementTodo(),
        incrementTodo(),
        incrementArchive(),
        incrementArchive(),
      ]);

      const todo = readJsonFile<{ count: number }>(todoPath);
      const archive = readJsonFile<{ count: number }>(archivePath);
      expect(todo?.count).toBe(2);
      expect(archive?.count).toBe(2);
    });
  });

  describe('withFileLock safety', () => {
    it('withFileLock prevents concurrent raw writes', async () => {
      writeFileSync(todoPath, '{"value": 0}', 'utf-8');
      let writes = 0;

      const lockedWrite = (val: number) =>
        withFileLock(todoPath, () => {
          const current = JSON.parse(readFileSync(todoPath, 'utf-8'));
          current.value = val;
          writeFileSync(todoPath, JSON.stringify(current), 'utf-8');
          writes++;
        });

      await Promise.all([lockedWrite(1), lockedWrite(2), lockedWrite(3)]);

      const final = JSON.parse(readFileSync(todoPath, 'utf-8'));
      expect(writes).toBe(3);
      // Final value should be one of 1, 2, or 3 (last writer wins)
      expect([1, 2, 3]).toContain(final.value);
    });

    it('withFileLock creates parent directory if needed', async () => {
      const deepPath = join(tempDir, 'deep', 'nested', 'file.json');
      // withFileLock should create the directory
      await withFileLock(deepPath, () => {
        writeFileSync(deepPath, '{"created": true}', 'utf-8');
      });
      expect(existsSync(deepPath)).toBe(true);
    });

    it('withFileLock creates file if not exists (for lock target)', async () => {
      const newFile = join(tempDir, 'new-file.json');
      expect(existsSync(newFile)).toBe(false);

      await withFileLock(newFile, () => {
        // File should exist now (created for lock target)
        expect(existsSync(newFile)).toBe(true);
      });
    });
  });

  describe('withMultiLock deadlock prevention', () => {
    it('acquires multiple locks in priority order', async () => {
      writeFileSync(todoPath, '{}', 'utf-8');
      writeFileSync(archivePath, '{}', 'utf-8');

      const result = await withMultiLock([archivePath, todoPath], () => {
        // Both files locked - write to both
        writeJsonFileAtomic(todoPath, { moved: false });
        writeJsonFileAtomic(archivePath, { moved: true });
        return 'done';
      });

      expect(result).toBe('done');
      expect(readJsonFile(todoPath)).toEqual({ moved: false });
      expect(readJsonFile(archivePath)).toEqual({ moved: true });
    });

    it('releases locks on error', async () => {
      writeFileSync(todoPath, '{}', 'utf-8');
      writeFileSync(archivePath, '{}', 'utf-8');

      await expect(
        withMultiLock([todoPath, archivePath], () => {
          throw new Error('Simulated failure');
        })
      ).rejects.toThrow('Simulated failure');

      // Should be able to acquire locks again (they were released)
      const result = await withFileLock(todoPath, () => 'reacquired');
      expect(result).toBe('reacquired');
    });

    it('concurrent multilock operations do not deadlock', async () => {
      writeFileSync(todoPath, '{"a": 0}', 'utf-8');
      writeFileSync(archivePath, '{"b": 0}', 'utf-8');

      const op1 = withMultiLock([todoPath, archivePath], () => {
        const todo = readJsonFile<{ a: number }>(todoPath);
        writeJsonFileAtomic(todoPath, { a: (todo?.a ?? 0) + 1 });
        return 'op1';
      });

      const op2 = withMultiLock([todoPath, archivePath], () => {
        const archive = readJsonFile<{ b: number }>(archivePath);
        writeJsonFileAtomic(archivePath, { b: (archive?.b ?? 0) + 1 });
        return 'op2';
      });

      const results = await Promise.all([op1, op2]);
      expect(results).toContain('op1');
      expect(results).toContain('op2');
    });
  });

  describe('Data corruption prevention', () => {
    it('readJsonFile returns null for non-existent file', () => {
      const result = readJsonFile(join(tempDir, 'nonexistent.json'));
      expect(result).toBeNull();
    });

    it('readJsonFile throws on invalid JSON', () => {
      writeFileSync(todoPath, 'not valid json{{{', 'utf-8');
      expect(() => readJsonFile(todoPath)).toThrow();
    });

    it('readJsonFile handles empty file gracefully', () => {
      writeFileSync(todoPath, '', 'utf-8');
      expect(() => readJsonFile(todoPath)).toThrow();
    });

    it('writeJsonFileAtomic does not leave temp files on success', () => {
      writeJsonFileAtomic(todoPath, { clean: true });
      const files = require('fs').readdirSync(tempDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('atomic write preserves original on validation failure', () => {
      // Write initial valid data
      writeJsonFileAtomic(todoPath, { original: true });

      // Attempt write with circular reference (will fail JSON.stringify)
      const circular: any = {};
      circular.self = circular;
      expect(() => writeJsonFileAtomic(todoPath, circular)).toThrow();

      // Original should still be intact
      const result = readJsonFile(todoPath);
      expect(result).toEqual({ original: true });
    });
  });
});
