import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observeBrainMock = vi.fn();

vi.mock('../../../memory/brain-retrieval.js', () => ({
  observeBrain: observeBrainMock,
}));

import { handlePromptSubmit, handleResponseComplete } from '../mcp-hooks.js';

describe('mcp hook handlers', () => {
  const originalEnv = process.env['CLEO_BRAIN_CAPTURE_MCP'];

  beforeEach(() => {
    observeBrainMock.mockReset();
    delete process.env['CLEO_BRAIN_CAPTURE_MCP'];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = originalEnv;
    } else {
      delete process.env['CLEO_BRAIN_CAPTURE_MCP'];
    }
  });

  describe('handlePromptSubmit', () => {
    it('does NOT call observeBrain by default', async () => {
      await handlePromptSubmit('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        gateway: 'query',
        domain: 'tasks',
        operation: 'find',
      });

      expect(observeBrainMock).not.toHaveBeenCalled();
    });

    it('calls observeBrain when CLEO_BRAIN_CAPTURE_MCP=true', async () => {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = 'true';
      observeBrainMock.mockResolvedValue(undefined);

      await handlePromptSubmit('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        gateway: 'query',
        domain: 'tasks',
        operation: 'find',
        source: 'agent-alpha',
      });

      expect(observeBrainMock).toHaveBeenCalledTimes(1);
      expect(observeBrainMock).toHaveBeenCalledWith(
        '/tmp/project',
        expect.objectContaining({
          text: expect.stringContaining('Prompt submitted: query:tasks.find from agent-alpha'),
          title: 'Prompt: tasks.find',
          type: 'discovery',
          sourceType: 'agent',
        }),
      );
    });

    it('swallows brain schema missing error when capture is on', async () => {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = 'true';
      observeBrainMock.mockRejectedValue(new Error('no such table: brain_observations'));

      await expect(
        handlePromptSubmit('/tmp/project', {
          timestamp: '2026-03-04T00:00:00.000Z',
          gateway: 'mutate',
          domain: 'tasks',
          operation: 'add',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleResponseComplete', () => {
    it('does NOT call observeBrain by default', async () => {
      await handleResponseComplete('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        gateway: 'query',
        domain: 'tasks',
        operation: 'find',
        success: true,
      });

      expect(observeBrainMock).not.toHaveBeenCalled();
    });

    it('calls observeBrain when CLEO_BRAIN_CAPTURE_MCP=true', async () => {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = 'true';
      observeBrainMock.mockResolvedValue(undefined);

      await handleResponseComplete('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'complete',
        success: true,
        durationMs: 150,
      });

      expect(observeBrainMock).toHaveBeenCalledTimes(1);
      expect(observeBrainMock).toHaveBeenCalledWith(
        '/tmp/project',
        expect.objectContaining({
          text: expect.stringContaining('Response success: mutate:tasks.complete (150ms)'),
          title: 'Response: tasks.complete',
          type: 'discovery',
          sourceType: 'agent',
        }),
      );
    });

    it('captures failed responses with error code', async () => {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = 'true';
      observeBrainMock.mockResolvedValue(undefined);

      await handleResponseComplete('/tmp/project', {
        timestamp: '2026-03-04T00:00:00.000Z',
        gateway: 'query',
        domain: 'tasks',
        operation: 'show',
        success: false,
        errorCode: 'E_NOT_FOUND',
      });

      const callText = observeBrainMock.mock.calls[0][1].text as string;
      expect(callText).toContain('Response failed');
      expect(callText).toContain('E_NOT_FOUND');
      expect(observeBrainMock.mock.calls[0][1].type).toBe('change');
    });

    it('swallows brain schema missing error when capture is on', async () => {
      process.env['CLEO_BRAIN_CAPTURE_MCP'] = 'true';
      observeBrainMock.mockRejectedValue(new Error('SQLITE_ERROR: no such table: brain_decisions'));

      await expect(
        handleResponseComplete('/tmp/project', {
          timestamp: '2026-03-04T00:00:00.000Z',
          gateway: 'query',
          domain: 'tasks',
          operation: 'find',
          success: true,
        }),
      ).resolves.toBeUndefined();
    });
  });
});
