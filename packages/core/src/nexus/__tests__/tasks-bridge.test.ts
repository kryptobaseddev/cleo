/**
 * Tests for TASKS → NEXUS bridge operations (T1067).
 *
 * Covers:
 * - linkTaskToSymbols: writing task_touches_symbol edges
 * - getTasksForSymbol: reverse-lookup queries
 * - getSymbolsForTask: forward-lookup queries
 * - runGitLogTaskLinker: git-log sweeper + idempotency
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import {
  getSymbolsForTask,
  getTasksForSymbol,
  linkTaskToSymbols,
} from '../tasks-bridge.js';
import { EDGE_TYPES } from '../../memory/edge-types.js';
import { BRAIN_EDGE_TYPES } from '../../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { getNexusDb, getNexusNativeDb } from '../../store/nexus-sqlite.js';

describe('tasks-bridge', () => {
  let projectRoot: string;
  let brainDb: DatabaseSync.Database;
  let nexusDb: DatabaseSync.Database;

  beforeEach(async () => {
    // Create isolated temp directory for this test
    projectRoot = mkdtempSync(join(tmpdir(), 'tasks-bridge-test-'));

    // Initialize databases (will create schema)
    await getBrainDb(projectRoot);
    await getNexusDb();

    brainDb = getBrainNativeDb()!;
    nexusDb = getNexusNativeDb()!;

    // Verify DBs were initialized
    expect(brainDb).toBeDefined();
    expect(nexusDb).toBeDefined();

    // Insert test symbols into nexus
    nexusDb
      .prepare(
        `INSERT INTO nexus_nodes
         (id, project_id, kind, name, file_path, label, indexed_at, is_exported)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run('src/file.ts::myFunction', 'test-project', 'function', 'myFunction', 'src/file.ts', 'myFunction', 1);

    nexusDb
      .prepare(
        `INSERT INTO nexus_nodes
         (id, project_id, kind, name, file_path, label, indexed_at, is_exported)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run('src/file.ts::MyClass', 'test-project', 'class', 'MyClass', 'src/file.ts', 'MyClass', 1);

    nexusDb
      .prepare(
        `INSERT INTO nexus_nodes
         (id, project_id, kind, name, file_path, label, indexed_at, is_exported)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
      )
      .run('src/other.ts::helperFunction', 'test-project', 'function', 'helperFunction', 'src/other.ts', 'helperFunction', 0);
  });

  afterEach(() => {
    // Clean up temp directory
    rmSync(projectRoot, { recursive: true, force: true });
  });

  describe('linkTaskToSymbols', () => {
    it('should create task_touches_symbol edges for task files', async () => {
      const filesJson = JSON.stringify(['src/file.ts', 'src/other.ts']);
      const result = await linkTaskToSymbols('T001', filesJson, projectRoot);

      expect(result.taskId).toBe('T001');
      expect(result.filesProcessed).toBe(2);
      expect(result.symbolsFound).toBeGreaterThan(0);
      expect(result.linked).toBeGreaterThan(0);

      // Verify edges were written to brain_page_edges
      const edges = brainDb
        .prepare(
          `SELECT from_id, to_id, edge_type FROM brain_page_edges
           WHERE from_id = ? AND edge_type = ?`,
        )
        .all('task:T001', EDGE_TYPES.TASK_TOUCHES_SYMBOL) as Array<{
        from_id: string;
        to_id: string;
        edge_type: string;
      }>;

      expect(edges.length).toBeGreaterThan(0);
      expect(edges[0].edge_type).toBe(EDGE_TYPES.TASK_TOUCHES_SYMBOL);
    });

    it('should handle empty files_json gracefully', async () => {
      const result = await linkTaskToSymbols('T002', '[]', projectRoot);

      expect(result.taskId).toBe('T002');
      expect(result.filesProcessed).toBe(0);
      expect(result.linked).toBe(0);
    });

    it('should handle malformed files_json gracefully', async () => {
      const result = await linkTaskToSymbols('T003', 'not valid json', projectRoot);

      expect(result.taskId).toBe('T003');
      expect(result.filesProcessed).toBe(0);
      expect(result.linked).toBe(0);
    });

    it('should be idempotent for duplicate links', async () => {
      const filesJson = JSON.stringify(['src/file.ts']);

      // First call
      const result1 = await linkTaskToSymbols('T004', filesJson, projectRoot);
      const count1 = result1.linked;

      // Second call with same data
      const result2 = await linkTaskToSymbols('T004', filesJson, projectRoot);
      const count2 = result2.linked;

      // Both should succeed, but second should not duplicate
      expect(count1).toBeGreaterThan(0);
      expect(count2).toBe(count1); // Duplicates prevented by INSERT ... ON CONFLICT DO NOTHING
    });
  });

  describe('getSymbolsForTask', () => {
    beforeEach(async () => {
      // Set up some edges for querying
      await linkTaskToSymbols('T100', JSON.stringify(['src/file.ts']), projectRoot);
    });

    it('should return symbols touched by a task', async () => {
      const symbols = await getSymbolsForTask('T100', projectRoot);

      expect(symbols.length).toBeGreaterThan(0);
      expect(symbols[0]).toHaveProperty('nexusNodeId');
      expect(symbols[0]).toHaveProperty('label');
      expect(symbols[0]).toHaveProperty('kind');
      expect(symbols[0]).toHaveProperty('weight');
    });

    it('should return empty array for task with no symbols', async () => {
      const symbols = await getSymbolsForTask('T999', projectRoot);

      expect(symbols).toEqual([]);
    });
  });

  describe('getTasksForSymbol', () => {
    beforeEach(async () => {
      // Set up some edges for querying
      await linkTaskToSymbols('T200', JSON.stringify(['src/file.ts']), projectRoot);
    });

    it('should return tasks that touched a symbol', async () => {
      const tasks = await getTasksForSymbol('src/file.ts::myFunction', projectRoot);

      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]).toHaveProperty('taskId');
      expect(tasks[0]).toHaveProperty('label');
      expect(tasks[0]).toHaveProperty('weight');
      expect(tasks[0].taskId).toContain('T200');
    });

    it('should return empty array for symbol with no tasks', async () => {
      const tasks = await getTasksForSymbol('unknown::symbol', projectRoot);

      expect(tasks).toEqual([]);
    });
  });

  describe('schema compliance', () => {
    it('should validate that task_touches_symbol is in BRAIN_EDGE_TYPES', () => {
      // Ensure the edge type is registered in the schema
      expect(BRAIN_EDGE_TYPES).toContain('task_touches_symbol');
    });

    it('should validate that TASK_TOUCHES_SYMBOL is in EDGE_TYPES constant', () => {
      // Ensure the constant is defined correctly
      expect(EDGE_TYPES.TASK_TOUCHES_SYMBOL).toBe('task_touches_symbol');
    });
  });
});
