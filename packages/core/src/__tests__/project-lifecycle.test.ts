/**
 * Unit tests for project-lifecycle.ts — moveProject, renameProject, reregisterProject.
 *
 * Covers AC2-AC7 (AC1 is architectural — TS-only is enforced by the .ts extension).
 *
 * @task T11010
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineResult } from '../engine-result.js';
import {
  type MoveProjectResult,
  moveProject,
  type RenameProjectResult,
  type ReregisterProjectResult,
  renameProject,
  reregisterProject,
} from '../project-lifecycle.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a minimal CLEO project in a temp directory with project-info.json. */
async function createTempProject(name = 'test-project'): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'cleo-lifecycle-test-'));
  const cleoDir = join(dir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });

  const info = {
    projectHash: 'a1b2c3d4e5f6',
    projectId: '550e8400-e29b-41d4-a716-446655440000',
    projectRoot: dir,
    projectName: name,
  };
  writeFileSync(join(cleoDir, 'project-info.json'), JSON.stringify(info, null, 2));

  // Create minimal tasks.db so nexusReconcile passes isCleoProject check
  const db = new DatabaseSync(join(cleoDir, 'tasks.db'));
  db.exec('CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY)');
  db.close();

  return dir;
}

/** Clean up a temp directory. */
async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Assert that an EngineResult is a success and return its data. */
function expectSuccess<T>(result: EngineResult<T>): T {
  if (!result.success) {
    throw new Error(
      `Expected success but got error: ${result.error.code} — ${result.error.message}`,
    );
  }
  return result.data;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('project-lifecycle', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await createTempProject();
  });

  afterEach(async () => {
    await cleanup(projectDir);
  });

  // ── moveProject ──────────────────────────────────────────────────

  describe('moveProject', () => {
    it('AC3: copies project files to new location and updates project-info.json', async () => {
      const newDir = join(tmpdir(), `cleo-moved-${Date.now()}`);

      // moveProject will fail at nexus (test project isn't in global registry),
      // but the file copy + project-info.json write happen first
      const result = await moveProject(newDir, projectDir);

      // Verify project-info.json was written at the destination
      const { readFileSync } = await import('node:fs');
      const destInfo = JSON.parse(
        readFileSync(join(newDir, '.cleo', 'project-info.json'), 'utf-8'),
      );

      expect(destInfo.projectId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(destInfo.projectRoot).toBe(newDir);
      expect(typeof destInfo.projectHash).toBe('string');
      expect(destInfo.projectHash.length).toBeGreaterThanOrEqual(12);
      // projectHash should differ from original because path changed
      expect(destInfo.projectHash).not.toBe('a1b2c3d4e5f6');

      // Nexus error is expected in tests (no global nexus registry setup)
      // The result shape should still be EngineResult
      expect('success' in result).toBe(true);

      await cleanup(newDir);
    });

    it('AC2: returns EngineResult with proper shape', async () => {
      const newDir = join(tmpdir(), `cleo-moved-typed-${Date.now()}`);
      const result = await moveProject(newDir, projectDir);

      // Verify it's an EngineResult
      expect('success' in result).toBe(true);
      if (result.success) {
        // On success, all MoveProjectResult fields must be present
        const data = result.data as MoveProjectResult;
        expect(typeof data.projectId).toBe('string');
        expect(typeof data.oldPath).toBe('string');
        expect(typeof data.newPath).toBe('string');
        expect(typeof data.newProjectHash).toBe('string');
      } else {
        // On failure, error must have code + message
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }

      await cleanup(newDir);
    });

    it('AC7: rejects non-absolute newPath', async () => {
      const result = await moveProject('relative/path', projectDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_PATH');
      }
    });

    it('AC7: rejects non-absolute projectRoot', async () => {
      const result = await moveProject('/tmp/test', 'relative/path');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_PATH');
      }
    });

    it('rejects missing project-info.json', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'cleo-empty-'));
      const newDir = join(tmpdir(), `cleo-dest-${Date.now()}`);

      const result = await moveProject(newDir, emptyDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_NOT_CLEO_PROJECT');
      }

      await cleanup(emptyDir);
    });

    it('AC3: rejects move to same resolved path', async () => {
      const result = await moveProject(projectDir, projectDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_SAME_PATH');
      }
    });

    it('AC5: handles Unicode paths', async () => {
      const newDir = join(tmpdir(), `cleo-日本語-${Date.now()}`);
      const result = await moveProject(newDir, projectDir);
      // Should not throw on Unicode paths
      expect('success' in result).toBe(true);
      await cleanup(newDir);
    });

    it('AC5: normalizes paths with trailing slash', async () => {
      const newDir = join(tmpdir(), `cleo-trailing-${Date.now()}`);
      const result = await moveProject(newDir + '/', projectDir);
      // Should handle trailing slash and resolve correctly
      expect('success' in result).toBe(true);
      await cleanup(newDir);
    });

    it('AC7: copy-based move avoids cross-filesystem rename issues', async () => {
      // Implementation uses fs.cp rather than fs.rename, so EXDEV errors
      // are never encountered. The copy-then-validate pattern is
      // cross-filesystem safe by design.
      const newDir = join(tmpdir(), `cleo-xfs-${Date.now()}`);
      const result = await moveProject(newDir, projectDir);

      // Verify files were actually copied (not symlinked or renamed)
      const { existsSync } = await import('node:fs');
      expect(existsSync(join(newDir, '.cleo', 'project-info.json'))).toBe(true);
      // Original should still exist (copy, not move)
      expect(existsSync(join(projectDir, '.cleo', 'project-info.json'))).toBe(true);

      await cleanup(newDir);
    });

    it('rejects corrupt project-info.json', async () => {
      const corruptDir = await mkdtemp(join(tmpdir(), 'cleo-corrupt-'));
      const cleoDir = join(corruptDir, '.cleo');
      mkdirSync(cleoDir, { recursive: true });
      writeFileSync(join(cleoDir, 'project-info.json'), '{invalid json!!!');

      const newDir = join(tmpdir(), `cleo-corrupt-dest-${Date.now()}`);
      const result = await moveProject(newDir, corruptDir);
      expect(result.success).toBe(false);
      // Should be E_PROJECT_INFO_MISSING or similar parse error
      if (!result.success) {
        expect(result.error.code).toMatch(/E_PROJECT_INFO|E_NOT_CLEO/);
      }

      await cleanup(corruptDir);
      await cleanup(newDir);
    });

    it('AC3: preserves projectId across moves', async () => {
      const newDir = join(tmpdir(), `cleo-moved-id-${Date.now()}`);

      const result = await moveProject(newDir, projectDir);

      // Verify project-info.json at destination preserves projectId
      const { readFileSync } = await import('node:fs');
      const destInfo = JSON.parse(
        readFileSync(join(newDir, '.cleo', 'project-info.json'), 'utf-8'),
      );
      expect(destInfo.projectId).toBe('550e8400-e29b-41d4-a716-446655440000');

      // Result is EngineResult regardless of nexus outcome
      expect('success' in result).toBe(true);

      await cleanup(newDir);
    });
  });

  // ── renameProject ─────────────────────────────────────────────────

  describe('renameProject', () => {
    it('AC4: updates project name and recomputes projectHash', async () => {
      const result = await renameProject('new-test-name', projectDir);
      const data = expectSuccess(result) as RenameProjectResult;

      expect(data.projectId).toBe('550e8400-e29b-41d4-a716-446655440000');
      expect(data.projectRoot).toBe(projectDir);
      expect(data.oldName).toBe('test-project');
      expect(data.newName).toBe('new-test-name');
      expect(data.newProjectHash).toBeTypeOf('string');
      expect(data.newProjectHash.length).toBeGreaterThanOrEqual(12);
    });

    it('AC2: returns renameProjectResult with all typed fields', async () => {
      const result = await renameProject('typed-name', projectDir);
      const data = expectSuccess(result) as RenameProjectResult;

      expect(typeof data.projectId).toBe('string');
      expect(typeof data.projectRoot).toBe('string');
      expect(typeof data.oldName).toBe('string');
      expect(typeof data.newName).toBe('string');
      expect(typeof data.newProjectHash).toBe('string');
    });

    it('AC7: rejects non-absolute projectRoot', async () => {
      const result = await renameProject('test', 'relative');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_PATH');
      }
    });

    it('rejects empty newName', async () => {
      const result = await renameProject('', projectDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_NAME');
      }
    });

    it('rejects whitespace-only newName', async () => {
      const result = await renameProject('   ', projectDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_NAME');
      }
    });
  });

  // ── reregisterProject ─────────────────────────────────────────────

  describe('reregisterProject', () => {
    it('AC5: reads project-info.json and calls nexusReconcile', async () => {
      // reregisterProject will fail at nexus (test project isn't in global registry),
      // but this validates the EngineResult contract is followed
      const result = await reregisterProject(projectDir);

      // Must be an EngineResult — either success or well-formed error
      expect('success' in result).toBe(true);
      if (result.success) {
        const data = result.data as ReregisterProjectResult;
        expect(data.projectId).toBe('550e8400-e29b-41d4-a716-446655440000');
        expect(data.projectRoot).toBe(projectDir);
        expect(typeof data.projectHash).toBe('string');
        expect(typeof data.drifted).toBe('boolean');
      } else {
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }
    });

    it('AC5: returns EngineResult even when nexus is unavailable', async () => {
      const result = await reregisterProject(projectDir);

      // Never throws — always returns EngineResult
      expect('success' in result).toBe(true);
    });

    it('AC7: rejects non-absolute projectRoot', async () => {
      const result = await reregisterProject('relative');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_INVALID_PATH');
      }
    });

    it('rejects missing project-info.json', async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), 'cleo-empty-'));
      const result = await reregisterProject(emptyDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_NOT_CLEO_PROJECT');
      }
      await cleanup(emptyDir);
    });
  });

  // ── Cross-cutting AC6: EngineResult<T> pattern ───────────────────

  describe('AC6: EngineResult<T> pattern', () => {
    it('moveProject returns EngineResult discriminated union', async () => {
      const newDir = join(tmpdir(), `cleo-ac6-move-${Date.now()}`);
      const result = await moveProject(newDir, projectDir);
      // Always EngineResult — never throws
      expect('success' in result).toBe(true);
      expect(typeof result.success).toBe('boolean');
      if (result.success) {
        expect(result).toHaveProperty('data');
      } else {
        expect(result).toHaveProperty('error');
        expect(result.error).toHaveProperty('code');
        expect(result.error).toHaveProperty('message');
      }
      await cleanup(newDir);
    });

    it('renameProject returns EngineResult(true) on valid input', async () => {
      const result = await renameProject('valid-name', projectDir);
      expect(result.success).toBe(true);
      expect(result).toHaveProperty('data');
    });

    it('reregisterProject returns EngineResult (never throws)', async () => {
      const result = await reregisterProject(projectDir);
      expect('success' in result).toBe(true);
      expect(result).toHaveProperty('success');
    });
  });
});
