/**
 * Tests for the production `cleo go` IVTR runner (T11805 · finding #5).
 *
 * `buildGoIvtrRunner` is the real seam the `cleo go` handler injects (go.ts:80)
 * — the only code that actually resolves `ivtr.cantbook`, seeds `ivtr_state`,
 * calls `executePlaybook`, and (now) mirrors the run's terminal status back
 * into `ivtr_state`. The core `driver.test.ts` only exercises a mock runner, so
 * this suite covers the runner's load-bearing wiring + ordering directly,
 * stubbing the heavy integration boundaries (playbook resolution/runtime, DB
 * singleton, dispatcher construction) so no subprocess is spawned and no real
 * DB is touched.
 *
 * @task T11805 — E-ORCH-STATE-MACHINE-COLLAPSE / T11764
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the seam's integration boundaries BEFORE importing the SUT.
// ---------------------------------------------------------------------------

const mockResolvePlaybook = vi.fn();
const mockParsePlaybook = vi.fn();
const mockExecutePlaybook = vi.fn();

const mockSeedIvtrForPlaybook = vi.fn();
const mockFinalizeIvtrFromPlaybook = vi.fn();
const mockGetDb = vi.fn();
const mockGetNativeDb = vi.fn();
const mockCreateToolGuard = vi.fn();
const mockRunSkillNodeOrSpawn = vi.fn();
const mockMaybeCreatePiRunner = vi.fn();
const mockResolveCantbookNodeProfile = vi.fn();
const mockHasCantbookProfilePin = vi.fn();
const mockOrchestrateSpawnExecute = vi.fn();

// `resolvePlaybook` is re-exported from `@cleocode/core` (static import).
vi.mock('@cleocode/core', () => ({
  resolvePlaybook: (...args: unknown[]) => mockResolvePlaybook(...args),
}));

// `executePlaybook` + `parsePlaybook` ship in `@cleocode/playbooks` (static).
vi.mock('@cleocode/playbooks', () => ({
  executePlaybook: (...args: unknown[]) => mockExecutePlaybook(...args),
  parsePlaybook: (...args: unknown[]) => mockParsePlaybook(...args),
}));

// The runner dynamically imports these from `@cleocode/core/internal`.
vi.mock('@cleocode/core/internal', () => ({
  seedIvtrForPlaybook: (...args: unknown[]) => mockSeedIvtrForPlaybook(...args),
  finalizeIvtrFromPlaybook: (...args: unknown[]) => mockFinalizeIvtrFromPlaybook(...args),
  getDb: (...args: unknown[]) => mockGetDb(...args),
  getNativeDb: (...args: unknown[]) => mockGetNativeDb(...args),
  createToolGuard: (...args: unknown[]) => mockCreateToolGuard(...args),
  runSkillNodeOrSpawn: (...args: unknown[]) => mockRunSkillNodeOrSpawn(...args),
  // T11945 (M4): default-OFF Pi runner wiring — returns undefined unless the flag
  // is set, so the dispatcher keeps the defaultSkillRunner path (zero change).
  maybeCreatePiRunner: (...args: unknown[]) => mockMaybeCreatePiRunner(...args),
  // T11759 (M4): cantbook stage LLM-profile resolution seam. Un-pinned nodes
  // skip it (`hasCantbookProfilePin` → false), so it is never called here.
  resolveCantbookNodeProfile: (...args: unknown[]) => mockResolveCantbookNodeProfile(...args),
  hasCantbookProfilePin: (...args: unknown[]) => mockHasCantbookProfilePin(...args),
}));

// Subprocess spawn gateway (dynamic import inside the dispatcher builder).
vi.mock('@cleocode/runtime/gateway', () => ({
  orchestrateSpawnExecute: (...args: unknown[]) => mockOrchestrateSpawnExecute(...args),
}));

const { buildGoIvtrRunner } = await import('../go-ivtr-runner.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A stand-in for the node:sqlite handle (only identity matters to the test). */
const FAKE_DB = { __fake: 'native-db' } as const;

function primeHappyPath(terminalStatus: string, runId = 'pbr_real_1'): void {
  mockResolvePlaybook.mockReturnValue({ source: 'cantbook-yaml-source' });
  mockParsePlaybook.mockReturnValue({
    definition: { name: 'ivtr', nodes: [], edges: [] },
    sourceHash: 'deadbeef',
  });
  mockSeedIvtrForPlaybook.mockResolvedValue({ taskId: 'T102', currentPhase: 'implement' });
  mockGetDb.mockResolvedValue(undefined);
  mockGetNativeDb.mockReturnValue(FAKE_DB);
  mockCreateToolGuard.mockReturnValue({ __guard: true });
  mockExecutePlaybook.mockResolvedValue({
    runId,
    terminalStatus,
    finalContext: { taskId: 'T102', testsPassed: true },
  });
  mockFinalizeIvtrFromPlaybook.mockResolvedValue({ state: { currentPhase: 'released' } });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildGoIvtrRunner (T11805 — real seam wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves+parses ivtr.cantbook, seeds ivtr_state, runs the playbook, mirrors terminal status', async () => {
    primeHappyPath('completed');
    const runner = buildGoIvtrRunner();

    const result = await runner('T102', { projectRoot: '/proj', epicId: 'T101' });

    // Playbook resolved through the tier-aware resolver + parsed.
    expect(mockResolvePlaybook).toHaveBeenCalledWith('ivtr', { projectRoot: '/proj' });
    expect(mockParsePlaybook).toHaveBeenCalledWith('cantbook-yaml-source');

    // ivtr_state seeded (gate stays load-bearing) BEFORE the run executes.
    expect(mockSeedIvtrForPlaybook).toHaveBeenCalledWith('T102', { cwd: '/proj' });

    // executePlaybook received taskId (via initialContext) + the parsed def + db.
    expect(mockExecutePlaybook).toHaveBeenCalledTimes(1);
    const execOpts = mockExecutePlaybook.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(execOpts.initialContext).toEqual({ taskId: 'T102' });
    expect(execOpts.db).toBe(FAKE_DB);
    expect(execOpts.epicId).toBe('T101');

    // Terminal status mirrored back into ivtr_state (finding #1 / #4 fix).
    expect(mockFinalizeIvtrFromPlaybook).toHaveBeenCalledTimes(1);
    expect(mockFinalizeIvtrFromPlaybook.mock.calls[0]?.[0]).toBe('T102');
    expect(mockFinalizeIvtrFromPlaybook.mock.calls[0]?.[1]).toBe('completed');
    expect(mockFinalizeIvtrFromPlaybook.mock.calls[0]?.[2]).toMatchObject({
      cwd: '/proj',
      runId: 'pbr_real_1',
      finalContext: { taskId: 'T102', testsPassed: true },
    });

    // Result surfaces runId + terminalStatus for the driver.
    expect(result).toEqual({ taskId: 'T102', runId: 'pbr_real_1', terminalStatus: 'completed' });
  });

  it('enforces seed → executePlaybook → finalize ordering', async () => {
    primeHappyPath('completed');
    const callOrder: string[] = [];
    mockSeedIvtrForPlaybook.mockImplementation(async () => {
      callOrder.push('seed');
      return { taskId: 'T102', currentPhase: 'implement' };
    });
    mockExecutePlaybook.mockImplementation(async () => {
      callOrder.push('execute');
      return { runId: 'pbr_x', terminalStatus: 'completed', finalContext: {} };
    });
    mockFinalizeIvtrFromPlaybook.mockImplementation(async () => {
      callOrder.push('finalize');
      return { state: { currentPhase: 'released' } };
    });

    const runner = buildGoIvtrRunner();
    await runner('T102', { projectRoot: '/proj' });

    expect(callOrder).toEqual(['seed', 'execute', 'finalize']);
  });

  it('passes sessionId through to executePlaybook when provided', async () => {
    primeHappyPath('completed');
    const runner = buildGoIvtrRunner();

    await runner('T102', { projectRoot: '/proj', epicId: 'T101', sessionId: 'ses_xyz' });

    const execOpts = mockExecutePlaybook.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(execOpts.sessionId).toBe('ses_xyz');
  });

  it('forwards the runtime errorContext into the terminal mirror on a failed run', async () => {
    primeHappyPath('failed');
    mockExecutePlaybook.mockResolvedValue({
      runId: 'pbr_fail',
      terminalStatus: 'failed',
      finalContext: {},
      errorContext: 'implement node exceeded retries',
    });
    const runner = buildGoIvtrRunner();

    const result = await runner('T102', { projectRoot: '/proj' });

    expect(mockFinalizeIvtrFromPlaybook.mock.calls[0]?.[1]).toBe('failed');
    expect(mockFinalizeIvtrFromPlaybook.mock.calls[0]?.[2]).toMatchObject({
      error: 'implement node exceeded retries',
    });
    expect(result.terminalStatus).toBe('failed');
  });

  it('throws when the tasks.db singleton was not initialized by getDb()', async () => {
    primeHappyPath('completed');
    mockGetNativeDb.mockReturnValue(undefined);
    const runner = buildGoIvtrRunner();

    await expect(runner('T102', { projectRoot: '/proj' })).rejects.toThrow(
      /tasks.db singleton was not initialized/,
    );
    // executePlaybook must NOT run when the DB handle is missing.
    expect(mockExecutePlaybook).not.toHaveBeenCalled();
  });
});
