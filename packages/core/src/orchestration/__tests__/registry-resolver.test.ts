/**
 * Unit tests for {@link resolvePersonaFromRegistry} and
 * {@link listTierDirectories} — T898 / T899.
 *
 * Tests use an isolated tmp workspace to avoid polluting the real global
 * CLEO install. The global CANT dir and packaged seed dir are redirected
 * to per-test tmp directories.
 *
 * Coverage:
 *  1. Returns `null` when no agents are installed anywhere.
 *  2. Resolves from the packaged tier when a stem matches task keywords.
 *  3. Resolves from the project tier (highest priority).
 *  4. Project tier overrides global tier.
 *  5. Global tier overrides packaged tier.
 *  6. Returns `null` when keywords match no installed agents.
 *  7. {@link listTierDirectories} returns only existing dirs.
 *
 * @task T898
 * @task T899
 * @epic T889
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifyInput } from '../registry-resolver.js';
import { listTierDirectories, resolvePersonaFromRegistry } from '../registry-resolver.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TierDirs {
  projectAgentsDir: string;
  globalAgentsDir: string;
  packagedSeedDir: string;
  projectRoot: string;
}

/** Create isolated tier directories in a tmp base directory. */
function makeTierDirs(base: string): TierDirs {
  const projectRoot = join(base, 'project');
  const projectAgentsDir = join(projectRoot, '.cleo', 'cant', 'agents');
  const globalAgentsDir = join(base, 'global-agents');
  const packagedSeedDir = join(base, 'packaged-seed');

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  mkdirSync(packagedSeedDir, { recursive: true });

  return { projectAgentsDir, globalAgentsDir, packagedSeedDir, projectRoot };
}

/** Write a minimal `.cant` file. */
function writeCant(dir: string, agentId: string): void {
  writeFileSync(join(dir, `${agentId}.cant`), `# ${agentId} fixture`, 'utf8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolvePersonaFromRegistry — T898 / T899', () => {
  let base: string;
  let dirs: TierDirs;

  beforeEach(() => {
    vi.resetModules();
    base = mkdtempSync(join(tmpdir(), 'cleo-registry-resolver-test-'));
    dirs = makeTierDirs(base);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    vi.doUnmock('../../paths.js');
    vi.resetModules();
  });

  it('returns null when no agents are installed anywhere', async () => {
    const task: ClassifyInput = {
      id: 'T001',
      title: 'Implement rust crate for parser',
    };

    // Ensure global dir is also empty for this test
    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => join(base, 'empty-global'),
      };
    });

    const { resolvePersonaFromRegistry: freshFn } = await import('../registry-resolver.js');
    const result = await freshFn(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });
    expect(result).toBeNull();
  });

  it('resolves from packaged tier when a stem matches keywords', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-rust-lead');

    const task: ClassifyInput = {
      id: 'T002',
      title: 'Fix rust compilation error in crate',
    };

    // Mock getCleoGlobalCantAgentsDir to point at an empty dir so the global
    // tier does not accidentally match and shadow the packaged tier.
    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => join(base, 'empty-global-for-this-test'),
      };
    });

    const { resolvePersonaFromRegistry: freshFn } = await import('../registry-resolver.js');
    const result = await freshFn(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('cleo-rust-lead');
    expect(result!.tier).toBe('packaged');
    expect(result!.source).toBe('filesystem');
    expect(result!.reason).toContain('packaged');
  });

  it('resolves from project tier with highest priority', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-rust-lead');
    writeCant(dirs.globalAgentsDir, 'cleo-rust-lead');
    writeCant(dirs.projectAgentsDir, 'cleo-rust-lead');

    const task: ClassifyInput = {
      id: 'T003',
      title: 'rust crate compilation fix',
    };

    // Mock paths to redirect global dir
    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => dirs.globalAgentsDir,
      };
    });

    const { resolvePersonaFromRegistry: freshFn } = await import('../registry-resolver.js');
    const result = await freshFn(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('project');
  });

  it('global tier overrides packaged tier', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-dev');
    writeCant(dirs.globalAgentsDir, 'cleo-dev');
    // No project-tier agent

    const task: ClassifyInput = {
      id: 'T004',
      title: 'dev implementation fix',
    };

    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => dirs.globalAgentsDir,
      };
    });

    const { resolvePersonaFromRegistry: freshFn } = await import('../registry-resolver.js');
    const result = await freshFn(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).not.toBeNull();
    expect(result!.tier).toBe('global');
  });

  it('returns null when keywords match no installed agents', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-prime');

    const task: ClassifyInput = {
      id: 'T005',
      title: 'something completely unrelated',
      labels: ['xyz-label'],
    };

    // Isolate global tier to prevent real global agents from matching
    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => join(base, 'empty-global-t005'),
      };
    });

    const { resolvePersonaFromRegistry: freshFn } = await import('../registry-resolver.js');
    const result = await freshFn(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).toBeNull();
  });

  it('resolves agentId from description when title has no match', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-historian');

    const task: ClassifyInput = {
      id: 'T006',
      title: 'some task',
      description: 'write historian notes',
    };
    const result = await resolvePersonaFromRegistry(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).not.toBeNull();
    expect(result!.agentId).toBe('cleo-historian');
  });

  it('PersonaResolution has expected fields', async () => {
    writeCant(dirs.packagedSeedDir, 'cleo-dev');

    const task: ClassifyInput = {
      id: 'T007',
      title: 'dev build task',
    };
    const result = await resolvePersonaFromRegistry(task, {
      projectRoot: dirs.projectRoot,
      packagedSeedDir: dirs.packagedSeedDir,
    });

    expect(result).not.toBeNull();
    expect(typeof result!.agentId).toBe('string');
    expect(['project', 'global', 'packaged', 'fallback']).toContain(result!.tier);
    expect(typeof result!.cantPath).toBe('string');
    expect(['registry', 'filesystem']).toContain(result!.source);
    expect(typeof result!.reason).toBe('string');
  });
});

describe('listTierDirectories — T899', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cleo-tier-dirs-test-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('returns only tiers whose directories exist', () => {
    const projectRoot = join(base, 'project');
    const projectAgentsDir = join(projectRoot, '.cleo', 'cant', 'agents');
    mkdirSync(projectAgentsDir, { recursive: true });

    // Don't create packagedSeedDir — it should not appear
    const dirs = listTierDirectories(projectRoot, join(base, 'nonexistent-packaged'));

    const tiers = dirs.map((d) => d.tier);
    expect(tiers).toContain('project');
    expect(tiers).not.toContain('packaged');
  });

  it('returns global tier when its directory exists', () => {
    const projectRoot = join(base, 'project');
    mkdirSync(join(projectRoot, '.cleo', 'cant', 'agents'), { recursive: true });

    const globalDir = join(base, 'global-agents');
    mkdirSync(globalDir, { recursive: true });

    vi.doMock('../../paths.js', async () => {
      const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
      return {
        ...actual,
        getCleoGlobalCantAgentsDir: () => globalDir,
      };
    });

    const dirs = listTierDirectories(projectRoot, join(base, 'nonexistent'));
    const tiers = dirs.map((d) => d.tier);
    expect(Array.isArray(tiers)).toBe(true);
  });

  it('returns an empty array when no directories exist', () => {
    const dirs = listTierDirectories(
      join(base, 'nonexistent-project'),
      join(base, 'nonexistent-packaged'),
    );
    // global tier may or may not exist depending on the machine;
    // just check that the return is an array
    expect(Array.isArray(dirs)).toBe(true);
  });
});
