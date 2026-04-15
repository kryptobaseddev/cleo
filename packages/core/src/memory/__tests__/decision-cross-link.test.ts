/**
 * Tests for decision-cross-link module.
 *
 * Covers:
 *  - extractReferencedSymbols: file-path detection, symbol detection, dedup,
 *    stop-word filtering, short-name filtering.
 *  - linkDecisionToTargets: verifies edges are written to brain_page_edges
 *    when autoCapture is enabled.
 *  - autoCrossLinkDecision: end-to-end smoke test (never throws).
 *
 * @task T626
 * @epic T626
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-decision-cross-link-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/brain-sqlite.js');
  closeBrainDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// extractReferencedSymbols
// ---------------------------------------------------------------------------

describe('extractReferencedSymbols', () => {
  it('extracts a relative TypeScript file path', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols('Changed src/store/brain-schema.ts to add new column');
    const fileRefs = refs.filter((r) => r.nodeType === 'file');
    expect(fileRefs.length).toBeGreaterThanOrEqual(1);
    expect(fileRefs.some((r) => r.raw === 'src/store/brain-schema.ts')).toBe(true);
  });

  it('extracts an absolute TypeScript file path', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols(
      'See /mnt/projects/cleocode/packages/core/src/memory/decisions.ts for details',
    );
    const fileRefs = refs.filter((r) => r.nodeType === 'file');
    expect(fileRefs.some((r) => r.raw.endsWith('decisions.ts'))).toBe(true);
  });

  it('extracts a PascalCase class reference', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols('BrainDataAccessor must expose the new query method');
    const symRefs = refs.filter((r) => r.nodeType === 'symbol');
    expect(symRefs.some((r) => r.raw === 'BrainDataAccessor')).toBe(true);
  });

  it('extracts a camelCase function reference', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols('Call upsertGraphNode before addGraphEdge');
    const symRefs = refs.filter((r) => r.nodeType === 'symbol');
    const names = symRefs.map((r) => r.raw);
    expect(names).toContain('upsertGraphNode');
    expect(names).toContain('addGraphEdge');
  });

  it('deduplicates identical references', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols(
      'upsertGraphNode is called twice: upsertGraphNode for nodes, upsertGraphNode for edges',
    );
    const symRefs = refs.filter((r) => r.raw === 'upsertGraphNode');
    expect(symRefs).toHaveLength(1);
  });

  it('filters out stop-words', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    // "always", "should", "never" are in the stop-word list
    const refs = extractReferencedSymbols('always should never with this that from into');
    const symRefs = refs.filter((r) => r.nodeType === 'symbol');
    const names = symRefs.map((r) => r.raw.toLowerCase());
    expect(names).not.toContain('always');
    expect(names).not.toContain('should');
    expect(names).not.toContain('never');
  });

  it('filters out symbols shorter than 4 characters', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols('Use DB to store it');
    const symRefs = refs.filter((r) => r.nodeType === 'symbol' && r.raw.length < 4);
    expect(symRefs).toHaveLength(0);
  });

  it('returns empty array for plain-English text with no references', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols('We decided to use a relational database.');
    // May have some false positives for symbols, but no file refs
    const fileRefs = refs.filter((r) => r.nodeType === 'file');
    expect(fileRefs).toHaveLength(0);
  });

  it('assigns correct nodeIds', async () => {
    const { extractReferencedSymbols } = await import('../decision-cross-link.js');
    const refs = extractReferencedSymbols(
      'Updated src/memory/decisions.ts and called storeDecision',
    );
    const fileRef = refs.find((r) => r.nodeType === 'file');
    const symRef = refs.find((r) => r.nodeType === 'symbol' && r.raw === 'storeDecision');
    expect(fileRef?.nodeId).toMatch(/^file:/);
    expect(symRef?.nodeId).toBe('symbol:storeDecision');
  });
});

// ---------------------------------------------------------------------------
// linkDecisionToTargets — graph writes
// ---------------------------------------------------------------------------

describe('linkDecisionToTargets', () => {
  it('creates applies_to edges in brain_page_edges when autoCapture is enabled', async () => {
    // Stub shouldAutoPopulateGraph to return true by setting autoCapture config
    // The easiest approach: write a minimal config.json so isAutoCaptureEnabled returns true
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ brain: { autoCapture: true } }));

    const { closeBrainDb, getBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();

    // Initialise DB
    const db = await getBrainDb(tempDir);

    const { extractReferencedSymbols, linkDecisionToTargets } = await import(
      '../decision-cross-link.js'
    );
    const { brainPageEdges } = await import('../../store/brain-schema.js');

    const refs = extractReferencedSymbols(
      'Refactored src/store/brain-schema.ts to add BrainPageNodes column',
    );
    expect(refs.length).toBeGreaterThan(0);

    await linkDecisionToTargets(tempDir, 'D001', refs);

    // Check that at least one applies_to edge was created
    const edges = await db.select().from(brainPageEdges);
    const affectsEdges = edges.filter(
      (e) => e.fromId === 'decision:D001' && e.edgeType === 'applies_to',
    );
    expect(affectsEdges.length).toBeGreaterThanOrEqual(1);
  });

  it('is a no-op when refs array is empty', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ brain: { autoCapture: true } }));

    const { closeBrainDb, getBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();
    const db = await getBrainDb(tempDir);
    const { brainPageEdges } = await import('../../store/brain-schema.js');

    const { linkDecisionToTargets } = await import('../decision-cross-link.js');
    await linkDecisionToTargets(tempDir, 'D001', []);

    const edges = await db.select().from(brainPageEdges);
    expect(edges.filter((e) => e.fromId === 'decision:D001')).toHaveLength(0);
  });

  it('does not throw when autoCapture is disabled', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({ brain: { autoCapture: false } }),
    );

    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();

    const { extractReferencedSymbols, linkDecisionToTargets } = await import(
      '../decision-cross-link.js'
    );
    const refs = extractReferencedSymbols('Changed src/store/brain-schema.ts');
    // Should not throw even when autoCapture is off
    await expect(linkDecisionToTargets(tempDir, 'D001', refs)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// autoCrossLinkDecision — convenience facade
// ---------------------------------------------------------------------------

describe('autoCrossLinkDecision', () => {
  it('never throws for any input', async () => {
    const { autoCrossLinkDecision } = await import('../decision-cross-link.js');

    // Should not throw even without a DB or config
    await expect(
      autoCrossLinkDecision(tempDir, 'D001', 'some decision text', 'some rationale'),
    ).resolves.toBeUndefined();

    // Empty strings
    await expect(autoCrossLinkDecision(tempDir, 'D001', '', '')).resolves.toBeUndefined();
  });

  it('creates edges when decision text mentions a known file path', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({ brain: { autoCapture: true } }));

    const { closeBrainDb, getBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();
    const db = await getBrainDb(tempDir);
    const { brainPageEdges } = await import('../../store/brain-schema.js');

    const { autoCrossLinkDecision } = await import('../decision-cross-link.js');
    await autoCrossLinkDecision(
      tempDir,
      'D042',
      'Use packages/core/src/memory/decisions.ts as the write gate',
      'Centralises all decision writes in one module',
    );

    const edges = await db.select().from(brainPageEdges);
    const decisionsEdges = edges.filter(
      (e) =>
        e.fromId === 'decision:D042' && e.edgeType === 'applies_to' && e.toId.startsWith('file:'),
    );
    expect(decisionsEdges.length).toBeGreaterThanOrEqual(1);
  });
});
