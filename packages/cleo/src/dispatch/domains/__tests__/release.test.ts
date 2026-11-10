/**
 * Tests for the ReleaseHandler dispatch domain.
 *
 * The IVTR-only `gate` and `ivtr-suggest` operations were deleted in T14311;
 * these tests pin that they are gone from both gateways.
 *
 * @task T1416
 * @task T14311
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any imports that touch the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../../lib/engine.js', () => ({
  releaseOpen: vi.fn(),
  releasePlan: vi.fn(),
  releaseReconcileV2: vi.fn(),
  // T9937 — Saga T9862: canonical CHANGELOG header validator.
  validateChangelog: vi.fn(),
}));

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { validateChangelog } from '../../lib/engine.js';
import { ReleaseHandler } from '../release.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReleaseHandler', () => {
  let handler: ReleaseHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new ReleaseHandler();
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  it('declares expected query and mutate operations', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('validate-changelog');
    expect(ops.query).not.toContain('gate');
    expect(ops.query).not.toContain('ivtr-suggest');
    expect(ops.mutate).not.toContain('gate');
    expect(ops.mutate).not.toContain('ivtr-suggest');
  });

  // -----------------------------------------------------------------------
  // query('validate-changelog') — T9937 / Saga T9862
  // -----------------------------------------------------------------------

  describe('query("validate-changelog")', () => {
    it('returns E_INVALID_INPUT when version is missing', async () => {
      const result = await handler.query('validate-changelog', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('returns success envelope when canonical header is present', async () => {
      vi.mocked(validateChangelog).mockResolvedValue({
        valid: true,
        version: 'v2026.5.94',
        normalizedVersion: '2026.5.94',
        changelogPath: '/mock/project/CHANGELOG.md',
        headerFound: '## [2026.5.94]',
      });
      const result = await handler.query('validate-changelog', { version: 'v2026.5.94' });
      expect(result.success).toBe(true);
      expect((result.data as Record<string, unknown>)['valid']).toBe(true);
      expect((result.data as Record<string, unknown>)['headerFound']).toBe('## [2026.5.94]');
      expect(validateChangelog).toHaveBeenCalledWith({
        version: 'v2026.5.94',
        projectRoot: '/mock/project',
      });
    });

    it('returns E_CHANGELOG_MISSING_SECTION when the header is absent', async () => {
      vi.mocked(validateChangelog).mockResolvedValue({
        valid: false,
        version: 'v2026.5.94',
        normalizedVersion: '2026.5.94',
        changelogPath: '/mock/project/CHANGELOG.md',
        headerFound: null,
        reason: 'CHANGELOG.md does not contain ## [2026.5.94]',
      });
      const result = await handler.query('validate-changelog', { version: 'v2026.5.94' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_CHANGELOG_MISSING_SECTION');
      expect(result.error?.message).toContain('2026.5.94');
      expect(result.error?.details).toMatchObject({
        normalizedVersion: '2026.5.94',
        headerFound: null,
      });
    });

    it('forwards explicit changelogPath when provided', async () => {
      vi.mocked(validateChangelog).mockResolvedValue({
        valid: true,
        version: '2026.5.94',
        normalizedVersion: '2026.5.94',
        changelogPath: '/custom/NOTES.md',
        headerFound: '## [2026.5.94]',
      });
      await handler.query('validate-changelog', {
        version: '2026.5.94',
        changelogPath: '/custom/NOTES.md',
      });
      expect(validateChangelog).toHaveBeenCalledWith({
        version: '2026.5.94',
        projectRoot: '/mock/project',
        changelogPath: '/custom/NOTES.md',
      });
    });
  });

  // -----------------------------------------------------------------------
  // Removed IVTR operations (T14311) and unknown operations
  // -----------------------------------------------------------------------

  describe('removed IVTR operations', () => {
    for (const operation of ['gate', 'ivtr-suggest']) {
      it(`query("${operation}") is an unknown operation`, async () => {
        const result = await handler.query(operation, { epicId: 'T900', taskId: 'T901' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_OPERATION');
      });

      it(`mutate("${operation}") is an unknown operation`, async () => {
        const result = await handler.mutate(operation, { epicId: 'T900', taskId: 'T901' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_OPERATION');
      });
    }

    it('returns E_INVALID_OPERATION for unknown mutate operations', async () => {
      const result = await handler.mutate('ship', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });
  });
});
