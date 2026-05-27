/**
 * Unit tests for @cleocode/adapter-cursor
 *
 * Tests the CursorAdapter, CursorHookProvider, and CursorInstallProvider.
 * Cursor has no spawn support, so no spawn provider tests.
 *
 * @task T5240
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CursorAdapter,
  CursorHookProvider,
  CursorInstallProvider,
  createCursorAdapter as createAdapter,
} from '@cleocode/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('CursorAdapter — integration', () => {
  let adapter: CursorAdapter;

  beforeEach(() => {
    adapter = new CursorAdapter();
  });

  it('has correct identity fields', () => {
    expect(adapter.id).toBe('cursor');
    expect(adapter.name).toBe('Cursor');
    expect(adapter.version).toBe('1.0.0');
  });

  it('supports hooks with 10 CAAMP events', () => {
    expect(adapter.capabilities.supportsHooks).toBe(true);
    expect(adapter.capabilities.supportedHookEvents).toHaveLength(10);
    expect(adapter.capabilities.supportedHookEvents).toContain('SessionStart');
    expect(adapter.capabilities.supportedHookEvents).toContain('SessionEnd');
    expect(adapter.capabilities.supportedHookEvents).toContain('PreToolUse');
    expect(adapter.capabilities.supportedHookEvents).toContain('PostToolUse');
  });

  it('does not support spawn', () => {
    expect(adapter.capabilities.supportsSpawn).toBe(false);
  });

  it('supports install and instruction files', () => {
    expect(adapter.capabilities.supportsInstall).toBe(true);
    expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
    expect(adapter.capabilities.instructionFilePattern).toBe('.cursor/rules/*.mdc');
  });

  it('has no spawn provider', () => {
    expect((adapter as unknown as Record<string, unknown>).spawn).toBeUndefined();
  });

  it('exposes hooks and install providers', () => {
    expect(adapter.hooks).toBeInstanceOf(CursorHookProvider);
    expect(adapter.install).toBeInstanceOf(CursorInstallProvider);
  });

  it('tracks initialization state', async () => {
    expect(adapter.isInitialized()).toBe(false);
    await adapter.initialize('/tmp/test-project');
    expect(adapter.isInitialized()).toBe(true);
    expect(adapter.getProjectDir()).toBe('/tmp/test-project');
  });

  it('clears state on dispose', async () => {
    await adapter.initialize('/tmp/test-project');
    await adapter.dispose();
    expect(adapter.isInitialized()).toBe(false);
    expect(adapter.getProjectDir()).toBeNull();
  });

  it('reports unhealthy when not initialized', async () => {
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.provider).toBe('cursor');
    expect(health.details?.error).toBe('Adapter not initialized');
  });

  it('reports health based on .cursor/ presence', async () => {
    const testDir = join(tmpdir(), `cursor-health-${Date.now()}`);
    mkdirSync(join(testDir, '.cursor'), { recursive: true });

    try {
      await adapter.initialize(testDir);
      const health = await adapter.healthCheck();
      expect(health.provider).toBe('cursor');
      expect(health.details?.configDirExists).toBe(true);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('CursorHookProvider — integration', () => {
  let hooks: CursorHookProvider;

  beforeEach(() => {
    hooks = new CursorHookProvider();
  });

  it('maps Cursor native events to CAAMP canonical names', () => {
    expect(hooks.mapProviderEvent('sessionStart')).toBe('SessionStart');
    expect(hooks.mapProviderEvent('sessionEnd')).toBe('SessionEnd');
    expect(hooks.mapProviderEvent('beforeSubmitPrompt')).toBe('PromptSubmit');
    expect(hooks.mapProviderEvent('stop')).toBe('ResponseComplete');
    expect(hooks.mapProviderEvent('preToolUse')).toBe('PreToolUse');
    expect(hooks.mapProviderEvent('postToolUse')).toBe('PostToolUse');
    expect(hooks.mapProviderEvent('postToolUseFailure')).toBe('PostToolUseFailure');
    expect(hooks.mapProviderEvent('subagentStart')).toBe('SubagentStart');
    expect(hooks.mapProviderEvent('subagentStop')).toBe('SubagentStop');
    expect(hooks.mapProviderEvent('preCompact')).toBe('PreCompact');
  });

  it('returns null for unsupported or unknown events', () => {
    expect(hooks.mapProviderEvent('SessionStart')).toBeNull();
    expect(hooks.mapProviderEvent('')).toBeNull();
    expect(hooks.mapProviderEvent('anything')).toBeNull();
  });

  it('tracks registration state', async () => {
    expect(hooks.isRegistered()).toBe(false);
    await hooks.registerNativeHooks('/tmp/test');
    expect(hooks.isRegistered()).toBe(true);
    await hooks.unregisterNativeHooks();
    expect(hooks.isRegistered()).toBe(false);
  });
});

describe('CursorInstallProvider — integration', () => {
  let install: CursorInstallProvider;
  let testDir: string;

  beforeEach(() => {
    install = new CursorInstallProvider();
    testDir = join(tmpdir(), `cleo-cursor-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('creates .cursor/rules/cleo.mdc with @-references', async () => {
    await install.ensureInstructionReferences(testDir);

    const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
    expect(existsSync(mdcPath)).toBe(true);

    const content = readFileSync(mdcPath, 'utf-8');
    expect(content).toContain('alwaysApply: true');
    // Structure check: must be a non-empty @~/... path pointing to CLEO-INJECTION.md (OS-agnostic)
    expect(content).toMatch(/@~\/.+\/CLEO-INJECTION\.md/);
    expect(content).toContain('@.cleo/memory-bridge.md');
  });

  it('uses MDC frontmatter format', async () => {
    await install.ensureInstructionReferences(testDir);

    const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
    const content = readFileSync(mdcPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('description: CLEO task management protocol references');
    expect(content).toContain('globs: "**/*"');
  });

  it('is idempotent for modern rules', async () => {
    await install.ensureInstructionReferences(testDir);
    const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
    const first = readFileSync(mdcPath, 'utf-8');

    await install.ensureInstructionReferences(testDir);
    const second = readFileSync(mdcPath, 'utf-8');

    expect(first).toBe(second);
  });

  it('appends to legacy .cursorrules if it exists', async () => {
    const legacyPath = join(testDir, '.cursorrules');
    writeFileSync(legacyPath, '# Project Rules\nUse TypeScript.\n', 'utf-8');

    await install.ensureInstructionReferences(testDir);

    const content = readFileSync(legacyPath, 'utf-8');
    expect(content).toContain('# Project Rules');
    expect(content).toContain('Use TypeScript.');
    // Structure check: must be a non-empty @~/... path pointing to CLEO-INJECTION.md (OS-agnostic)
    expect(content).toMatch(/@~\/.+\/CLEO-INJECTION\.md/);
    expect(content).toContain('@.cleo/memory-bridge.md');
  });

  it('does not create legacy .cursorrules if it does not exist', async () => {
    await install.ensureInstructionReferences(testDir);
    expect(existsSync(join(testDir, '.cursorrules'))).toBe(false);
  });

  it('does not duplicate references in legacy .cursorrules', async () => {
    const legacyPath = join(testDir, '.cursorrules');
    // Pre-seed with the dynamically-resolved reference so dedup logic fires
    const { getCleoTemplatesTildePath } = await import('../providers/shared/paths.js');
    const injectionRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
    writeFileSync(legacyPath, `${injectionRef}\n@.cleo/memory-bridge.md\n`, 'utf-8');

    await install.ensureInstructionReferences(testDir);

    const content = readFileSync(legacyPath, 'utf-8');
    const injectionCount = (content.match(/@~\/.+\/CLEO-INJECTION\.md/g) ?? []).length;
    expect(injectionCount).toBe(1);
  });

  it('install returns expected shape', async () => {
    const result = await install.install({
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.instructionFileUpdated).toBe(true);
  });

  it('uninstall is a no-op', async () => {
    await expect(install.uninstall()).resolves.toBeUndefined();
  });
});

describe('createCursorAdapter factory', () => {
  it('returns a CursorAdapter instance', () => {
    const adapter = createAdapter();
    expect(adapter).toBeInstanceOf(CursorAdapter);
    expect(adapter.id).toBe('cursor');
  });
});
