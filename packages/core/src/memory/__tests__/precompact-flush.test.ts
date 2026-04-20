/**
 * Tests for precompact-flush.ts (T1004).
 *
 * Verifies that:
 * 1. A flush with zero pending observations returns {flushed: 0} without error.
 * 2. Pending observations queued via enqueuePendingObservation are persisted on flush.
 * 3. The dispatch operation 'precompact-flush' is registered in memory.ts getSupportedOperations().mutate.
 * 4. precompact-safestop.sh contains the string "cleo memory precompact-flush".
 * 5. A second flush call after the queue is cleared is a no-op.
 * 6. precompact-flush.ts exports a precompactFlush function with an explicit return type.
 *
 * @task T1004
 * @epic T1000
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
// ============================================================================

const { mockObserveBrain, mockGetBrainNativeDb, mockExec } = vi.hoisted(() => {
  const mockExec = vi.fn();
  return {
    mockObserveBrain: vi.fn().mockResolvedValue({ id: 'obs-1', type: 'discovery', createdAt: '' }),
    mockGetBrainNativeDb: vi.fn().mockReturnValue({ exec: mockExec }),
    mockExec,
  };
});

vi.mock('../brain-retrieval.js', () => ({
  observeBrain: mockObserveBrain,
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainNativeDb: mockGetBrainNativeDb,
}));

vi.mock('../../sessions/context-alert.js', () => ({
  getCurrentSessionId: vi.fn().mockReturnValue('ses_test_001'),
}));

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import {
  clearPendingObservations,
  enqueuePendingObservation,
  getPendingObservations,
  precompactFlush,
} from '../precompact-flush.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

// ============================================================================
// Tests
// ============================================================================

describe('precompactFlush', () => {
  beforeEach(() => {
    // Reset the pending queue and mocks before each test.
    clearPendingObservations();
    vi.clearAllMocks();
    // Re-apply default mock return values after clearAllMocks.
    mockObserveBrain.mockResolvedValue({ id: 'obs-1', type: 'discovery', createdAt: '' });
    mockGetBrainNativeDb.mockReturnValue({ exec: mockExec });
  });

  afterEach(() => {
    clearPendingObservations();
  });

  // -------------------------------------------------------------------------
  // Test 1: Zero pending observations → {flushed: 0} no error
  // -------------------------------------------------------------------------

  it('returns flushed=0 when no pending observations exist', async () => {
    const result = await precompactFlush(PROJECT_ROOT);

    expect(result.flushed).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockObserveBrain).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 2: Pending observations are persisted
  // -------------------------------------------------------------------------

  it('flushes all queued pending observations to brain_observations', async () => {
    enqueuePendingObservation({
      text: 'Working on T1004 flush logic',
      title: 'T1004 progress note',
      type: 'discovery',
      sessionId: 'ses_test_001',
    });
    enqueuePendingObservation({
      text: 'WAL checkpoint strategy decided',
      title: 'WAL strategy',
      type: 'decision',
    });
    enqueuePendingObservation({
      text: 'In-flight safestop hook pattern identified',
      title: 'Safestop pattern',
    });

    expect(getPendingObservations()).toHaveLength(3);

    const result = await precompactFlush(PROJECT_ROOT);

    expect(result.flushed).toBe(3);
    expect(result.errors).toHaveLength(0);
    expect(mockObserveBrain).toHaveBeenCalledTimes(3);

    // Verify each call used the correct text and sourceType
    expect(mockObserveBrain).toHaveBeenCalledWith(
      PROJECT_ROOT,
      expect.objectContaining({
        text: 'Working on T1004 flush logic',
        sourceType: 'agent',
      }),
    );
    expect(mockObserveBrain).toHaveBeenCalledWith(
      PROJECT_ROOT,
      expect.objectContaining({
        text: 'WAL checkpoint strategy decided',
        sourceType: 'agent',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 3: WAL checkpoint is executed when nativeDb is available
  // -------------------------------------------------------------------------

  it('executes PRAGMA wal_checkpoint(TRUNCATE) when brain.db is open', async () => {
    const result = await precompactFlush(PROJECT_ROOT);

    expect(result.walCheckpointed).toBe(true);
    expect(mockExec).toHaveBeenCalledWith('PRAGMA wal_checkpoint(TRUNCATE)');
  });

  it('skips WAL checkpoint gracefully when brain.db is not initialised (nativeDb = null)', async () => {
    mockGetBrainNativeDb.mockReturnValueOnce(null);

    const result = await precompactFlush(PROJECT_ROOT);

    expect(result.walCheckpointed).toBe(false);
    expect(result.errors).toHaveLength(0);
    expect(mockExec).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 4: Idempotency — second call is a no-op
  // -------------------------------------------------------------------------

  it('second flush call is a no-op after queue is cleared', async () => {
    enqueuePendingObservation({
      text: 'First flush observation',
      title: 'First obs',
      type: 'discovery',
    });

    const first = await precompactFlush(PROJECT_ROOT);
    expect(first.flushed).toBe(1);

    // Reset exec mock call count but keep it functional
    mockExec.mockClear();
    mockObserveBrain.mockClear();

    // Second call — queue should be empty
    const second = await precompactFlush(PROJECT_ROOT);
    expect(second.flushed).toBe(0);
    expect(mockObserveBrain).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Test 5: Errors in individual observation flushes are captured, not thrown
  // -------------------------------------------------------------------------

  it('captures per-observation errors without throwing', async () => {
    enqueuePendingObservation({ text: 'Good observation', title: 'Good' });
    enqueuePendingObservation({ text: 'Bad observation', title: 'Bad' });

    mockObserveBrain
      .mockResolvedValueOnce({ id: 'obs-ok', type: 'discovery', createdAt: '' })
      .mockRejectedValueOnce(new Error('DB write failed'));

    const result = await precompactFlush(PROJECT_ROOT);

    expect(result.flushed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('DB write failed');
  });

  // -------------------------------------------------------------------------
  // Test 6: enqueuePendingObservation / getPendingObservations / clear
  // -------------------------------------------------------------------------

  it('enqueuePendingObservation adds to the queue, clearPendingObservations drains it', () => {
    expect(getPendingObservations()).toHaveLength(0);

    enqueuePendingObservation({ text: 'obs 1' });
    enqueuePendingObservation({ text: 'obs 2' });

    expect(getPendingObservations()).toHaveLength(2);

    clearPendingObservations();
    expect(getPendingObservations()).toHaveLength(0);
  });
});

// ============================================================================
// Integration: dispatch operation registration
// ============================================================================

describe('MemoryHandler — precompact-flush operation registration', () => {
  it('registers precompact-flush in getSupportedOperations().mutate', () => {
    // MemoryHandler lives in @cleocode/cleo. Dynamic imports across packages
    // from a core vitest context are flaky (circular @cleocode/core resolution)
    // — verify via source grep instead. The corresponding behavior test lives
    // in packages/cleo/src/dispatch/domains/__tests__/memory.test.ts.
    const handlerSourcePath = join(
      import.meta.dirname ?? __dirname,
      '../../../../cleo/src/dispatch/domains/memory.ts',
    );
    const handlerSource = readFileSync(handlerSourcePath, 'utf-8');
    expect(handlerSource).toContain("'precompact-flush'");
    expect(handlerSource).toMatch(/case\s+'precompact-flush'/);
  });
});

// ============================================================================
// Shell script check: precompact-safestop.sh contains the flush call
// ============================================================================

describe('precompact-safestop.sh', () => {
  it('contains "cleo memory precompact-flush" invocation', () => {
    // Resolve path from this test file location:
    // packages/core/src/memory/__tests__/ -> ../../../templates/hooks/
    const scriptPath = join(
      import.meta.dirname ?? __dirname,
      '../../../templates/hooks/precompact-safestop.sh',
    );
    const scriptContent = readFileSync(scriptPath, 'utf-8');
    expect(scriptContent).toContain('cleo memory precompact-flush');
  });
});

// ============================================================================
// Export signature check (compile-time & runtime)
// ============================================================================

describe('precompactFlush export signature', () => {
  it('exports precompactFlush as an async function', () => {
    expect(typeof precompactFlush).toBe('function');
    // Invoke with no args to verify it returns a Promise (explicit return type)
    clearPendingObservations();
    const returnValue = precompactFlush();
    expect(returnValue).toBeInstanceOf(Promise);
    // Await to avoid unhandled promise warning
    return returnValue;
  });

  it('exports enqueuePendingObservation, getPendingObservations, clearPendingObservations', () => {
    expect(typeof enqueuePendingObservation).toBe('function');
    expect(typeof getPendingObservations).toBe('function');
    expect(typeof clearPendingObservations).toBe('function');
  });
});
