/**
 * Tests for pre-migration JSON validation.
 *
 * @task T4725
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { 
  validateSourceFiles, 
  formatValidationResult, 
  checkTaskCountMismatch,
  type JsonValidationResult 
} from '../validate.js';

let tempDir: string;
let cleoDir: string;

describe('validateSourceFiles', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-validate-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('valid JSON files', () => {
    it('validates all files successfully with data', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          version: '2.10.0',
          tasks: [
            { id: 'T001', title: 'Task 1', status: 'pending' },
            { id: 'T002', title: 'Task 2', status: 'done' },
          ],
          _meta: { schemaVersion: '2.10.0' },
        })
      );

      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({
          version: '1.0.0',
          sessions: [
            { id: 'sess-001', name: 'Session 1', status: 'ended' },
          ],
          _meta: { schemaVersion: '1.0.0' },
        })
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({
          _meta: { schemaVersion: '2.4.0' },
          archivedTasks: [
            { id: 'T100', title: 'Archived', status: 'done' },
          ],
        })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.todoJson.valid).toBe(true);
      expect(result.todoJson.exists).toBe(true);
      expect(result.todoJson.count).toBe(2);
      expect(result.sessionsJson.valid).toBe(true);
      expect(result.sessionsJson.count).toBe(1);
      expect(result.archiveJson.valid).toBe(true);
      expect(result.archiveJson.count).toBe(1);
      expect(result.totalTasks).toBe(3); // 2 active + 1 archived
    });

    it('validates successfully with missing optional files', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({
          tasks: [{ id: 'T001', title: 'Task 1', status: 'pending' }],
          _meta: { schemaVersion: '2.10.0' },
        })
      );

      // No sessions.json or archive.json

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.todoJson.valid).toBe(true);
      expect(result.todoJson.count).toBe(1);
      expect(result.sessionsJson.exists).toBe(false);
      expect(result.sessionsJson.valid).toBe(true); // Non-existent is valid
      expect(result.archiveJson.exists).toBe(false);
      expect(result.archiveJson.valid).toBe(true);
    });

    it('accepts archive.json with "tasks" key instead of "archivedTasks"', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [], _meta: { schemaVersion: '2.10.0' } })
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({
          _meta: { schemaVersion: '2.4.0' },
          tasks: [
            { id: 'T100', title: 'Archived', status: 'done' },
            { id: 'T101', title: 'Archived 2', status: 'done' },
          ],
        })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.archiveJson.count).toBe(2);
      expect(result.totalTasks).toBe(2);
    });
  });

  describe('corrupted JSON detection', () => {
    it('detects corrupted todo.json with syntax error', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        '{ "tasks": [ { "id": "T001", "title": "Test", "status": "pending" }, ] }' // Trailing comma
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(false);
      expect(result.todoJson.valid).toBe(false);
      expect(result.todoJson.exists).toBe(true);
      expect(result.todoJson.error).toContain('Parse error');
      expect(result.todoJson.error).toContain('todo.json');
    });

    it('detects corrupted sessions.json', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [], _meta: { schemaVersion: '2.10.0' } })
      );

      await writeFile(
        join(cleoDir, 'sessions.json'),
        '{ invalid json content }'
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(false);
      expect(result.sessionsJson.valid).toBe(false);
      expect(result.sessionsJson.error).toContain('Parse error');
    });

    it('detects corrupted archive.json', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [], _meta: { schemaVersion: '2.10.0' } })
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        '[ "not", "an", "object" ]'
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true); // File parses, just has wrong structure
      expect(result.archiveJson.count).toBe(0); // No valid tasks array found
    });

    it('detects empty file', async () => {
      await writeFile(join(cleoDir, 'todo.json'), '');

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(false);
      expect(result.todoJson.valid).toBe(false);
      expect(result.todoJson.error).toContain('empty');
    });

    it('detects whitespace-only file', async () => {
      await writeFile(join(cleoDir, 'todo.json'), '   \n\t  ');

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(false);
      expect(result.todoJson.valid).toBe(false);
      expect(result.todoJson.error).toContain('whitespace');
    });
  });

  describe('empty JSON warnings', () => {
    it('warns about empty tasks array', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [], _meta: { schemaVersion: '2.10.0' } })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.todoJson.count).toBe(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('todo.json has 0 tasks');
    });

    it('warns about empty sessions array', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [{ id: 'T001', title: 'Test', status: 'pending' }] })
      );

      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({ sessions: [], _meta: { schemaVersion: '1.0.0' } })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('sessions.json has 0 sessions');
    });

    it('warns about empty archive', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [{ id: 'T001', title: 'Test', status: 'pending' }] })
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ archivedTasks: [], _meta: { schemaVersion: '2.4.0' } })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('todo-archive.json has 0 archived tasks');
    });

    it('reports multiple warnings', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [], _meta: { schemaVersion: '2.10.0' } })
      );

      await writeFile(
        join(cleoDir, 'sessions.json'),
        JSON.stringify({ sessions: [] })
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ archivedTasks: [] })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(3);
    });
  });

  describe('multiple file validation', () => {
    it('fails if any file is corrupted', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        JSON.stringify({ tasks: [{ id: 'T001', title: 'Valid', status: 'pending' }] })
      );

      await writeFile(
        join(cleoDir, 'sessions.json'),
        '{ invalid }'
      );

      await writeFile(
        join(cleoDir, 'todo-archive.json'),
        JSON.stringify({ archivedTasks: [{ id: 'T100', title: 'Archived', status: 'done' }] })
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.valid).toBe(false);
      expect(result.todoJson.valid).toBe(true);
      expect(result.sessionsJson.valid).toBe(false);
      expect(result.archiveJson.valid).toBe(true);
    });

    it('includes file paths in error messages', async () => {
      await writeFile(
        join(cleoDir, 'todo.json'),
        '{ "tasks": [invalid] }'
      );

      const result = validateSourceFiles(cleoDir);

      expect(result.todoJson.error).toContain(cleoDir);
      expect(result.todoJson.error).toContain('todo.json');
    });
  });
});

describe('formatValidationResult', () => {
  it('formats successful validation', () => {
    const result: JsonValidationResult = {
      valid: true,
      todoJson: { valid: true, exists: true, count: 5 },
      sessionsJson: { valid: true, exists: true, count: 2 },
      archiveJson: { valid: true, exists: false, count: 0 },
      totalTasks: 5,
      warnings: [],
    };

    const formatted = formatValidationResult(result);

    expect(formatted).toContain('✓ All JSON files are valid');
    expect(formatted).toContain('todo.json: 5 tasks');
    expect(formatted).toContain('sessions.json: 2 sessions');
    expect(formatted).toContain('todo-archive.json: not found');
    expect(formatted).toContain('Total tasks to migrate: 5');
  });

  it('formats failed validation', () => {
    const result: JsonValidationResult = {
      valid: false,
      todoJson: { valid: false, exists: true, count: 0, error: 'Parse error: unexpected token' },
      sessionsJson: { valid: true, exists: false, count: 0 },
      archiveJson: { valid: true, exists: true, count: 3 },
      totalTasks: 3,
      warnings: [],
    };

    const formatted = formatValidationResult(result);

    expect(formatted).toContain('✗ JSON validation failed');
    expect(formatted).toContain('todo.json: ERROR');
    expect(formatted).toContain('Parse error');
  });

  it('includes warnings in output', () => {
    const result: JsonValidationResult = {
      valid: true,
      todoJson: { valid: true, exists: true, count: 0 },
      sessionsJson: { valid: true, exists: false, count: 0 },
      archiveJson: { valid: true, exists: false, count: 0 },
      totalTasks: 0,
      warnings: ['todo.json has 0 tasks', 'sessions.json has 0 sessions'],
    };

    const formatted = formatValidationResult(result);

    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain('⚠ todo.json has 0 tasks');
    expect(formatted).toContain('⚠ sessions.json has 0 sessions');
  });
});

describe('checkTaskCountMismatch', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mismatch-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when no database exists', async () => {
    const warning = checkTaskCountMismatch(cleoDir, 5);
    expect(warning).toBeNull();
  });

  it('returns null when JSON has tasks', async () => {
    // Create a database file
    await writeFile(join(cleoDir, 'tasks.db'), Buffer.alloc(4096));

    const warning = checkTaskCountMismatch(cleoDir, 5);
    expect(warning).toBeNull();
  });

  it('warns when DB exists but JSON has 0 tasks', async () => {
    // Create a database file with content
    await writeFile(join(cleoDir, 'tasks.db'), Buffer.alloc(8192));

    const warning = checkTaskCountMismatch(cleoDir, 0);

    expect(warning).not.toBeNull();
    expect(warning).toContain('WARNING');
    expect(warning).toContain('Existing database');
    expect(warning).toContain('JSON has 0 tasks');
    expect(warning).toContain('data loss');
  });

  it('includes DB size in warning', async () => {
    const dbSize = 16384;
    await writeFile(join(cleoDir, 'tasks.db'), Buffer.alloc(dbSize));

    const warning = checkTaskCountMismatch(cleoDir, 0);

    expect(warning).toContain(`${dbSize} bytes`);
  });
});
