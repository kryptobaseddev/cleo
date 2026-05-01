/**
 * Lifecycle Scope Guard Tests (T1162)
 *
 * Verifies that `lifecycleProgress`, `lifecycleSkip`, and `lifecycleReset`
 * reject lifecycle mutations when the active session is scoped to a child task
 * rather than the target epic.
 *
 * Root incident: during T1150 RCASD orchestration a subagent advanced all 9
 * lifecycle stages of T1150 within 75 seconds (17:59:17→18:00:32, 2026-04-21)
 * to bypass E_LIFECYCLE_GATE_FAILED.  These tests document and lock down the
 * fix so the vector cannot regress.
 *
 * Test matrix:
 *   1. Child-task-scoped session + lifecycleProgress → E_LIFECYCLE_SCOPE_DENIED
 *   2. Child-task-scoped session + lifecycleSkip     → E_LIFECYCLE_SCOPE_DENIED
 *   3. Child-task-scoped session + lifecycleReset    → E_LIFECYCLE_SCOPE_DENIED
 *   4. Epic-scoped session (rootTaskId matches)      → proceeds normally
 *   5. Global-scope session                          → proceeds normally
 *   6. No active session                             → proceeds normally (defer to session enforcement)
 *   7. Child-task-scoped + CLEO_OWNER_OVERRIDE=1    → allowed + audit entry written
 *   8. Worker role + CLEO_OWNER_OVERRIDE=1           → still denied (T1118 L4b)
 *
 * @task T1162
 * @task T1576 - ENG-MIG-9: moved scope guard to core/lifecycle/engine-ops.ts
 * @adr ADR-054 (scope-guard addendum)
 */

import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — declare mock functions before vi.mock() factory runs.
//
// Vitest hoists vi.mock() calls to the top of the file, but vi.hoisted()
// is also hoisted and returns values that are therefore available inside
// the factory. This avoids "Cannot access before initialization" errors
// that occur when const declarations are referenced inside factory fns.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getActiveSession: vi.fn(),
  recordStageProgress: vi.fn(),
  skipStageWithReason: vi.fn(),
  resetStage: vi.fn(),
  getLifecycleStatus: vi.fn(),
  checkGate: vi.fn(),
  resolveStageAlias: vi.fn((s: string) => s),
  getLifecycleGates: vi.fn(),
  getLifecycleHistory: vi.fn(),
  getStagePrerequisites: vi.fn(),
  checkStagePrerequisites: vi.fn(),
  listEpicsWithLifecycle: vi.fn(),
  passGate: vi.fn(),
  failGate: vi.fn(),
  isPipelineTransitionForward: vi.fn(),
  getPipelineStageOrder: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock the lifecycle index (used by engine-ops.ts to get lifecycle functions).
// engine-ops.ts imports from './index.js' inside core/lifecycle.
// We mock the resolved path that Vitest will encounter at test runtime.
// ---------------------------------------------------------------------------

vi.mock('../../../../../core/src/lifecycle/index.js', () => ({
  getActiveSession: mocks.getActiveSession,
  recordStageProgress: mocks.recordStageProgress,
  skipStageWithReason: mocks.skipStageWithReason,
  resetStage: mocks.resetStage,
  getLifecycleStatus: mocks.getLifecycleStatus,
  checkGate: mocks.checkGate,
  resolveStageAlias: mocks.resolveStageAlias,
  getLifecycleGates: mocks.getLifecycleGates,
  getLifecycleHistory: mocks.getLifecycleHistory,
  getStagePrerequisites: mocks.getStagePrerequisites,
  checkStagePrerequisites: mocks.checkStagePrerequisites,
  listEpicsWithLifecycle: mocks.listEpicsWithLifecycle,
  passGate: mocks.passGate,
  failGate: mocks.failGate,
}));

// Mock the session store (engine-ops.ts imports getActiveSession from here)
vi.mock('../../../../../core/src/store/session-store.js', () => ({
  getActiveSession: mocks.getActiveSession,
  createSession: vi.fn(),
}));

// Mock pipeline-stage.ts (engine-ops.ts imports isPipelineTransitionForward from here)
vi.mock('../../../../../core/src/tasks/pipeline-stage.js', () => ({
  isPipelineTransitionForward: mocks.isPipelineTransitionForward,
  getPipelineStageOrder: mocks.getPipelineStageOrder,
  isValidPipelineStage: vi.fn(() => true),
}));

// Mock gate-audit.ts (engine-ops.ts uses getForceBypassPath from here)
vi.mock('../../../../../core/src/tasks/gate-audit.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../../core/src/tasks/gate-audit.js')>();
  return {
    ...actual,
    // Keep getForceBypassPath to allow audit file writes in test 7
  };
});

// ---------------------------------------------------------------------------
// Mock @cleocode/core (used by engine-result.ts for engineError/engineSuccess)
// ---------------------------------------------------------------------------

vi.mock('@cleocode/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core')>();
  return {
    ...actual,
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { Session } from '@cleocode/core';
import {
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
} from '../../../../../core/src/lifecycle/engine-ops.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPIC_ID = 'T1150';
const CHILD_TASK_ID = 'T1159';
const PROJECT_ROOT = '/mock/project';

/** Build a minimal Session with the given scope. */
function makeSession(scope: Session['scope']): Session {
  return {
    id: 'ses_test_001',
    name: 'test-session',
    status: 'active',
    scope,
    taskWork: { taskId: null, setAt: null },
    startedAt: new Date().toISOString(),
  };
}

/** Scope where session is scoped to a child task (not the target epic). */
const CHILD_SCOPED_SESSION = makeSession({
  type: 'epic',
  epicId: EPIC_ID,
  rootTaskId: CHILD_TASK_ID, // rootTaskId is the child, NOT the parent epic
});

/** Scope where session is correctly scoped to the target epic. */
const EPIC_SCOPED_SESSION = makeSession({
  type: 'epic',
  epicId: EPIC_ID,
  rootTaskId: EPIC_ID,
});

/** Global scope — owner-level. */
const GLOBAL_SCOPED_SESSION = makeSession({ type: 'global' });

/** Happy-path stubs — let the downstream operations succeed. */
function stubDownstreamHappy(): void {
  mocks.recordStageProgress.mockResolvedValue({
    taskId: EPIC_ID,
    stage: 'research',
    status: 'completed',
  });
  mocks.skipStageWithReason.mockResolvedValue({ taskId: EPIC_ID, stage: 'research' });
  mocks.resetStage.mockResolvedValue({ taskId: EPIC_ID, stage: 'research' });
  mocks.getLifecycleStatus.mockResolvedValue({ currentStage: null });
  mocks.checkGate.mockResolvedValue({ allowed: true, message: '' });
  mocks.resolveStageAlias.mockImplementation((s: string) => s);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir = '';

beforeEach(() => {
  vi.clearAllMocks();
  stubDownstreamHappy();
  // Clear override env vars between tests
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  delete process.env['CLEO_AGENT_ROLE'];
  // Create a temp dir for audit file tests
  tmpDir = join(tmpdir(), `scope-guard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  delete process.env['CLEO_OWNER_OVERRIDE'];
  delete process.env['CLEO_OWNER_OVERRIDE_REASON'];
  delete process.env['CLEO_AGENT_ROLE'];
  if (tmpDir && existsSync(tmpDir)) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 1-3: Child-task-scoped session → rejected for all three mutate operations
// ---------------------------------------------------------------------------

describe('child-task-scoped session (rootTaskId != target epicId)', () => {
  it('1. lifecycleProgress rejects with E_LIFECYCLE_SCOPE_DENIED', async () => {
    mocks.getActiveSession.mockResolvedValue(CHILD_SCOPED_SESSION);

    const result = await lifecycleProgress(
      EPIC_ID,
      'research',
      'completed',
      undefined,
      PROJECT_ROOT,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(result.error?.message).toContain(EPIC_ID);
    expect(result.error?.message).toContain('CLEO_OWNER_OVERRIDE');

    // Downstream recordStageProgress must NOT have been called
    expect(mocks.recordStageProgress).not.toHaveBeenCalled();
  });

  it('2. lifecycleSkip rejects with E_LIFECYCLE_SCOPE_DENIED', async () => {
    mocks.getActiveSession.mockResolvedValue(CHILD_SCOPED_SESSION);

    const result = await lifecycleSkip(EPIC_ID, 'research', 'testing skip', PROJECT_ROOT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(result.error?.message).toContain(EPIC_ID);

    expect(mocks.skipStageWithReason).not.toHaveBeenCalled();
  });

  it('3. lifecycleReset rejects with E_LIFECYCLE_SCOPE_DENIED', async () => {
    mocks.getActiveSession.mockResolvedValue(CHILD_SCOPED_SESSION);

    const result = await lifecycleReset(EPIC_ID, 'research', 'testing reset', PROJECT_ROOT);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(result.error?.message).toContain(EPIC_ID);

    expect(mocks.resetStage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4: Epic-scoped session (rootTaskId = target epicId) → allowed
// ---------------------------------------------------------------------------

describe('epic-scoped session (rootTaskId = target epicId)', () => {
  it('4. lifecycleProgress proceeds when session is scoped to the target epic', async () => {
    mocks.getActiveSession.mockResolvedValue(EPIC_SCOPED_SESSION);

    const result = await lifecycleProgress(
      EPIC_ID,
      'research',
      'completed',
      undefined,
      PROJECT_ROOT,
    );

    // Should not be a scope error
    expect(result.error?.code).not.toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(mocks.recordStageProgress).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5: Global scope → always allowed
// ---------------------------------------------------------------------------

describe('global scope session', () => {
  it('5. lifecycleProgress is allowed with global scope', async () => {
    mocks.getActiveSession.mockResolvedValue(GLOBAL_SCOPED_SESSION);

    const result = await lifecycleProgress(
      EPIC_ID,
      'research',
      'completed',
      undefined,
      PROJECT_ROOT,
    );

    expect(result.error?.code).not.toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(mocks.recordStageProgress).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 6: No active session → allowed (defer to session enforcement layer)
// ---------------------------------------------------------------------------

describe('no active session', () => {
  it('6. lifecycleProgress proceeds when there is no active session', async () => {
    mocks.getActiveSession.mockResolvedValue(null);

    const result = await lifecycleProgress(
      EPIC_ID,
      'research',
      'completed',
      undefined,
      PROJECT_ROOT,
    );

    expect(result.error?.code).not.toBe('E_LIFECYCLE_SCOPE_DENIED');
    expect(mocks.recordStageProgress).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 7: Child-task-scoped + CLEO_OWNER_OVERRIDE=1 → allowed + audit entry written
// ---------------------------------------------------------------------------

describe('CLEO_OWNER_OVERRIDE=1 escape hatch', () => {
  it('7. lifecycleProgress is allowed with CLEO_OWNER_OVERRIDE=1 + audit entry written', async () => {
    mocks.getActiveSession.mockResolvedValue(CHILD_SCOPED_SESSION);
    process.env['CLEO_OWNER_OVERRIDE'] = '1';
    process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'incident-1234 hotfix';

    const result = await lifecycleProgress(EPIC_ID, 'research', 'completed', undefined, tmpDir);

    // Should not be a scope error
    expect(result.error?.code).not.toBe('E_LIFECYCLE_SCOPE_DENIED');
    // Downstream was called
    expect(mocks.recordStageProgress).toHaveBeenCalled();

    // Audit entry should have been written to the force-bypass log
    const auditPath = join(tmpDir, '.cleo', 'audit', 'force-bypass.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const auditContent = readFileSync(auditPath, 'utf-8').trim();
    const auditEntry = JSON.parse(auditContent);
    expect(auditEntry.type).toBe('lifecycle_scope_bypass');
    expect(auditEntry.epicId).toBe(EPIC_ID);
    expect(auditEntry.overrideReason).toBe('incident-1234 hotfix');
  });
});

// ---------------------------------------------------------------------------
// 8: Worker role + CLEO_OWNER_OVERRIDE=1 → still denied (T1118 L4b)
// ---------------------------------------------------------------------------

describe('restricted agent role + CLEO_OWNER_OVERRIDE=1', () => {
  const restrictedRoles = ['worker', 'lead', 'subagent'] as const;

  for (const role of restrictedRoles) {
    it(`8. lifecycleProgress is denied when CLEO_AGENT_ROLE=${role} even with override`, async () => {
      mocks.getActiveSession.mockResolvedValue(CHILD_SCOPED_SESSION);
      process.env['CLEO_OWNER_OVERRIDE'] = '1';
      process.env['CLEO_OWNER_OVERRIDE_REASON'] = 'should be blocked';
      process.env['CLEO_AGENT_ROLE'] = role;

      const result = await lifecycleProgress(
        EPIC_ID,
        'research',
        'completed',
        undefined,
        PROJECT_ROOT,
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_LIFECYCLE_SCOPE_DENIED');
      expect(mocks.recordStageProgress).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Regression: T1150 incident — all 9 stages in 75 seconds
//
// Simulates the exact pattern the subagent used: a session scoped to child
// task T1159 advancing T1150's lifecycle through all RCASD stages.
// ---------------------------------------------------------------------------

describe('regression: T1150 incident (9 stages in 75 seconds)', () => {
  const RCASD_STAGES = [
    'research',
    'consensus',
    'architecture_decision',
    'specification',
    'decomposition',
    'implementation',
    'validation',
    'testing',
    'release',
  ] as const;

  it('all 9 lifecycle stages are blocked for a child-task-scoped session', async () => {
    // Simulate the T1159 subagent session (scoped to T1159, not T1150)
    const t1159Session = makeSession({
      type: 'epic',
      epicId: 'T1150', // part of T1150 epic
      rootTaskId: 'T1159', // but working on child T1159
    });
    mocks.getActiveSession.mockResolvedValue(t1159Session);

    for (const stage of RCASD_STAGES) {
      const result = await lifecycleProgress('T1150', stage, 'completed', undefined, PROJECT_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_LIFECYCLE_SCOPE_DENIED');
    }

    // None of the 9 stage advancement calls should have reached the DB
    expect(mocks.recordStageProgress).not.toHaveBeenCalled();
  });
});
