/**
 * Tests for renameProject in packages/core/src/project-lifecycle.ts
 *
 * @task T11010 / T11015
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveProject, renameProject, reregisterProject } from '../project-lifecycle.js';

describe('renameProject', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-rename-test-'));
    const cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    const projectInfo = {
      projectId: 'test-uuid-1234',
      projectHash: 'oldhash12345',
      projectName: 'old-project-name',
      cleoVersion: '0.0.0',
      lastUpdated: new Date().toISOString(),
    };
    await writeFile(join(cleoDir, 'project-info.json'), JSON.stringify(projectInfo, null, 2));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('renames a project successfully', async () => {
    const result = await renameProject('new-project-name', projectRoot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.newName).toBe('new-project-name');
      expect(result.data.oldName).toBe('old-project-name');
      expect(result.data.projectId).toBe('test-uuid-1234');
      expect(result.data.newProjectHash).toBeTruthy();
      expect(result.data.newProjectHash).not.toBe('oldhash12345');
    }
  });

  it('rejects empty names', async () => {
    const result = await renameProject('', projectRoot);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_NAME');
    }
  });

  it('rejects non-absolute projectRoot', async () => {
    const result = await renameProject('newname', 'relative/path');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('E_INVALID_PATH');
    }
  });

  it('rejects missing project-info.json', async () => {
    // Create a dir without project-info.json
    const emptyDir = await mkdtemp(join(tmpdir(), 'cleo-empty-'));
    try {
      const result = await renameProject('newname', emptyDir);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('E_PROJECT_INFO_MISSING');
      }
    } finally {
      await rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('preserves projectId across rename', async () => {
    const result = await renameProject('another-name', projectRoot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('test-uuid-1234');
    }
  });
});

describe('reregisterProject', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'cleo-rereg-'));
    const cleoDir = join(projectRoot, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    const projectInfo = {
      projectId: 'test-uuid-5678',
      projectHash: 'rereghash123',
      projectName: 'rereg-project',
      cleoVersion: '0.0.0',
      lastUpdated: new Date().toISOString(),
    };
    await writeFile(join(cleoDir, 'project-info.json'), JSON.stringify(projectInfo, null, 2));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('re-registers a project successfully', async () => {
    const result = await reregisterProject(projectRoot);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.projectId).toBe('test-uuid-5678');
      expect(result.data.projectHash).toBeTruthy();
    }
  });
});
