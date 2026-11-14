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
import { parseAdrFile } from './parse.js';
import type { AdrRecord } from './types.js';

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

/** One ADR in the ADR home with an id that is unique across the home. */
export interface ResolvedAdr {
  /** The file. */
  readonly file: AdrFile;
  /** Lowercase file stem, e.g. `adr-086-cli-output-contract-e9`. */
  readonly slug: string;
  /** Parsed record; `record.id` is unique (see {@link loadAdrs}). */
  readonly record: AdrRecord;
}

/** Status preference when several ADRs share a number: the live decision wins. */
const STATUS_RANK: Readonly<Record<string, number>> = {
  accepted: 0,
  proposed: 1,
  deprecated: 3,
  superseded: 4,
};

function statusRank(record: AdrRecord, slug: string): number {
  // An amendment never takes its parent's number from a decision of the same status.
  const amendment = slug.includes('-amendment-') ? 0.5 : 0;
  if (record.frontmatter['Superseded By']) return STATUS_RANK.superseded! + amendment;
  const word =
    (record.frontmatter.Status ?? '')
      .trim()
      .split(/[\s—–-]/)[0]
      ?.toLowerCase() ?? '';
  return (STATUS_RANK[word] ?? 2) + amendment;
}

/**
 * Parse every ADR in the ADR home and give each one an id unique across the
 * home. ADR numbers are display aliases and several ADRs share one (ADR-090:
 * the slug is the handle). For each number the preferred ADR (accepted, then
 * proposed, then undeclared, deprecated, superseded; an amendment after a
 * decision of the same status; ties by file name) keeps
 * the id `ADR-NNN`; every other ADR with that number is keyed by its slug, so
 * no ADR overwrites another in `architecture_decisions` (T14108).
 *
 * @param projectRoot - Absolute project root.
 * @returns ADRs in file-name order.
 */
export function loadAdrs(projectRoot: string): ResolvedAdr[] {
  const parsed = listAdrFiles(projectRoot).map((file) => ({
    file,
    slug: file.name.replace(/\.md$/i, '').toLowerCase(),
    record: parseAdrFile(file.absPath, projectRoot),
  }));
  const primary = new Map<string, (typeof parsed)[number]>();
  for (const adr of parsed) {
    const current = primary.get(adr.record.id);
    if (!current || statusRank(adr.record, adr.slug) < statusRank(current.record, current.slug)) {
      primary.set(adr.record.id, adr);
    }
  }
  return parsed.map((adr) =>
    primary.get(adr.record.id) === adr ? adr : { ...adr, record: { ...adr.record, id: adr.slug } },
  );
}

/**
 * Resolve an ADR reference such as `ADR-086 (\`adr-086-cli-output-contract-e9\`)`
 * or `adr-024-multi-store-canonical-logging.md` to a {@link loadAdrs} id: an
 * ADR slug in the reference wins, else its `ADR-NNN` number.
 *
 * @param ref - Frontmatter value or link text.
 * @param adrs - Result of {@link loadAdrs}.
 * @returns The id, or null when the reference names no ADR in the home.
 */
export function resolveAdrRef(ref: string, adrs: readonly ResolvedAdr[]): string | null {
  for (const token of ref.toLowerCase().match(/adr-\d+(?:-[a-z0-9]+)*/g) ?? []) {
    const bySlug = adrs.find((adr) => adr.slug === token);
    if (bySlug) return bySlug.record.id;
  }
  const number = ref.match(/adr-(\d+)/i)?.[1];
  if (!number) return null;
  const id = `ADR-${number}`;
  return adrs.some((adr) => adr.record.id === id) ? id : null;
}
