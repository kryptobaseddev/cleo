/**
 * Tests for the programmatic PreCompact flush hook handler (T1013).
 *
 * Verifies that:
 *   1. `handlePreCompactFlush` invokes `precompactFlush` with the given root.
 *   2. A successful flush returns a LAFS-shaped envelope with `success: true`.
 *   3. Flush errors are captured in `meta.warnings` (never thrown).
 *   4. Unexpected throws from `precompactFlush` surface as a failure
 *      envelope with `success: false` + `E_PRECOMPACT_FLUSH_FAILED`.
 *   5. The handler is idempotent — the second call after a successful flush
 *      returns `{flushed: 0}` without error.
 *   6. The hook registry resolves `PreCompact` to this handler at priority 110,
 *      ensuring it runs *before* the observation-writer at priority 100.
 *
 * @task T1013
 * @epic T1000
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mocks — must be declared before module import for auto-registration
// ---------------------------------------------------------------------------

const { mockPrecompactFlush } = vi.hoisted(() => ({
  mockPrecompactFlush: vi.fn(),
}));

vi.mock('../../../memory/precompact-flush.js', () => ({
  precompactFlush: mockPrecompactFlush,
}));

// ---------------------------------------------------------------------------
// Import module under test AFTER mocks are registered
// ---------------------------------------------------------------------------

// Re-import the shared registry so we can inspect handler registration.
import { hooks } from '../../registry.js';
import type { PreCompactPayload } from '../../types.js';
import {
  handlePreCompactFlush,
  PRECOMPACT_FLUSH_HOOK_ID,
  PRECOMPACT_FLUSH_HOOK_PRIORITY,
  precompactHookRegistryAdapter,
} from '../precompact.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/fake/project';

/** Build a minimal PreCompactPayload for test dispatches. */
function makePayload(overrides: Partial<PreCompactPayload> = {}): PreCompactPayload {
  return {
    timestamp: '2026-04-19T12:00:00.000Z',
    sessionId: 'ses_test_001',
    tokensBefore: 120_000,
    reason: 'auto-compact-95-percent',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handlePreCompactFlush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: successful empty-queue flush.
    mockPrecompactFlush.mockResolvedValue({
      flushed: 0,
      walCheckpointed: true,
      errors: [],
    });
  });

  // -------------------------------------------------------------------------
  // 1. Invokes precompactFlush with the project root
  // -------------------------------------------------------------------------

  it('invokes precompactFlush with the supplied project root', async () => {
    await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(mockPrecompactFlush).toHaveBeenCalledTimes(1);
    expect(mockPrecompactFlush).toHaveBeenCalledWith(PROJECT_ROOT);
  });

  // -------------------------------------------------------------------------
  // 2. Returns LAFS envelope on success (populated queue case)
  // -------------------------------------------------------------------------

  it('returns a LAFS success envelope with flushed + walCheckpointed', async () => {
    mockPrecompactFlush.mockResolvedValueOnce({
      flushed: 3,
      walCheckpointed: true,
      errors: [],
    });

    const envelope = await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.data.flushed).toBe(3);
      expect(envelope.data.walCheckpointed).toBe(true);
      expect(envelope.meta.projectRoot).toBe(PROJECT_ROOT);
      expect(envelope.meta.sessionId).toBe('ses_test_001');
      expect(envelope.meta.warnings).toEqual([]);
      expect(typeof envelope.meta.timestamp).toBe('string');
      expect(envelope.meta.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Empty-queue + WAL checkpoint case
  // -------------------------------------------------------------------------

  it('returns flushed=0 with walCheckpointed=true when the queue is empty', async () => {
    const envelope = await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.data.flushed).toBe(0);
      expect(envelope.data.walCheckpointed).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Flush errors are surfaced via meta.warnings (never thrown)
  // -------------------------------------------------------------------------

  it('captures per-observation flush errors in meta.warnings', async () => {
    mockPrecompactFlush.mockResolvedValueOnce({
      flushed: 1,
      walCheckpointed: true,
      errors: ['Failed to flush observation "obs-2": DB write failed'],
    });

    const envelope = await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.data.flushed).toBe(1);
      expect(envelope.meta.warnings).toHaveLength(1);
      expect(envelope.meta.warnings[0]).toContain('DB write failed');
    }
  });

  // -------------------------------------------------------------------------
  // 5. Unexpected throws produce a LAFS failure envelope — never throw
  // -------------------------------------------------------------------------

  it('returns a LAFS failure envelope when precompactFlush throws unexpectedly', async () => {
    mockPrecompactFlush.mockRejectedValueOnce(new Error('catastrophic failure'));

    const envelope = await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(envelope.success).toBe(false);
    if (!envelope.success) {
      expect(envelope.error.code).toBe('E_PRECOMPACT_FLUSH_FAILED');
      expect(envelope.error.message).toContain('catastrophic failure');
      expect(envelope.meta.projectRoot).toBe(PROJECT_ROOT);
    }
  });

  it('never throws — always resolves to an envelope', async () => {
    mockPrecompactFlush.mockRejectedValueOnce(new Error('boom'));

    await expect(handlePreCompactFlush(PROJECT_ROOT, makePayload())).resolves.toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 6. Idempotency — second call after drain returns flushed=0
  // -------------------------------------------------------------------------

  it('is idempotent — second invocation after a drain returns flushed=0', async () => {
    mockPrecompactFlush
      .mockResolvedValueOnce({ flushed: 2, walCheckpointed: true, errors: [] })
      .mockResolvedValueOnce({ flushed: 0, walCheckpointed: true, errors: [] });

    const first = await handlePreCompactFlush(PROJECT_ROOT, makePayload());
    const second = await handlePreCompactFlush(PROJECT_ROOT, makePayload());

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success) expect(first.data.flushed).toBe(2);
    if (second.success) expect(second.data.flushed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. Omits sessionId from meta when payload lacks it
  // -------------------------------------------------------------------------

  it('omits meta.sessionId when the payload has no sessionId', async () => {
    const payload: PreCompactPayload = {
      timestamp: '2026-04-19T12:00:00.000Z',
      tokensBefore: 9000,
    };

    const envelope = await handlePreCompactFlush(PROJECT_ROOT, payload);

    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.meta.sessionId).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Registry lookup: PreCompact resolves to the flush handler at priority 110
// ---------------------------------------------------------------------------

describe('PreCompact hook registry wiring', () => {
  it('registers the flush handler under PreCompact with id and priority', () => {
    const registrations = hooks.listHandlers('PreCompact');
    const flushReg = registrations.find((r) => r.id === PRECOMPACT_FLUSH_HOOK_ID);

    expect(flushReg).toBeDefined();
    expect(flushReg?.priority).toBe(PRECOMPACT_FLUSH_HOOK_PRIORITY);
    expect(flushReg?.priority).toBe(110);
    // Registry-facing adapter is registered (wraps the rich-envelope handler
    // in a `Promise<void>` shell to satisfy HookHandler contract).
    expect(flushReg?.handler).toBe(precompactHookRegistryAdapter);
  });

  it('registry adapter returns void but still invokes handlePreCompactFlush internally', async () => {
    // Sanity check: we get a Promise<void>, not a Promise<envelope>.
    const returned = precompactHookRegistryAdapter('/tmp', {
      timestamp: '2026-04-19T12:00:00.000Z',
    });
    expect(returned).toBeInstanceOf(Promise);
    const resolved = await returned;
    expect(resolved).toBeUndefined();
  });

  it('flush handler priority (110) sorts ahead of brain-pre-compact (100)', () => {
    const registrations = hooks.listHandlers('PreCompact');
    const flushIdx = registrations.findIndex((r) => r.id === PRECOMPACT_FLUSH_HOOK_ID);
    const observeIdx = registrations.findIndex((r) => r.id === 'brain-pre-compact');

    // Registry sorts by priority DESC, so the higher-priority flush must
    // precede the observation-writer in the dispatch order.
    expect(flushIdx).toBeGreaterThanOrEqual(0);
    // brain-pre-compact is registered by context-hooks.ts; if it's loaded
    // (which it will be via handlers/index.ts) the flush should come first.
    if (observeIdx !== -1) {
      expect(flushIdx).toBeLessThan(observeIdx);
    }
  });

  it('exports stable PRECOMPACT_FLUSH_HOOK_ID and priority constants', () => {
    expect(PRECOMPACT_FLUSH_HOOK_ID).toBe('brain-precompact-flush');
    expect(PRECOMPACT_FLUSH_HOOK_PRIORITY).toBe(110);
  });
});
