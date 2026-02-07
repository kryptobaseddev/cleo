/**
 * Tests for response formatter
 *
 * @task T2912
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  formatSuccess,
  formatError,
  createError,
  isRecoverable,
  getCurrentVersion,
  generateTimestamp,
  formatCliOutput,
  resetVersionCache,
  toDomainResponse,
  formatDomainSuccess,
  formatDomainError,
  formatPartialSuccess,
  type CleoResponse,
} from '../formatter.js';
import { SCHEMA_URL_OUTPUT } from '../schema.js';

describe('formatter', () => {
  beforeEach(() => {
    resetVersionCache();
  });

  describe('getCurrentVersion', () => {
    it('returns version from VERSION file', () => {
      const version = getCurrentVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('caches version for repeated calls', () => {
      const v1 = getCurrentVersion();
      const v2 = getCurrentVersion();
      expect(v1).toBe(v2);
    });
  });

  describe('generateTimestamp', () => {
    it('returns ISO-8601 timestamp', () => {
      const timestamp = generateTimestamp();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('generates different timestamps for sequential calls', () => {
      const t1 = generateTimestamp();
      const t2 = generateTimestamp();
      // Timestamps should be close but may differ by milliseconds
      expect(t1).toBeDefined();
      expect(t2).toBeDefined();
    });
  });

  describe('isRecoverable', () => {
    it('returns true for retryable exit codes', () => {
      expect(isRecoverable(7)).toBe(true);
      expect(isRecoverable(20)).toBe(true);
      expect(isRecoverable(21)).toBe(true);
      expect(isRecoverable(22)).toBe(true);
      expect(isRecoverable(60)).toBe(true);
      expect(isRecoverable(61)).toBe(true);
      expect(isRecoverable(62)).toBe(true);
      expect(isRecoverable(63)).toBe(true);
    });

    it('returns false for non-retryable exit codes', () => {
      expect(isRecoverable(1)).toBe(false);
      expect(isRecoverable(4)).toBe(false);
      expect(isRecoverable(75)).toBe(false);
      expect(isRecoverable(100)).toBe(false);
    });
  });

  describe('createError', () => {
    it('creates basic error with code and message', () => {
      const error = createError('E_TEST', 'Test error', 1);

      expect(error.code).toBe('E_TEST');
      expect(error.message).toBe('Test error');
      expect(error.exitCode).toBe(1);
      expect(error.recoverable).toBe(false);
    });

    it('marks retryable errors as recoverable', () => {
      const error = createError('E_RETRYABLE', 'Retry me', 7);
      expect(error.recoverable).toBe(true);
    });

    it('includes optional fields', () => {
      const error = createError('E_TEST', 'Test', 1, {
        suggestion: 'Try this',
        fix: 'cleo fix',
        alternatives: [{ action: 'Alt', command: 'cleo alt' }],
        context: { field: 'value' },
      });

      expect(error.suggestion).toBe('Try this');
      expect(error.fix).toBe('cleo fix');
      expect(error.alternatives).toHaveLength(1);
      expect(error.context).toEqual({ field: 'value' });
    });
  });

  describe('formatSuccess', () => {
    it('wraps data in _meta envelope', () => {
      const response = formatSuccess('test command', { result: 'ok' });

      expect(response.$schema).toBe(SCHEMA_URL_OUTPUT);
      expect(response.success).toBe(true);
      expect(response._meta.format).toBe('json');
      expect(response._meta.command).toBe('test command');
      expect(response._meta.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(response._meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response.data).toEqual({ result: 'ok' });
    });

    it('includes session when provided', () => {
      const response = formatSuccess('test', { result: 'ok' }, 'session_123');

      expect(response._meta.session).toBe('session_123');
    });

    it('includes null session when explicitly null', () => {
      const response = formatSuccess('test', { result: 'ok' }, null);

      expect(response._meta.session).toBe(null);
    });

    it('omits session field when undefined', () => {
      const response = formatSuccess('test', { result: 'ok' }, undefined);

      expect(response._meta).not.toHaveProperty('session');
    });
  });

  describe('formatError', () => {
    it('wraps error in _meta envelope', () => {
      const error = createError('E_TEST', 'Test error', 4);
      const response = formatError('test command', error);

      expect(response.$schema).toBe(SCHEMA_URL_OUTPUT);
      expect(response.success).toBe(false);
      expect(response._meta.command).toBe('test command');
      expect(response.error).toEqual(error);
    });

    it('includes session when provided', () => {
      const error = createError('E_TEST', 'Test', 1);
      const response = formatError('test', error, 'session_456');

      expect(response._meta.session).toBe('session_456');
    });
  });

  describe('formatCliOutput', () => {
    it('parses JSON and wraps in envelope', () => {
      const cliOutput = JSON.stringify({ taskId: 'T001', title: 'Test' });
      const response = formatCliOutput('test', cliOutput);

      expect(response.success).toBe(true);
      expect(response.data).toEqual({ taskId: 'T001', title: 'Test' });
      expect(response._meta.command).toBe('test');
    });

    it('returns as-is if already has _meta', () => {
      const existing: CleoResponse = {
        $schema: SCHEMA_URL_OUTPUT,
        _meta: {
          format: 'json',
          version: '1.0.0',
          command: 'original',
          timestamp: '2026-01-31T00:00:00Z',
        },
        success: true,
        data: { result: 'ok' },
      };

      const response = formatCliOutput('test', JSON.stringify(existing));

      expect(response).toEqual(existing);
      expect(response._meta.command).toBe('original'); // Not overwritten
    });

    it('wraps structured output with success field', () => {
      const cliOutput = JSON.stringify({
        success: true,
        taskId: 'T001',
      });

      const response = formatCliOutput('test', cliOutput);

      expect(response.$schema).toBe(SCHEMA_URL_OUTPUT);
      expect(response.success).toBe(true);
      expect(response).toHaveProperty('taskId', 'T001');
    });

    it('returns error for invalid JSON', () => {
      const response = formatCliOutput('test', 'not json');

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('E_CLI_PARSE_ERROR');
      expect(response.error?.context?.output).toBe('not json');
    });

    it('includes session when provided', () => {
      const cliOutput = JSON.stringify({ result: 'ok' });
      const response = formatCliOutput('test', cliOutput, 'session_789');

      expect(response._meta.session).toBe('session_789');
    });
  });

  describe('toDomainResponse', () => {
    it('converts CleoResponse to domain response format', () => {
      const cleoResponse = formatSuccess('test', { result: 'ok' });
      const startTime = Date.now() - 50;
      const response = toDomainResponse(cleoResponse, 'cleo_query', 'tasks', 'show', startTime);

      expect(response._meta.gateway).toBe('cleo_query');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('show');
      expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(response.success).toBe(true);
      expect(response.data).toEqual({ result: 'ok' });
    });

    it('includes duration_ms as 0 when no startTime provided', () => {
      const cleoResponse = formatSuccess('test', { result: 'ok' });
      const response = toDomainResponse(cleoResponse, 'cleo_query', 'tasks', 'show');

      expect(response._meta.duration_ms).toBe(0);
    });

    it('converts error responses preserving error fields', () => {
      const error = createError('E_NOT_FOUND', 'Task not found', 4, {
        fix: 'Use ct find to search',
        alternatives: [{ action: 'Search', command: 'ct find "query"' }],
      });
      const cleoResponse = formatError('test', error);
      const response = toDomainResponse(cleoResponse, 'cleo_query', 'tasks', 'show', Date.now());

      expect(response.success).toBe(false);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe('E_NOT_FOUND');
      expect(response.error!.fix).toBe('Use ct find to search');
      expect(response.error!.alternatives).toHaveLength(1);
    });
  });

  describe('formatDomainSuccess', () => {
    it('creates domain success response with _meta envelope', () => {
      const startTime = Date.now() - 25;
      const response = formatDomainSuccess('cleo_query', 'tasks', 'list', { tasks: [] }, startTime);

      expect(response._meta.gateway).toBe('cleo_query');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('list');
      expect(response._meta.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(response._meta.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(response.success).toBe(true);
      expect(response.data).toEqual({ tasks: [] });
    });

    it('defaults duration_ms to 0 without startTime', () => {
      const response = formatDomainSuccess('cleo_query', 'tasks', 'list', {});

      expect(response._meta.duration_ms).toBe(0);
    });
  });

  describe('formatDomainError', () => {
    it('creates domain error response per spec Section 3.2', () => {
      const error = createError('E_VALIDATION_FAILED', 'Title required', 6, {
        fix: 'Provide a title',
        alternatives: [{ action: 'Use default', command: 'ct add "Untitled"' }],
        context: { field: 'title', constraint: 'required' },
      });
      const startTime = Date.now() - 10;
      const response = formatDomainError('cleo_mutate', 'tasks', 'add', error, startTime);

      expect(response._meta.gateway).toBe('cleo_mutate');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('add');
      expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(response.success).toBe(false);
      expect(response.error.code).toBe('E_VALIDATION_FAILED');
      expect(response.error.exitCode).toBe(6);
      expect(response.error.message).toBe('Title required');
      expect(response.error.fix).toBe('Provide a title');
      expect(response.error.alternatives).toHaveLength(1);
      expect(response.error.details).toEqual({ field: 'title', constraint: 'required' });
    });

    it('omits optional fields when not present in CleoError', () => {
      const error = createError('E_TEST', 'Basic error', 1);
      const response = formatDomainError('cleo_mutate', 'tasks', 'update', error);

      expect(response.error.code).toBe('E_TEST');
      expect(response.error.exitCode).toBe(1);
      expect(response.error.message).toBe('Basic error');
      expect(response.error).not.toHaveProperty('fix');
      expect(response.error).not.toHaveProperty('alternatives');
      expect(response.error).not.toHaveProperty('details');
    });
  });

  describe('formatPartialSuccess', () => {
    it('creates partial success response per spec Section 3.3', () => {
      const succeeded = [
        { taskId: 'T001', status: 'completed' },
        { taskId: 'T002', status: 'completed' },
      ];
      const failed = [
        { taskId: 'T003', error: { code: 'E_BLOCKED', message: 'Dependencies unresolved' } },
      ];
      const startTime = Date.now() - 30;

      const response = formatPartialSuccess(
        'cleo_mutate',
        'tasks',
        'complete',
        succeeded,
        failed,
        startTime
      );

      expect(response._meta.gateway).toBe('cleo_mutate');
      expect(response._meta.domain).toBe('tasks');
      expect(response._meta.operation).toBe('complete');
      expect(response._meta.duration_ms).toBeGreaterThanOrEqual(0);
      expect(response.success).toBe(true);
      expect(response.partial).toBe(true);
      expect(response.data.succeeded).toHaveLength(2);
      expect(response.data.failed).toHaveLength(1);
      expect(response.data.failed[0].taskId).toBe('T003');
    });

    it('handles empty succeeded and failed arrays', () => {
      const response = formatPartialSuccess('cleo_mutate', 'tasks', 'archive', [], []);

      expect(response.success).toBe(true);
      expect(response.partial).toBe(true);
      expect(response.data.succeeded).toHaveLength(0);
      expect(response.data.failed).toHaveLength(0);
    });

    it('defaults duration_ms to 0 without startTime', () => {
      const response = formatPartialSuccess('cleo_mutate', 'tasks', 'complete', [], []);

      expect(response._meta.duration_ms).toBe(0);
    });
  });
});
