/**
 * Tests for restore-json-merge.ts (T354).
 *
 * Covers: all 6 classification categories (identical, machine-local,
 * user-intent, project-identity, auto-detect, unknown), nested dot-notation
 * path traversal, missing-on-one-side cases, conflict counting, and the
 * applied merge result correctness per ADR-038 §10 and T311 spec §6.
 *
 * All tests call regenerateAndCompare directly with pre-built A/B objects so
 * there are no filesystem or network side-effects.
 *
 * @task T354
 * @epic T311
 */

import { describe, expect, it } from 'vitest';
import { regenerateAndCompare } from '../restore-json-merge.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand for a config.json comparison. */
function compareConfig(local: Record<string, unknown>, imported: Record<string, unknown>) {
  return regenerateAndCompare({ filename: 'config.json', localGenerated: local, imported });
}

/** Shorthand for a project-info.json comparison. */
function compareInfo(local: Record<string, unknown>, imported: Record<string, unknown>) {
  return regenerateAndCompare({
    filename: 'project-info.json',
    localGenerated: local,
    imported,
  });
}

/** Shorthand for a project-context.json comparison. */
function compareContext(local: Record<string, unknown>, imported: Record<string, unknown>) {
  return regenerateAndCompare({
    filename: 'project-context.json',
    localGenerated: local,
    imported,
  });
}

// ---------------------------------------------------------------------------
// Identical fields
// ---------------------------------------------------------------------------

describe('T354 A/B regenerate-and-compare', () => {
  it('identical fields produce no conflicts', () => {
    const report = compareConfig(
      { brain: { provider: 'local' } },
      { brain: { provider: 'local' } },
    );
    expect(report.conflictCount).toBe(0);
    expect(report.classifications.every((c) => c.category === 'identical')).toBe(true);
  });

  it('all identical fields have resolution A', () => {
    const report = compareConfig(
      { brain: { provider: 'local' }, hooks: { pre: 'echo hi' } },
      { brain: { provider: 'local' }, hooks: { pre: 'echo hi' } },
    );
    for (const c of report.classifications) {
      expect(c.resolution).toBe('A');
    }
  });

  // -------------------------------------------------------------------------
  // Machine-local
  // -------------------------------------------------------------------------

  it('machine-local field (projectRoot) keeps A', () => {
    const report = compareConfig({ projectRoot: '/local/path' }, { projectRoot: '/source/path' });
    const c = report.classifications.find((cl) => cl.path === 'projectRoot');
    expect(c?.category).toBe('machine-local');
    expect(c?.resolution).toBe('A');
    expect((report.applied as Record<string, unknown>).projectRoot).toBe('/local/path');
  });

  it('machine-local field (hostname) keeps A', () => {
    const report = compareInfo({ hostname: 'my-machine' }, { hostname: 'other-machine' });
    const c = report.classifications.find((cl) => cl.path === 'hostname');
    expect(c?.category).toBe('machine-local');
    expect(c?.resolution).toBe('A');
    expect((report.applied as Record<string, unknown>).hostname).toBe('my-machine');
  });

  it('machine-local field (createdAt) keeps A', () => {
    const report = compareConfig(
      { createdAt: '2026-01-01T00:00:00Z' },
      { createdAt: '2025-01-01T00:00:00Z' },
    );
    const c = report.classifications.find((cl) => cl.path === 'createdAt');
    expect(c?.category).toBe('machine-local');
    expect(c?.resolution).toBe('A');
  });

  it('absolute path heuristic classifies Unix path as machine-local', () => {
    const report = compareConfig(
      { arbitraryPath: '/home/user/project' },
      { arbitraryPath: '/home/other/project' },
    );
    const c = report.classifications.find((cl) => cl.path === 'arbitraryPath');
    expect(c?.category).toBe('machine-local');
    expect(c?.resolution).toBe('A');
  });

  it('absolute path heuristic classifies Windows path as machine-local', () => {
    const report = compareConfig(
      { arbitraryPath: 'C:\\Users\\project' },
      { arbitraryPath: 'D:\\Users\\project' },
    );
    const c = report.classifications.find((cl) => cl.path === 'arbitraryPath');
    expect(c?.category).toBe('machine-local');
  });

  // -------------------------------------------------------------------------
  // User-intent (config.json)
  // -------------------------------------------------------------------------

  it('user-intent field (brain.embeddingProvider) keeps B', () => {
    const report = compareConfig(
      { brain: { embeddingProvider: 'local' } },
      { brain: { embeddingProvider: 'openai' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'brain.embeddingProvider');
    expect(c?.category).toBe('user-intent');
    expect(c?.resolution).toBe('B');
    expect(
      (report.applied as Record<string, unknown & { brain: Record<string, unknown> }>).brain
        .embeddingProvider,
    ).toBe('openai');
  });

  it('user-intent field (enabledFeatures) keeps B', () => {
    const report = compareConfig(
      { enabledFeatures: ['alpha'] },
      { enabledFeatures: ['alpha', 'beta'] },
    );
    const c = report.classifications.find((cl) => cl.path === 'enabledFeatures');
    expect(c?.category).toBe('user-intent');
    expect(c?.resolution).toBe('B');
    expect((report.applied as Record<string, unknown>).enabledFeatures).toEqual(['alpha', 'beta']);
  });

  it('user-intent field (hooks) keeps B', () => {
    const report = compareConfig(
      { hooks: { pre: 'echo local' } },
      { hooks: { pre: 'echo imported' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'hooks.pre');
    expect(c?.category).toBe('user-intent');
    expect(c?.resolution).toBe('B');
  });

  it('user-intent does NOT apply to project-info.json', () => {
    // brain.* in project-info.json should fall through to unknown if not
    // matched by any other rule.
    const report = compareInfo({ brain: { x: 1 } }, { brain: { x: 2 } });
    const c = report.classifications.find((cl) => cl.path === 'brain.x');
    expect(c?.category).not.toBe('user-intent');
  });

  // -------------------------------------------------------------------------
  // Project-identity (project-info.json)
  // -------------------------------------------------------------------------

  it('project-identity field (name) keeps B', () => {
    const report = compareInfo({ name: 'local-project' }, { name: 'imported-project' });
    const c = report.classifications.find((cl) => cl.path === 'name');
    expect(c?.category).toBe('project-identity');
    expect(c?.resolution).toBe('B');
    expect((report.applied as Record<string, unknown>).name).toBe('imported-project');
  });

  it('project-identity field (description) keeps B', () => {
    const report = compareInfo(
      { description: 'local description' },
      { description: 'imported description' },
    );
    const c = report.classifications.find((cl) => cl.path === 'description');
    expect(c?.category).toBe('project-identity');
    expect(c?.resolution).toBe('B');
  });

  it('project-identity field (tags) keeps B', () => {
    const report = compareInfo({ tags: ['ts'] }, { tags: ['ts', 'rust'] });
    const c = report.classifications.find((cl) => cl.path === 'tags');
    expect(c?.category).toBe('project-identity');
    expect(c?.resolution).toBe('B');
    expect((report.applied as Record<string, unknown>).tags).toEqual(['ts', 'rust']);
  });

  it('project-identity does NOT apply to config.json', () => {
    const report = compareConfig({ name: 'local' }, { name: 'imported' });
    const c = report.classifications.find((cl) => cl.path === 'name');
    expect(c?.category).not.toBe('project-identity');
  });

  // -------------------------------------------------------------------------
  // Auto-detect (project-context.json)
  // -------------------------------------------------------------------------

  it('auto-detect field (testing.framework) keeps A', () => {
    const report = compareContext(
      { testing: { framework: 'vitest' } },
      { testing: { framework: 'jest' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'testing.framework');
    expect(c?.category).toBe('auto-detect');
    expect(c?.resolution).toBe('A');
    expect((report.applied as Record<string, Record<string, unknown>>).testing?.framework).toBe(
      'vitest',
    );
  });

  it('auto-detect field (build.command) keeps A', () => {
    const report = compareContext(
      { build: { command: 'pnpm build' } },
      { build: { command: 'npm run build' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'build.command');
    expect(c?.category).toBe('auto-detect');
    expect(c?.resolution).toBe('A');
  });

  it('auto-detect field (llmHints) keeps A', () => {
    const report = compareContext(
      { llmHints: { typeSystem: 'TypeScript strict' } },
      { llmHints: { typeSystem: 'JavaScript' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'llmHints.typeSystem');
    expect(c?.category).toBe('auto-detect');
    expect(c?.resolution).toBe('A');
  });

  it('auto-detect does NOT apply to config.json', () => {
    const report = compareConfig(
      { testing: { framework: 'vitest' } },
      { testing: { framework: 'jest' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'testing.framework');
    // Should not be auto-detect in config.json — likely unknown or user-intent
    expect(c?.category).not.toBe('auto-detect');
  });

  // -------------------------------------------------------------------------
  // Unknown / manual-review
  // -------------------------------------------------------------------------

  it('unknown field is flagged for manual review', () => {
    const report = compareConfig({}, { somethingNew: { weird: 'value' } });
    const c = report.classifications.find((cl) => cl.path.startsWith('somethingNew'));
    expect(c?.category).toBe('unknown');
    expect(c?.resolution).toBe('manual-review');
    expect(report.conflictCount).toBeGreaterThan(0);
  });

  it('unknown field keeps A (local) as safe default in applied', () => {
    const report = compareConfig({ unknown123: 'local-val' }, { unknown123: 'imported-val' });
    const c = report.classifications.find((cl) => cl.path === 'unknown123');
    expect(c?.category).toBe('unknown');
    expect(c?.resolution).toBe('manual-review');
    // Safe default: keep local value in applied
    expect((report.applied as Record<string, unknown>).unknown123).toBe('local-val');
  });

  // -------------------------------------------------------------------------
  // Missing-on-one-side
  // -------------------------------------------------------------------------

  it('field present in B but missing in A', () => {
    const report = compareConfig({ brain: {} }, { brain: { embeddingProvider: 'openai' } });
    const c = report.classifications.find((cl) => cl.path === 'brain.embeddingProvider');
    expect(c?.local).toBeUndefined();
    expect(c?.imported).toBe('openai');
  });

  it('field present in A but missing in B', () => {
    const report = compareConfig({ brain: { embeddingProvider: 'local' } }, { brain: {} });
    const c = report.classifications.find((cl) => cl.path === 'brain.embeddingProvider');
    expect(c?.local).toBe('local');
    expect(c?.imported).toBeUndefined();
  });

  it('field absent in A and present in B with user-intent path applies B resolution', () => {
    const report = compareConfig({ brain: {} }, { brain: { newSetting: 'val' } });
    const c = report.classifications.find((cl) => cl.path === 'brain.newSetting');
    expect(c?.category).toBe('user-intent');
    expect(c?.resolution).toBe('B');
    expect((report.applied as Record<string, Record<string, unknown>>).brain?.newSetting).toBe(
      'val',
    );
  });

  // -------------------------------------------------------------------------
  // Nested object walking
  // -------------------------------------------------------------------------

  it('nested object walking produces correct dot-notation paths', () => {
    const report = compareConfig({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } });
    const c = report.classifications.find((cl) => cl.path === 'a.b.c');
    expect(c).toBeDefined();
  });

  it('deeply nested path is classified correctly', () => {
    const report = compareContext(
      { conventions: { fileNaming: 'kebab-case', importStyle: 'esm' } },
      { conventions: { fileNaming: 'camelCase', importStyle: 'cjs' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'conventions.fileNaming');
    expect(c?.category).toBe('auto-detect');
    expect(c?.resolution).toBe('A');
  });

  it('arrays are treated as atomic leaf values (no per-element classification)', () => {
    const report = compareInfo({ tags: ['ts', 'node'] }, { tags: ['ts', 'rust'] });
    // Should produce exactly one classification for tags, not one per element
    const tagClassifications = report.classifications.filter((c) => c.path === 'tags');
    expect(tagClassifications).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Rationale
  // -------------------------------------------------------------------------

  it('rationale is non-empty for every classification', () => {
    const report = compareConfig({ x: 1, projectRoot: '/a' }, { x: 2, projectRoot: '/b' });
    for (const c of report.classifications) {
      expect(c.rationale.length).toBeGreaterThan(0);
    }
  });

  it('identical classification rationale mentions identical', () => {
    const report = compareConfig({ brain: { x: 1 } }, { brain: { x: 1 } });
    const c = report.classifications[0];
    expect(c?.rationale).toMatch(/identical/i);
  });

  // -------------------------------------------------------------------------
  // conflictCount
  // -------------------------------------------------------------------------

  it('conflictCount = number of manual-review classifications', () => {
    const report = compareConfig({ brain: { x: 1 }, weird: 'a' }, { brain: { x: 2 }, weird: 'b' });
    // brain.x is user-intent (resolution=B, no conflict)
    // weird is unknown (manual-review)
    const manualCount = report.classifications.filter(
      (c) => c.resolution === 'manual-review',
    ).length;
    expect(report.conflictCount).toBe(manualCount);
  });

  it('conflictCount = 0 when all fields are identical', () => {
    const report = compareConfig({ brain: { x: 1 } }, { brain: { x: 1 } });
    expect(report.conflictCount).toBe(0);
  });

  it('conflictCount equals unknown-category count exactly', () => {
    const report = compareConfig({ brain: { x: 1 }, weird: 'a' }, { brain: { x: 2 }, weird: 'b' });
    const unknownCount = report.classifications.filter((c) => c.category === 'unknown').length;
    expect(report.conflictCount).toBe(unknownCount);
  });

  // -------------------------------------------------------------------------
  // Applied merge correctness
  // -------------------------------------------------------------------------

  it('applied object contains merged values per classification', () => {
    const report = compareConfig(
      { projectRoot: '/local', brain: { provider: 'local' } },
      { projectRoot: '/source', brain: { provider: 'openai' } },
    );
    const applied = report.applied as Record<string, unknown & { brain: Record<string, unknown> }>;
    expect(applied.projectRoot).toBe('/local'); // machine-local → A
    expect(applied.brain.provider).toBe('openai'); // user-intent → B
  });

  it('multi-field applied: machine-local + project-identity + auto-detect', () => {
    const localInfo = {
      projectRoot: '/local/path',
      name: 'local-project',
      description: 'local desc',
    };
    const importedInfo = {
      projectRoot: '/source/path',
      name: 'imported-project',
      description: 'imported desc',
    };
    const report = regenerateAndCompare({
      filename: 'project-info.json',
      localGenerated: localInfo,
      imported: importedInfo,
    });
    const applied = report.applied as typeof localInfo;
    expect(applied.projectRoot).toBe('/local/path'); // machine-local → A
    expect(applied.name).toBe('imported-project'); // project-identity → B
    expect(applied.description).toBe('imported desc'); // project-identity → B
  });

  it('auto-detect context: applied keeps A for all auto-detect fields', () => {
    const report = compareContext(
      {
        testing: { framework: 'vitest', command: 'pnpm test' },
        build: { command: 'pnpm build' },
      },
      {
        testing: { framework: 'jest', command: 'npm test' },
        build: { command: 'npm run build' },
      },
    );
    const applied = report.applied as Record<string, Record<string, unknown>>;
    expect(applied.testing?.framework).toBe('vitest');
    expect(applied.testing?.command).toBe('pnpm test');
    expect(applied.build?.command).toBe('pnpm build');
  });

  // -------------------------------------------------------------------------
  // Report shape
  // -------------------------------------------------------------------------

  it('report contains filename, localGenerated, imported, classifications, applied', () => {
    const local = { brain: { x: 1 } };
    const imported = { brain: { x: 2 } };
    const report = compareConfig(local, imported);
    expect(report.filename).toBe('config.json');
    expect(report.localGenerated).toEqual(local);
    expect(report.imported).toEqual(imported);
    expect(Array.isArray(report.classifications)).toBe(true);
    expect(report.applied).toBeDefined();
    expect(typeof report.conflictCount).toBe('number');
  });

  it('report for project-info.json has correct filename', () => {
    const report = compareInfo({ name: 'a' }, { name: 'b' });
    expect(report.filename).toBe('project-info.json');
  });

  it('report for project-context.json has correct filename', () => {
    const report = compareContext(
      { testing: { framework: 'vitest' } },
      { testing: { framework: 'jest' } },
    );
    expect(report.filename).toBe('project-context.json');
  });

  // -------------------------------------------------------------------------
  // Spec §8.3 scenarios
  // -------------------------------------------------------------------------

  it('§8.3: config.json user-intent brain.embeddingProvider — keeps B, in resolved section', () => {
    const report = compareConfig(
      { brain: { embeddingProvider: 'local' } },
      { brain: { embeddingProvider: 'openai' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'brain.embeddingProvider');
    expect(c?.category).toBe('user-intent');
    expect(c?.resolution).toBe('B');
    expect(report.conflictCount).toBe(0);
  });

  it('§8.3: project-info.json machine-local projectRoot — keeps A', () => {
    const report = compareInfo({ projectRoot: '/local' }, { projectRoot: '/source' });
    const c = report.classifications.find((cl) => cl.path === 'projectRoot');
    expect(c?.category).toBe('machine-local');
    expect(c?.resolution).toBe('A');
  });

  it('§8.3: project-info.json project-identity name — keeps B', () => {
    const report = compareInfo({ name: 'local' }, { name: 'imported' });
    const c = report.classifications.find((cl) => cl.path === 'name');
    expect(c?.category).toBe('project-identity');
    expect(c?.resolution).toBe('B');
  });

  it('§8.3: project-context.json auto-detect testing.framework identical — no conflict', () => {
    const report = compareContext(
      { testing: { framework: 'vitest' } },
      { testing: { framework: 'vitest' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'testing.framework');
    expect(c?.category).toBe('identical');
    expect(report.conflictCount).toBe(0);
  });

  it('§8.3: project-context.json auto-detect build.command differs — keeps A', () => {
    const report = compareContext(
      { build: { command: 'pnpm build' } },
      { build: { command: 'npm run build' } },
    );
    const c = report.classifications.find((cl) => cl.path === 'build.command');
    expect(c?.category).toBe('auto-detect');
    expect(c?.resolution).toBe('A');
    expect((report.applied as Record<string, Record<string, unknown>>).build?.command).toBe(
      'pnpm build',
    );
  });

  it('§8.3: config.json unknown field present only in B — manual-review, A used as default', () => {
    const report = compareConfig({}, { strangeThing: 'value' });
    const c = report.classifications.find((cl) => cl.path === 'strangeThing');
    expect(c?.category).toBe('unknown');
    expect(c?.resolution).toBe('manual-review');
    // applied should keep A (undefined → absent) as safe default
    expect((report.applied as Record<string, unknown>).strangeThing).toBeUndefined();
  });

  it('§8.3: all fields identical across all three files — zero conflicts', () => {
    const configReport = compareConfig({ brain: { x: 1 } }, { brain: { x: 1 } });
    const infoReport = compareInfo({ name: 'proj' }, { name: 'proj' });
    const ctxReport = compareContext(
      { testing: { framework: 'vitest' } },
      { testing: { framework: 'vitest' } },
    );
    expect(configReport.conflictCount).toBe(0);
    expect(infoReport.conflictCount).toBe(0);
    expect(ctxReport.conflictCount).toBe(0);
  });
});
