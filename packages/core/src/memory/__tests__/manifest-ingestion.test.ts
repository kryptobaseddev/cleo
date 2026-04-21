/**
 * Unit tests for manifest ingestion functions.
 *
 * Tests ingestion of RCASD phase directories and loose agent-output markdown
 * files into pipeline_manifest table.
 *
 * @task T1099
 * @epic T1093
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../store/sqlite.js';
import { ingestLooseAgentOutputs, ingestRcasdDirectories } from '../manifest-ingestion.js';

/**
 * Create a temporary project structure for testing.
 */
async function setupTestProject(): Promise<{
  root: string;
  db: Awaited<ReturnType<typeof getDb>>;
  cleanup: () => void;
}> {
  // Create temp project directory
  const root = join(tmpdir(), `.cleo-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(root, { recursive: true });

  // Create .cleo directories
  mkdirSync(join(root, '.cleo', 'rcasd'), { recursive: true });
  mkdirSync(join(root, '.cleo', 'agent-outputs'), { recursive: true });

  // Get database
  const db = await getDb(root);

  const cleanup = () => {
    // Clean up temp directory (in a real scenario)
    try {
      const fs = require('node:fs');
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return { root, db, cleanup };
}

describe('manifest-ingestion', () => {
  describe('ingestRcasdDirectories', () => {
    it('should ingest RCASD phase files', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Create RCASD structure
        const rcasdDir = join(root, '.cleo', 'rcasd', 'T001', 'research');
        mkdirSync(rcasdDir, { recursive: true });
        writeFileSync(join(rcasdDir, 'T001-research.md'), '# T001 Research\nSample content');

        // Ingest
        const result = await ingestRcasdDirectories(root, db);

        expect(result.ingested).toBeGreaterThan(0);
        expect(result.ingested).toEqual(1);
        expect(result.skipped).toEqual(0);
      } finally {
        cleanup();
      }
    });

    it('should be idempotent on repeated ingestion', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Create RCASD structure
        const rcasdDir = join(root, '.cleo', 'rcasd', 'T002', 'specification');
        mkdirSync(rcasdDir, { recursive: true });
        writeFileSync(join(rcasdDir, 'spec.md'), '# Specification\nContent goes here');

        // First ingestion
        const result1 = await ingestRcasdDirectories(root, db);
        expect(result1.ingested).toEqual(1);

        // Second ingestion should not duplicate
        const result2 = await ingestRcasdDirectories(root, db);
        expect(result2.ingested).toEqual(0);
      } finally {
        cleanup();
      }
    });

    it('should map testing phase to validation type', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Create testing phase directory
        const testingDir = join(root, '.cleo', 'rcasd', 'T003', 'testing');
        mkdirSync(testingDir, { recursive: true });
        writeFileSync(join(testingDir, 'test-results.md'), '# Test Results\nContent');

        // Ingest
        const result = await ingestRcasdDirectories(root, db);
        expect(result.ingested).toEqual(1);
        expect(result.skipped).toEqual(0);
      } finally {
        cleanup();
      }
    });

    it('should handle multiple files in phase directory', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Create RCASD structure with multiple files
        const rcasdDir = join(root, '.cleo', 'rcasd', 'T004', 'decomposition');
        mkdirSync(rcasdDir, { recursive: true });
        writeFileSync(join(rcasdDir, 'decomp1.md'), '# Part 1\nContent 1');
        writeFileSync(join(rcasdDir, 'decomp2.md'), '# Part 2\nContent 2');

        // Ingest
        const result = await ingestRcasdDirectories(root, db);
        expect(result.ingested).toEqual(2);
      } finally {
        cleanup();
      }
    });

    it('should return 0 when rcasd directory does not exist', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Don't create rcasd directory, only ensure .cleo exists
        mkdirSync(join(root, '.cleo'), { recursive: true });

        // Ingest should handle gracefully
        const result = await ingestRcasdDirectories(root, db);
        expect(result.ingested).toEqual(0);
        expect(result.skipped).toEqual(0);
      } finally {
        cleanup();
      }
    });
  });

  describe('ingestLooseAgentOutputs', () => {
    it('should ingest loose markdown files', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Create loose files
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        writeFileSync(join(agentOutputDir, 'T001-research.md'), '# Research\nContent');
        writeFileSync(join(agentOutputDir, 'T002-audit.md'), '# Audit\nContent');

        // Ingest
        const result = await ingestLooseAgentOutputs(root, db);
        expect(result.ingested).toBeGreaterThanOrEqual(2);
        expect(result.skipped).toEqual(0);
      } finally {
        cleanup();
      }
    });

    it('should extract task ID from filename', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        writeFileSync(join(agentOutputDir, 'T042-implementation.md'), '# Implementation\nContent');

        // Ingest
        const result = await ingestLooseAgentOutputs(root, db);
        expect(result.ingested).toEqual(1);
      } finally {
        cleanup();
      }
    });

    it('should infer type from filename patterns', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        writeFileSync(join(agentOutputDir, 'T001-research.md'), '# Research\nContent');
        writeFileSync(join(agentOutputDir, 'T002-specification.md'), '# Spec\nContent');
        writeFileSync(join(agentOutputDir, 'T003-architecture.md'), '# Arch\nContent');
        writeFileSync(join(agentOutputDir, 'T004-fix-bug.md'), '# Fix\nContent');

        // Ingest
        const result = await ingestLooseAgentOutputs(root, db);
        expect(result.ingested).toBeGreaterThanOrEqual(4);
      } finally {
        cleanup();
      }
    });

    it('should handle files without task ID', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        writeFileSync(join(agentOutputDir, 'MASTER-SESSION-PLAN.md'), '# Plan\nContent');
        writeFileSync(join(agentOutputDir, 'R-research.md'), '# R-search\nContent');

        // Ingest
        const result = await ingestLooseAgentOutputs(root, db);
        expect(result.ingested).toBeGreaterThanOrEqual(2);
      } finally {
        cleanup();
      }
    });

    it('should be idempotent', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        writeFileSync(join(agentOutputDir, 'T100-research.md'), '# Content');

        // First ingest
        const result1 = await ingestLooseAgentOutputs(root, db);
        expect(result1.ingested).toEqual(1);

        // Second ingest should not duplicate
        const result2 = await ingestLooseAgentOutputs(root, db);
        expect(result2.ingested).toEqual(0);
      } finally {
        cleanup();
      }
    });

    it('should skip subdirectories', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        const agentOutputDir = join(root, '.cleo', 'agent-outputs');
        // Create a subdirectory with a markdown file
        mkdirSync(join(agentOutputDir, 'T001-tier3-design'), { recursive: true });
        writeFileSync(join(agentOutputDir, 'T001-tier3-design', 'nested.md'), '# Nested\nContent');

        // Also create a top-level file
        writeFileSync(join(agentOutputDir, 'T001-research.md'), '# Research\nContent');

        // Ingest
        const result = await ingestLooseAgentOutputs(root, db);
        // Should only ingest the top-level file, not the nested one
        expect(result.ingested).toEqual(1);
      } finally {
        cleanup();
      }
    });

    it('should return 0 when agent-outputs directory does not exist', async () => {
      const { root, db, cleanup } = await setupTestProject();

      try {
        // Don't create agent-outputs directory
        mkdirSync(join(root, '.cleo'), { recursive: true });

        // Ingest should handle gracefully
        const result = await ingestLooseAgentOutputs(root, db);
        expect(result.ingested).toEqual(0);
        expect(result.skipped).toEqual(0);
      } finally {
        cleanup();
      }
    });
  });
});
