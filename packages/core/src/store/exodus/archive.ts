/**
 * Exodus source-DB ARCHIVE + completion-marker subsystem (T11777).
 *
 * ## Why this exists (stranded-residue corruption trigger)
 *
 * The exodus engine migrates from SIX legacy source DBs (project: `tasks.db`,
 * `brain.db`, `conduit.db`; global: `nexus.db`, `signaldock.db`, `skills.db`)
 * but, historically, NEVER retired them — `on-open.ts` literally notes "the file
 * is never unlinked." Every cutover therefore STRANDS the legacy files, and each
 * stranded file re-arms the `tasks_tasks=0` auto-recover / exodus-on-open
 * corruption trigger (DHQ-052 · T11662): on the next open the consolidated DB
 * looks empty-with-legacy-present and the hook re-fires.
 *
 * This module closes the loop. After a migration's lossless validation passes
 * (row-count parity + integrity — `verifyMigration` / `isDataContinuityOk`), the
 * consumed source DBs are ARCHIVED (moved, never deleted) into a per-scope
 * `_archive/` directory, and a committed COMPLETION MARKER records the cutover.
 * The marker becomes the durable "this scope is already migrated" signal so a
 * re-appearing or stranded legacy file can never re-trigger exodus-on-open.
 *
 * ## Archive destinations (per scope, via the paths SSoT)
 *
 *   - project sources → `<cleoDir>/_archive/`     (e.g. `.cleo/_archive/`)
 *   - global  sources → `<cleoHome>/_archive/`    (e.g. `~/.local/share/cleo/_archive/`)
 *
 * Both are resolved through `resolveCleoDir(cwd)` / `getCleoHome()` — never a
 * hardcoded `~/.local/share` (Paths SSoT · Gate 2 · D009).
 *
 * ## Reversibility + idempotency invariants
 *
 *   - **Reversible** — archiving is an atomic `rename` (fallback copy+unlink
 *     across filesystems). Nothing is ever deleted; an operator can move a DB
 *     back out of `_archive/` to roll the cutover back.
 *   - **Idempotent** — a source that is already absent (already archived, or a
 *     fresh install that never had it) is a silent no-op. Re-running over an
 *     already-archived fleet does nothing and never throws.
 *   - **Never blind-move** — only sources the caller asserts were actually
 *     consumed + validated by the migration are archived. A source whose
 *     migration did not run is left untouched.
 *   - **Emergency-archive reconciliation** — this box was emergency-archived
 *     (`.cleo/_archive-legacy-postcutover-*` already holds `tasks.db` +
 *     `conduit.db`). When the canonical destination already contains a file with
 *     the same name, the incoming file is parked under a timestamped sibling name
 *     rather than clobbering the prior archive.
 *
 * @module
 * @task T11777 (exodus archives all 6 legacy DBs post-validation + completion marker)
 * @epic T11249 (E6)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/exodus/on-open.ts — wires this into the validated success path
 * @see packages/core/src/store/exodus/plan.ts — buildSourceDescriptors (the 6 sources)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { getLogger } from '../../logger.js';
import { getCleoHome, resolveCleoDir } from '../../paths.js';
import { getCleoVersion } from '../../scaffold/ensure-config.js';
import type { ExodusScope, LegacyDbDescriptor } from './types.js';

const log = getLogger('exodus-archive');

/** Per-scope archive directory name (sibling of the migrated DBs). */
const ARCHIVE_DIR_NAME = '_archive' as const;

/** Per-scope completion-marker filename written next to the consolidated cleo.db. */
const MARKER_FILENAME_BY_SCOPE: Readonly<Record<ExodusScope, string>> = {
  project: 'exodus-complete',
  global: 'exodus-complete',
};

/** SQLite sidecar suffixes archived alongside the main DB file. */
const SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

/**
 * Resolve the directory that holds a scope's legacy source DBs (and therefore
 * its archive + completion marker): project → `<cleoDir>`, global →
 * `<cleoHome>`. Always via the paths SSoT.
 *
 * @param scope - Target scope.
 * @param cwd   - Working directory used to resolve the project `.cleo/` dir.
 * @returns Absolute path to the scope's base directory.
 */
function scopeBaseDir(scope: ExodusScope, cwd: string | undefined): string {
  return scope === 'project' ? resolveCleoDir(cwd) : getCleoHome();
}

/**
 * Absolute path to a scope's `_archive/` directory.
 *
 * @param scope - Target scope.
 * @param cwd   - Working directory used to resolve the project `.cleo/` dir.
 * @returns Absolute path to `<scopeBase>/_archive/`.
 */
export function exodusArchiveDir(scope: ExodusScope, cwd?: string): string {
  return join(scopeBaseDir(scope, cwd), ARCHIVE_DIR_NAME);
}

/**
 * Absolute path to a scope's exodus completion marker file.
 *
 * @param scope - Target scope.
 * @param cwd   - Working directory used to resolve the project `.cleo/` dir.
 * @returns Absolute path to `<scopeBase>/exodus-complete`.
 */
export function exodusMarkerPath(scope: ExodusScope, cwd?: string): string {
  return join(scopeBaseDir(scope, cwd), MARKER_FILENAME_BY_SCOPE[scope]);
}

/**
 * Shape of the committed exodus completion marker (`exodus-complete`).
 *
 * Recorded once per scope after a validated cutover. Its presence — not the
 * source-file `existsSync` — is the durable trigger-gate for exodus-on-open.
 */
export interface ExodusCompleteMarker {
  /** Marker format version. */
  readonly version: 1;
  /** Scope this marker certifies as migrated. */
  readonly scope: ExodusScope;
  /** cleo package version that performed the cutover. */
  readonly cleoVersion: string;
  /** ISO-8601 timestamp of the cutover. */
  readonly completedAt: string;
  /** Logical names of the legacy sources that were archived (provenance). */
  readonly archivedSources: readonly string[];
}

/**
 * Return `true` if a scope's exodus completion marker exists on disk.
 *
 * Resolution-safe: when the project `.cleo/` dir cannot be resolved (e.g. `cwd`
 * is not inside a CLEO project — `resolveCleoDir` throws), this returns `false`
 * (no marker) rather than propagating, so the on-open trigger gate degrades to
 * the source-file path safely instead of crashing the open.
 *
 * @param scope - Target scope.
 * @param cwd   - Working directory used to resolve the project `.cleo/` dir.
 * @returns Whether `<scopeBase>/exodus-complete` exists.
 */
export function hasExodusCompleteMarker(scope: ExodusScope, cwd?: string): boolean {
  try {
    return existsSync(exodusMarkerPath(scope, cwd));
  } catch {
    return false;
  }
}

/**
 * Write a scope's exodus completion marker atomically (write-then-rename).
 *
 * Idempotent: re-writing simply refreshes the marker (same path). The marker is
 * the SSoT trigger-gate consulted by {@link maybeRunExodusOnOpen} — once present,
 * a stranded/re-appearing legacy file cannot re-arm the auto-migration.
 *
 * @param scope           - Scope being certified as migrated.
 * @param archivedSources - Logical names of the sources archived for this scope.
 * @param cwd             - Working directory used to resolve the project dir.
 * @returns The marker's absolute path.
 *
 * @task T11777
 */
export function writeExodusCompleteMarker(
  scope: ExodusScope,
  archivedSources: readonly string[],
  cwd?: string,
): string {
  const markerPath = exodusMarkerPath(scope, cwd);
  const baseDir = scopeBaseDir(scope, cwd);
  mkdirSync(baseDir, { recursive: true });

  const marker: ExodusCompleteMarker = {
    version: 1,
    scope,
    cleoVersion: getCleoVersion(),
    completedAt: new Date().toISOString(),
    archivedSources: [...archivedSources],
  };

  const tmpPath = `${markerPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, markerPath);
  log.info({ scope, markerPath, archivedSources }, 'exodus: wrote completion marker');
  return markerPath;
}

/**
 * Outcome of archiving one source DB.
 */
export interface ArchivedSourceResult {
  /** Logical source name (`LegacyDbDescriptor.name`). */
  readonly name: string;
  /** Original absolute source path. */
  readonly sourcePath: string;
  /** Destination path inside `_archive/`, or `null` when nothing was moved. */
  readonly archivedTo: string | null;
  /** `'archived'` — moved; `'absent'` — nothing to move (idempotent no-op). */
  readonly action: 'archived' | 'absent';
}

/**
 * Move a single file to `destDir`, atomically when possible.
 *
 * Uses `rename`; on a cross-filesystem `EXDEV` (or any rename failure) falls back
 * to copy-then-unlink so the move still completes. When `destDir` already holds a
 * file with the same name (e.g. a prior emergency archive), the incoming file is
 * parked under a timestamped sibling name so the prior archive is never clobbered.
 *
 * @param srcPath - Absolute source file path (assumed to exist).
 * @param destDir - Absolute archive directory (created if missing).
 * @returns The absolute destination path the file landed at.
 */
function moveFileInto(srcPath: string, destDir: string): string {
  mkdirSync(destDir, { recursive: true });
  let dest = join(destDir, basename(srcPath));
  if (existsSync(dest)) {
    // Do not clobber a prior archive (e.g. emergency-archived tasks.db). Park
    // the incoming file under a timestamped sibling name instead.
    const stamp = new Date().toISOString().replace(/[:.]/g, '').replace(/Z$/, 'Z');
    dest = join(destDir, `${basename(srcPath)}.${stamp}`);
  }
  try {
    renameSync(srcPath, dest);
  } catch {
    // Cross-filesystem (EXDEV) or other rename failure → copy + unlink fallback.
    copyFileSync(srcPath, dest);
    unlinkSync(srcPath);
  }
  return dest;
}

/**
 * Archive ONE legacy source DB (and its `-wal` / `-shm` sidecars) into the
 * scope's `_archive/` directory.
 *
 * Idempotent: if the main DB file is already absent, this is a no-op (the file
 * was already archived, or never existed). Sidecars are archived best-effort and
 * only when the main DB is present.
 *
 * @param source - The descriptor for the source DB to archive.
 * @param cwd    - Working directory used to resolve the project dir.
 * @returns A {@link ArchivedSourceResult} describing what happened.
 *
 * @task T11777
 */
export function archiveSourceDb(source: LegacyDbDescriptor, cwd?: string): ArchivedSourceResult {
  // Idempotent no-op: nothing to archive (already archived or fresh install).
  if (!existsSync(source.path)) {
    return { name: source.name, sourcePath: source.path, archivedTo: null, action: 'absent' };
  }

  const destDir = exodusArchiveDir(source.targetScope, cwd);
  const archivedTo = moveFileInto(source.path, destDir);

  // Archive sidecars alongside the DB (best-effort — they may not exist).
  for (const suffix of SIDECAR_SUFFIXES) {
    const sidecar = `${source.path}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        moveFileInto(sidecar, destDir);
      } catch (err) {
        log.warn(
          { err, sidecar, sourceName: source.name },
          'exodus-archive: failed to archive sidecar (non-fatal)',
        );
      }
    }
  }

  log.info(
    { sourceName: source.name, sourcePath: source.path, archivedTo, scope: source.targetScope },
    'exodus-archive: archived legacy source DB',
  );
  return {
    name: source.name,
    sourcePath: source.path,
    archivedTo,
    action: 'archived',
  };
}

/**
 * Result of {@link archiveMigratedSources}.
 */
export interface ArchiveMigratedSourcesResult {
  /** Per-source archive outcomes. */
  readonly sources: readonly ArchivedSourceResult[];
  /** Scopes for which a completion marker was written. */
  readonly markersWritten: readonly ExodusScope[];
}

/**
 * Archive every consumed legacy source DB AFTER a validated cutover and write a
 * per-scope completion marker.
 *
 * **Never blind-moves**: only the descriptors passed in `consumed` are archived
 * — the caller (the validated migrate/on-open success path) passes exactly the
 * sources whose migration actually ran and passed parity. A completion marker is
 * written for every scope represented in `consumed`, even if some of that scope's
 * sources were already absent (already archived) — the marker certifies "this
 * scope's cutover is done", which is true once parity passed.
 *
 * Idempotent + reversible (see module docs). Safe to call repeatedly.
 *
 * @param consumed - Source descriptors the migration consumed + validated.
 * @param cwd      - Working directory used to resolve the project dir.
 * @returns A {@link ArchiveMigratedSourcesResult} with per-source + per-scope outcomes.
 *
 * @task T11777
 */
export function archiveMigratedSources(
  consumed: readonly LegacyDbDescriptor[],
  cwd?: string,
): ArchiveMigratedSourcesResult {
  const results: ArchivedSourceResult[] = [];
  const scopes = new Set<ExodusScope>();

  for (const source of consumed) {
    scopes.add(source.targetScope);
    results.push(archiveSourceDb(source, cwd));
  }

  const markersWritten: ExodusScope[] = [];
  for (const scope of scopes) {
    const archivedForScope = consumed.filter((s) => s.targetScope === scope).map((s) => s.name);
    writeExodusCompleteMarker(scope, archivedForScope, cwd);
    markersWritten.push(scope);
  }

  return { sources: results, markersWritten };
}

/**
 * A legacy source DB that is still present on disk AFTER its scope's exodus
 * completion marker was written — i.e. stranded residue that should have been
 * archived.
 */
export interface StrandedResidueEntry {
  /** Logical source name. */
  readonly name: string;
  /** Absolute path of the still-present legacy DB. */
  readonly path: string;
  /** Scope whose marker certifies the cutover. */
  readonly scope: ExodusScope;
}

/**
 * Detect stranded legacy source DBs: any of the six sources still present on
 * disk for a scope whose exodus completion marker exists.
 *
 * Returns an empty array when no marker exists for either scope (a pre-cutover
 * install where legacy DBs are still the live source of truth — NOT residue) or
 * when every source for a marked scope has been archived.
 *
 * @param sources - The full legacy source descriptor list (from `buildExodusPlan`).
 * @param cwd     - Working directory used to resolve the project dir + markers.
 * @returns The stranded entries (empty when clean).
 *
 * @task T11777
 */
export function detectStrandedResidue(
  sources: readonly LegacyDbDescriptor[],
  cwd?: string,
): StrandedResidueEntry[] {
  const markedScopes = new Set<ExodusScope>();
  for (const scope of ['project', 'global'] as const) {
    if (hasExodusCompleteMarker(scope, cwd)) markedScopes.add(scope);
  }
  if (markedScopes.size === 0) return [];

  const stranded: StrandedResidueEntry[] = [];
  for (const source of sources) {
    if (!markedScopes.has(source.targetScope)) continue;
    if (existsSync(source.path)) {
      stranded.push({ name: source.name, path: source.path, scope: source.targetScope });
    }
  }
  return stranded;
}

/**
 * Archive stranded residue detected by {@link detectStrandedResidue}.
 *
 * This is the `--fix` action for the `cleo doctor exodus-residue` check. It reuses
 * {@link archiveSourceDb} so the on-open success path and the doctor fix share one
 * archive routine. Reversible (move, never delete) and idempotent.
 *
 * @param stranded - The stranded entries to archive.
 * @param sources  - The full source descriptor list (to map name → descriptor).
 * @param cwd      - Working directory used to resolve the project dir.
 * @returns Per-source archive outcomes.
 *
 * @task T11777
 */
export function archiveStrandedResidue(
  stranded: readonly StrandedResidueEntry[],
  sources: readonly LegacyDbDescriptor[],
  cwd?: string,
): ArchivedSourceResult[] {
  const byName = new Map(sources.map((s) => [s.name, s]));
  const results: ArchivedSourceResult[] = [];
  for (const entry of stranded) {
    const descriptor = byName.get(entry.name);
    if (descriptor === undefined) continue;
    results.push(archiveSourceDb(descriptor, cwd));
  }
  return results;
}
