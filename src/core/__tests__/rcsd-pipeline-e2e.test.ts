/**
 * RCASD Pipeline End-to-End Integration Test
 *
 * Tests the unified lifecycle pipeline including:
 * - Canonical full-form stage definitions and ordering from stages.ts
 * - Prerequisite checking
 * - Transition validation
 * - RCASD-INDEX population and querying
 *
 * @task T4806
 * @epic T4798
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Canonical imports from stages.ts
import {
  PIPELINE_STAGES,
  CONTRIBUTION_STAGE,
  validateStage,
  getNextStage,
  getPreviousStage,
  getPrerequisites,
  checkTransition,
} from '../lifecycle/stages.js';

// Barrel imports from index.ts
import {
  PIPELINE_STAGES as BARREL_PIPELINE_STAGES,
  CANONICAL_STAGE_DEFINITIONS,
  CANONICAL_PREREQUISITES,
} from '../lifecycle/index.js';

// RCASD-INDEX population
import {
  buildIndex,
  writeIndex,
  readIndex,
  getTaskAnchor,
  findByStage,
  findByStatus,
  getIndexTotals,
  rebuildIndex,
} from '../lifecycle/rcasd-index.js';

describe('RCSD Pipeline E2E', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'cleo-e2e-'));
    // Create .cleo directory structure
    await mkdir(join(testDir, '.cleo', 'rcasd'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Stage Definition Tests (stages.ts)
  // ===========================================================================

  describe('canonical stage definitions', () => {
    it('defines exactly 9 pipeline stages in order with full names', () => {
      expect(PIPELINE_STAGES).toEqual([
        'research', 'consensus', 'architecture_decision', 'specification', 'decomposition',
        'implementation', 'validation', 'testing', 'release',
      ]);
      expect(PIPELINE_STAGES.length).toBe(9);
    });

    it('defines contribution as a separate cross-cutting stage', () => {
      expect(CONTRIBUTION_STAGE).toBe('contribution');
      expect(PIPELINE_STAGES).not.toContain('contribution');
    });

    it('validates known stage names', () => {
      for (const stage of PIPELINE_STAGES) {
        expect(() => validateStage(stage)).not.toThrow();
      }
    });

    it('rejects unknown stage names including old short forms', () => {
      expect(() => validateStage('invalid')).toThrow();
      expect(() => validateStage('spec')).toThrow(); // old short name
      expect(() => validateStage('decompose')).toThrow(); // old short name
      expect(() => validateStage('implement')).toThrow(); // old short name
      expect(() => validateStage('verify')).toThrow(); // old short name
      expect(() => validateStage('test')).toThrow(); // old short name
      expect(() => validateStage('adr')).toThrow(); // old short name
    });

    it('supports navigation between stages', () => {
      expect(getNextStage('research')).toBe('consensus');
      expect(getNextStage('consensus')).toBe('architecture_decision');
      expect(getNextStage('architecture_decision')).toBe('specification');
      expect(getNextStage('specification')).toBe('decomposition');
      expect(getNextStage('decomposition')).toBe('implementation');
      expect(getNextStage('implementation')).toBe('validation');
      expect(getNextStage('validation')).toBe('testing');
      expect(getNextStage('testing')).toBe('release');
      expect(getNextStage('release')).toBeNull();

      expect(getPreviousStage('research')).toBeNull();
      expect(getPreviousStage('consensus')).toBe('research');
      expect(getPreviousStage('release')).toBe('testing');
    });

    it('enforces prerequisite chains', () => {
      // Research has no prerequisites
      expect(getPrerequisites('research')).toEqual([]);

      // Consensus requires research
      expect(getPrerequisites('consensus')).toContain('research');

      // Specification requires consensus and architecture_decision
      const specPrereqs = getPrerequisites('specification');
      expect(specPrereqs).toContain('research');
      expect(specPrereqs).toContain('consensus');
      expect(specPrereqs).toContain('architecture_decision');

      // Validation requires implementation
      expect(getPrerequisites('validation')).toContain('implementation');

      // Testing requires validation
      const testPrereqs = getPrerequisites('testing');
      expect(testPrereqs).toContain('implementation');
      expect(testPrereqs).toContain('validation');

      // Release requires all execution stages
      const releasePrereqs = getPrerequisites('release');
      expect(releasePrereqs).toContain('implementation');
      expect(releasePrereqs).toContain('validation');
      expect(releasePrereqs).toContain('testing');
    });

    it('validates forward transitions', () => {
      // Research -> consensus is a normal forward progression
      const t1 = checkTransition('research', 'consensus', false);
      expect(t1.allowed).toBe(true);
      expect(t1.requiresForce).toBe(false);

      // Consensus -> architecture_decision is allowed
      const t2 = checkTransition('consensus', 'architecture_decision', false);
      expect(t2.allowed).toBe(true);

      // Same stage transition is always allowed
      const t3 = checkTransition('research', 'research', false);
      expect(t3.allowed).toBe(true);
    });
  });

  // ===========================================================================
  // Barrel Re-export Tests
  // ===========================================================================

  describe('barrel re-exports from index.ts', () => {
    it('re-exports PIPELINE_STAGES from stages.ts through barrel', () => {
      expect(BARREL_PIPELINE_STAGES).toEqual(PIPELINE_STAGES);
    });

    it('re-exports CANONICAL_STAGE_DEFINITIONS from stages.ts', () => {
      expect(CANONICAL_STAGE_DEFINITIONS).toBeDefined();
      expect(CANONICAL_STAGE_DEFINITIONS['research']).toBeDefined();
      expect(CANONICAL_STAGE_DEFINITIONS['research'].stage).toBe('research');
    });

    it('re-exports CANONICAL_PREREQUISITES from stages.ts', () => {
      expect(CANONICAL_PREREQUISITES).toBeDefined();
      expect(CANONICAL_PREREQUISITES['research']).toEqual([]);
      // Canonical prerequisites include architecture_decision for specification
      expect(CANONICAL_PREREQUISITES['specification']).toContain('architecture_decision');
      expect(CANONICAL_PREREQUISITES['testing']).toContain('validation');
    });
  });

  // ===========================================================================
  // RCASD-INDEX Population and Querying Tests
  // ===========================================================================

  describe('RCASD-INDEX', () => {
    it('builds an empty index when no RCSD directories exist', () => {
      const index = buildIndex(testDir);
      expect(index.$schema).toBe('https://cleo-dev.com/schemas/v1/rcasd-index.schema.json');
      expect(index._meta.version).toBe('1.0.0');
      expect(index._meta.totals.tasks).toBe(0);
      expect(index._meta.totals.specs).toBe(0);
      expect(Object.keys(index.taskAnchored)).toHaveLength(0);
    });

    it('builds an index from on-disk manifests', async () => {
      // Create a sample RCSD task directory with manifest
      const taskDir = join(testDir, '.cleo', 'rcasd', 'T1234');
      await mkdir(taskDir, { recursive: true });

      const manifest = {
        epicId: 'T1234',
        title: 'Test Epic',
        stages: {
          research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
          consensus: { status: 'completed', completedAt: '2026-01-02T00:00:00Z' },
          specification: { status: 'pending' },
        },
      };
      await writeFile(
        join(taskDir, '_manifest.json'),
        JSON.stringify(manifest, null, 2),
      );

      // Create a spec file
      await writeFile(
        join(taskDir, 'TEST-SPEC.md'),
        '# Test Spec\n\nThis is a test specification.',
      );

      const index = buildIndex(testDir);
      expect(index._meta.totals.tasks).toBe(1);
      expect(index._meta.totals.specs).toBe(1);
      expect(index.taskAnchored['T1234']).toBeDefined();
      expect(index.taskAnchored['T1234'].pipelineStage).toBe('consensus');
      expect(index.taskAnchored['T1234'].spec).toBe('TEST-SPEC.md');
    });

    it('writes and reads index from disk', async () => {
      const index = buildIndex(testDir);
      writeIndex(index, testDir);

      const indexPath = join(testDir, '.cleo', 'RCASD-INDEX.json');
      expect(existsSync(indexPath)).toBe(true);

      const readBack = readIndex(testDir);
      expect(readBack).not.toBeNull();
      expect(readBack!.$schema).toBe(index.$schema);
      expect(readBack!._meta.version).toBe('1.0.0');
    });

    it('queries task anchors', async () => {
      // Set up a manifest
      const taskDir = join(testDir, '.cleo', 'rcasd', 'T5678');
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        join(taskDir, '_manifest.json'),
        JSON.stringify({
          epicId: 'T5678',
          stages: {
            research: { status: 'completed', completedAt: '2026-02-01T00:00:00Z' },
          },
        }),
      );

      // Build and write index
      rebuildIndex(testDir);

      // Query
      const anchor = getTaskAnchor('T5678', testDir);
      expect(anchor).not.toBeNull();
      expect(anchor!.pipelineStage).toBe('research');

      const notFound = getTaskAnchor('T9999', testDir);
      expect(notFound).toBeNull();
    });

    it('finds tasks by stage', async () => {
      const taskDir1 = join(testDir, '.cleo', 'rcasd', 'T1001');
      const taskDir2 = join(testDir, '.cleo', 'rcasd', 'T1002');
      await mkdir(taskDir1, { recursive: true });
      await mkdir(taskDir2, { recursive: true });

      await writeFile(
        join(taskDir1, '_manifest.json'),
        JSON.stringify({
          epicId: 'T1001',
          stages: { research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' } },
        }),
      );
      await writeFile(
        join(taskDir2, '_manifest.json'),
        JSON.stringify({
          epicId: 'T1002',
          stages: {
            research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
            consensus: { status: 'completed', completedAt: '2026-01-02T00:00:00Z' },
          },
        }),
      );

      rebuildIndex(testDir);

      const researchTasks = findByStage('research', testDir);
      const consensusTasks = findByStage('consensus', testDir);

      expect(researchTasks.length).toBe(1); // Only T1001 is at research
      expect(consensusTasks.length).toBe(1); // Only T1002 is at consensus
    });

    it('provides index totals', async () => {
      const taskDir = join(testDir, '.cleo', 'rcasd', 'T2001');
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        join(taskDir, '_manifest.json'),
        JSON.stringify({
          epicId: 'T2001',
          stages: { research: { status: 'pending' } },
        }),
      );

      rebuildIndex(testDir);

      const totals = getIndexTotals(testDir);
      expect(totals).not.toBeNull();
      expect(totals!.tasks).toBe(1);
      expect(totals!.activeResearch).toBe(1);
    });

    it('tracks active research and pending consensus counts', async () => {
      const taskDir1 = join(testDir, '.cleo', 'rcasd', 'T3001');
      const taskDir2 = join(testDir, '.cleo', 'rcasd', 'T3002');
      await mkdir(taskDir1, { recursive: true });
      await mkdir(taskDir2, { recursive: true });

      // T3001: active research
      await writeFile(
        join(taskDir1, '_manifest.json'),
        JSON.stringify({
          epicId: 'T3001',
          stages: { research: { status: 'pending' } },
        }),
      );

      // T3002: research done, consensus pending
      await writeFile(
        join(taskDir2, '_manifest.json'),
        JSON.stringify({
          epicId: 'T3002',
          stages: {
            research: { status: 'completed', completedAt: '2026-01-01T00:00:00Z' },
            consensus: { status: 'pending' },
          },
        }),
      );

      rebuildIndex(testDir);

      const totals = getIndexTotals(testDir);
      expect(totals!.activeResearch).toBe(1);
      expect(totals!.pendingConsensus).toBe(1);
    });
  });
});
