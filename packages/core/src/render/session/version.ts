/**
 * Human renderer for `cleo version`.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6).
 *
 * @task T4666
 * @task T10131
 */

export function renderVersion(data: Record<string, unknown>, quiet: boolean): string {
  const version = data['version'] as string | undefined;
  if (quiet) return version ?? '';
  return `Cleo v${version}`;
}
