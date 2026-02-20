/**
 * Tests for idempotent migration functionality (T4724)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  migrateJsonToSqlite,
  countJsonRecords,
  type MigrationResult,
} from '../migration-sqlite.js';
import { dbExists, closeDb } from '../sqlite.js';

describe('Idempotent Migration (T4724)', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    
    // Create .cleo directory
    mkdirSync(cleoDir, { recursive: true });
    
    // Create minimal todo.json
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '2.10.0',
        tasks: [
          { id: 'T001', title: 'Test Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
          { id: 'T002', title: 'Test Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
        ],
      }),
    );

    // Create empty archive
    writeFileSync(
      join(cleoDir, 'todo-archive.json'),
      JSON.stringify({
        _meta: { schemaVersion: '2.10.0' },
        archivedTasks: [],
      }),
    );

    // Create empty sessions
    writeFileSync(
      join(cleoDir, 'sessions.json'),
      JSON.stringify({
        version: '1.0.0',
        sessions: [],
      }),
    );
  });

  afterEach(() => {
    closeDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should import data on first migration', async () => {
    const result = await migrateJsonToSqlite(tempDir);

    expect(result.success).toBe(true);
    expect(result.tasksImported).toBe(2);
    expect(result.archivedImported).toBe(0);
    expect(result.sessionsImported).toBe(0);
    expect(dbExists(tempDir)).toBe(true);
  });

  it('should skip migration when data already exists', async () => {
    // First migration
    await migrateJsonToSqlite(tempDir);

    // Second migration (should skip)
    const result = await migrateJsonToSqlite(tempDir);

    expect(result.success).toBe(true);
    expect(result.tasksImported).toBe(0);
    expect(result.warnings).toContain('Database already contains migrated data. Use --force to re-import.');
  });

  it('should re-import with force flag', async () => {
    // First migration
    await migrateJsonToSqlite(tempDir);

    // Second migration with force
    const result = await migrateJsonToSqlite(tempDir, { force: true });

    expect(result.success).toBe(true);
    expect(result.warnings).toContain('Force mode: Re-importing data despite existing database.');
  });

  it('should detect data mismatch', async () => {
    // First migration
    await migrateJsonToSqlite(tempDir);

    // Add more tasks to JSON
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '2.10.0',
        tasks: [
          { id: 'T001', title: 'Test Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
          { id: 'T002', title: 'Test Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
          { id: 'T003', title: 'Extra Task', status: 'pending', priority: 'low', createdAt: new Date().toISOString() },
        ],
      }),
    );

    // Second migration should detect mismatch
    const result = await migrateJsonToSqlite(tempDir);

    expect(result.success).toBe(true);
    expect(result.warnings.some(w => w.includes('Data mismatch detected'))).toBe(true);
    expect(result.jsonCounts?.tasks).toBe(3);
    expect(result.existingCounts?.tasks).toBe(2);
  });

  it('should show diff in dry-run mode without changes', async () => {
    // First migration
    await migrateJsonToSqlite(tempDir);

    // Add more tasks to JSON
    writeFileSync(
      join(cleoDir, 'todo.json'),
      JSON.stringify({
        version: '2.10.0',
        tasks: [
          { id: 'T001', title: 'Test Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
          { id: 'T002', title: 'Test Task 2', status: 'done', priority: 'high', createdAt: new Date().toISOString() },
          { id: 'T003', title: 'Extra Task', status: 'pending', priority: 'low', createdAt: new Date().toISOString() },
        ],
      }),
    );

    // Dry-run should show diff
    const result = await migrateJsonToSqlite(tempDir, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.tasksImported).toBe(0);
    expect(result.warnings.some(w => w.includes('Dry-run'))).toBe(true);
  });

  it('should show what would be imported in dry-run on fresh database', async () => {
    const result = await migrateJsonToSqlite(tempDir, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.tasksImported).toBe(0);
    expect(result.warnings.some(w => w.includes('Would import'))).toBe(true);
    expect(dbExists(tempDir)).toBe(false);
  });

  it('should return counts in migration result', async () => {
    const result = await migrateJsonToSqlite(tempDir);

    expect(result.jsonCounts).toBeDefined();
    expect(result.jsonCounts?.tasks).toBe(2);
    expect(result.jsonCounts?.archived).toBe(0);
    expect(result.jsonCounts?.sessions).toBe(0);
  });

  it('countJsonRecords should count source files correctly', () => {
    const counts = countJsonRecords(cleoDir);

    expect(counts.tasks).toBe(2);
    expect(counts.archived).toBe(0);
    expect(counts.sessions).toBe(0);
  });
});
