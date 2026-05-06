/**
 * Unit tests for the T1937 {@link resolvePlaybook} and {@link listPlaybooks}
 * functions in `packages/core/src/playbooks/playbook-resolver.ts`.
 *
 * Coverage:
 *   - Each tier hit individually (project / global / packaged).
 *   - Tier override behaviour: project wins over global/packaged.
 *   - Empty higher tiers fall through cleanly to packaged.
 *   - `PlaybookNotFoundError` thrown when all tiers miss; error lists
 *     all tried paths.
 *   - `listPlaybooks()` dedupe with provenance.
 *   - Three packaged starter playbooks (rcasd / ivtr / release) discoverable
 *     via the packaged tier (real filesystem smoke test).
 *
 * Test strategy:
 *   - Project and global tiers: real temp directories via `mkdtempSync`.
 *   - Packaged tier: real `packages/playbooks/starter/` directory when
 *     available; overridable via `packagedStarterDir` for CI environments
 *     without the workspace layout.
 *   - No mocks — all assertions operate on actual files.
 *
 * @task T1937
 * @see packages/core/src/playbooks/playbook-resolver.ts
 * @see ADR-068 Decision 4
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listPlaybooks,
  PlaybookNotFoundError,
  type ResolvedPlaybook,
  resolvePlaybook,
} from '../playbook-resolver.js';

// ---------------------------------------------------------------------------
// Locate real packaged starter directory
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Try to locate the real `packages/playbooks/starter/` directory from the
 * workspace layout so smoke tests can verify packaged starters without
 * hardcoding paths.
 *
 * The test file lives at:
 *   packages/core/src/playbooks/__tests__/playbook-resolver.test.ts
 * → climb to packages/playbooks/starter
 */
const REAL_STARTER_DIR = resolve(__dirname, '..', '..', '..', '..', 'playbooks', 'starter');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePlaybookContent(name: string): string {
  return [
    'version: "1.0"',
    `name: ${name}`,
    `description: Test playbook ${name}`,
    'nodes:',
    '  - id: step1',
    '    type: agentic',
    '    skill: ct-test',
    'edges: []',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Suite setup: a fresh pair of temp dirs per test
// ---------------------------------------------------------------------------

let projectDir: string;
let globalDir: string;
let projectPlaybooksDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-proj-'));
  globalDir = mkdtempSync(join(tmpdir(), 'cleo-global-'));
  projectPlaybooksDir = join(projectDir, '.cleo', 'playbooks');
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(globalDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Project tier
// ---------------------------------------------------------------------------

describe('project tier', () => {
  it('resolves a playbook placed in <projectRoot>/.cleo/playbooks/', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    writeFileSync(join(projectPlaybooksDir, 'my-flow.cantbook'), makePlaybookContent('my-flow'));

    const result = resolvePlaybook('my-flow', {
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: globalDir, // empty — forces project to win
    });

    expect(result.name).toBe('my-flow');
    expect(result.tier).toBe('project');
    expect(result.path).toBe(join(projectPlaybooksDir, 'my-flow.cantbook'));
    expect(result.source).toContain('name: my-flow');
  });

  it('silently falls through when projectRoot is absent', () => {
    // Without projectRoot the project tier is skipped — should land on packaged.
    expect(() =>
      resolvePlaybook('rcasd', {
        packagedStarterDir: REAL_STARTER_DIR,
      }),
    ).not.toThrow();

    const result = resolvePlaybook('rcasd', { packagedStarterDir: REAL_STARTER_DIR });
    expect(result.tier).toBe('packaged');
  });
});

// ---------------------------------------------------------------------------
// 2. Global tier
// ---------------------------------------------------------------------------

describe('global tier', () => {
  it('resolves a playbook placed in the global dir when project tier is empty', () => {
    writeFileSync(join(globalDir, 'global-flow.cantbook'), makePlaybookContent('global-flow'));

    const result = resolvePlaybook('global-flow', {
      projectRoot: projectDir, // project dir exists but playbooks/ subdir does not
      globalPlaybooksDir: globalDir,
      packagedStarterDir: join(tmpdir(), 'no-packaged'), // non-existent
    });

    expect(result.name).toBe('global-flow');
    expect(result.tier).toBe('global');
    expect(result.path).toBe(join(globalDir, 'global-flow.cantbook'));
  });

  it('falls through to packaged when global dir exists but name is absent', () => {
    // globalDir is empty — fallthrough expected.
    const result = resolvePlaybook('rcasd', {
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    expect(result.tier).toBe('packaged');
    expect(result.name).toBe('rcasd');
  });
});

// ---------------------------------------------------------------------------
// 3. Packaged tier
// ---------------------------------------------------------------------------

describe('packaged tier', () => {
  it('resolves rcasd from the real starter directory', () => {
    const result = resolvePlaybook('rcasd', {
      packagedStarterDir: REAL_STARTER_DIR,
    });

    expect(result.name).toBe('rcasd');
    expect(result.tier).toBe('packaged');
    expect(result.path).toContain('rcasd.cantbook');
    expect(result.source.length).toBeGreaterThan(0);
  });

  it('resolves ivtr from the real starter directory', () => {
    const result = resolvePlaybook('ivtr', { packagedStarterDir: REAL_STARTER_DIR });
    expect(result.tier).toBe('packaged');
    expect(result.name).toBe('ivtr');
  });

  it('resolves release from the real starter directory', () => {
    const result = resolvePlaybook('release', { packagedStarterDir: REAL_STARTER_DIR });
    expect(result.tier).toBe('packaged');
    expect(result.name).toBe('release');
  });
});

// ---------------------------------------------------------------------------
// 4. Tier override behaviour (project shadows global/packaged)
// ---------------------------------------------------------------------------

describe('tier override / shadowing', () => {
  it('project tier wins over global when both contain same name', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    writeFileSync(
      join(projectPlaybooksDir, 'shared.cantbook'),
      makePlaybookContent('project-version'),
    );
    writeFileSync(join(globalDir, 'shared.cantbook'), makePlaybookContent('global-version'));

    const result = resolvePlaybook('shared', {
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    expect(result.tier).toBe('project');
    expect(result.source).toContain('project-version');
  });

  it('global tier wins over packaged when both contain same name', () => {
    // rcasd exists in packaged tier; place a global override
    writeFileSync(join(globalDir, 'rcasd.cantbook'), makePlaybookContent('global-rcasd-override'));

    const result = resolvePlaybook('rcasd', {
      projectRoot: projectDir, // empty project playbooks dir
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    expect(result.tier).toBe('global');
    expect(result.source).toContain('global-rcasd-override');
  });

  it('project tier wins over both global and packaged for same name', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    writeFileSync(
      join(projectPlaybooksDir, 'rcasd.cantbook'),
      makePlaybookContent('project-rcasd'),
    );
    writeFileSync(join(globalDir, 'rcasd.cantbook'), makePlaybookContent('global-rcasd'));

    const result = resolvePlaybook('rcasd', {
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    expect(result.tier).toBe('project');
    expect(result.source).toContain('project-rcasd');
  });

  it('preferTier=packaged moves packaged to the head of the lookup order', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    writeFileSync(
      join(projectPlaybooksDir, 'rcasd.cantbook'),
      makePlaybookContent('project-override'),
    );

    const result = resolvePlaybook('rcasd', {
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
      preferTier: 'packaged',
    });

    // packaged was tried first — so it wins even though project has a file.
    expect(result.tier).toBe('packaged');
  });
});

// ---------------------------------------------------------------------------
// 5. PlaybookNotFoundError
// ---------------------------------------------------------------------------

describe('PlaybookNotFoundError', () => {
  it('throws when all tiers miss', () => {
    expect(() =>
      resolvePlaybook('totally-unknown-playbook-xyz', {
        projectRoot: projectDir,
        globalPlaybooksDir: globalDir,
        packagedStarterDir: join(tmpdir(), 'no-packaged-dir'),
      }),
    ).toThrow(PlaybookNotFoundError);
  });

  it('error message lists all tried paths', () => {
    try {
      resolvePlaybook('no-such-playbook', {
        projectRoot: projectDir,
        globalPlaybooksDir: globalDir,
        packagedStarterDir: join(tmpdir(), 'empty-packaged'),
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PlaybookNotFoundError);
      const e = err as PlaybookNotFoundError;
      // Should list paths for all 3 tiers.
      expect(e.triedPaths).toHaveLength(3);
      expect(e.triedPaths[0]).toContain('.cleo');
      expect(e.triedPaths[0]).toContain('no-such-playbook.cantbook');
      expect(e.triedPaths[1]).toContain('no-such-playbook.cantbook');
      expect(e.triedPaths[2]).toContain('no-such-playbook.cantbook');
      // Error message includes all paths.
      for (const p of e.triedPaths) {
        expect(e.message).toContain(p);
      }
    }
  });

  it('error has code E_PLAYBOOK_NOT_FOUND and exitCode 66', () => {
    try {
      resolvePlaybook('ghost', {
        globalPlaybooksDir: globalDir,
        packagedStarterDir: join(tmpdir(), 'x'),
      });
    } catch (err) {
      const e = err as PlaybookNotFoundError;
      expect(e.code).toBe('E_PLAYBOOK_NOT_FOUND');
      expect(e.exitCode).toBe(66);
      expect(e.playbookName).toBe('ghost');
    }
  });
});

// ---------------------------------------------------------------------------
// 6. listPlaybooks() — dedupe with provenance
// ---------------------------------------------------------------------------

describe('listPlaybooks()', () => {
  it('returns all playbooks across tiers, deduplicated by name', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    // Project has two unique playbooks and one that shadows a packaged starter.
    writeFileSync(join(projectPlaybooksDir, 'alpha.cantbook'), makePlaybookContent('alpha'));
    writeFileSync(
      join(projectPlaybooksDir, 'rcasd.cantbook'),
      makePlaybookContent('project-rcasd'),
    );

    // Global has one unique playbook.
    writeFileSync(join(globalDir, 'beta.cantbook'), makePlaybookContent('beta'));

    const results = listPlaybooks({
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    const byName = new Map<string, ResolvedPlaybook>(results.map((r) => [r.name, r]));

    // alpha from project
    expect(byName.get('alpha')?.tier).toBe('project');
    // rcasd shadowed by project (not packaged)
    expect(byName.get('rcasd')?.tier).toBe('project');
    expect(byName.get('rcasd')?.source).toContain('project-rcasd');
    // beta from global
    expect(byName.get('beta')?.tier).toBe('global');
    // packaged starters that aren't shadowed
    expect(byName.get('ivtr')?.tier).toBe('packaged');
    expect(byName.get('release')?.tier).toBe('packaged');

    // No duplicate names.
    const names = results.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns only packaged starters when project and global dirs are empty', () => {
    const results = listPlaybooks({
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    const tiers = results.map((r) => r.tier);
    expect(tiers.every((t) => t === 'packaged')).toBe(true);
    expect(results.map((r) => r.name).sort()).toEqual(['ivtr', 'rcasd', 'release']);
  });

  it('returns empty array when all tiers are empty or missing', () => {
    const results = listPlaybooks({
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: join(tmpdir(), 'truly-empty-dir-xyz'),
    });

    expect(results).toEqual([]);
  });

  it('preserves tier order: project entries appear before global, global before packaged', () => {
    mkdirSync(projectPlaybooksDir, { recursive: true });
    writeFileSync(
      join(projectPlaybooksDir, 'proj-only.cantbook'),
      makePlaybookContent('proj-only'),
    );
    writeFileSync(join(globalDir, 'glob-only.cantbook'), makePlaybookContent('glob-only'));

    const results = listPlaybooks({
      projectRoot: projectDir,
      globalPlaybooksDir: globalDir,
      packagedStarterDir: REAL_STARTER_DIR,
    });

    const projectIdx = results.findIndex((r) => r.tier === 'project');
    const globalIdx = results.findIndex((r) => r.tier === 'global');
    const packagedIdx = results.findIndex((r) => r.tier === 'packaged');

    expect(projectIdx).toBeLessThan(globalIdx);
    expect(globalIdx).toBeLessThan(packagedIdx);
  });
});

// ---------------------------------------------------------------------------
// 7. Smoke test: real packaged starters discoverable
// ---------------------------------------------------------------------------

describe('packaged starter smoke test (real filesystem)', () => {
  it('all three packaged starters have non-empty source', () => {
    const names = ['rcasd', 'ivtr', 'release'];
    for (const name of names) {
      const result = resolvePlaybook(name, { packagedStarterDir: REAL_STARTER_DIR });
      expect(result.source.trim().length).toBeGreaterThan(0);
      expect(result.tier).toBe('packaged');
    }
  });
});
