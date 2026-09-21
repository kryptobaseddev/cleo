/**
 * Unit tests for manifest ingestion functions.
 *
 * Tests ingestion of RCASD phase directories and loose agent-output markdown
 * files into pipeline_manifest table.
 *
 * @task T1099
 * @epic T1093
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindTasksDomain, type getDb } from '../../store/sqlite.js';
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
  mkdirSync(join(root, '.git'));
  const { db, native, store } = await bindTasksDomain(root);
  native.exec('PRAGMA foreign_keys=ON');
  expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  for (const id of ['T001', 'T002', 'T003', 'T004', 'T042', 'T100']) {
    native
      .prepare(
        "INSERT INTO tasks_tasks(id,title,status,created_at,updated_at) VALUES (?, 'Canonical task','pending','2026-09-20','2026-09-20')",
      )
      .run(id);
  }
  expect(native.prepare("SELECT count(*) AS n FROM tasks WHERE id='T001'").get()).toEqual({ n: 0 });

  const cleanup = () => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  };

  return { root, db, cleanup };
}

// Read and write the selected project's manifest and bridge fixtures.
beforeEach(() => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});
afterEach(() => vi.unstubAllEnvs());

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
        rmSync(join(root, '.cleo', 'agent-outputs'), { recursive: true });

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

describe.each(['rcasd', 'loose'] as const)('guarded %s manifest ingestion', (layout) => {
  const ingest = layout === 'rcasd' ? ingestRcasdDirectories : ingestLooseAgentOutputs;
  function directory(root: string) {
    const path =
      layout === 'rcasd'
        ? join(root, '.cleo', 'rcasd', 'T001', 'research')
        : join(root, '.cleo', 'agent-outputs');
    mkdirSync(path, { recursive: true });
    return path;
  }

  it('commits authentic content to modern storage and survives an independent process read', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      const content = '# Authentic foreground learning\nπ | literal evidence  \n';
      writeFileSync(join(directory(root), 'T001-note.md'), content);
      expect(await ingest(root, db)).toEqual({ ingested: 1, skipped: 0 });
      const { native, store } = await bindTasksDomain(root);
      expect(native.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(native.prepare('SELECT task_id,content FROM docs_pipeline_manifest').all()).toEqual([
        { task_id: 'T001', content },
      ]);
      expect(native.prepare('SELECT count(*) AS n FROM pipeline_manifest').get()).toEqual({ n: 0 });
      const read = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--input-type=module',
          '-e',
          'import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(process.argv[1], {readOnly:true}); process.stdout.write(JSON.stringify(db.prepare("SELECT task_id,content FROM docs_pipeline_manifest").all())); db.close();',
          store.dbPath,
        ],
        { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } },
      );
      expect(read.error).toBeUndefined();
      expect(read.status, read.stderr).toBe(0);
      expect(JSON.parse(read.stdout)).toEqual([{ task_id: 'T001', content }]);
      expect(await ingest(root, db)).toEqual({ ingested: 0, skipped: 1 });
    } finally {
      cleanup();
    }
  });

  it('rejects changed source under an existing identity without overwriting history', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      const path = join(directory(root), 'T001-note.md');
      writeFileSync(path, '# Original evidence');
      await ingest(root, db);
      const { native } = await bindTasksDomain(root);
      const before = native.prepare('SELECT * FROM docs_pipeline_manifest').all();
      writeFileSync(path, '# Different evidence');
      await expect(ingest(root, db)).rejects.toMatchObject({ code: 'E_MANIFEST_ID_CONFLICT' });
      expect(native.prepare('SELECT * FROM docs_pipeline_manifest').all()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it('rolls back the complete batch when a later storage write fails', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      const dir = directory(root);
      writeFileSync(join(dir, 'T001-a.md'), '# First');
      writeFileSync(join(dir, 'T001-z.md'), '# Second');
      const { native } = await bindTasksDomain(root);
      native.exec(
        "CREATE TRIGGER reject_later BEFORE INSERT ON docs_pipeline_manifest WHEN NEW.content='# Second' BEGIN SELECT RAISE(ABORT,'synthetic batch failure'); END",
      );
      await expect(ingest(root, db)).rejects.toThrow('synthetic batch failure');
      expect(native.prepare('SELECT count(*) AS n FROM docs_pipeline_manifest').get()).toEqual({
        n: 0,
      });
      expect(native.prepare('SELECT count(*) AS n FROM pipeline_manifest').get()).toEqual({ n: 0 });
    } finally {
      cleanup();
    }
  });

  it('compares metadata even when content and hash are unchanged', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      writeFileSync(join(directory(root), 'T001-note.md'), '# Evidence');
      await ingest(root, db);
      const { native } = await bindTasksDomain(root);
      native.exec('UPDATE docs_pipeline_manifest SET metadata_json=\'{"historical":true}\'');
      const before = native.prepare('SELECT * FROM docs_pipeline_manifest').all();
      await expect(ingest(root, db)).rejects.toMatchObject({ code: 'E_MANIFEST_ID_CONFLICT' });
      expect(native.prepare('SELECT * FROM docs_pipeline_manifest').all()).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it('retains explicit project ownership under contradictory ambient roots', async () => {
    const a = await setupTestProject();
    const b = await setupTestProject();
    try {
      writeFileSync(join(directory(a.root), 'T001-note.md'), '# Project A');
      vi.stubEnv('CLEO_ROOT', b.root);
      vi.stubEnv('CLEO_DIR', join(b.root, '.cleo'));
      expect(await ingest(a.root, a.db)).toEqual({ ingested: 1, skipped: 0 });
      for (const project of [a, b]) {
        const read = spawnSync(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            '--input-type=module',
            '-e',
            'import { DatabaseSync } from "node:sqlite"; const db=new DatabaseSync(process.argv[1],{readOnly:true}); process.stdout.write(JSON.stringify(db.prepare("SELECT content FROM docs_pipeline_manifest").all())); db.close();',
            join(project.root, '.cleo', 'cleo.db'),
          ],
          { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH } },
        );
        expect(read.error).toBeUndefined();
        expect(read.status, read.stderr).toBe(0);
        expect(JSON.parse(read.stdout)).toEqual(project === a ? [{ content: '# Project A' }] : []);
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('keeps legacy evidence intact and requires explicit repair', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      writeFileSync(join(directory(root), 'T001-note.md'), '# Evidence');
      const id = layout === 'rcasd' ? 'T001-rcasd-research-t001-note' : 'T001-loose-t001-note';
      const { native } = await bindTasksDomain(root);
      native
        .prepare(
          'INSERT INTO pipeline_manifest(id,type,content,status,created_at) VALUES (?,?,?,?,?)',
        )
        .run(id, 'implementation', '# Historical evidence', 'active', '2026-01-01');
      const before = native.prepare('SELECT * FROM pipeline_manifest').all();
      await expect(ingest(root, db)).rejects.toMatchObject({
        code: 'E_MANIFEST_LEGACY_REPAIR_REQUIRED',
      });
      expect(native.prepare('SELECT * FROM pipeline_manifest').all()).toEqual(before);
      expect(native.prepare('SELECT count(*) AS n FROM docs_pipeline_manifest').get()).toEqual({
        n: 0,
      });
    } finally {
      cleanup();
    }
  });

  it('rejects a database supplied for a different project', async () => {
    const a = await setupTestProject();
    const b = await setupTestProject();
    try {
      writeFileSync(join(directory(a.root), 'T001-note.md'), '# Project A');
      await expect(ingest(a.root, b.db)).rejects.toMatchObject({
        code: 'E_MANIFEST_DATABASE_MISMATCH',
      });
      for (const project of [a, b]) {
        const { native } = await bindTasksDomain(project.root);
        expect(native.prepare('SELECT count(*) AS n FROM docs_pipeline_manifest').get()).toEqual({
          n: 0,
        });
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it('reports directory read failure rather than a successful empty scan', async () => {
    const { root, db, cleanup } = await setupTestProject();
    try {
      const path =
        layout === 'rcasd' ? join(root, '.cleo', 'rcasd') : join(root, '.cleo', 'agent-outputs');
      rmSync(path, { recursive: true });
      writeFileSync(path, 'not a directory');
      await expect(ingest(root, db)).rejects.toThrow();
    } finally {
      cleanup();
    }
  });
});
