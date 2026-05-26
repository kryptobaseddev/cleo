/**
 * Architecture tests for PM-Core V2 hierarchy traversal ownership.
 *
 * T10585: hierarchy traversal must be owned by the core WorkGraph path. These
 * tests are intentionally static so new direct SQL walkers or legacy
 * task_relations.groups hierarchy shortcuts fail before they ship.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Repository root resolved from this test file. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Production roots that may accidentally grow task hierarchy traversal. */
const PRODUCTION_ROOTS = ['packages/core/src', 'packages/cleo/src', 'packages/studio/src'] as const;

/** Public WorkGraph boundary files that must stay storage- and CLI-agnostic. */
const WORKGRAPH_PUBLIC_BOUNDARY_FILES = [
  'packages/contracts/src/workgraph.ts',
  'packages/core/src/workgraph/index.ts',
] as const;

/** Core modules allowed to own physical hierarchy reads until WorkGraph is the sole facade. */
const CORE_HIERARCHY_STORAGE_OWNERS = new Set([
  'packages/core/src/store/tasks-sqlite.ts',
  'packages/core/src/store/sqlite-data-accessor.ts',
  'packages/core/src/store/umbrella-data-accessor.ts',
  'packages/core/src/store/safety-data-accessor.ts',
  'packages/core/src/tasks/hierarchy.ts',
  'packages/core/src/tasks/task-tree.ts',
  'packages/core/src/tasks/generic-tree.ts',
  'packages/core/src/tasks/graph-cache.ts',
  'packages/core/src/workgraph/containment.ts',
]);

/** Legacy saga relation modules may mention groups, but not as hierarchy storage. */
const LEGACY_GROUP_RELATION_OWNERS = new Set([
  'packages/core/src/sagas/add.ts',
  'packages/core/src/sagas/constants.ts',
  'packages/core/src/sagas/detach.ts',
  'packages/core/src/sagas/enforcement.ts',
  'packages/core/src/sagas/list.ts',
  'packages/core/src/sagas/members.ts',
  'packages/core/src/sagas/reconcile.ts',
  'packages/core/src/sagas/repair.ts',
  'packages/core/src/sagas/storage.ts',
  'packages/core/src/doctor/saga-audit.ts',
  // CLI command files are presentation facades that mention legacy groups in
  // help text while dispatching to core saga operations for behavior.
  'packages/cleo/src/cli/commands/find.ts',
  'packages/cleo/src/cli/commands/orchestrate.ts',
  'packages/cleo/src/cli/commands/release.ts',
  'packages/cleo/src/cli/commands/saga.ts',
]);

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

function walkTsFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === 'coverage') {
        continue;
      }
      files.push(...walkTsFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(absolutePath);
    }
  }

  return files;
}

function productionFiles(): SourceFile[] {
  return PRODUCTION_ROOTS.flatMap((root) => walkTsFiles(resolve(REPO_ROOT, root)))
    .map((absolutePath) => ({
      path: relative(REPO_ROOT, absolutePath),
      text: readFileSync(absolutePath, 'utf8'),
    }))
    .filter((file) => !isTestOrFixture(file.path));
}

function isTestOrFixture(path: string): boolean {
  return (
    path.includes('/__tests__/') ||
    path.includes('/test/') ||
    path.includes('/tests/') ||
    path.includes('/fixtures/') ||
    path.endsWith('.test.ts')
  );
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function hasTaskHierarchyRecursiveSql(text: string): boolean {
  const source = stripComments(text).toLowerCase();
  return (
    source.includes('with recursive') &&
    source.includes('tasks') &&
    (source.includes('parent_id') || source.includes('parentid'))
  );
}

function hasLegacyGroupsHierarchyTraversal(text: string): boolean {
  const source = stripComments(text).toLowerCase();
  const mentionsLegacyGroups = source.includes('task_relations') && source.includes('groups');
  const readsRelationRows = /\b(select|join|from|where|getrelations|listrelations)\b/.test(source);
  const mentionsTraversal =
    /\b(child|children|parent|ancestor|descendant|hierarchy|tree|traversal|walk|rollup)\b/.test(
      source,
    );
  return mentionsLegacyGroups && readsRelationRows && mentionsTraversal;
}

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function publicBoundaryImports(text: string): string[] {
  return Array.from(
    text.matchAll(/^import\s+(?:type\s+)?(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"];?/gm),
  ).map((match) => match[1] ?? '');
}

describe('PM-Core V2 WorkGraph architecture', () => {
  it('exposes WorkGraph public types from contracts and core without exposing storage', () => {
    const missingFiles = WORKGRAPH_PUBLIC_BOUNDARY_FILES.filter(
      (path) => !existsSync(resolve(REPO_ROOT, path)),
    );
    expect(missingFiles).toEqual([]);

    const contractsIndex = readRepoFile('packages/contracts/src/index.ts');
    const coreIndex = readRepoFile('packages/core/src/index.ts');
    const corePackageJson = readRepoFile('packages/core/package.json');
    const coreBoundary = readRepoFile('packages/core/src/workgraph/index.ts');

    expect(contractsIndex).toContain("from './workgraph.js'");
    expect(coreIndex).toContain("export * as workGraph from './workgraph/index.js'");
    expect(corePackageJson).toContain('"./workgraph"');
    expect(coreBoundary).toContain("from '@cleocode/contracts'");

    const forbiddenImports = publicBoundaryImports(coreBoundary).filter(
      (specifier) =>
        specifier.includes('/store') ||
        specifier.startsWith('../store') ||
        specifier.includes('/cleo') ||
        specifier.startsWith('@cleocode/cleo'),
    );
    expect(forbiddenImports).toEqual([]);
  });

  it('keeps recursive task hierarchy SQL inside core-owned storage/traversal modules', () => {
    const offenders = productionFiles()
      .filter((file) => hasTaskHierarchyRecursiveSql(file.text))
      .map((file) => file.path)
      .filter((path) => !CORE_HIERARCHY_STORAGE_OWNERS.has(path));

    expect(offenders).toEqual([]);
  });

  it('forbids legacy task_relations.groups from being used as a hierarchy traversal source', () => {
    const offenders = productionFiles()
      .filter((file) => hasLegacyGroupsHierarchyTraversal(file.text))
      .map((file) => file.path)
      .filter((path) => !LEGACY_GROUP_RELATION_OWNERS.has(path));

    expect(offenders).toEqual([]);
  });

  it('ignores legacy groups fixtures while still catching production traversal shortcuts', () => {
    expect(isTestOrFixture('packages/core/src/sagas/__tests__/legacy-groups.fixture.test.ts')).toBe(
      true,
    );
    expect(isTestOrFixture('packages/core/src/sagas/storage.ts')).toBe(false);

    expect(
      hasLegacyGroupsHierarchyTraversal(`
        SELECT child.*
        FROM task_relations tr
        JOIN tasks child ON child.id = tr.to_id
        WHERE tr.type = 'groups'
      `),
    ).toBe(true);
  });
});
