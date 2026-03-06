import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { initCliLogger } from '../logger-bootstrap.js';

const { initLoggerMock, getProjectInfoSyncMock } = vi.hoisted(() => ({
  initLoggerMock: vi.fn(),
  getProjectInfoSyncMock: vi.fn(),
}));

vi.mock('../../core/logger.js', () => ({
  initLogger: initLoggerMock,
}));

vi.mock('../../core/project-info.js', () => ({
  getProjectInfoSync: getProjectInfoSyncMock,
}));

describe('initCliLogger', () => {
  const cwd = '/tmp/test-project';
  const loggingConfig = {
    level: 'info',
    filePath: 'logs/cleo.log',
    maxFileSize: 1024,
    maxFiles: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('propagates projectHash from project-info into initLogger', () => {
    getProjectInfoSyncMock.mockReturnValue({ projectHash: 'hash-abc123' });

    initCliLogger(cwd, loggingConfig);

    expect(getProjectInfoSyncMock).toHaveBeenCalledWith(cwd);
    expect(initLoggerMock).toHaveBeenCalledWith(
      join(cwd, '.cleo'),
      loggingConfig,
      'hash-abc123',
    );
  });

  it('initializes logger without projectHash when project-info is unavailable', () => {
    getProjectInfoSyncMock.mockReturnValue(null);

    initCliLogger(cwd, loggingConfig);

    expect(initLoggerMock).toHaveBeenCalledWith(
      join(cwd, '.cleo'),
      loggingConfig,
      undefined,
    );
  });
});
