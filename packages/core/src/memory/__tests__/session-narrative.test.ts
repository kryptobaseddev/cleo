/**
 * Tests for session-narrative.ts — detectPivot with cosine similarity + keyword fallback.
 *
 * Covers:
 *   - cosineSimilarity helper correctness
 *   - detectPivot using embedding-based cosine path (vec-available)
 *   - detectPivot using keyword-overlap fallback path (vec-unavailable)
 *   - PIVOT_COSINE_THRESHOLD constant is exported and numeric
 *   - Edge cases: empty narrative, short delta, zero-magnitude vectors
 *
 * @task T1531
 * @epic T1056
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock brain-embedding before importing session-narrative
// ---------------------------------------------------------------------------

vi.mock('../brain-embedding.js', () => ({
  isEmbeddingAvailable: vi.fn(() => false),
  embedText: vi.fn(async (_text: string) => null),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are registered)
// ---------------------------------------------------------------------------

import { embedText, isEmbeddingAvailable } from '../brain-embedding.js';
import { cosineSimilarity, detectPivot, PIVOT_COSINE_THRESHOLD } from '../session-narrative.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a Float32Array filled with a constant value. */
function constVec(dims: number, value: number): Float32Array {
  return new Float32Array(dims).fill(value);
}

/** Create a unit vector along dimension `axis` of total `dims`. */
function unitVec(dims: number, axis: number): Float32Array {
  const v = new Float32Array(dims);
  v[axis] = 1;
  return v;
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    const v = new Float32Array([1, 0.5, -0.3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = unitVec(3, 0);
    const b = unitVec(3, 1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it('returns 0 for zero-magnitude vectors (avoids division by zero)', () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = unitVec(3, 0);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it('is commutative', () => {
    const a = new Float32Array([0.1, 0.9, 0.3]);
    const b = new Float32Array([0.8, 0.2, 0.5]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 10);
  });

  it('handles constant vectors (all same value)', () => {
    const a = constVec(4, 0.5);
    const b = constVec(4, 0.5);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5);
  });
});

// ---------------------------------------------------------------------------
// PIVOT_COSINE_THRESHOLD constant
// ---------------------------------------------------------------------------

describe('PIVOT_COSINE_THRESHOLD', () => {
  it('is a number', () => {
    expect(typeof PIVOT_COSINE_THRESHOLD).toBe('number');
  });

  it('is between 0 and 1 exclusive', () => {
    expect(PIVOT_COSINE_THRESHOLD).toBeGreaterThan(0);
    expect(PIVOT_COSINE_THRESHOLD).toBeLessThan(1);
  });
});

// ---------------------------------------------------------------------------
// detectPivot — keyword fallback path (embedding unavailable)
// ---------------------------------------------------------------------------

describe('detectPivot — keyword fallback (embedding unavailable)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isEmbeddingAvailable).mockReturnValue(false);
    vi.mocked(embedText).mockResolvedValue(null);
  });

  it('returns false when existingNarrative is empty', async () => {
    const result = await detectPivot('switching to Rust implementation', '');
    expect(result).toBe(false);
  });

  it('returns false when existingNarrative is whitespace only', async () => {
    const result = await detectPivot('switching to Rust implementation', '   ');
    expect(result).toBe(false);
  });

  it('detects pivot when delta tokens are mostly new (different topic)', async () => {
    const existing = 'typescript type system discussion interface generics polymorphism';
    const delta = 'switching rust memory safety borrow checker lifetimes ownership';
    const result = await detectPivot(delta, existing);
    expect(result).toBe(true);
  });

  it('does not detect pivot when delta tokens largely overlap with narrative', async () => {
    const existing = 'typescript type system discussion interface generics polymorphism';
    const delta = 'continuing typescript type system work with generics interface design';
    const result = await detectPivot(delta, existing);
    expect(result).toBe(false);
  });

  it('returns false for short delta (< 5 tokens) to avoid false positives', async () => {
    const existing = 'typescript type system discussion';
    // Only 4 tokens of length >= 4: "done" "with" "that" -> actually 1 token "that" (len 4), "done" (len 4), "with" (len 4)
    // Build a delta that tokenises to < 5 words
    const delta = 'okay done'; // 0 tokens >= 4 chars: none pass
    const result = await detectPivot(delta, existing);
    expect(result).toBe(false);
  });

  it('embedText is not called when embedding is unavailable', async () => {
    vi.mocked(isEmbeddingAvailable).mockReturnValue(false);
    const existing = 'typescript type system discussion interface generics';
    const delta = 'switching rust memory safety borrow checker lifetimes';
    await detectPivot(delta, existing);
    expect(embedText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// detectPivot — cosine similarity path (embedding available)
// ---------------------------------------------------------------------------

describe('detectPivot — cosine similarity (embedding available)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isEmbeddingAvailable).mockReturnValue(true);
  });

  it('detects pivot when cosine similarity is below threshold', async () => {
    // Orthogonal unit vectors → similarity = 0, which is below PIVOT_COSINE_THRESHOLD (0.3)
    const deltaVec = unitVec(384, 0);
    const narrativeVec = unitVec(384, 1);

    vi.mocked(embedText).mockImplementation(async (text: string) => {
      return text.startsWith('rust') ? deltaVec : narrativeVec;
    });

    const result = await detectPivot('rust memory ownership', 'typescript generics system');
    expect(result).toBe(true);
  });

  it('does not detect pivot when cosine similarity is above threshold', async () => {
    // Identical vectors → similarity = 1, which is above PIVOT_COSINE_THRESHOLD (0.3)
    const sharedVec = constVec(384, 0.1);

    vi.mocked(embedText).mockResolvedValue(sharedVec);

    const result = await detectPivot('continuing typescript work', 'typescript type system');
    expect(result).toBe(false);
  });

  it('detects pivot at exactly the threshold boundary (similarity === threshold → no pivot)', async () => {
    // cosine similarity === PIVOT_COSINE_THRESHOLD means NOT a pivot (strictly less than triggers)
    const dims = 384;
    // Build two vectors with cosine similarity exactly equal to PIVOT_COSINE_THRESHOLD (0.3)
    // Using: a = [1, 0, ...], b = [0.3, sqrt(1-0.09), 0, ...] normalized
    const a = new Float32Array(dims);
    a[0] = 1;
    const b = new Float32Array(dims);
    b[0] = PIVOT_COSINE_THRESHOLD;
    b[1] = Math.sqrt(1 - PIVOT_COSINE_THRESHOLD ** 2);

    vi.mocked(embedText)
      .mockResolvedValueOnce(a) // delta
      .mockResolvedValueOnce(b); // narrative

    const result = await detectPivot('delta text', 'narrative text');
    // similarity equals threshold → not strictly less than → no pivot
    expect(result).toBe(false);
  });

  it('falls back to keyword heuristic when embedText returns null for delta', async () => {
    vi.mocked(isEmbeddingAvailable).mockReturnValue(true);
    vi.mocked(embedText).mockResolvedValueOnce(null); // delta returns null

    // existing narrative has many shared tokens to avoid pivot via keyword path
    const existing = 'typescript generics type system interface design polymorphism';
    const delta = 'typescript generics type system interface design polymorphism continues';
    const result = await detectPivot(delta, existing);
    // keyword path: high overlap → no pivot
    expect(result).toBe(false);
  });

  it('falls back to keyword heuristic when embedText returns null for narrative', async () => {
    vi.mocked(isEmbeddingAvailable).mockReturnValue(true);
    const deltaVec = unitVec(384, 0);
    vi.mocked(embedText)
      .mockResolvedValueOnce(deltaVec) // delta gets a vec
      .mockResolvedValueOnce(null); // narrative returns null

    // keyword path: different topics → pivot
    const existing = 'typescript generics type system interface design polymorphism';
    const delta = 'rust ownership memory borrow checker lifetimes allocation pointers';
    const result = await detectPivot(delta, existing);
    // keyword path: low overlap → pivot
    expect(result).toBe(true);
  });

  it('calls embedText for both delta and narrative when embedding is available', async () => {
    const sharedVec = constVec(384, 0.5);
    vi.mocked(embedText).mockResolvedValue(sharedVec);

    await detectPivot('delta narrative text content', 'existing narrative content here');
    expect(embedText).toHaveBeenCalledTimes(2);
  });

  it('returns false for empty existing narrative regardless of embedding path', async () => {
    const sharedVec = constVec(384, 0.5);
    vi.mocked(embedText).mockResolvedValue(sharedVec);

    const result = await detectPivot('any topic text content here words', '');
    expect(result).toBe(false);
    // Should short-circuit before calling embedText
    expect(embedText).not.toHaveBeenCalled();
  });
});
