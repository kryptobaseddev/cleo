/**
 * E2E tests for Memory Bridge generation flow.
 *
 * Tests the full pipeline: brain.db data -> generateMemoryBridgeContent -> writeMemoryBridge.
 * Uses a real temporary brain.db with seeded data.
 *
 * @task T5240
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('Memory Bridge E2E', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-bridge-e2e-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should generate memory bridge from brain.db with all data types', async () => {
    const { generateMemoryBridgeContent } = await import(
      '../../src/core/memory/memory-bridge.js'
    );
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);

    // Seed all data types
    await accessor.addDecision({
      id: 'D-e2e-001',
      type: 'technical',
      decision: 'Use provider adapter pattern for multi-tool support',
      rationale: 'Decouples provider-specific code from core',
      confidence: 'high',
    });

    await accessor.addLearning({
      id: 'L-e2e-001',
      insight: 'Atomic file operations prevent data corruption',
      source: 'codebase analysis',
      confidence: 0.92,
      actionable: true,
    });

    await accessor.addPattern({
      id: 'P-e2e-001',
      type: 'success',
      pattern: 'Always validate inputs before writes',
      context: 'Data integrity pattern',
      frequency: 8,
    });

    await accessor.addPattern({
      id: 'P-e2e-002',
      type: 'failure',
      pattern: 'Editing config files directly without CLI',
      context: 'Bypasses validation',
      frequency: 3,
    });

    await accessor.addObservation({
      id: 'O-e2e-001',
      type: 'discovery',
      title: 'Provider adapters enable multi-tool support',
      narrative: 'The adapter pattern lets CLEO work with any AI coding tool',
      sourceType: 'agent',
      createdAt: '2026-03-09 14:00:00',
    });

    const content = await generateMemoryBridgeContent(tempDir);

    expect(content).toContain('# CLEO Memory Bridge');
    expect(content).toContain('Auto-generated at');
  });

  it('should include all sections in bridge output', async () => {
    const { generateMemoryBridgeContent } = await import(
      '../../src/core/memory/memory-bridge.js'
    );
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);

    await accessor.addDecision({
      id: 'D-sec-001',
      type: 'architectural',
      decision: 'Adopt dispatch-first architecture',
      rationale: 'Centralizes operation routing',
      confidence: 'high',
    });

    await accessor.addLearning({
      id: 'L-sec-001',
      insight: 'ESM imports require .js extensions',
      source: 'TypeScript migration',
      confidence: 0.88,
      actionable: true,
    });

    await accessor.addPattern({
      id: 'P-sec-001',
      type: 'success',
      pattern: 'Use shared-core pattern for business logic',
      context: 'Architecture',
      frequency: 5,
    });

    await accessor.addPattern({
      id: 'P-sec-002',
      type: 'failure',
      pattern: 'Duplicating logic between MCP and CLI',
      context: 'DRY violation',
      frequency: 2,
    });

    await accessor.addObservation({
      id: 'O-sec-001',
      type: 'insight',
      title: 'Memory bridge replaces claude-mem dependency',
      narrative: 'Native bridge is more reliable',
      sourceType: 'agent',
      createdAt: '2026-03-10 09:00:00',
    });

    const content = await generateMemoryBridgeContent(tempDir);

    // Verify all sections present
    expect(content).toContain('## Recent Decisions');
    expect(content).toContain('## Key Learnings');
    expect(content).toContain('## Patterns to Follow');
    expect(content).toContain('## Anti-Patterns to Avoid');
    expect(content).toContain('## Recent Observations');

    // Verify content within sections
    expect(content).toContain('D-sec-001');
    expect(content).toContain('Adopt dispatch-first architecture');
    expect(content).toContain('L-sec-001');
    expect(content).toContain('ESM imports require .js extensions');
    expect(content).toContain('P-sec-001');
    expect(content).toContain('Use shared-core pattern');
    expect(content).toContain('AVOID: Duplicating logic');
    expect(content).toContain('O-sec-001');
    expect(content).toContain('Memory bridge replaces claude-mem');
  });

  it('should handle empty brain.db gracefully', async () => {
    const { generateMemoryBridgeContent } = await import(
      '../../src/core/memory/memory-bridge.js'
    );
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();

    const content = await generateMemoryBridgeContent(tempDir);

    // Should produce valid content even with no data
    expect(content).toContain('# CLEO Memory Bridge');
    // Should not have any data sections
    expect(content).not.toContain('## Recent Decisions');
    expect(content).not.toContain('## Key Learnings');
    expect(content).not.toContain('## Recent Observations');
  });

  it('should write bridge file to .cleo/memory-bridge.md', async () => {
    const { writeMemoryBridge } = await import('../../src/core/memory/memory-bridge.js');
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);
    await accessor.addObservation({
      id: 'O-write-001',
      type: 'discovery',
      title: 'Bridge file creation works end-to-end',
      narrative: 'The write flow succeeds',
      sourceType: 'agent',
      createdAt: '2026-03-09 15:00:00',
    });

    const result = await writeMemoryBridge(tempDir);
    expect(result.written).toBe(true);
    expect(existsSync(result.path)).toBe(true);

    const fileContent = readFileSync(result.path, 'utf-8');
    expect(fileContent).toContain('# CLEO Memory Bridge');
    expect(fileContent).toContain('O-write-001');
    expect(fileContent).toContain('Bridge file creation works end-to-end');
  });

  it('should respect config limits across all sections', async () => {
    const { generateMemoryBridgeContent } = await import(
      '../../src/core/memory/memory-bridge.js'
    );
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    const { getBrainAccessor } = await import('../../src/store/brain-accessor.js');
    closeBrainDb();

    const accessor = await getBrainAccessor(tempDir);

    // Add many of each type
    for (let i = 1; i <= 20; i++) {
      const idx = String(i).padStart(3, '0');
      await accessor.addDecision({
        id: `D-lim-${idx}`,
        type: 'technical',
        decision: `Decision ${i} about something important`,
        rationale: `Rationale ${i}`,
        confidence: 'medium',
      });
      await accessor.addLearning({
        id: `L-lim-${idx}`,
        insight: `Learning ${i} about the system`,
        source: 'test',
        confidence: 0.5 + i * 0.02,
        actionable: true,
      });
      await accessor.addObservation({
        id: `O-lim-${idx}`,
        type: 'insight',
        title: `Observation ${i} about behavior`,
        narrative: `Details about observation ${i}`,
        sourceType: 'agent',
        createdAt: `2026-03-${String(Math.min(i, 28)).padStart(2, '0')} 10:00:00`,
      });
    }

    const content = await generateMemoryBridgeContent(tempDir, {
      maxDecisions: 2,
      maxLearnings: 3,
      maxObservations: 4,
      maxPatterns: 1,
    });

    // Count lines starting with "- [D-lim-"
    const decisionLines = content.split('\n').filter((l) => l.includes('[D-lim-'));
    expect(decisionLines).toHaveLength(2);

    const learningLines = content.split('\n').filter((l) => l.includes('[L-lim-'));
    expect(learningLines).toHaveLength(3);

    const observationLines = content.split('\n').filter((l) => l.includes('[O-lim-'));
    expect(observationLines).toHaveLength(4);
  });

  it('should not rewrite bridge when content is unchanged', async () => {
    const { writeMemoryBridge } = await import('../../src/core/memory/memory-bridge.js');
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();

    const first = await writeMemoryBridge(tempDir);
    expect(first.written).toBe(true);

    const second = await writeMemoryBridge(tempDir);
    expect(second.written).toBe(false);
  });

  it('should use refreshMemoryBridge as a safe no-throw wrapper', async () => {
    const { refreshMemoryBridge } = await import('../../src/core/memory/memory-bridge.js');
    const { closeBrainDb } = await import('../../src/store/brain-sqlite.js');
    closeBrainDb();

    // Should never throw, even with fresh/empty state
    await expect(refreshMemoryBridge(tempDir)).resolves.toBeUndefined();

    // Verify the file was created
    const bridgePath = join(cleoDir, 'memory-bridge.md');
    expect(existsSync(bridgePath)).toBe(true);
  });
});
