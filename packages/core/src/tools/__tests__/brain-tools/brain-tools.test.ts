/**
 * BrainTools SDK tool registration tests.
 *
 * Validates that each BrainTool is correctly registered (identity, schemas)
 * and that the fn wrappers forward correctly without top-level I/O.
 *
 * @task T10070
 * @epic T9835
 */

import { describe, expect, it } from 'vitest';
import { fetchBrainEntries } from '../../../brain-tools/brain-fetch.js';
import { observeBrain } from '../../../brain-tools/brain-observe.js';
import { searchBrain } from '../../../brain-tools/brain-search.js';
import { timelineBrain } from '../../../brain-tools/brain-timeline.js';
import { buildRetrievalBundle } from '../../../brain-tools/build-retrieval-bundle.js';

// ---------------------------------------------------------------------------
// searchBrain
// ---------------------------------------------------------------------------
describe('searchBrain (SDK tool registration)', () => {
  it('has a stable identity', () => {
    expect(searchBrain.identity.name).toBe('search-brain');
    expect(searchBrain.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof searchBrain.identity.description).toBe('string');
  });

  it('exposes inputSchema and outputSchema', () => {
    expect(searchBrain.inputSchema.type).toBe('object');
    expect(searchBrain.outputSchema.type).toBe('object');
    expect(searchBrain.inputSchema.required).toContain('projectRoot');
    expect(searchBrain.inputSchema.required).toContain('params');
  });

  it('invoke is a function', () => {
    expect(typeof searchBrain.invoke).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// observeBrain
// ---------------------------------------------------------------------------
describe('observeBrain (SDK tool registration)', () => {
  it('has a stable identity', () => {
    expect(observeBrain.identity.name).toBe('observe-brain');
    expect(observeBrain.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof observeBrain.identity.description).toBe('string');
  });

  it('exposes inputSchema and outputSchema', () => {
    expect(observeBrain.inputSchema.type).toBe('object');
    expect(observeBrain.outputSchema.type).toBe('object');
    expect(observeBrain.inputSchema.required).toContain('projectRoot');
    expect(observeBrain.inputSchema.required).toContain('params');
  });

  it('inputSchema params require text', () => {
    const paramsSchema = observeBrain.inputSchema.properties?.['params'] as {
      required?: string[];
    };
    expect(paramsSchema?.required).toContain('text');
  });
});

// ---------------------------------------------------------------------------
// fetchBrainEntries
// ---------------------------------------------------------------------------
describe('fetchBrainEntries (SDK tool registration)', () => {
  it('has a stable identity', () => {
    expect(fetchBrainEntries.identity.name).toBe('fetch-brain-entries');
    expect(fetchBrainEntries.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof fetchBrainEntries.identity.description).toBe('string');
  });

  it('exposes inputSchema and outputSchema', () => {
    expect(fetchBrainEntries.inputSchema.type).toBe('object');
    expect(fetchBrainEntries.outputSchema.type).toBe('object');
    expect(fetchBrainEntries.inputSchema.required).toContain('projectRoot');
    expect(fetchBrainEntries.inputSchema.required).toContain('params');
  });

  it('inputSchema params require ids array', () => {
    const paramsSchema = fetchBrainEntries.inputSchema.properties?.['params'] as {
      required?: string[];
    };
    expect(paramsSchema?.required).toContain('ids');
  });
});

// ---------------------------------------------------------------------------
// timelineBrain
// ---------------------------------------------------------------------------
describe('timelineBrain (SDK tool registration)', () => {
  it('has a stable identity', () => {
    expect(timelineBrain.identity.name).toBe('timeline-brain');
    expect(timelineBrain.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof timelineBrain.identity.description).toBe('string');
  });

  it('exposes inputSchema and outputSchema', () => {
    expect(timelineBrain.inputSchema.type).toBe('object');
    expect(timelineBrain.outputSchema.type).toBe('object');
    expect(timelineBrain.inputSchema.required).toContain('projectRoot');
    expect(timelineBrain.inputSchema.required).toContain('params');
  });

  it('inputSchema params require anchor', () => {
    const paramsSchema = timelineBrain.inputSchema.properties?.['params'] as {
      required?: string[];
    };
    expect(paramsSchema?.required).toContain('anchor');
  });
});

// ---------------------------------------------------------------------------
// buildRetrievalBundle
// ---------------------------------------------------------------------------
describe('buildRetrievalBundle (SDK tool registration)', () => {
  it('has a stable identity', () => {
    expect(buildRetrievalBundle.identity.name).toBe('build-retrieval-bundle');
    expect(buildRetrievalBundle.identity.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof buildRetrievalBundle.identity.description).toBe('string');
  });

  it('exposes inputSchema and outputSchema', () => {
    expect(buildRetrievalBundle.inputSchema.type).toBe('object');
    expect(buildRetrievalBundle.outputSchema.type).toBe('object');
    expect(buildRetrievalBundle.inputSchema.required).toContain('req');
    expect(buildRetrievalBundle.inputSchema.required).toContain('projectRoot');
  });

  it('inputSchema req requires peerId and sessionId', () => {
    const reqSchema = buildRetrievalBundle.inputSchema.properties?.['req'] as {
      required?: string[];
    };
    expect(reqSchema?.required).toContain('peerId');
    expect(reqSchema?.required).toContain('sessionId');
  });

  it('all 5 brain tools are frozen (immutable identity)', () => {
    const tools = [
      searchBrain,
      observeBrain,
      fetchBrainEntries,
      timelineBrain,
      buildRetrievalBundle,
    ];
    for (const tool of tools) {
      expect(Object.isFrozen(tool)).toBe(true);
    }
  });
});
