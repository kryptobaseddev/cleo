/**
 * Tests for NEXUS permissions module.
 * @task T4574
 * @epic T4540
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  permissionLevel,
  getPermission,
  checkPermission,
  requirePermission,
  checkPermissionDetail,
  canRead,
  canWrite,
  canExecute,
} from '../permissions.js';
import { nexusRegister, nexusInit } from '../registry.js';

let testDir: string;
let projectDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'nexus-perms-test-'));
  const registryDir = join(testDir, 'cleo-home');
  projectDir = join(testDir, 'test-project');

  await mkdir(registryDir, { recursive: true });
  await mkdir(join(projectDir, '.cleo'), { recursive: true });
  await writeFile(
    join(projectDir, '.cleo', 'todo.json'),
    '{"tasks":[]}',
  );

  process.env['CLEO_HOME'] = registryDir;
  process.env['NEXUS_HOME'] = join(registryDir, 'nexus');
  process.env['NEXUS_CACHE_DIR'] = join(registryDir, 'nexus', 'cache');
  process.env['NEXUS_REGISTRY_FILE'] = join(registryDir, 'projects-registry.json');
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
});

afterEach(async () => {
  delete process.env['CLEO_HOME'];
  delete process.env['NEXUS_HOME'];
  delete process.env['NEXUS_CACHE_DIR'];
  delete process.env['NEXUS_REGISTRY_FILE'];
  delete process.env['NEXUS_SKIP_PERMISSION_CHECK'];
  await rm(testDir, { recursive: true, force: true });
});

describe('permissionLevel', () => {
  it('returns correct numeric levels', () => {
    expect(permissionLevel('read')).toBe(1);
    expect(permissionLevel('write')).toBe(2);
    expect(permissionLevel('execute')).toBe(3);
  });

  it('returns 0 for invalid permissions', () => {
    expect(permissionLevel('invalid')).toBe(0);
    expect(permissionLevel('')).toBe(0);
  });
});

describe('checkPermission', () => {
  it('allows read on read-permission project', async () => {
    await nexusRegister(projectDir, 'read-proj', 'read');
    expect(await checkPermission('read-proj', 'read')).toBe(true);
  });

  it('denies write on read-only project', async () => {
    await nexusRegister(projectDir, 'read-proj', 'read');
    expect(await checkPermission('read-proj', 'write')).toBe(false);
  });

  it('allows read on write-permission project (hierarchical)', async () => {
    await nexusRegister(projectDir, 'write-proj', 'write');
    expect(await checkPermission('write-proj', 'read')).toBe(true);
  });

  it('allows all on execute-permission project', async () => {
    await nexusRegister(projectDir, 'exec-proj', 'execute');
    expect(await checkPermission('exec-proj', 'read')).toBe(true);
    expect(await checkPermission('exec-proj', 'write')).toBe(true);
    expect(await checkPermission('exec-proj', 'execute')).toBe(true);
  });

  it('respects NEXUS_SKIP_PERMISSION_CHECK bypass', async () => {
    await nexusRegister(projectDir, 'read-proj', 'read');
    process.env['NEXUS_SKIP_PERMISSION_CHECK'] = 'true';

    expect(await checkPermission('read-proj', 'execute')).toBe(true);
  });
});

describe('requirePermission', () => {
  it('does not throw when permission is sufficient', async () => {
    await nexusRegister(projectDir, 'write-proj', 'write');
    await expect(
      requirePermission('write-proj', 'read', 'test'),
    ).resolves.toBeUndefined();
  });

  it('throws CleoError when permission is insufficient', async () => {
    await nexusRegister(projectDir, 'read-proj', 'read');
    await expect(
      requirePermission('read-proj', 'write', 'update task'),
    ).rejects.toThrow(/Permission denied/);
  });
});

describe('checkPermissionDetail', () => {
  it('returns structured result with allowed=true', async () => {
    await nexusRegister(projectDir, 'write-proj', 'write');
    const result = await checkPermissionDetail('write-proj', 'read');

    expect(result.project).toBe('write-proj');
    expect(result.required).toBe('read');
    expect(result.granted).toBe('write');
    expect(result.allowed).toBe(true);
  });

  it('returns structured result with allowed=false', async () => {
    await nexusRegister(projectDir, 'read-proj', 'read');
    const result = await checkPermissionDetail('read-proj', 'execute');

    expect(result.allowed).toBe(false);
    expect(result.granted).toBe('read');
    expect(result.required).toBe('execute');
  });
});

describe('convenience helpers', () => {
  it('canRead returns true for read-level project', async () => {
    await nexusRegister(projectDir, 'proj', 'read');
    expect(await canRead('proj')).toBe(true);
  });

  it('canWrite returns false for read-level project', async () => {
    await nexusRegister(projectDir, 'proj', 'read');
    expect(await canWrite('proj')).toBe(false);
  });

  it('canExecute returns true for execute-level project', async () => {
    await nexusRegister(projectDir, 'proj', 'execute');
    expect(await canExecute('proj')).toBe(true);
  });
});
