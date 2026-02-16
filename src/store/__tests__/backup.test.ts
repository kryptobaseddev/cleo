/**
 * Tests for backup system.
 * @task T4627
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBackup, listBackups, restoreFromBackup } from '../backup.js';

describe('createBackup', () => {
  let tempDir: string;
  let backupDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    backupDir = join(tempDir, 'backups');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a numbered backup (.1)', async () => {
    const sourceFile = join(tempDir, 'todo.json');
    await writeFile(sourceFile, '{"tasks": []}');

    const path = await createBackup(sourceFile, backupDir);
    expect(path).toContain('todo.json.1');

    const content = await readFile(path, 'utf8');
    expect(content).toBe('{"tasks": []}');
  });

  it('rotates existing backups', async () => {
    const sourceFile = join(tempDir, 'todo.json');

    await writeFile(sourceFile, 'version-1');
    await createBackup(sourceFile, backupDir);

    await writeFile(sourceFile, 'version-2');
    await createBackup(sourceFile, backupDir);

    // .1 should have version-2, .2 should have version-1
    const newest = await readFile(join(backupDir, 'todo.json.1'), 'utf8');
    const older = await readFile(join(backupDir, 'todo.json.2'), 'utf8');
    expect(newest).toBe('version-2');
    expect(older).toBe('version-1');
  });

  it('respects maxBackups limit', async () => {
    const sourceFile = join(tempDir, 'data.json');
    const maxBackups = 3;

    for (let i = 1; i <= 5; i++) {
      await writeFile(sourceFile, `version-${i}`);
      await createBackup(sourceFile, backupDir, maxBackups);
    }

    const entries = await readdir(backupDir);
    const backupFiles = entries.filter(e => e.startsWith('data.json.'));
    expect(backupFiles.length).toBeLessThanOrEqual(maxBackups);
  });

  it('creates backup directory if it does not exist', async () => {
    const sourceFile = join(tempDir, 'test.json');
    const nestedBackupDir = join(tempDir, 'nested', 'backups');
    await writeFile(sourceFile, 'content');

    await createBackup(sourceFile, nestedBackupDir);

    const s = await stat(nestedBackupDir);
    expect(s.isDirectory()).toBe(true);
  });

  it('throws for nonexistent source file', async () => {
    const sourceFile = join(tempDir, 'nonexistent.json');
    await expect(createBackup(sourceFile, backupDir)).rejects.toThrow();
  });
});

describe('listBackups', () => {
  let tempDir: string;
  let backupDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    backupDir = join(tempDir, 'backups');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('lists backups sorted by number', async () => {
    const sourceFile = join(tempDir, 'todo.json');

    await writeFile(sourceFile, 'v1');
    await createBackup(sourceFile, backupDir);
    await writeFile(sourceFile, 'v2');
    await createBackup(sourceFile, backupDir);
    await writeFile(sourceFile, 'v3');
    await createBackup(sourceFile, backupDir);

    const backups = await listBackups('todo.json', backupDir);
    expect(backups).toHaveLength(3);
    expect(backups[0]).toContain('todo.json.1');
    expect(backups[1]).toContain('todo.json.2');
    expect(backups[2]).toContain('todo.json.3');
  });

  it('returns empty for nonexistent backup dir', async () => {
    const backups = await listBackups('todo.json', '/nonexistent/path');
    expect(backups).toEqual([]);
  });

  it('ignores non-numbered files', async () => {
    const sourceFile = join(tempDir, 'todo.json');
    await writeFile(sourceFile, 'data');
    await createBackup(sourceFile, backupDir);

    // Create a non-numbered file
    await writeFile(join(backupDir, 'todo.json.bak'), 'garbage');

    const backups = await listBackups('todo.json', backupDir);
    expect(backups).toHaveLength(1);
  });
});

describe('restoreFromBackup', () => {
  let tempDir: string;
  let backupDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    backupDir = join(tempDir, 'backups');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('restores from most recent backup', async () => {
    const sourceFile = join(tempDir, 'todo.json');

    await writeFile(sourceFile, 'original');
    await createBackup(sourceFile, backupDir);

    await writeFile(sourceFile, 'modified');
    await createBackup(sourceFile, backupDir);

    // Now restore
    const targetFile = join(tempDir, 'restored.json');
    const backupPath = await restoreFromBackup('todo.json', backupDir, targetFile);

    expect(backupPath).toContain('todo.json.1');
    const content = await readFile(targetFile, 'utf8');
    expect(content).toBe('modified');
  });

  it('throws when no backups exist', async () => {
    const targetFile = join(tempDir, 'restored.json');
    await expect(
      restoreFromBackup('todo.json', backupDir, targetFile),
    ).rejects.toThrow(/no backups/i);
  });
});
