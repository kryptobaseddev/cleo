import { beforeEach, describe, expect, it, vi } from 'vitest';

const observeBrainMock = vi.fn();

vi.mock('../../../memory/brain-retrieval.js', () => ({
  observeBrain: observeBrainMock,
}));

import { handleFileChange } from '../file-hooks.js';

describe('file hook handlers', () => {
  beforeEach(() => {
    observeBrainMock.mockReset();
    vi.restoreAllMocks();
  });

  it('calls observeBrain with file path and change type', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      filePath: 'src/core/tasks.ts',
      changeType: 'write',
      sizeBytes: 1024,
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: expect.stringContaining('File write: src/core/tasks.ts'),
        title: expect.stringContaining('File changed: src/core/tasks.ts'),
        type: 'change',
        sourceType: 'agent',
      }),
    );
    const callText = observeBrainMock.mock.calls[0][1].text as string;
    expect(callText).toContain('1024 bytes');
  });

  it('deduplicates rapid writes to same file within 5s', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    // Use a unique file path for this test to avoid cross-test dedup
    const uniquePath = `src/dedup-test-${Date.now()}.ts`;

    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      filePath: uniquePath,
      changeType: 'write',
    });

    // Second call within 5s should be deduped
    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:01.000Z',
      filePath: uniquePath,
      changeType: 'write',
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(1);
  });

  it('allows writes to different files within 5s', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    const fileA = `src/file-a-${Date.now()}.ts`;
    const fileB = `src/file-b-${Date.now()}.ts`;

    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      filePath: fileA,
      changeType: 'write',
    });

    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:01.000Z',
      filePath: fileB,
      changeType: 'create',
    });

    expect(observeBrainMock).toHaveBeenCalledTimes(2);
  });

  it('converts absolute path to relative', async () => {
    observeBrainMock.mockResolvedValue(undefined);

    const absPath = `/tmp/project/src/abs-test-${Date.now()}.ts`;

    await handleFileChange('/tmp/project', {
      timestamp: '2026-03-04T00:00:00.000Z',
      filePath: absPath,
      changeType: 'write',
    });

    expect(observeBrainMock).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        text: expect.stringMatching(/File write: src\/abs-test-\d+\.ts/),
        title: expect.stringMatching(/File changed: src\/abs-test-\d+\.ts/),
      }),
    );
  });

  it('swallows brain schema missing error', async () => {
    observeBrainMock.mockRejectedValue(
      new Error('no such table: brain_observations'),
    );

    const uniquePath = `src/swallow-test-${Date.now()}.ts`;

    await expect(
      handleFileChange('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        filePath: uniquePath,
        changeType: 'delete',
      }),
    ).resolves.toBeUndefined();
  });

  it('rethrows non-schema errors', async () => {
    observeBrainMock.mockRejectedValue(new Error('disk full'));

    const uniquePath = `src/rethrow-test-${Date.now()}.ts`;

    await expect(
      handleFileChange('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        filePath: uniquePath,
        changeType: 'write',
      }),
    ).rejects.toThrow('disk full');
  });
});
