/**
 * Repo-guard tests (T13142): tests that live in one package but read another
 * package's files, or scan the whole tree, without a workspace dependency on
 * what they read. Package-level affected selection cannot see that edge, so a
 * pull request that changed only the package they read would skip them.
 *
 * They run in the package-less `repo-guards` vitest project declared in the
 * root `vitest.config.ts`, which PR CI's affected selection always runs (a
 * project that covers no package is always appended, like `scripts`), and
 * their home projects exclude them, so a full run does not run them twice.
 *
 * Paths are repo-relative. Add a test here when it reads another package's
 * tree; T13157 tracks a lint that finds such reads.
 */
export const REPO_GUARD_TESTS: readonly string[] = [
  // Globs packages/*/src/**/*.ts for raw SQLite pragmas.
  'packages/core/src/__tests__/pragma-drift-guard.test.ts',
  // Scans packages/core/src, packages/cleo/src and packages/studio/src.
  'packages/core/src/tasks/__tests__/workgraph-architecture.test.ts',
  // Reads the real packages/playbooks/starter tree.
  'packages/core/src/playbooks/__tests__/playbook-resolver.test.ts',
  // Reads packages/core/templates/workflows.
  'packages/contracts/src/operations/__tests__/release-shared-surface.test.ts',
  // Reads packages/core/templates/CLEO-INJECTION.md and CLEO-REFERENCE.md.
  'packages/skills/skills/ct-cleo/__tests__/injection-content.test.ts',
  // Not here while quarantined (packages/cleo/vitest.quarantine.ts, T12072):
  // packages/cleo/src/dispatch/__tests__/transport-inventory.test.ts, which
  // checks the repo's package topology. Add it when it leaves quarantine.
];

/**
 * The repo-guard tests under a project root, relative to it, for that
 * project's `exclude`.
 *
 * @param root - The project root, repo-relative with a trailing slash (`packages/core/`),
 *   or `''` for a project rooted at the repo.
 * @returns The paths to exclude.
 */
export function repoGuardsUnder(root: string): string[] {
  return REPO_GUARD_TESTS.filter((p) => p.startsWith(root)).map((p) => p.slice(root.length));
}
