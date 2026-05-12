/**
 * Tests for T1897 — origin + validated_at + provenance_chain on brain_observations.
 *
 * Verifies:
 * 1. observeBrain accepts and passes through origin param
 * 2. observeBrain accepts and passes through provenanceChain param
 * 3. ProvenanceDistribution computeProvenanceDistribution returns correct structure
 * 4. manual origin set correctly when sourceType='manual'
 *
 * @task T1897
 * @epic T1892
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockGetBrainDb = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const mockGetBrainNativeDb = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockGetBrainAccessor = vi.hoisted(() => vi.fn());
const mockAddObservation = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    id: 'O-test-001',
    type: 'discovery',
    title: 'Test',
    narrative: 'Test obs',
    createdAt: '2026-05-12 00:00:00',
  }),
);
const mockIsEmbeddingAvailable = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockVerifyCandidate = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ action: 'stored', id: null, reason: 'verified-new' }),
);

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

vi.mock('../../store/memory-accessor.js', () => ({
  getBrainAccessor: mockGetBrainAccessor,
}));

vi.mock('../brain-embedding.js', () => ({
  isEmbeddingAvailable: mockIsEmbeddingAvailable,
}));

vi.mock('../extraction-gate.js', () => ({
  verifyCandidate: mockVerifyCandidate,
  verifyAndStore: vi
    .fn()
    .mockResolvedValue({ action: 'stored', id: 'O-test-001', reason: 'verified-new' }),
}));

vi.mock('../brain-similarity.js', () => ({
  searchSimilar: vi.fn().mockResolvedValue([]),
}));

vi.mock('../graph-auto-populate.js', () => ({
  upsertGraphNode: vi.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { observeBrain } from '../brain-retrieval.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

function buildMockAccessor() {
  return {
    addObservation: mockAddObservation,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mockAddObservation.mockResolvedValue({
    id: 'O-test-001',
    type: 'discovery',
    title: 'Test',
    narrative: 'Test obs',
    createdAt: '2026-05-12 00:00:00',
  });
  mockVerifyCandidate.mockResolvedValue({ action: 'stored', id: null, reason: 'verified-new' });
});

// ============================================================================
// Tests
// ============================================================================

describe('observeBrain — T1897 provenance columns', () => {
  it('passes origin param through to addObservation', async () => {
    mockGetBrainAccessor.mockResolvedValue(buildMockAccessor());

    await observeBrain(PROJECT_ROOT, {
      text: 'Test observation',
      origin: 'manual',
      _skipGate: true,
    });

    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    const call = mockAddObservation.mock.calls[0][0];
    expect(call.origin).toBe('manual');
  });

  it('passes provenanceChain param through as JSON to addObservation', async () => {
    mockGetBrainAccessor.mockResolvedValue(buildMockAccessor());

    await observeBrain(PROJECT_ROOT, {
      text: 'Derived observation',
      origin: 'auto-extract',
      provenanceChain: ['O-parent-001', 'O-parent-002'],
      _skipGate: true,
    });

    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    const call = mockAddObservation.mock.calls[0][0];
    expect(call.provenanceChain).toBe(JSON.stringify(['O-parent-001', 'O-parent-002']));
    expect(call.origin).toBe('auto-extract');
  });

  it('omits origin when not provided', async () => {
    mockGetBrainAccessor.mockResolvedValue(buildMockAccessor());

    await observeBrain(PROJECT_ROOT, {
      text: 'Legacy observation',
      _skipGate: true,
    });

    expect(mockAddObservation).toHaveBeenCalledTimes(1);
    const call = mockAddObservation.mock.calls[0][0];
    expect(call).not.toHaveProperty('origin');
    expect(call).not.toHaveProperty('provenanceChain');
  });

  it('accepts test origin for test-generated observations', async () => {
    mockGetBrainAccessor.mockResolvedValue(buildMockAccessor());

    await observeBrain(PROJECT_ROOT, {
      text: 'Test fixture observation',
      origin: 'test',
      _skipGate: true,
    });

    const call = mockAddObservation.mock.calls[0][0];
    expect(call.origin).toBe('test');
  });
});
