/** Heuristic similarity cannot replace sourced caller authority. */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeTempDirSync } from '../../__tests__/test-cleanup.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { resetBrainDbState } from '../../store/memory-sqlite.js';
import { resetNexusDbState } from '../../store/nexus-sqlite.js';
import type { SimilarityResult } from '../brain-similarity.js';
import { verifyAndStore } from '../extraction-gate.js';

const { similar } = vi.hoisted(() => ({ similar: vi.fn<() => Promise<SimilarityResult[]>>() }));
vi.mock('../brain-embedding.js', () => ({ isEmbeddingAvailable: () => true }));
vi.mock('../brain-similarity.js', () => ({ searchSimilar: similar }));
let root: string;
let priorDir: string | undefined;
let priorHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-extraction-authority-'));
  mkdirSync(join(root, '.cleo'));
  priorDir = process.env['CLEO_DIR'];
  priorHome = process.env['CLEO_HOME'];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'home');
});
afterEach(() => {
  resetBrainDbState();
  resetNexusDbState();
  if (priorDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = priorDir;
  if (priorHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = priorHome;
  removeTempDirSync(root);
});

describe('extraction authority', () => {
  it.each([
    0.1, 0.2,
  ])('preserves both sourced learnings at similarity distance %s', async (distance) => {
    const accessor = await getBrainAccessor(root);
    const previousText = 'Always require complete coverage evidence before deployment';
    await accessor.addLearning({
      id: 'L-existing',
      insight: previousText,
      source: 'tracked-owner-directive',
      confidence: 0.9,
    });
    similar.mockResolvedValue([
      {
        id: 'L-existing',
        distance,
        type: 'learning',
        title: 'Coverage policy',
        text: previousText,
      },
    ]);
    const result = await verifyAndStore(root, {
      text: 'Never require complete coverage evidence before deployment',
      memoryType: 'semantic',
      tier: 'short',
      confidence: 0.9,
      source: 'transcript',
      sourceConfidence: 'agent',
    });
    expect(result.action).toBe('stored');
    expect(result.id).not.toBe('L-existing');
    expect(result.candidateIds).toEqual(['L-existing']);
    expect(await accessor.getLearning('L-existing')).toMatchObject({
      insight: previousText,
      invalidAt: null,
    });
    expect(await accessor.findLearnings()).toHaveLength(2);
  });
});
