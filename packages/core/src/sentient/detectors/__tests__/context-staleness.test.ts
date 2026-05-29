/**
 * Tests for the context-staleness detector (T9896).
 *
 * Coverage:
 *   - detectContextStaleness: stale context (>30d) → proposal with severity P2
 *   - detectContextStaleness: fresh context (yesterday) → null
 *   - detectContextStaleness: missing file (loader returns null) → null
 *   - detectContextStaleness: invalid date string → null + does not throw
 *   - detectContextStaleness: missing detectedAt field → null
 *   - detectContextStaleness: loader throws → null
 *   - safeRunContextStalenessScan: kill-switch blocks generation
 *   - safeRunContextStalenessScan: tier2Enabled=false marks outcome 'disabled'
 *   - safeRunContextStalenessScan: detector throwing surfaces 'error' outcome
 *   - safeRunContextStalenessScan: no-context outcome when context missing
 *
 * Tests mock `loadProjectContext` to keep them filesystem-independent.
 *
 * @task T9896
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/registry.js', () => ({
  loadProjectContext: vi.fn(),
}));

import type { ProjectContext } from '@cleocode/contracts';
import { loadProjectContext } from '../../../config/registry.js';
import {
  CONTEXT_REFRESH_KIND,
  CONTEXT_STALENESS_MS,
  detectContextStaleness,
  safeRunContextStalenessScan,
} from '../context-staleness.js';

// Cast the mocked import to vi.fn so we can configure return values per test.
const mockLoadProjectContext = loadProjectContext as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ROOT = '/tmp/cleo-test-project-root';
const STATE_PATH = '/tmp/cleo-test-sentient-state.json';

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makeContext(detectedAt: string | undefined): ProjectContext {
  // Minimal shape sufficient for the detector; cast through unknown so we
  // don't have to mock the entire ProjectContext surface (typing/build).
  return {
    schemaVersion: '1.0.0',
    detectedAt: detectedAt as string,
    projectTypes: ['node'],
    monorepo: false,
  } as ProjectContext;
}

beforeEach(() => {
  mockLoadProjectContext.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectContextStaleness', () => {
  it('returns a P2 proposal when detectedAt is older than 30 days', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(isoDaysAgo(31)));

    const proposal = await detectContextStaleness(PROJECT_ROOT);

    expect(proposal).not.toBeNull();
    expect(proposal?.kind).toBe(CONTEXT_REFRESH_KIND);
    expect(proposal?.severity).toBe('P2');
    expect(proposal?.title).toBe('Project context is >30 days old');
    expect(proposal?.fixAction).toContain('cleo init --refresh-context');
    expect(proposal?.id).toMatch(/^prop-context-staleness-/);
    expect(proposal?.reason).toContain('31 days ago');
  });

  it('returns null when detectedAt is within the staleness window', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(isoDaysAgo(1)));

    const proposal = await detectContextStaleness(PROJECT_ROOT);

    expect(proposal).toBeNull();
  });

  it('returns null when the project-context.json file is missing', async () => {
    mockLoadProjectContext.mockResolvedValue(null);

    const proposal = await detectContextStaleness(PROJECT_ROOT);

    expect(proposal).toBeNull();
  });

  it('returns null and does not throw when detectedAt is unparseable', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext('not-a-date'));

    await expect(detectContextStaleness(PROJECT_ROOT)).resolves.toBeNull();
  });

  it('returns null when detectedAt is absent', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(undefined));

    const proposal = await detectContextStaleness(PROJECT_ROOT);

    expect(proposal).toBeNull();
  });

  it('returns null when the loader throws', async () => {
    mockLoadProjectContext.mockRejectedValue(new Error('disk read failed'));

    const proposal = await detectContextStaleness(PROJECT_ROOT);

    expect(proposal).toBeNull();
  });

  it('returns null exactly at the staleness boundary (age == threshold)', async () => {
    // Age strictly equal to the threshold is NOT stale; detector emits only when age > threshold.
    // Freeze the clock so the detector's Date.now() equals the value used to
    // derive detectedAt. Without this, wall-time elapsed between this line and
    // the detector's read pushes ageMs to threshold+ε (> threshold), flipping
    // the result to a proposal — an intermittent shard failure under CI load.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T00:00:00.000Z'));
    try {
      const detectedAt = new Date(Date.now() - CONTEXT_STALENESS_MS).toISOString();
      mockLoadProjectContext.mockResolvedValue(makeContext(detectedAt));

      const proposal = await detectContextStaleness(PROJECT_ROOT);

      expect(proposal).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('safeRunContextStalenessScan', () => {
  it('returns outcome=killed and generates no proposal when killSwitch is active', async () => {
    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => true,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('detector should not run when killed');
      },
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.proposal).toBeNull();
  });

  it('returns outcome=disabled (with proposal payload) when tier2Enabled=false', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(isoDaysAgo(60)));

    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => false,
    });

    expect(outcome.kind).toBe('disabled');
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.proposal?.severity).toBe('P2');
  });

  it('returns outcome=stale when context is stale and tier2 is enabled', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(isoDaysAgo(45)));

    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
    });

    expect(outcome.kind).toBe('stale');
    expect(outcome.proposal).not.toBeNull();
    expect(outcome.proposal?.kind).toBe(CONTEXT_REFRESH_KIND);
  });

  it('returns outcome=fresh when context is present and within window', async () => {
    mockLoadProjectContext.mockResolvedValue(makeContext(isoDaysAgo(5)));

    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
    });

    expect(outcome.kind).toBe('fresh');
    expect(outcome.proposal).toBeNull();
  });

  it('returns outcome=no-context when project-context.json is absent', async () => {
    mockLoadProjectContext.mockResolvedValue(null);

    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
    });

    expect(outcome.kind).toBe('no-context');
    expect(outcome.proposal).toBeNull();
  });

  it('returns outcome=error when the detector throws (kill-switch + tier2 checks succeed)', async () => {
    const outcome = await safeRunContextStalenessScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(outcome.proposal).toBeNull();
    expect(outcome.detail).toContain('boom');
  });
});
