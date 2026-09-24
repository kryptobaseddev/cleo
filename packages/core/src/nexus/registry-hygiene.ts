/**
 * Registry hygiene primitives shared by encounter registration, the registry
 * row mapper, and `cleo nexus projects clean`.
 *
 * Two facts live here so every caller agrees on them:
 *
 * 1. **Which paths are ephemeral.** A project under the OS temp directory (or
 *    `/tmp`, `/var/tmp`) is a fixture, a scratchpad, or a one-off experiment.
 *    Auto-registering it into a persistent global registry is how the owner's
 *    registry reached 1,137 rows of which ~1,096 were test/temp directories.
 * 2. **Where a registered project's live store is.** Post-E6 (ADR-068) every
 *    project domain lives in `<root>/.cleo/cleo.db`; the registry's
 *    `tasks_db_path` / `brain_db_path` columns kept naming the pre-migration
 *    `tasks.db` / `brain.db` files, which are empty relics in a migrated
 *    project.
 *
 * @task T12324
 */

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

/** File name of the consolidated project store (ADR-068). */
const PROJECT_STORE_FILENAME = 'cleo.db';

/** Pre-migration per-domain store file names the registry used to record. */
const LEGACY_STORE_FILENAMES: ReadonlySet<string> = new Set(['tasks.db', 'brain.db']);

/** Absolute and, where resolvable, physical forms of a path. */
function pathForms(p: string): string[] {
  const forms = new Set<string>([resolve(p)]);
  try {
    forms.add(realpathSync(p));
  } catch {
    // Missing paths keep only their lexical form.
  }
  return [...forms];
}

/**
 * Return the directories whose descendants are treated as ephemeral: the OS
 * temp directory plus, off Windows, `/tmp` and `/var/tmp`. Filesystem roots are
 * never returned, so a misconfigured `TMPDIR=/` cannot classify everything.
 *
 * @returns Absolute lexical and physical forms of each temp root.
 */
export function getEphemeralRoots(): string[] {
  const candidates = [tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])];
  const roots = new Set<string>();
  for (const candidate of candidates) {
    for (const form of pathForms(candidate)) {
      if (parse(form).root !== form) roots.add(form);
    }
  }
  return [...roots];
}

/**
 * Report whether `p` is (or lies under) an ephemeral temp root.
 *
 * @param p - Path to classify; need not exist.
 * @returns `true` when any form of `p` is inside a root from {@link getEphemeralRoots}.
 * @example
 * ```ts
 * isEphemeralPath(join(tmpdir(), 'fixture')); // true
 * ```
 */
export function isEphemeralPath(p: string): boolean {
  const roots = getEphemeralRoots();
  return pathForms(p).some((form) =>
    roots.some((root) => form === root || form.startsWith(root.endsWith(sep) ? root : root + sep)),
  );
}

/**
 * Decide whether encountering `projectRoot` may auto-register it into the
 * registry homed at `cleoHome`.
 *
 * An ephemeral project is refused only when the registry is persistent: a
 * sandboxed test run (temp `CLEO_HOME`) still registers its temp fixtures, but
 * a scratch directory never lands in the owner's real registry. Explicit
 * `cleo nexus register` is unaffected.
 *
 * @param projectRoot - Encountered project root.
 * @param cleoHome - Global home that owns the target registry.
 * @returns `true` when encounter registration should proceed.
 */
export function shouldAutoRegisterProject(projectRoot: string, cleoHome: string): boolean {
  return !isEphemeralPath(projectRoot) || isEphemeralPath(cleoHome);
}

/**
 * Return the live consolidated store path for a registered project root.
 *
 * @param projectRoot - Absolute project root recorded in the registry.
 * @returns `<projectRoot>/.cleo/cleo.db`.
 */
export function registryStorePath(projectRoot: string): string {
  return join(projectRoot, '.cleo', PROJECT_STORE_FILENAME);
}

/**
 * Map a stored `tasks_db_path` / `brain_db_path` value to the live store.
 *
 * Rows written before T12324 name `.cleo/tasks.db` or `.cleo/brain.db`; those
 * are rewritten to the sibling `.cleo/cleo.db`. Any other value (including
 * `null`) is returned unchanged so a deliberate override is never hidden.
 *
 * @param stored - Value read from the registry row.
 * @returns The live store path, or `stored` when it is not a legacy path.
 */
export function normalizeRegistryStorePath(stored: string | null): string | null {
  if (stored === null) return null;
  const dir = dirname(stored);
  if (basename(dir) === '.cleo' && LEGACY_STORE_FILENAMES.has(basename(stored))) {
    return join(dir, PROJECT_STORE_FILENAME);
  }
  return stored;
}
