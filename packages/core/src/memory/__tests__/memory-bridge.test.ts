/**
 * Tests for Memory Bridge Generator.
 *
 * Unit tests use mocks for isolation.
 * Integration tests use a real temporary brain.db.
 *
 * @task T5240
 * @task T999
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** Write a minimal config.json with the given brain.memoryBridge.mode. */
function writeConfigWithMode(cleoDir: string, mode: 'cli' | 'file'): void {
  const configPath = join(cleoDir, 'config.json');
  const config = { brain: { memoryBridge: { mode } } };
  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

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
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    try {
      const { closeDb } = await import('../../store/sqlite.js');
      closeDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  describe('generateMemoryBridgeContent', () => {
    it('should return content with header when brain.db has no data', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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

    it('should include high-confidence learnings and exclude low-confidence ones', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      // Low confidence (< 0.6) should be excluded from the bridge
      expect(content).not.toContain('L-low1');
    });

    it('should include success patterns under Patterns to Follow', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const decisionLines = content.split('\n').filter((line) => line.startsWith('- [D'));
      expect(decisionLines).toHaveLength(3);
    });

    it('should omit anti-patterns when includeAntiPatterns is false', async () => {
      const { generateMemoryBridgeContent } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
    it('should write memory-bridge.md file when mode=file', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      // mode=file: legacy behavior — file must be written
      writeConfigWithMode(cleoDir, 'file');

      const result = await writeMemoryBridge(tempDir);
      expect(result.written).toBe(true);
      expect(result.path).toContain('memory-bridge.md');
      expect(existsSync(result.path)).toBe(true);

      const content = readFileSync(result.path, 'utf-8');
      expect(content).toContain('# CLEO Memory Bridge');
    });

    it('should not rewrite when content unchanged (mode=file)', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'file');

      const result1 = await writeMemoryBridge(tempDir);
      expect(result1.written).toBe(true);

      const result2 = await writeMemoryBridge(tempDir);
      expect(result2.written).toBe(false);
    });
  });

  describe('refreshMemoryBridge', () => {
    it('should not throw on any error', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      await expect(refreshMemoryBridge(tempDir)).resolves.toBeUndefined();
    });

    it('should create the bridge file when mode=file', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'file');
      await refreshMemoryBridge(tempDir);

      const bridgePath = join(cleoDir, 'memory-bridge.md');
      expect(existsSync(bridgePath)).toBe(true);
    });
  });

  // ── T999: mode-gate tests ──────────────────────────────────────────────────

  describe('T999 — mode gate (cli vs file)', () => {
    it('mode=cli (default): writeMemoryBridge does NOT write the file', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      // No config.json — default is 'cli'
      const result = await writeMemoryBridge(tempDir);
      expect(result.written).toBe(false);
      expect(existsSync(join(cleoDir, 'memory-bridge.md'))).toBe(false);
    });

    it('mode=cli (explicit config): writeMemoryBridge does NOT write the file', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'cli');

      const result = await writeMemoryBridge(tempDir);
      expect(result.written).toBe(false);
      expect(existsSync(join(cleoDir, 'memory-bridge.md'))).toBe(false);
    });

    it('mode=file: writeMemoryBridge DOES write the file', async () => {
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'file');

      const result = await writeMemoryBridge(tempDir);
      expect(result.written).toBe(true);
      expect(existsSync(join(cleoDir, 'memory-bridge.md'))).toBe(true);
    });

    it('mode=cli: refreshMemoryBridge does NOT create the bridge file', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'cli');
      await refreshMemoryBridge(tempDir);

      expect(existsSync(join(cleoDir, 'memory-bridge.md'))).toBe(false);
    });

    it('mode=file overrides default: refreshMemoryBridge creates the bridge file', async () => {
      const { refreshMemoryBridge } = await import('../memory-bridge.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      writeConfigWithMode(cleoDir, 'file');
      await refreshMemoryBridge(tempDir);

      expect(existsSync(join(cleoDir, 'memory-bridge.md'))).toBe(true);
    });

    it('config defaults to cli when brain.memoryBridge.mode is absent', async () => {
      const { loadConfig } = await import('../../config.js');
      const config = await loadConfig(tempDir);
      expect(config.brain?.memoryBridge?.mode).toBe('cli');
    });
  });
});
