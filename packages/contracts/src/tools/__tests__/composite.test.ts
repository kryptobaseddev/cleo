/**
 * Contract-shape tests for the composite meta-tool contracts (T11484).
 *
 * The RUNTIME for `module-relocation` / `add-workspace-package` is deferred to
 * epic T11456 (the TOOLS canonical structure that supplies their correct home,
 * category enum, descriptor schema, and registry — see composite.ts header).
 * These tests lock the CONTRACT surface that ships now: the breakage-class and
 * wiring-point SoT arrays, and that the input/result shapes are constructible.
 *
 * @epic T11480
 * @task T11484
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  ADD_WORKSPACE_PACKAGE_WIRING_POINTS,
  type AddWorkspacePackageInput,
  type AddWorkspacePackageResult,
  MODULE_RELOCATION_BREAKAGE_CLASSES,
  type ModuleRelocationInput,
  type ModuleRelocationResult,
} from '../composite.js';

describe('module-relocation contract (DHQ-032)', () => {
  it('enumerates exactly the seven breakage classes', () => {
    expect([...MODULE_RELOCATION_BREAKAGE_CLASSES]).toEqual([
      'relative-import-depth',
      'barrels',
      'js-form-and-dynamic-import',
      'mirror-test-dirs',
      'deprecations-yml',
      'doc-comments',
      'cross-package-importers',
    ]);
    expect(new Set(MODULE_RELOCATION_BREAKAGE_CLASSES).size).toBe(7);
  });

  it('has a constructible input + result shape', () => {
    const input: ModuleRelocationInput = {
      fromPath: 'packages/core/src/a.ts',
      toPath: 'packages/core/src/sub/a.ts',
      repoRoot: '/repo',
    };
    expect(input.fromPath).toBe('packages/core/src/a.ts');

    const result: ModuleRelocationResult = {
      toPath: input.toPath,
      shimLeft: false,
      dryRun: true,
      classes: [{ class: 'barrels', files: ['packages/core/src/index.ts'], edits: 1 }],
      filesTouched: ['packages/core/src/index.ts'],
    };
    expect(result.classes[0]?.class).toBe('barrels');
    expectTypeOf(result.classes).items.toHaveProperty('class');
  });
});

describe('add-workspace-package contract (DHQ-027)', () => {
  it('enumerates exactly the six wiring points', () => {
    expect([...ADD_WORKSPACE_PACKAGE_WIRING_POINTS]).toEqual([
      'deps',
      'tsconfig-refs',
      'build-mjs-buildpkg',
      'inline-maps',
      'boundary-entry',
      'private-no-readme',
    ]);
    expect(new Set(ADD_WORKSPACE_PACKAGE_WIRING_POINTS).size).toBe(6);
  });

  it('has a constructible input + result shape', () => {
    const input: AddWorkspacePackageInput = {
      packageName: '@cleocode/foo',
      repoRoot: '/repo',
      consumers: ['@cleocode/core'],
    };
    expect(input.packageName).toBe('@cleocode/foo');

    const result: AddWorkspacePackageResult = {
      packageName: input.packageName,
      packageDir: 'packages/foo',
      dryRun: true,
      points: [{ point: 'deps', files: ['packages/core/package.json'] }],
    };
    expect(result.points[0]?.point).toBe('deps');
    expectTypeOf(result.points).items.toHaveProperty('point');
  });
});
