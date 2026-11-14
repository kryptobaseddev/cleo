/**
 * ADR home resolution (T14108).
 *
 * ADRs live in the CLEO docs store; their human-readable mirror is the
 * `publishMirror` of the `adr` kind in `.cleo/canon.yml` (`docs/adr/`), which
 * `cleo docs publish` generates from the store. The legacy `.cleo/adrs/`
 * mirror is retired. Every `cleo adr` operation reads ADR files through
 * {@link listAdrFiles}, so the home is resolved in one place.
 *
 * @task T14108
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCanonRegistry } from '../session/canon-lint.js';

/** Project-relative ADR mirror used when `.cleo/canon.yml` declares none. */
export const DEFAULT_ADR_HOME = 'docs/adr';

/** An ADR file name: `ADR-NNN-…md` or `adr-NNN-…md`. */
const ADR_FILE = /^adr-\d+.*\.md$/i;

/** One ADR markdown file in the ADR home. */
export interface AdrFile {
  /** File name, e.g. `adr-051-programmatic-gate-integrity.md`. */
  readonly name: string;
  /** Absolute path. */
  readonly absPath: string;
  /** Project-relative path with `/` separators, e.g. `docs/adr/adr-051-….md`. */
  readonly relPath: string;
}

/**
 * Resolve the project-relative ADR home: the `adr` kind's `publishMirror`
 * from `.cleo/canon.yml`, else {@link DEFAULT_ADR_HOME}.
 *
 * @param projectRoot - Absolute project root.
 * @returns The ADR home without a trailing slash, e.g. `docs/adr`.
 * @throws Error when `.cleo/canon.yml` exists but is malformed.
 */
export function resolveAdrHome(projectRoot: string): string {
  const mirror = loadCanonRegistry(projectRoot)?.kinds.adr?.publishMirror;
  return (mirror ?? DEFAULT_ADR_HOME).replace(/\/+$/, '');
}

/**
 * List the ADR markdown files directly inside the ADR home, sorted by name
 * (case-insensitively, so `ADR-051` and `adr-052` sort by number).
 * Returns an empty list when the home does not exist.
 *
 * @param projectRoot - Absolute project root.
 * @returns ADR files in name order.
 */
export function listAdrFiles(projectRoot: string): AdrFile[] {
  const home = resolveAdrHome(projectRoot);
  const dir = join(projectRoot, home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ADR_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
    .map((name) => ({ name, absPath: join(dir, name), relPath: `${home}/${name}` }));
}
