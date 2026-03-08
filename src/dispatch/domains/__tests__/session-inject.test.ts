/**
 * Session Domain — context.inject Operation (Post-Cutover)
 *
 * Tests that the SessionHandler correctly delegates context.inject to
 * the sessionContextInject function from sessions/context-inject.ts
 * after T5241 cutover (moved from memory domain inject).
 *
 * @task T5241
 * @epic T5149
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine functions required by SessionHandler
vi.mock('../../lib/engine.js', () => ({
  sessionStatus: vi.fn(),
  sessionList: vi.fn(),
  sessionShow: vi.fn(),
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  sessionResume: vi.fn(),
  sessionSuspend: vi.fn(),
  sessionGc: vi.fn(),
  sessionHistory: vi.fn(),
  sessionRecordDecision: vi.fn(),
  sessionDecisionLog: vi.fn(),
  sessionContextDrift: vi.fn(),
  sessionRecordAssumption: vi.fn(),
  sessionHandoff: vi.fn(),
  sessionComputeHandoff: vi.fn(),
  sessionBriefing: vi.fn(),
  sessionComputeDebrief: vi.fn(),
  sessionDebriefShow: vi.fn(),
  sessionChainShow: vi.fn(),
  sessionFind: vi.fn(),
  sessionContextInject: vi.fn(),
}));

// Mock session context binding
vi.mock('../../context/session-context.js', () => ({
  bindSession: vi.fn(),
  unbindSession: vi.fn(),
}));

// Mock getProjectRoot
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { SessionHandler } from '../session.js';
import { sessionContextInject } from '../../lib/engine.js';

describe('SessionHandler context.inject', () => {
  let handler: SessionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new SessionHandler();
  });

  // =========================================================================
  // getSupportedOperations
  // =========================================================================

  describe('getSupportedOperations', () => {
    it('should not list context.inject in canonical mutate operations (moved to admin, T5615)', () => {
      const ops = handler.getSupportedOperations();
      // context.inject moved to admin domain — still handled as backward-compat alias
      expect(ops.mutate).not.toContain('context.inject');
    });
  });

  // =========================================================================
  // Mutate: session.context.inject
  // =========================================================================

  describe('mutate: context.inject', () => {
    it('should return protocol content for valid protocolType', async () => {
      vi.mocked(sessionContextInject).mockReturnValue({
        success: true,
        data: {
          protocolType: 'research',
          content: '# Research Protocol\n...',
          path: 'protocols/research.md',
          contentLength: 200,
          estimatedTokens: 50,
          taskId: null,
          variant: null,
        },
      });

      const result = await handler.mutate('context.inject', { protocolType: 'research' });
      expect(result.success).toBe(true);
      expect((result.data as { protocolType: string }).protocolType).toBe('research');
      expect((result.data as { content: string }).content).toContain('Research Protocol');
      expect(sessionContextInject).toHaveBeenCalledWith(
        'research',
        { taskId: undefined, variant: undefined },
        '/mock/project',
      );
    });

    it('should pass optional taskId and variant params', async () => {
      vi.mocked(sessionContextInject).mockReturnValue({
        success: true,
        data: {
          protocolType: 'implementation',
          content: '# Impl Protocol',
          path: 'protocols/implementation.md',
          contentLength: 100,
          estimatedTokens: 25,
          taskId: 'T5241',
          variant: 'compact',
        },
      });

      const result = await handler.mutate('context.inject', {
        protocolType: 'implementation',
        taskId: 'T5241',
        variant: 'compact',
      });

      expect(result.success).toBe(true);
      expect(sessionContextInject).toHaveBeenCalledWith(
        'implementation',
        { taskId: 'T5241', variant: 'compact' },
        '/mock/project',
      );
    });

    it('should return E_INVALID_INPUT when protocolType is missing', async () => {
      const result = await handler.mutate('context.inject', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('protocolType');
    });

    it('should propagate E_NOT_FOUND when protocol file not found', async () => {
      vi.mocked(sessionContextInject).mockReturnValue({
        success: false,
        error: { code: 'E_NOT_FOUND', message: "Protocol 'unknown' not found" },
      });

      const result = await handler.mutate('context.inject', { protocolType: 'unknown' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  // =========================================================================
  // Response metadata
  // =========================================================================

  describe('response metadata', () => {
    it('should include _meta with session domain for context.inject', async () => {
      vi.mocked(sessionContextInject).mockReturnValue({
        success: true,
        data: { protocolType: 'test', content: 'content', path: 'p', contentLength: 7, estimatedTokens: 2, taskId: null, variant: null },
      });

      const result = await handler.mutate('context.inject', { protocolType: 'test' });
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('session');
      expect(result._meta.operation).toBe('context.inject');
      expect(result._meta.gateway).toBe('mutate');
    });

    it('should include _meta in error responses', async () => {
      const result = await handler.mutate('context.inject', {});
      expect(result._meta).toBeDefined();
      expect(result._meta.domain).toBe('session');
      expect(result._meta.operation).toBe('context.inject');
    });
  });
});
