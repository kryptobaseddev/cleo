/**
 * Tools Domain E2E Tests
 *
 * End-to-end tests for the tools domain handler:
 * 1. Skill list (tools.skill.list)
 * 2. Skill find (tools.skill.find)
 * 3. Skill catalog info (tools.skill.catalog with type:"info")
 * 4. Provider list (tools.provider.list)
 * 5. Provider detect (tools.provider.detect)
 * 6. TodoWrite status (tools.todowrite.status)
 *
 * All tests use real implementations with isolated temp directories. No mocks.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Tools domain E2E workflow', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'tools-e2e-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_ROOT'] = testDir;

    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../../src/store/sqlite.js');
    await closeAllDatabases();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should list skills via ToolsHandler.query(skill.list)', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('skill.list', {});
    expect(result).toBeDefined();
    expect(result._meta).toBeDefined();
    expect(result._meta.domain).toBe('tools');
    expect(result._meta.operation).toBe('skill.list');
    // Skills may or may not exist depending on the environment
    if (result.success) {
      expect(result.data).toBeDefined();
      expect(Array.isArray((result.data as { skills: unknown[] }).skills)).toBe(true);
    }
  });

  it('should find skills with query filter', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('skill.find', { query: 'nonexistent-skill-xyz' });
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('skill.find');
    if (result.success) {
      const data = result.data as { skills: unknown[]; count: number; query: string };
      expect(data.query).toBe('nonexistent-skill-xyz');
      expect(Array.isArray(data.skills)).toBe(true);
    }
  });

  it('should return catalog info via skill.catalog with type:info', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('skill.catalog', { type: 'info' });
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('skill.catalog');
    if (result.success) {
      const data = result.data as {
        available: boolean;
        version: string | null;
        libraryRoot: string | null;
        skillCount: number;
        protocolCount: number;
        profileCount: number;
      };
      expect(typeof data.available).toBe('boolean');
      expect(typeof data.skillCount).toBe('number');
      expect(typeof data.protocolCount).toBe('number');
      expect(typeof data.profileCount).toBe('number');
    }
  });

  it('should list providers via provider.list', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('provider.list', {});
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('provider.list');
    if (result.success) {
      const data = result.data as { providers: unknown[]; count: number };
      expect(Array.isArray(data.providers)).toBe(true);
      expect(typeof data.count).toBe('number');
    }
  });

  it('should detect providers via provider.detect', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('provider.detect', {});
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('provider.detect');
    if (result.success) {
      const data = result.data as { providers: unknown[]; count: number };
      expect(Array.isArray(data.providers)).toBe(true);
      expect(typeof data.count).toBe('number');
    }
  });

  it('should return todowrite status', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('todowrite.status', {});
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('todowrite.status');
    // TodoWrite status should return a result even with no sync state
    expect(result.success).toBeDefined();
  });

  it('should handle unsupported operations gracefully', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('nonexistent.operation', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
  });

  it('should handle issue.diagnostics query', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    const result = await handler.query('issue.diagnostics', {});
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('issue.diagnostics');
    if (result.success) {
      expect(result.data).toBeDefined();
    }
  });

  it('should handle skill.verify with a known name', async () => {
    const { ToolsHandler } = await import('../../src/dispatch/domains/tools.js');
    const handler = new ToolsHandler();

    // Verify a skill that may or may not exist
    const result = await handler.query('skill.verify', { name: 'ct-cleo' });
    expect(result).toBeDefined();
    expect(result._meta.operation).toBe('skill.verify');
    if (result.success) {
      const data = result.data as { skill: string; installed: boolean; inCatalog: boolean };
      expect(data.skill).toBe('ct-cleo');
      expect(typeof data.installed).toBe('boolean');
      expect(typeof data.inCatalog).toBe('boolean');
    }
  });
});
