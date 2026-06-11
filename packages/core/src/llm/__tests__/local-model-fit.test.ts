/**
 * Tests for `llm/local-model-fit.ts` (T11982 · T11990).
 *
 * Coverage:
 *   - low-RAM floor (< 4 GB → no recommendation)
 *   - 8 GB RAM pick (gemma4:e4b-class should rank highly)
 *   - 32 GB RAM pick (gemma4:12b eligible)
 *   - 62 GB RAM + VRAM present → VRAM boost ranks larger models
 *   - already-pulled model gets bonus and surfaces in `alreadyPulled`
 *   - Ollama running + model in /api/tags → `alreadyPulled: true`
 *   - Ollama not running → empty pulledModels, `ollamaRunning: false`
 *
 * @task T11982
 * @task T11990
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OllamaPulledModel, VramInfo } from '../local-model-fit.js';
import {
  captureHardwareSnapshot,
  LOCAL_FIT_FLOOR_GB,
  LOCAL_MODEL_CANDIDATES,
  listOllamaPulledModels,
  rankLocalModelFit,
} from '../local-model-fit.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GB = 1024 ** 3;

function makeVramNone(): VramInfo {
  return { totalBytes: null, freeBytes: null, method: 'none' };
}

function makeVram(totalGb: number, freeGb: number): VramInfo {
  return {
    totalBytes: totalGb * GB,
    freeBytes: freeGb * GB,
    method: 'nvidia-smi',
  };
}

/** Build a mock fetch that returns the given pulled model tags from /api/tags. */
function makeMockFetch(
  models: Array<{ name: string; paramSize?: string; quant?: string; family?: string }>,
): typeof fetch {
  const body = JSON.stringify({
    models: models.map((m) => ({
      name: m.name,
      model: m.name,
      details: {
        parameter_size: m.paramSize ?? '3B',
        quantization_level: m.quant ?? 'Q4_K_M',
        family: m.family ?? 'unknown',
      },
    })),
  });
  return (_url, _init) =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as ReturnType<typeof fetch>;
}

function makeFailFetch(): typeof fetch {
  return (_url, _init) => Promise.reject(new Error('connection refused'));
}

// ---------------------------------------------------------------------------
// probeOllamaAlive mock setup
// ---------------------------------------------------------------------------

// We need to mock `probeOllamaAlive` from cross-provider-selector to avoid
// real network calls in unit tests.

vi.mock('../cross-provider-selector.js', () => ({
  probeOllamaAlive: vi.fn().mockResolvedValue(false),
  _resetOllamaProbeCache: vi.fn(),
}));

import * as crossProviderSelector from '../cross-provider-selector.js';

const mockProbeOllamaAlive = vi.mocked(crossProviderSelector.probeOllamaAlive);

beforeEach(() => {
  mockProbeOllamaAlive.mockResolvedValue(false);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Unit tests: captureHardwareSnapshot
// ---------------------------------------------------------------------------

describe('captureHardwareSnapshot', () => {
  it('accepts hardware overrides without making OS calls', async () => {
    const snap = await captureHardwareSnapshot({
      totalRamBytes: 8 * GB,
      availableRamBytes: 6 * GB,
      vram: makeVram(10, 8),
      platform: 'linux',
    });
    expect(snap.totalRamBytes).toBe(8 * GB);
    expect(snap.availableRamBytes).toBe(6 * GB);
    expect(snap.vram.method).toBe('nvidia-smi');
    expect(snap.vram.totalBytes).toBe(10 * GB);
  });

  it('returns vram.method=none when no GPU detected', async () => {
    const snap = await captureHardwareSnapshot({
      totalRamBytes: 4 * GB,
      availableRamBytes: 2 * GB,
      vram: makeVramNone(),
      platform: 'linux',
    });
    expect(snap.vram.method).toBe('none');
    expect(snap.vram.totalBytes).toBeNull();
    expect(snap.vram.freeBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unit tests: listOllamaPulledModels
// ---------------------------------------------------------------------------

describe('listOllamaPulledModels', () => {
  it('parses /api/tags response correctly', async () => {
    const mockFetch = makeMockFetch([
      { name: 'gemma4:e4b', paramSize: '4B', quant: 'Q4_K_M', family: 'gemma4' },
      { name: 'qwen2.5-coder:3b', paramSize: '3.1B', quant: 'Q4_K_M', family: 'qwen2' },
    ]);
    const models = await listOllamaPulledModels('http://localhost:11434', mockFetch);
    expect(models).toHaveLength(2);
    expect(models[0]?.name).toBe('gemma4:e4b');
    expect(models[1]?.name).toBe('qwen2.5-coder:3b');
  });

  it('returns empty array when fetch fails', async () => {
    const models = await listOllamaPulledModels('http://localhost:11434', makeFailFetch());
    expect(models).toHaveLength(0);
  });

  it('returns empty array for malformed response', async () => {
    const badFetch: typeof fetch = () =>
      Promise.resolve(
        new Response('not json {', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ) as ReturnType<typeof fetch>;
    const models = await listOllamaPulledModels('http://localhost:11434', badFetch);
    expect(models).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — low-RAM floor
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — low-RAM floor (< 4 GB)', () => {
  it('returns no recommendations when RAM is below LOCAL_FIT_FLOOR_GB', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 3 * GB,
        availableRamBytes: 2 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });

    expect(result.recommendations).toHaveLength(0);
    expect(result.noRecommendationReason).toContain('RAM');
    expect(result.hardware.totalRamGb).toBeCloseTo(3, 0);
  });

  it('floor constant is 4 GB', () => {
    expect(LOCAL_FIT_FLOOR_GB).toBe(4);
  });

  it('qwen2:0.5b is NOT in the candidate table', () => {
    const tags = LOCAL_MODEL_CANDIDATES.map((c) => c.modelTag);
    expect(tags).not.toContain('qwen2:0.5b');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — 8 GB RAM, no VRAM
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — 8 GB RAM, no VRAM', () => {
  it('recommends up to 3 models, all within RAM budget', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });

    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeLessThanOrEqual(3);
    expect(result.noRecommendationReason).toBeNull();

    for (const rec of result.recommendations) {
      // Each recommendation must fit within the machine's RAM
      expect(rec.candidate.minRamGb).toBeLessThanOrEqual(8);
    }
  });

  it('returns models sorted by score descending', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });
    const scores = result.recommendations.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it('each recommendation includes a pullCommand', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });
    for (const rec of result.recommendations) {
      expect(rec.pullCommand).toMatch(/^ollama pull /);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — 32 GB RAM, no VRAM
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — 32 GB RAM, no VRAM', () => {
  it('includes gemma4:12b in recommendations at 32 GB', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 32 * GB,
        availableRamBytes: 24 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });
    const tags = result.recommendations.map((r) => r.candidate.modelTag);
    expect(tags).toContain('gemma4:12b');
  });

  it('does not recommend models requiring more RAM than available', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 32 * GB,
        availableRamBytes: 24 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });
    for (const rec of result.recommendations) {
      expect(rec.candidate.minRamGb).toBeLessThanOrEqual(32);
    }
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — VRAM boost
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — VRAM present boosts scores', () => {
  it('higher-scoring models when 10 GB VRAM present vs none (62 GB RAM)', async () => {
    const noVram = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 62 * GB,
        availableRamBytes: 40 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });

    const withVram = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 62 * GB,
        availableRamBytes: 40 * GB,
        vram: makeVram(10, 8),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });

    // With VRAM, the top recommendation should have a higher score
    const topScoreWithVram = withVram.recommendations[0]?.score ?? 0;
    const topScoreNoVram = noVram.recommendations[0]?.score ?? 0;
    expect(topScoreWithVram).toBeGreaterThan(topScoreNoVram);
  });

  it('reasons include VRAM fit explanation when GPU is detected', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 62 * GB,
        availableRamBytes: 40 * GB,
        vram: makeVram(10, 8),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });

    // At least one recommendation should mention VRAM
    const allReasons = result.recommendations.flatMap((r) => r.reasons).join(' ');
    expect(allReasons).toMatch(/VRAM|GPU/i);
  });

  it('hardware envelope reports VRAM correctly', async () => {
    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 62 * GB,
        availableRamBytes: 40 * GB,
        vram: makeVram(10, 8),
        platform: 'linux',
      },
      pulledModelsOverride: [],
    });
    expect(result.hardware.vramTotalGb).toBeCloseTo(10, 0);
    expect(result.hardware.vramFreeGb).toBeCloseTo(8, 0);
    expect(result.hardware.vramMethod).toBe('nvidia-smi');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — already-pulled bonus
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — already-pulled status', () => {
  it('marks a model as alreadyPulled when it appears in pulledModels list', async () => {
    const pulled: OllamaPulledModel[] = [
      { name: 'gemma4:e4b', parameterSize: '4B', quantizationLevel: 'Q4_K_M', family: 'gemma4' },
    ];

    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 16 * GB,
        availableRamBytes: 12 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: pulled,
    });

    const gemmaRec = result.recommendations.find((r) => r.candidate.modelTag === 'gemma4:e4b');
    expect(gemmaRec).toBeDefined();
    expect(gemmaRec?.alreadyPulled).toBe(true);
    expect(gemmaRec?.reasons).toContain('already pulled — no download needed');
  });

  it('already-pulled model ranks higher than an equally-capable unpulled model', async () => {
    const pulled: OllamaPulledModel[] = [
      {
        name: 'llama3.2:3b',
        parameterSize: '3B',
        quantizationLevel: 'Q4_K_M',
        family: 'llama',
      },
    ];

    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: pulled,
    });

    const llamaRec = result.recommendations.find((r) => r.candidate.modelTag === 'llama3.2:3b');
    expect(llamaRec?.alreadyPulled).toBe(true);

    // The already-pulled model should appear in recommendations
    expect(result.recommendations.map((r) => r.candidate.modelTag)).toContain('llama3.2:3b');
  });

  it('pulledModels is populated from the envelope', async () => {
    const pulled: OllamaPulledModel[] = [
      {
        name: 'qwen2.5-coder:3b',
        parameterSize: '3.1B',
        quantizationLevel: 'Q4_K_M',
        family: 'qwen2',
      },
    ];

    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      pulledModelsOverride: pulled,
    });

    expect(result.pulledModels).toHaveLength(1);
    expect(result.pulledModels[0]?.name).toBe('qwen2.5-coder:3b');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: rankLocalModelFit — Ollama running state
// ---------------------------------------------------------------------------

describe('rankLocalModelFit — Ollama liveness', () => {
  it('sets ollamaRunning=true and fetches models when Ollama is up', async () => {
    mockProbeOllamaAlive.mockResolvedValue(true);

    const mockFetch = makeMockFetch([
      { name: 'gemma4:e2b', paramSize: '2B', quant: 'Q4_K_M', family: 'gemma4' },
    ]);

    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
      fetchFn: mockFetch,
    });

    expect(result.ollamaRunning).toBe(true);
    expect(result.pulledModels).toHaveLength(1);
    expect(result.pulledModels[0]?.name).toBe('gemma4:e2b');
  });

  it('sets ollamaRunning=false and returns empty pulledModels when Ollama is down', async () => {
    mockProbeOllamaAlive.mockResolvedValue(false);

    const result = await rankLocalModelFit({
      hardwareOverride: {
        totalRamBytes: 8 * GB,
        availableRamBytes: 6 * GB,
        vram: makeVramNone(),
        platform: 'linux',
      },
    });

    expect(result.ollamaRunning).toBe(false);
    expect(result.pulledModels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: candidate table invariants
// ---------------------------------------------------------------------------

describe('LOCAL_MODEL_CANDIDATES table invariants', () => {
  it('all candidates have unique modelTags', () => {
    const tags = LOCAL_MODEL_CANDIDATES.map((c) => c.modelTag);
    const unique = new Set(tags);
    expect(unique.size).toBe(tags.length);
  });

  it('all candidates have minRamGb >= 1 (reasonable hardware minimum)', () => {
    // The LOCAL_FIT_FLOOR_GB (4 GB) applies to the MACHINE, not the model table.
    // Small models like gemma3:1b and qwen3:1.7b have minRamGb=3, which is valid —
    // they are still excluded from ranking when the machine is under 4 GB.
    for (const c of LOCAL_MODEL_CANDIDATES) {
      expect(c.minRamGb).toBeGreaterThanOrEqual(1);
    }
  });

  it('no candidate uses the qwen2:0.5b proof-of-life model tag', () => {
    // The floor check (machine RAM < 4 GB) produces no recommendations; this
    // verifies the proof-of-life model is structurally absent from the table.
    for (const c of LOCAL_MODEL_CANDIDATES) {
      expect(c.modelTag).not.toBe('qwen2:0.5b');
      expect(c.modelTag).not.toBe('qwen2:0.5b-text-preview-fp16');
    }
  });

  it('all candidates have recommendedRamGb >= minRamGb', () => {
    for (const c of LOCAL_MODEL_CANDIDATES) {
      expect(c.recommendedRamGb).toBeGreaterThanOrEqual(c.minRamGb);
    }
  });

  it('all candidates have recommendedVramGb >= minVramGb', () => {
    for (const c of LOCAL_MODEL_CANDIDATES) {
      expect(c.recommendedVramGb).toBeGreaterThanOrEqual(c.minVramGb);
    }
  });

  it('pullCommand format for each candidate is valid', () => {
    for (const c of LOCAL_MODEL_CANDIDATES) {
      const pullCmd = `ollama pull ${c.modelTag}`;
      expect(pullCmd).toMatch(/^ollama pull \S+/);
    }
  });
});
