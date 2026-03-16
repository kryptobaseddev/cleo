/**
 * Tests for Memory Bridge Generator.
 *
 * Unit tests use mocks for isolation.
 * Integration tests use a real temporary brain.db.
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

describe('Memory Bridge', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-memory-bridge-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('generateMemoryBridgeContent', () => {
    it('should return content with header when brain.db has no data', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('# CLEO Memory Bridge');
      expect(content).toContain('Auto-generated at');
      // With an empty brain.db (tables exist but no rows), we get the header but no sections
      expect(content).not.toContain('## Recent Decisions');
      expect(content).not.toContain('## Key Learnings');
    });

    it('should include decisions when present', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'technical',
        decision: 'Use SQLite for brain storage',
        rationale: 'Fast, embedded, zero config',
        confidence: 'high',
      });

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('## Recent Decisions');
      expect(content).toContain('D001');
      expect(content).toContain('Use SQLite for brain storage');
    });

    it('should include learnings ordered by confidence desc', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addLearning({
        id: 'L-low1',
        insight: 'Low confidence learning',
        source: 'test',
        confidence: 0.3,
        actionable: false,
      });
      await accessor.addLearning({
        id: 'L-high1',
        insight: 'High confidence learning',
        source: 'test',
        confidence: 0.95,
        actionable: true,
      });

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('## Key Learnings');
      expect(content).toContain('L-high1');
      expect(content).toContain('High confidence learning');
      expect(content).toContain('confidence: 0.95');
      // High confidence should appear before low confidence
      const highIdx = content.indexOf('L-high1');
      const lowIdx = content.indexOf('L-low1');
      expect(highIdx).toBeLessThan(lowIdx);
    });

    it('should include success patterns under Patterns to Follow', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P-001',
        type: 'success',
        pattern: 'Use atomic file operations for writes',
        context: 'Data integrity',
        frequency: 5,
      });

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('## Patterns to Follow');
      expect(content).toContain('P-001');
      expect(content).toContain('Use atomic file operations');
    });

    it('should include failure patterns under Anti-Patterns', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P-002',
        type: 'failure',
        pattern: 'Editing JSON files directly',
        context: 'Breaks validation',
        frequency: 3,
      });

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('## Anti-Patterns to Avoid');
      expect(content).toContain('P-002');
      expect(content).toContain('AVOID: Editing JSON files directly');
    });

    it('should include recent observations', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addObservation({
        id: 'O-test1',
        type: 'discovery',
        title: 'Found authentication uses JWT tokens',
        narrative: 'Auth module uses JWT',
        sourceType: 'agent',
        createdAt: '2026-03-09 12:00:00',
      });

      const content = await generateMemoryBridgeContent(tempDir);
      expect(content).toContain('## Recent Observations');
      expect(content).toContain('O-test1');
      expect(content).toContain('Found authentication uses JWT tokens');
    });

    it('should respect maxDecisions config', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      for (let i = 1; i <= 10; i++) {
        await accessor.addDecision({
          id: `D${String(i).padStart(3, '0')}`,
          type: 'technical',
          decision: `Decision number ${i}`,
          rationale: `Rationale ${i}`,
          confidence: 'high',
        });
      }

      const content = await generateMemoryBridgeContent(tempDir, { maxDecisions: 3 });
      const decisionLines = content
        .split('\n')
        .filter((line) => line.startsWith('- [D'));
      expect(decisionLines).toHaveLength(3);
    });

    it('should omit anti-patterns when includeAntiPatterns is false', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P-003',
        type: 'failure',
        pattern: 'Some bad pattern',
        context: 'Testing',
        frequency: 1,
      });

      const content = await generateMemoryBridgeContent(tempDir, {
        includeAntiPatterns: false,
      });
      expect(content).not.toContain('## Anti-Patterns to Avoid');
    });
  });

  describe('writeMemoryBridge', () => {
    it('should write memory-bridge.md file', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const result = await writeMemoryBridge(tempDir);
      expect(result.written).toBe(true);
      expect(result.path).toContain('memory-bridge.md');
      expect(existsSync(result.path)).toBe(true);

      const content = readFileSync(result.path, 'utf-8');
      expect(content).toContain('# CLEO Memory Bridge');
    });

    it('should not rewrite when content unchanged', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const result1 = await writeMemoryBridge(tempDir);
      expect(result1.written).toBe(true);

      const result2 = await writeMemoryBridge(tempDir);
      expect(result2.written).toBe(false);
    });
  });

  describe('refreshMemoryBridge', () => {
    it('should not throw on any error', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await expect(refreshMemoryBridge(tempDir)).resolves.toBeUndefined();
    });

    it('should create the bridge file', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      await refreshMemoryBridge(tempDir);

      const bridgePath = join(cleoDir, 'memory-bridge.md');
      expect(existsSync(bridgePath)).toBe(true);
    });
  });
});
