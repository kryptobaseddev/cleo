/**
 * Tests for import logging (import-logging.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies before importing the module
vi.mock('../json.js', () => ({
  readJson: vi.fn().mockResolvedValue({
    _meta: {
      source: { project: 'test-project' },
      exportedAt: '2026-01-01T00:00:00Z',
      checksum: 'abc123',
      taskCount: 5,
    },
  }),
  appendJsonl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/paths.js', () => ({
  getLogPath: vi.fn().mockReturnValue('/tmp/test-log.json'),
}));

import {
  extractPackageMeta,
  logImportStart,
  logImportSuccess,
  logImportError,
  logImportConflict,
} from '../import-logging.js';
import { appendJsonl } from '../json.js';

describe('extractPackageMeta', () => {
  it('should extract metadata from export file', async () => {
    const meta = await extractPackageMeta('/path/to/export.json');

    expect(meta.sourceFile).toBe('export.json');
    expect(meta.sourceProject).toBe('test-project');
    expect(meta.exportedAt).toBe('2026-01-01T00:00:00Z');
    expect(meta.packageChecksum).toBe('abc123');
    expect(meta.taskCount).toBe(5);
  });
});

describe('logImportStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log import start event', async () => {
    await logImportStart('/path/to/export.json', 'session-1');

    expect(appendJsonl).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendJsonl).mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.action).toBe('import');
    expect((entry.details as Record<string, unknown>).stage).toBe('start');
  });
});

describe('logImportSuccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log import success with task details', async () => {
    await logImportSuccess(
      '/path/to/export.json',
      ['T031', 'T032'],
      { T001: 'T031', T002: 'T032' },
      [{ type: 'duplicate_title', resolution: 'rename' }],
      { parent: 'T001' },
      'session-1',
    );

    expect(appendJsonl).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendJsonl).mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.action).toBe('import');
    const details = entry.details as Record<string, unknown>;
    expect(details.stage).toBe('success');
    expect(details.tasksImported).toEqual(['T031', 'T032']);
    expect(details.idRemap).toEqual({ T001: 'T031', T002: 'T032' });
  });
});

describe('logImportError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log import error with diagnostic details', async () => {
    await logImportError(
      '/path/to/export.json',
      'Invalid checksum',
      '6',
      'validation',
    );

    expect(appendJsonl).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendJsonl).mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.action).toBe('error_occurred');
    const details = entry.details as Record<string, unknown>;
    expect(details.stage).toBe('validation');
    const error = details.error as Record<string, unknown>;
    expect(error.message).toBe('Invalid checksum');
    expect(error.code).toBe('6');
  });
});

describe('logImportConflict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log import conflict with resolution', async () => {
    await logImportConflict(
      'duplicate_title',
      'T001',
      { existingId: 'T050', title: 'Duplicate Task' },
      'rename',
    );

    expect(appendJsonl).toHaveBeenCalledTimes(1);
    const entry = vi.mocked(appendJsonl).mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.action).toBe('task_updated');
    expect(entry.taskId).toBe('T001');
    const details = entry.details as Record<string, unknown>;
    expect(details.conflictType).toBe('duplicate_title');
    expect(details.resolution).toBe('rename');
  });
});
