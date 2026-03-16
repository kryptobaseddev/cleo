/**
 * E2E tests for MCP Memory Resources.
 *
 * Tests the MCP resource endpoints that serve brain.db content:
 * - cleo://memory/recent
 * - cleo://memory/learnings
 * - cleo://memory/patterns
 * - cleo://memory/handoff
 *
 * Also tests the LAFS budget-aware truncation system.
 *
 * @task T5240
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listMemoryResources,
  readMemoryResource,
} from '../../src/mcp/resources/index.js';
import { estimateTokens, truncateToTokenBudget } from '../../src/mcp/resources/budget.js';

let tempDir: string;
let cleoDir: string;
let originalCwd: string;

describe('MCP Memory Resources', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-mcp-res-e2e-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should list 4 available memory resources', () => {
    const resources = listMemoryResources();
    expect(resources).toHaveLength(4);

    const uris = resources.map((r) => r.uri);
    expect(uris).toContain('cleo://memory/recent');
    expect(uris).toContain('cleo://memory/learnings');
    expect(uris).toContain('cleo://memory/patterns');
    expect(uris).toContain('cleo://memory/handoff');

    // All should be text/markdown
    for (const r of resources) {
      expect(r.mimeType).toBe('text/markdown');
      expect(r.name).toBeTruthy();
      expect(r.description).toBeTruthy();
    }
  });

  it('should serve cleo://memory/recent', async () => {
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);
    await accessor.addObservation({
      id: 'O-mcp-001',
      type: 'discovery',
      title: 'MCP resources serve brain data',
      narrative: 'Test observation for MCP resource',
      sourceType: 'agent',
      createdAt: '2026-03-09 16:00:00',
    });

    const result = await readMemoryResource('cleo://memory/recent');
    expect(result).not.toBeNull();
    expect(result?.uri).toBe('cleo://memory/recent');
    expect(result?.mimeType).toBe('text/markdown');
    expect(result?.text).toContain('Recent Observations');
    expect(result?.text).toContain('O-mcp-001');
    expect(result?.text).toContain('MCP resources serve brain data');
  });

  it('should serve cleo://memory/learnings', async () => {
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);
    await accessor.addLearning({
      id: 'L-mcp-001',
      insight: 'MCP resource endpoints work correctly',
      source: 'e2e test',
      confidence: 0.95,
      actionable: true,
    });

    const result = await readMemoryResource('cleo://memory/learnings');
    expect(result).not.toBeNull();
    expect(result?.uri).toBe('cleo://memory/learnings');
    expect(result?.text).toContain('Active Learnings');
    expect(result?.text).toContain('L-mcp-001');
    expect(result?.text).toContain('MCP resource endpoints work correctly');
    expect(result?.text).toContain('0.95');
  });

  it('should serve cleo://memory/patterns', async () => {
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);
    await accessor.addPattern({
      id: 'P-mcp-001',
      type: 'success',
      pattern: 'Use resource endpoints for memory access',
      context: 'MCP integration',
      frequency: 4,
    });
    await accessor.addPattern({
      id: 'P-mcp-002',
      type: 'failure',
      pattern: 'Bypass MCP for direct file reads',
      context: 'Anti-pattern',
      frequency: 2,
    });

    const result = await readMemoryResource('cleo://memory/patterns');
    expect(result).not.toBeNull();
    expect(result?.uri).toBe('cleo://memory/patterns');
    expect(result?.text).toContain('Active Patterns');
    expect(result?.text).toContain('P-mcp-001');
    expect(result?.text).toContain('Use resource endpoints');
    expect(result?.text).toContain('P-mcp-002');
    expect(result?.text).toContain('AVOID');
  });

  it('should serve cleo://memory/handoff with no prior session', async () => {
    // readMemoryResource checks brain.db existence in cwd first — must init it
    const { closeBrainDb, getBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();
    await getBrainDb(tempDir);

    const result = await readMemoryResource('cleo://memory/handoff');
    expect(result).not.toBeNull();
    expect(result?.uri).toBe('cleo://memory/handoff');
    expect(result?.text).toContain('Session Handoff');
    // With no prior session, should indicate no handoff available
    expect(result?.text).toMatch(/no prior session|not available|No prior|Unable to retrieve/i);
  });

  it('should return null for unknown resource URI when brain.db exists', async () => {
    // readMemoryResource checks brain.db first — must init it to reach the switch
    const { closeBrainDb, getBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();
    await getBrainDb(tempDir);

    const result = await readMemoryResource('cleo://memory/nonexistent');
    expect(result).toBeNull();
  });

  it('should handle missing brain.db gracefully', async () => {
    // Point to a directory without brain.db
    const emptyDir = await mkdtemp(join(tmpdir(), 'cleo-no-brain-'));
    const origCwd = process.cwd();
    process.chdir(emptyDir);

    try {
      const result = await readMemoryResource('cleo://memory/recent');
      expect(result).not.toBeNull();
      expect(result?.text).toContain('No Brain Data');
    } finally {
      process.chdir(origCwd);
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should serve empty sections when brain.db has no data', async () => {
    const { closeBrainDb, getBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();
    // Initialize brain.db with empty tables
    await getBrainDb(tempDir);

    const recent = await readMemoryResource('cleo://memory/recent');
    expect(recent?.text).toContain('No observations recorded');

    const learnings = await readMemoryResource('cleo://memory/learnings');
    expect(learnings?.text).toContain('No learnings recorded');

    const patterns = await readMemoryResource('cleo://memory/patterns');
    expect(patterns?.text).toContain('No patterns recorded');
  });
});

describe('Token Budget Truncation', () => {
  it('should estimate tokens from text length', () => {
    // ~4 chars per token, so 100 chars = ~25 tokens
    const text = 'a'.repeat(100);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(25);
  });

  it('should not truncate text under budget', () => {
    const text = 'Short text';
    const result = truncateToTokenBudget(text, 100);
    expect(result).toBe(text);
  });

  it('should truncate text exceeding budget', () => {
    // Create text that exceeds 10 tokens (~40 chars at 0.25 tokens/char)
    const text = 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six is a much longer line to exceed the budget';
    const result = truncateToTokenBudget(text, 10);

    expect(result).toContain('[Truncated:');
    expect(result.length).toBeLessThan(text.length);
  });

  it('should truncate at line boundary when possible', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: some content here`);
    const text = lines.join('\n');
    const result = truncateToTokenBudget(text, 20);

    // Should end at a line boundary, not mid-line
    const truncatedPart = result.split('\n\n[Truncated:')[0];
    // Each line should be complete (not cut mid-word)
    const lastLine = truncatedPart.split('\n').pop() ?? '';
    expect(lastLine).toMatch(/^Line \d+: some content here$/);
  });

  it('should use default budget of 500 tokens when not specified', () => {
    const shortText = 'Hello world';
    const result = truncateToTokenBudget(shortText);
    expect(result).toBe(shortText);

    // 500 tokens * 4 chars/token = 2000 chars max
    const longText = 'x'.repeat(3000);
    const truncated = truncateToTokenBudget(longText);
    expect(truncated).toContain('[Truncated:');
  });

  it('should include token estimate and budget in truncation notice', () => {
    const longText = 'y'.repeat(1000);
    const result = truncateToTokenBudget(longText, 50);
    expect(result).toContain('Truncated:');
    expect(result).toContain('budget: 50');
  });
});
