/**
 * Template registry — SSoT lookup surface over
 * {@link ./manifest-data.ts | TEMPLATE_MANIFEST_ENTRIES}.
 *
 * Replaces the scattered per-domain resolvers
 * (`getCleoTemplatesDir`, `getWorkflowTemplatesDir`, `resolveAgentTemplates`)
 * with a single typed registry consumers can query by id, kind, or installed
 * status. The legacy resolvers remain in place as `@deprecated` shims; T9879
 * rewires their last callers and removes them.
 *
 * The registry performs a fail-fast existence check at module load:
 * every entry's `sourcePath` must resolve to a real file in the monorepo
 * checkout. If any one is missing the registry throws synchronously, which
 * fails the dev build and CI immediately — preventing a class of "template
 * silently vanished" regressions. The check is skipped when the registry
 * runs from a published npm install (no `pnpm-workspace.yaml` reachable),
 * since the file layout there is flat and only a subset of templates ship.
 *
 * @task T9877
 * @epic T9874
 * @saga T9855
 */

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TemplateKind, TemplateManifestEntry } from '@cleocode/contracts';
import { TEMPLATE_MANIFEST_ENTRIES } from './manifest-data.js';

/**
 * Climb from this file towards the filesystem root until a directory
 * containing `pnpm-workspace.yaml` is found — that directory is the
 * monorepo root used to resolve every entry's repo-relative `sourcePath`.
 *
 * @returns Absolute path to the monorepo root, or `null` when not in a
 *   monorepo checkout (e.g. running from a published npm install).
 */
function findMonorepoRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  const root = resolve('/');
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || parent === root) {
      return null;
    }
    dir = parent;
  }
  return null;
}

/**
 * Validate that every manifest entry's `sourcePath` exists on disk. Runs
 * once, at module load, when a monorepo checkout is detected. Throws
 * synchronously on the first missing file.
 *
 * @throws When any entry's `sourcePath` is not found under the monorepo root.
 */
function assertSourcePathsExist(): void {
  const monorepoRoot = findMonorepoRoot();
  if (monorepoRoot === null) {
    // Published npm install layout — skip the dev/CI guard.
    return;
  }
  for (const entry of TEMPLATE_MANIFEST_ENTRIES) {
    const absolute = join(monorepoRoot, entry.sourcePath);
    if (!existsSync(absolute)) {
      throw new Error(`TemplateManifest: missing sourcePath: ${entry.sourcePath}`);
    }
  }
}

try {
  assertSourcePathsExist();
} catch (err) {
  // Re-throw so the module is unusable when the registry is inconsistent.
  // Wrapped in a try purely to give a clear stack origin for the failure.
  throw err instanceof Error ? err : new Error(String(err));
}

/**
 * Return the immutable list of every template entry CLEO ships.
 *
 * @returns Frozen array of {@link TemplateManifestEntry}.
 */
export function getTemplateManifest(): readonly TemplateManifestEntry[] {
  return TEMPLATE_MANIFEST_ENTRIES;
}

/**
 * Look up a single template entry by its stable `id`.
 *
 * @param id - Kebab-case identifier declared in
 *   {@link ./manifest-data.ts | TEMPLATE_MANIFEST_ENTRIES}.
 * @returns The matching entry, or `undefined` when no entry has that id.
 */
export function getTemplateById(id: string): TemplateManifestEntry | undefined {
  return TEMPLATE_MANIFEST_ENTRIES.find((entry) => entry.id === id);
}

/**
 * Return every template entry of the given `kind`.
 *
 * @param kind - Category discriminator from `@cleocode/contracts`.
 * @returns Frozen array of matching entries (empty when none registered).
 */
export function getTemplatesByKind(kind: TemplateKind): readonly TemplateManifestEntry[] {
  return TEMPLATE_MANIFEST_ENTRIES.filter((entry) => entry.kind === kind);
}

/**
 * Result of an {@link getInstalledStatus} probe — the absolute path the
 * registry resolved and whether the file currently exists there.
 */
export interface InstalledStatus {
  /** `true` when `path` exists on disk. */
  installed: boolean;
  /** Absolute path the registry computed for the install target. */
  path: string;
}

/**
 * Probe whether a template's `installPath` currently exists under
 * `projectRoot`. The probe is a simple `fs.existsSync` — content is NOT
 * compared and an existing file at the path is considered "installed"
 * regardless of whether it was written by CLEO.
 *
 * @param id - Template id from {@link getTemplateById}.
 * @param projectRoot - Absolute path to the project root to probe.
 * @returns Status with the resolved path and the existence flag.
 *
 * @throws When `id` is not a registered template entry, or `projectRoot`
 *   is not an absolute path.
 */
export function getInstalledStatus(id: string, projectRoot: string): InstalledStatus {
  if (!isAbsolute(projectRoot)) {
    throw new Error(`getInstalledStatus: projectRoot must be absolute (got "${projectRoot}")`);
  }
  const entry = getTemplateById(id);
  if (entry === undefined) {
    throw new Error(`getInstalledStatus: unknown template id "${id}"`);
  }
  const path = join(projectRoot, entry.installPath);
  return { installed: existsSync(path), path };
}
