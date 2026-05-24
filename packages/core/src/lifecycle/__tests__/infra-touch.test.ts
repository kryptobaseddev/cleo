/**
 * Tests for IVTR Lead R2 blast-radius infrastructure-touch detection.
 *
 * @task T9842
 */

import { describe, expect, it } from 'vitest';
import {
  buildBlastRadiusTestScopeSection,
  detectInfrastructureTouch,
  INFRASTRUCTURE_BASENAME_SUBSTRINGS,
  INFRASTRUCTURE_PATH_PATTERNS,
} from '../infra-touch.js';

describe('detectInfrastructureTouch', () => {
  it('returns affected=false for null / undefined / empty', () => {
    expect(detectInfrastructureTouch(undefined).affected).toBe(false);
    expect(detectInfrastructureTouch(null).affected).toBe(false);
    expect(detectInfrastructureTouch([]).affected).toBe(false);
  });

  it('returns affected=false for non-infrastructure paths', () => {
    const result = detectInfrastructureTouch([
      'packages/cleo/src/cli/commands/show.ts',
      'packages/cleo/src/cli/commands/list.ts',
      'docs/release/branch-protection-setup.md',
    ]);
    expect(result.affected).toBe(false);
    expect(result.matchedPaths).toEqual([]);
    expect(result.packages).toEqual([]);
  });

  it('detects packages/core/src/store/** as infrastructure', () => {
    const result = detectInfrastructureTouch([
      'packages/core/src/store/sqlite-data-accessor.ts',
      'packages/core/src/store/open-cleo-db.ts',
    ]);
    expect(result.affected).toBe(true);
    expect(result.matchedPaths).toHaveLength(2);
    expect(result.packages).toEqual(['core']);
  });

  it('detects packages/contracts/src/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/contracts/src/envelope.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['contracts']);
  });

  it('detects packages/core/src/orchestration/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/core/src/orchestration/spawn-prompt.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['core']);
  });

  it('detects packages/core/src/dispatch/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/core/src/dispatch/router.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['core']);
  });

  it('detects packages/cleo/src/dispatch/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/cleo/src/dispatch/domains/ivtr.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['cleo']);
  });

  it('detects packages/worktree/src/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/worktree/src/worktree-create.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['worktree']);
  });

  it('detects packages/core/src/migration/** as infrastructure', () => {
    const result = detectInfrastructureTouch(['packages/core/src/migration/m0001-init.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['core']);
  });

  it('detects "transaction" substring in basename even outside canonical dirs', () => {
    const result = detectInfrastructureTouch(['packages/brain/src/some-transaction-helper.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['brain']);
  });

  it('detects "pragma" substring in basename', () => {
    const result = detectInfrastructureTouch(['packages/agents/src/sqlite-pragmas.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['agents']);
  });

  it('detects "migration" substring in basename', () => {
    const result = detectInfrastructureTouch([
      'packages/studio/src/lib/server/db/migration-runner.ts',
    ]);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['studio']);
  });

  it('returns alphabetically-sorted unique packages on mixed input', () => {
    const result = detectInfrastructureTouch([
      'packages/worktree/src/worktree-create.ts',
      'packages/contracts/src/envelope.ts',
      'packages/core/src/store/sqlite.ts',
      'packages/contracts/src/operations.ts', // duplicate package
      'packages/cleo/src/cli/commands/show.ts', // NOT infra — filtered
    ]);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['contracts', 'core', 'worktree']);
  });

  it('preserves matchedPaths order from input', () => {
    const result = detectInfrastructureTouch([
      'packages/cleo/src/cli/commands/list.ts', // NOT infra
      'packages/core/src/store/sqlite.ts', // infra (index 1)
      'docs/release/x.md', // NOT infra
      'packages/contracts/src/envelope.ts', // infra (index 3)
    ]);
    expect(result.matchedPaths).toEqual([
      'packages/core/src/store/sqlite.ts',
      'packages/contracts/src/envelope.ts',
    ]);
  });

  it('normalizes windows backslashes', () => {
    const result = detectInfrastructureTouch(['packages\\core\\src\\store\\sqlite.ts']);
    expect(result.affected).toBe(true);
    expect(result.packages).toEqual(['core']);
  });

  it('handles non-string / empty entries defensively', () => {
    const result = detectInfrastructureTouch([
      '',
      'packages/core/src/store/sqlite.ts',
      // @ts-expect-error — intentionally bad input
      null,
      // @ts-expect-error — intentionally bad input
      123,
    ]);
    expect(result.affected).toBe(true);
    expect(result.matchedPaths).toEqual(['packages/core/src/store/sqlite.ts']);
  });

  it('the canonical pattern constants are non-empty (registry sanity)', () => {
    expect(INFRASTRUCTURE_PATH_PATTERNS.length).toBeGreaterThan(0);
    expect(INFRASTRUCTURE_BASENAME_SUBSTRINGS.length).toBeGreaterThan(0);
    // T9842 precedent — store/ is the path that broke T9814's IVTR review
    expect(INFRASTRUCTURE_PATH_PATTERNS).toContain('packages/core/src/store/');
  });
});

describe('buildBlastRadiusTestScopeSection', () => {
  it('returns empty string when not affected', () => {
    expect(
      buildBlastRadiusTestScopeSection({ affected: false, matchedPaths: [], packages: [] }),
    ).toBe('');
  });

  it('renders Blast-Radius header + T9842/T9814 citations + per-pkg commands', () => {
    const section = buildBlastRadiusTestScopeSection({
      affected: true,
      matchedPaths: ['packages/core/src/store/sqlite-data-accessor.ts'],
      packages: ['core'],
    });
    expect(section).toContain('Blast-Radius Test Scope');
    expect(section).toContain('MANDATORY');
    expect(section).toContain('T9842');
    expect(section).toContain('T9814');
    expect(section).toContain('agent-resolver');
    expect(section).toContain('pnpm --filter @cleocode/core run test');
    expect(section).toContain('packages/core/src/store/sqlite-data-accessor.ts');
    expect(section).toContain('infra-test-scope-violation');
  });

  it('falls back to `pnpm run test` when affected but no package can be derived', () => {
    // e.g. only a basename match like `Cargo.lock` won't yield a package dir.
    const section = buildBlastRadiusTestScopeSection({
      affected: true,
      matchedPaths: ['some/odd/transaction.toml'],
      packages: [],
    });
    expect(section).toContain('pnpm run test');
    // Must not emit per-pkg commands for empty package list.
    expect(section).not.toMatch(/pnpm --filter @cleocode\/[^ \n]+ run test/);
  });

  it('emits N pnpm --filter commands when N packages are touched', () => {
    const section = buildBlastRadiusTestScopeSection({
      affected: true,
      matchedPaths: [
        'packages/core/src/store/x.ts',
        'packages/contracts/src/y.ts',
        'packages/worktree/src/z.ts',
      ],
      packages: ['contracts', 'core', 'worktree'],
    });
    expect(section).toContain('pnpm --filter @cleocode/contracts run test');
    expect(section).toContain('pnpm --filter @cleocode/core run test');
    expect(section).toContain('pnpm --filter @cleocode/worktree run test');
  });
});
