/**
 * Tests for the config-drift detector (T9897).
 *
 * Coverage:
 *   - detectConfigDrift: invalid project config → 1 P2 proposal
 *   - detectConfigDrift: drift on metadata scope → 1 P3 proposal
 *   - detectConfigDrift: all valid + no drift → empty array
 *   - detectConfigDrift: missing config files → empty array
 *   - detectConfigDrift: validateConfig throws for one scope → other scopes still scanned
 *   - detectConfigDrift: combined violations + drift → both proposals returned
 *   - safeRunConfigDriftScan: kill-switch blocks generation
 *   - safeRunConfigDriftScan: tier2Enabled=false marks outcome 'disabled'
 *   - safeRunConfigDriftScan: clean outcome when no proposals
 *   - safeRunConfigDriftScan: violations outcome when proposals present
 *   - safeRunConfigDriftScan: detector throwing surfaces 'error' outcome
 *
 * Tests mock `validateConfig` and `checkDrift` to keep them
 * filesystem-independent.
 *
 * @task T9897
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/registry.js', () => ({
  validateConfig: vi.fn(),
  checkDrift: vi.fn(),
}));

import { checkDrift, validateConfig } from '../../../config/registry.js';
import { CONFIG_FIX_KIND, detectConfigDrift, safeRunConfigDriftScan } from '../config-drift.js';

const mockValidateConfig = validateConfig as unknown as ReturnType<typeof vi.fn>;
const mockCheckDrift = checkDrift as unknown as ReturnType<typeof vi.fn>;

const PROJECT_ROOT = '/tmp/cleo-test-project-root';
const STATE_PATH = '/tmp/cleo-test-sentient-state.json';

beforeEach(() => {
  mockValidateConfig.mockReset();
  mockCheckDrift.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Configure mocks so every scope is clean by default. */
function defaultAllClean(): void {
  mockValidateConfig.mockResolvedValue({ ok: true, issues: [] });
  mockCheckDrift.mockResolvedValue({ drift: false });
}

describe('detectConfigDrift', () => {
  it('returns one P2 proposal when project scope fails schema validation', async () => {
    mockValidateConfig.mockImplementation(async (scope: 'project' | 'global') => {
      if (scope === 'project') {
        return { ok: false, issues: ['release.branchModel: invalid enum value'] };
      }
      return { ok: true, issues: [] };
    });
    mockCheckDrift.mockResolvedValue({ drift: false });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p?.kind).toBe(CONFIG_FIX_KIND);
    expect(p?.severity).toBe('P2');
    expect(p?.title).toBe('Config (project) violates schema');
    expect(p?.fixAction).toContain('cleo config validate --scope project');
    expect(p?.reason).toContain('release.branchModel: invalid enum value');
    expect(p?.id).toMatch(/^prop-config-drift-project-/);
  });

  it('returns one P3 proposal when metadata scope reports drift', async () => {
    mockValidateConfig.mockResolvedValue({ ok: true, issues: [] });
    mockCheckDrift.mockImplementation(async (scope: 'project' | 'global' | 'metadata') => {
      if (scope === 'metadata') {
        return { drift: true, reason: 'staleness-gate: detectedAt is 45d old (>30d threshold)' };
      }
      return { drift: false };
    });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    const [p] = proposals;
    expect(p?.kind).toBe(CONFIG_FIX_KIND);
    expect(p?.severity).toBe('P3');
    expect(p?.title).toBe('Config (metadata) drift detected');
    expect(p?.fixAction).toContain('cleo config drift-check --scope metadata');
    expect(p?.reason).toContain('staleness-gate');
  });

  it('returns an empty array when every scope is clean and no drift is detected', async () => {
    defaultAllClean();

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('returns an empty array when config files are missing (validators short-circuit ok)', async () => {
    // validateConfig returns {ok: true, issues: []} for missing files per registry contract.
    mockValidateConfig.mockResolvedValue({ ok: true, issues: [] });
    mockCheckDrift.mockResolvedValue({ drift: false });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toEqual([]);
  });

  it('continues scanning when validateConfig throws for one scope', async () => {
    mockValidateConfig.mockImplementation(async (scope: 'project' | 'global') => {
      if (scope === 'project') throw new Error('disk read failed');
      return { ok: false, issues: ['some-global-issue'] };
    });
    mockCheckDrift.mockResolvedValue({ drift: false });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.title).toBe('Config (global) violates schema');
  });

  it('continues scanning when checkDrift throws for one scope', async () => {
    mockValidateConfig.mockResolvedValue({ ok: true, issues: [] });
    mockCheckDrift.mockImplementation(async (scope: 'project' | 'global' | 'metadata') => {
      if (scope === 'project') throw new Error('drift surface failed');
      if (scope === 'metadata') return { drift: true, reason: 'metadata stale' };
      return { drift: false };
    });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.title).toBe('Config (metadata) drift detected');
  });

  it('emits both validation and drift proposals when both surface findings', async () => {
    mockValidateConfig.mockImplementation(async (scope: 'project' | 'global') => {
      if (scope === 'project') {
        return { ok: false, issues: ['foo: required'] };
      }
      return { ok: true, issues: [] };
    });
    mockCheckDrift.mockImplementation(async (scope: 'project' | 'global' | 'metadata') => {
      if (scope === 'metadata') return { drift: true, reason: 'meta drift' };
      return { drift: false };
    });

    const proposals = await detectConfigDrift(PROJECT_ROOT);

    expect(proposals).toHaveLength(2);
    expect(proposals.map((p) => p.severity).sort()).toEqual(['P2', 'P3']);
    expect(proposals.map((p) => p.kind)).toEqual([CONFIG_FIX_KIND, CONFIG_FIX_KIND]);
  });
});

describe('safeRunConfigDriftScan', () => {
  it('returns outcome=killed and generates no proposals when killSwitch is active', async () => {
    const outcome = await safeRunConfigDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => true,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('detector should not run when killed');
      },
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.proposals).toEqual([]);
  });

  it('returns outcome=disabled with proposal payload when tier2Enabled=false', async () => {
    defaultAllClean();
    mockValidateConfig.mockResolvedValueOnce({ ok: false, issues: ['oops'] });

    const outcome = await safeRunConfigDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => false,
    });

    expect(outcome.kind).toBe('disabled');
    expect(outcome.proposals.length).toBeGreaterThan(0);
    expect(outcome.detail).toContain('not persisted');
  });

  it('returns outcome=clean when the detector emits zero proposals', async () => {
    defaultAllClean();

    const outcome = await safeRunConfigDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
    });

    expect(outcome.kind).toBe('clean');
    expect(outcome.proposals).toEqual([]);
  });

  it('returns outcome=violations when the detector emits at least one proposal', async () => {
    mockValidateConfig.mockResolvedValue({ ok: false, issues: ['x'] });
    mockCheckDrift.mockResolvedValue({ drift: false });

    const outcome = await safeRunConfigDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
    });

    expect(outcome.kind).toBe('violations');
    expect(outcome.proposals.length).toBeGreaterThan(0);
    expect(outcome.proposals.every((p) => p.kind === CONFIG_FIX_KIND)).toBe(true);
  });

  it('returns outcome=error when the detector throws (kill-switch + tier2 checks succeed)', async () => {
    const outcome = await safeRunConfigDriftScan({
      projectRoot: PROJECT_ROOT,
      statePath: STATE_PATH,
      isKilled: async () => false,
      isTier2Enabled: async () => true,
      detect: async () => {
        throw new Error('boom');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(outcome.proposals).toEqual([]);
    expect(outcome.detail).toContain('boom');
  });
});
