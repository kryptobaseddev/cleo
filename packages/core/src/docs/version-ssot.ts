/**
 * T11181 — Version SSoT: canonical version identifiers.
 *
 * Single source of truth for doc version identifiers. Previously versions were
 * derived from counting JSONL audit log lines; now they are stored directly on
 * the attachments DB row as `owner_version` (CLEO release version) and
 * `doc_version` (sequential per-slug counter).
 *
 * @task T11181
 * @epic T10518
 * @saga T10516
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOrCwd } from '../paths.js';

/** Result of auditing version fields across the codebase. */
export interface VersionAuditResult {
  /** Whether the audit passed (all version fields consistent). */
  ok: boolean;
  /** List of findings from the audit. */
  findings: string[];
  /** Number of rows that have an owner_version mismatch. */
  mismatchedRows: number;
  /** Number of rows audited. */
  totalRows: number;
}

/** SQL migration statements for version SSoT initialization. */
export const VERSION_SSOT_MIGRATION_SQL = [
  'ALTER TABLE attachments ADD COLUMN owner_version TEXT;',
  'ALTER TABLE attachments ADD COLUMN doc_version INTEGER NOT NULL DEFAULT 1;',
].join('\n');

const CALVER_RE = /^v?(\d{4})\.(\d{1,2})\.(\d+)$/;

interface CalverParts {
  year: number;
  month: number;
  patch: number;
}

function parseCalver(v: string): CalverParts | null {
  const m = v.match(CALVER_RE);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Get the canonical CLEO version from the project's package.json.
 *
 * @param projectRoot - Optional project root override.
 * @returns The version string from package.json, or `0.0.0` when unavailable.
 */
export function getCanonicalCleoVersion(projectRoot?: string): string {
  const root = resolveOrCwd(projectRoot);
  const pkgPath = join(root, 'package.json');
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { version?: string };
    if (pkg.version && typeof pkg.version === 'string' && pkg.version.length > 0) {
      return pkg.version;
    }
  } catch {
    // Fall through to default.
  }
  return '0.0.0';
}

/**
 * Compare two CLEO calver version strings.
 *
 * @param a - First version string.
 * @param b - Second version string.
 * @returns `-1` if `a < b`, `0` if equal, `1` if `a > b`.
 */
export function compareCleoVersions(a: string, b: string): number {
  const pa = parseCalver(a);
  const pb = parseCalver(b);

  if (!pa || !pb) return 0;

  if (pa.year !== pb.year) return pa.year < pb.year ? -1 : 1;
  if (pa.month !== pb.month) return pa.month < pb.month ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/**
 * Check whether a version is within an inclusive range.
 *
 * @param version - The version to check.
 * @param min - Minimum version, inclusive.
 * @param max - Maximum version, inclusive.
 * @returns True if the version is in range.
 */
export function versionInRange(version: string, min?: string, max?: string): boolean {
  if (min && compareCleoVersions(version, min) < 0) return false;
  if (max && compareCleoVersions(version, max) > 0) return false;
  return true;
}

/** Resolution strategy for version disambiguation. */
export type VersionResolutionStrategy = 'canonical' | 'latest' | 'exact';

/**
 * Resolve a version identifier using the given strategy.
 *
 * @param version - The version to resolve.
 * @param strategy - Resolution strategy.
 * @param candidates - Optional candidate versions for `latest` strategy.
 * @returns The resolved version string.
 */
export function resolveVersion(
  version: string,
  strategy: VersionResolutionStrategy = 'canonical',
  candidates?: string[],
): string {
  switch (strategy) {
    case 'canonical':
      return getCanonicalCleoVersion();
    case 'latest': {
      if (!candidates || candidates.length === 0) return version;
      let latest = candidates[0];
      for (let i = 1; i < candidates.length; i++) {
        if (compareCleoVersions(candidates[i], latest) > 0) {
          latest = candidates[i];
        }
      }
      return latest;
    }
    case 'exact':
      return version;
  }
}

/**
 * Audit version fields across doc records for drift.
 *
 * @param canonicalVersion - The canonical version to compare against.
 * @param projectRoot - Project root containing the tasks database.
 * @returns Audit result with findings.
 */
export async function auditVersionFields(
  canonicalVersion: string,
  projectRoot: string,
): Promise<VersionAuditResult> {
  const findings: string[] = [];
  let totalRows = 0;
  let mismatchedRows = 0;

  try {
    const { getDb } = await import('../store/sqlite.js');
    const { attachments } = await import('../store/schema/attachments.js');

    const db = await getDb(projectRoot);
    const rows = await db.select().from(attachments).all();

    totalRows = rows.length;

    for (const row of rows) {
      const ownerVersion = (row as Record<string, unknown>).owner_version as string | null;
      if (ownerVersion && ownerVersion !== canonicalVersion) {
        mismatchedRows++;
        findings.push(
          `Row ${row.id}: owner_version "${ownerVersion}" != canonical "${canonicalVersion}"`,
        );
      }
    }
  } catch (err) {
    findings.push(`Audit error: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: mismatchedRows === 0 && findings.length === 0,
    findings,
    mismatchedRows,
    totalRows,
  };
}
