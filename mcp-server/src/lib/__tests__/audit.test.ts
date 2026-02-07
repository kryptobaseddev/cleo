/**
 * Audit Logger Tests
 *
 * @task T2920
 * @task T3102
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import { join } from 'path';
import {
  logMutation,
  logError,
  readAuditLog,
  getAuditStats,
  clearAuditLog,
  archiveAuditLog,
  rotateLog,
  queryAudit,
  AuditEntry,
} from '../audit.js';
import * as config from '../config.js';

const TEST_AUDIT_PATH = join(process.cwd(), '.cleo', 'audit-log.json');

describe('Audit Logger', () => {
  beforeEach(async () => {
    // Clean up any existing audit log
    try {
      await fs.unlink(TEST_AUDIT_PATH);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  afterEach(async () => {
    // Clean up after tests
    try {
      await fs.unlink(TEST_AUDIT_PATH);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  describe('logMutation', () => {
    it('should log a successful mutation', async () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        sessionId: 'session_test',
        domain: 'tasks',
        operation: 'create',
        params: { title: 'Test Task', description: 'Test Description' },
        result: {
          success: true,
          exitCode: 0,
          duration: 123,
        },
        metadata: {
          taskId: 'T2920',
          source: 'mcp',
          gateway: 'cleo_mutate',
        },
      };

      await logMutation(entry);

      // Verify log file exists and contains entry
      const entries = await readAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        domain: 'tasks',
        operation: 'create',
        sessionId: 'session_test',
      });
    });

    it('should log a failed mutation with error', async () => {
      const entry: AuditEntry = {
        timestamp: new Date().toISOString(),
        sessionId: null,
        domain: 'tasks',
        operation: 'update',
        params: { taskId: 'T9999' },
        result: {
          success: false,
          exitCode: 4,
          duration: 45,
        },
        metadata: {
          taskId: 'T9999',
          source: 'mcp',
        },
        error: 'Task not found',
      };

      await logMutation(entry);

      const entries = await readAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].result.success).toBe(false);
      expect(entries[0].error).toBe('Task not found');
    });

    it('should handle multiple mutations', async () => {
      const entries: AuditEntry[] = [
        {
          timestamp: new Date().toISOString(),
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'create',
          params: {},
          result: { success: true, exitCode: 0, duration: 100 },
          metadata: { source: 'mcp' },
        },
        {
          timestamp: new Date().toISOString(),
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'update',
          params: {},
          result: { success: true, exitCode: 0, duration: 50 },
          metadata: { source: 'mcp' },
        },
        {
          timestamp: new Date().toISOString(),
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'complete',
          params: {},
          result: { success: true, exitCode: 0, duration: 75 },
          metadata: { source: 'mcp' },
        },
      ];

      for (const entry of entries) {
        await logMutation(entry);
      }

      const logged = await readAuditLog();
      expect(logged).toHaveLength(3);
    });
  });

  describe('logError', () => {
    it('should log error with full context', async () => {
      await logError(
        'tasks',
        'create',
        new Error('Validation failed'),
        { title: 'Test', description: 'Test' },
        6
      );

      const entries = await readAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].result.success).toBe(false);
      expect(entries[0].result.exitCode).toBe(6);
      expect(entries[0].error).toBe('Validation failed');
    });

    it('should handle string errors', async () => {
      await logError('session', 'start', 'Invalid scope', { scope: 'bad' });

      const entries = await readAuditLog();
      expect(entries[0].error).toBe('Invalid scope');
    });
  });

  describe('readAuditLog', () => {
    beforeEach(async () => {
      // Create test entries
      const testEntries: AuditEntry[] = [
        {
          timestamp: '2026-01-01T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'create',
          params: {},
          result: { success: true, exitCode: 0, duration: 100 },
          metadata: { source: 'mcp' },
        },
        {
          timestamp: '2026-01-02T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'update',
          params: {},
          result: { success: false, exitCode: 4, duration: 50 },
          metadata: { source: 'mcp' },
          error: 'Not found',
        },
        {
          timestamp: '2026-01-03T10:00:00Z',
          sessionId: 'session_2',
          domain: 'session',
          operation: 'start',
          params: {},
          result: { success: true, exitCode: 0, duration: 75 },
          metadata: { source: 'mcp' },
        },
      ];

      for (const entry of testEntries) {
        await logMutation(entry);
      }
    });

    it('should read all entries', async () => {
      const entries = await readAuditLog();
      expect(entries).toHaveLength(3);
    });

    it('should filter by domain', async () => {
      const entries = await readAuditLog({ domain: 'tasks' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.domain === 'tasks')).toBe(true);
    });

    it('should filter by operation', async () => {
      const entries = await readAuditLog({ operation: 'create' });
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe('create');
    });

    it('should filter by success', async () => {
      const entries = await readAuditLog({ success: false });
      expect(entries).toHaveLength(1);
      expect(entries[0].result.success).toBe(false);
    });

    it('should filter by since timestamp', async () => {
      const entries = await readAuditLog({ since: '2026-01-02T00:00:00Z' });
      expect(entries).toHaveLength(2);
    });

    it('should apply limit', async () => {
      const entries = await readAuditLog({ limit: 2 });
      expect(entries).toHaveLength(2);
    });

    it('should return empty array for non-existent log', async () => {
      await clearAuditLog();
      const entries = await readAuditLog();
      expect(entries).toHaveLength(0);
    });
  });

  describe('queryAudit', () => {
    beforeEach(async () => {
      // Create test entries with task IDs and session IDs
      const testEntries: AuditEntry[] = [
        {
          timestamp: '2026-01-01T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'create',
          params: { taskId: 'T100' },
          result: { success: true, exitCode: 0, duration: 100 },
          metadata: { taskId: 'T100', source: 'mcp' },
        },
        {
          timestamp: '2026-01-02T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'update',
          params: { taskId: 'T100' },
          result: { success: true, exitCode: 0, duration: 50 },
          metadata: { taskId: 'T100', source: 'mcp' },
        },
        {
          timestamp: '2026-01-03T10:00:00Z',
          sessionId: 'session_2',
          domain: 'tasks',
          operation: 'create',
          params: { taskId: 'T200' },
          result: { success: true, exitCode: 0, duration: 75 },
          metadata: { taskId: 'T200', source: 'mcp' },
        },
      ];

      for (const entry of testEntries) {
        await logMutation(entry);
      }
    });

    it('should filter by taskId', async () => {
      const entries = await queryAudit({ taskId: 'T100' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.metadata.taskId === 'T100')).toBe(true);
    });

    it('should filter by sessionId', async () => {
      const entries = await queryAudit({ sessionId: 'session_1' });
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => e.sessionId === 'session_1')).toBe(true);
    });

    it('should combine multiple filters', async () => {
      const entries = await queryAudit({
        taskId: 'T100',
        operation: 'create',
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].operation).toBe('create');
      expect(entries[0].metadata.taskId).toBe('T100');
    });
  });

  describe('getAuditStats', () => {
    beforeEach(async () => {
      const testEntries: AuditEntry[] = [
        {
          timestamp: '2026-01-01T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'create',
          params: {},
          result: { success: true, exitCode: 0, duration: 100 },
          metadata: { source: 'mcp' },
        },
        {
          timestamp: '2026-01-02T10:00:00Z',
          sessionId: 'session_1',
          domain: 'tasks',
          operation: 'update',
          params: {},
          result: { success: false, exitCode: 4, duration: 50 },
          metadata: { source: 'mcp' },
          error: 'Error',
        },
        {
          timestamp: '2026-01-03T10:00:00Z',
          sessionId: 'session_1',
          domain: 'session',
          operation: 'start',
          params: {},
          result: { success: true, exitCode: 0, duration: 200 },
          metadata: { source: 'mcp' },
        },
      ];

      for (const entry of testEntries) {
        await logMutation(entry);
      }
    });

    it('should calculate statistics correctly', async () => {
      const stats = await getAuditStats();
      expect(stats.totalEntries).toBe(3);
      expect(stats.successCount).toBe(2);
      expect(stats.failureCount).toBe(1);
      expect(stats.avgDuration).toBeCloseTo(116.67, 1);
    });

    it('should count by domain', async () => {
      const stats = await getAuditStats();
      expect(stats.byDomain.tasks).toBe(2);
      expect(stats.byDomain.session).toBe(1);
    });

    it('should count by operation', async () => {
      const stats = await getAuditStats();
      expect(stats.byOperation['tasks.create']).toBe(1);
      expect(stats.byOperation['tasks.update']).toBe(1);
      expect(stats.byOperation['session.start']).toBe(1);
    });
  });

  describe('clearAuditLog', () => {
    it('should clear audit log', async () => {
      await logMutation({
        timestamp: new Date().toISOString(),
        sessionId: null,
        domain: 'tasks',
        operation: 'create',
        params: {},
        result: { success: true, exitCode: 0, duration: 100 },
        metadata: { source: 'mcp' },
      });

      const count = await clearAuditLog();
      expect(count).toBe(1);

      const entries = await readAuditLog();
      expect(entries).toHaveLength(0);
    });

    it('should return 0 for non-existent log', async () => {
      const count = await clearAuditLog();
      expect(count).toBe(0);
    });
  });

  describe('archiveAuditLog', () => {
    beforeEach(async () => {
      const testEntries: AuditEntry[] = [
        {
          timestamp: '2026-01-01T10:00:00Z',
          sessionId: null,
          domain: 'tasks',
          operation: 'create',
          params: {},
          result: { success: true, exitCode: 0, duration: 100 },
          metadata: { source: 'mcp' },
        },
        {
          timestamp: '2026-01-15T10:00:00Z',
          sessionId: null,
          domain: 'tasks',
          operation: 'update',
          params: {},
          result: { success: true, exitCode: 0, duration: 50 },
          metadata: { source: 'mcp' },
        },
      ];

      for (const entry of testEntries) {
        await logMutation(entry);
      }
    });

    it('should archive old entries', async () => {
      const count = await archiveAuditLog('2026-01-10T00:00:00Z');
      expect(count).toBe(1);

      const entries = await readAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp).toBe('2026-01-15T10:00:00Z');
    });

    it('should return 0 if no entries to archive', async () => {
      const count = await archiveAuditLog('2025-01-01T00:00:00Z');
      expect(count).toBe(0);
    });
  });

  describe('rotateLog', () => {
    it('should rotate existing log', async () => {
      await logMutation({
        timestamp: new Date().toISOString(),
        sessionId: null,
        domain: 'tasks',
        operation: 'create',
        params: {},
        result: { success: true, exitCode: 0, duration: 100 },
        metadata: { source: 'mcp' },
      });

      const archivePath = await rotateLog();
      expect(archivePath).toBeTruthy();
      expect(archivePath).toContain('audit-log-');

      // Original log should not exist
      const entries = await readAuditLog();
      expect(entries).toHaveLength(0);
    });

    it('should return null for non-existent log', async () => {
      const archivePath = await rotateLog();
      expect(archivePath).toBeNull();
    });
  });

  describe('config integration', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should not log when auditLog config is false', async () => {
      // Mock getConfig to return auditLog: false
      jest.spyOn(config, 'getConfig').mockReturnValue({
        ...config.getConfig(),
        auditLog: false,
      });

      // Attempt to log mutation
      await logMutation({
        timestamp: new Date().toISOString(),
        sessionId: null,
        domain: 'tasks',
        operation: 'create',
        params: {},
        result: { success: true, exitCode: 0, duration: 100 },
        metadata: { source: 'mcp' },
      });

      // Verify no log file was created
      const entries = await readAuditLog();
      expect(entries).toHaveLength(0);
    });

    it('should not log errors when auditLog config is false', async () => {
      // Mock getConfig to return auditLog: false
      jest.spyOn(config, 'getConfig').mockReturnValue({
        ...config.getConfig(),
        auditLog: false,
      });

      // Attempt to log error
      await logError('tasks', 'create', 'Test error', { taskId: 'T123' }, 1);

      // Verify no log file was created
      const entries = await readAuditLog();
      expect(entries).toHaveLength(0);
    });

    it('should log when auditLog config is true', async () => {
      // Mock getConfig to return auditLog: true
      jest.spyOn(config, 'getConfig').mockReturnValue({
        ...config.getConfig(),
        auditLog: true,
      });

      // Log mutation
      await logMutation({
        timestamp: new Date().toISOString(),
        sessionId: null,
        domain: 'tasks',
        operation: 'create',
        params: {},
        result: { success: true, exitCode: 0, duration: 100 },
        metadata: { source: 'mcp' },
      });

      // Verify log file was created
      const entries = await readAuditLog();
      expect(entries).toHaveLength(1);
    });
  });
});
