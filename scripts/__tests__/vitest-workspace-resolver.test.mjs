/** Regression coverage for source resolution in unbuilt workspace packages. */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleoWorkspaceSubpathAliases,
  resolveWorkspaceSource,
} from '../../vitest-workspace-resolver.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const packages = new Set(['core', 'contracts', 'nexus', 'lafs', 'git-shim']);

describe('resolveWorkspaceSource', () => {
  it.each([
    ['@cleocode/nexus/reference-spool', 'nexus/src/pipeline/reference-spool.ts'],
    ['@cleocode/nexus/pipeline', 'nexus/src/pipeline/index.ts'],
    ['@cleocode/core/sdk', 'core/src/cleo.ts'],
    ['@cleocode/lafs/a2a/bindings', 'lafs/src/a2a/bindings/index.ts'],
    ['@cleocode/contracts/config.js', 'contracts/src/config/index.ts'],
    ['@cleocode/contracts/memory/observe.js', 'contracts/src/memory/observe.ts'],
    ['@cleocode/core', 'core/src/index.ts'],
    ['@cleocode/git-shim', 'git-shim/src/index.ts'],
  ])('follows the export target for %s', (specifier, source) => {
    expect(resolveWorkspaceSource(specifier, packages)).toBe(resolve(ROOT, 'packages', source));
  });

  it('retains source-file and directory fallbacks for internal imports', () => {
    expect(resolveWorkspaceSource('@cleocode/core/store/sqlite.js', packages)).toBe(
      resolve(ROOT, 'packages/core/src/store/sqlite.ts'),
    );
    expect(resolveWorkspaceSource('@cleocode/core/tasks', packages)).toBe(
      resolve(ROOT, 'packages/core/src/tasks/index.ts'),
    );
  });

  it.each([
    '@cleocode/not-a-workspace/file',
    '@cleocode/nexus/missing',
    '@cleocode/nexus/../package.json',
    '@cleocode/nexus/../../core/src/index',
  ])('leaves %s to default resolution', (specifier) => {
    expect(resolveWorkspaceSource(specifier, packages)).toBeNull();
  });

  it('uses exported source targets through the shared alias entry', () => {
    const [alias] = cleoWorkspaceSubpathAliases();
    expect(alias.customResolver('@cleocode/nexus/reference-spool')).toBe(
      resolve(ROOT, 'packages/nexus/src/pipeline/reference-spool.ts'),
    );
  });
});
